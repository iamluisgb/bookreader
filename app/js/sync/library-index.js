// IA10 F2 · El índice de toda la biblioteca en el sync de BookReader (ADR-059): lo construye el
// dispositivo, a partir del texto ya subido (book-text.js), y el MCP solo lo lee. El formato y
// la consulta, en library-index-build.js.
//
// Cada libro nuevo o re-troceado es un delta (3 escrituras: almacén, delta y manifiesto). Al
// pasar de MAX_DELTAS, este equipo compacta: baja la base y los deltas, los funde en una
// generación nueva y cambia el manifiesto de golpe (con su etag: si otro equipo escribió entre
// medias, se deja para la próxima). Fundir usa el propio índice, no los libros, así que vale en
// un equipo que no los tiene todos. Unas 16 escrituras por libro, amortizadas.
//
// Se indexa desde el texto del SERVIDOR (text/<id>…), no desde el de este equipo: las anclas
// del índice tienen que ser las del texto que lee el agente.
//
// `createIndexer(io, base)` no sabe de navegador: `io` es un proveedor ({ read, write, remove,
// list, writeBlocks }), y los tests le pasan el de memoria del MCP. La app usa el activo.

import {
  INDEX_FORMAT, MAX_DELTAS, PARTS, DIR, manifestPath, basePath, deltaPath, storePath,
  emptyManifest, bookPostings, encodeFile, decodeFile, splitByPartition, buildStore,
} from './library-index-build.js';

const CAS_RETRIES = 5;
export const SWEEP_GRACE_MS = 10 * 60 * 1000;

export const randomId = () => [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(36).padStart(2, '0')).join('');

const chaptersOf = (toc) => (toc.chapters || []).map(c => [Number(String(c.from).slice(1)), c.title || '']);

export function createIndexer(io, base) {
  async function readManifest() {
    const r = await io.read(manifestPath(base));
    if (!r) return { m: emptyManifest(), etag: null };
    let m = null;
    try { m = JSON.parse(r.content); } catch { /* roto: se empieza de cero */ }
    // Otro formato: se empieza de cero; lo viejo lo quita el barrido tras la primera compactación.
    if (!m || m.v !== INDEX_FORMAT) return { m: { ...emptyManifest(), dirty: true }, etag: r.etag };
    return { m, etag: r.etag };
  }

  // Cambia el manifiesto solo si nadie lo cambió desde que se leyó. `change(m)` lo modifica en
  // sitio y devuelve false si ya no hay nada que hacer. Devuelve el manifiesto escrito, o null.
  async function updateManifest(change) {
    for (let i = 0; i < CAS_RETRIES; i++) {
      const { m, etag } = await readManifest();
      if (change(m) === false) return null;
      try {
        await io.write(manifestPath(base), JSON.stringify(m), { ifMatch: etag || undefined });
        return m;
      } catch (e) {
        if (e.code !== 412) throw e;
      }
    }
    throw new Error('index: el manifiesto cambia sin parar');
  }

  // El texto de un libro tal como está en el servidor: su índice, sus trozos y su búsqueda.
  async function remoteFiles(bookId) {
    const toc = await io.read(base + 'text/' + bookId + '.json');
    if (!toc) return null;
    const t = JSON.parse(toc.content);
    const dir = base + 'text/' + bookId + '/';
    const search = await io.read(dir + 'search.txt');
    if (!search) return null;
    const parts = [];
    for (let n = 0; n < (t.parts || 0); n++) {
      const p = await io.read(dir + 'p' + n + '.txt');
      if (!p) return null;
      parts.push(p.content);
    }
    return { toc: t, tocEtag: toc.etag, parts, search: search.content };
  }

  /**
   * Indexa un libro (o lo re-indexa) desde su texto en el servidor. `tocEtag` del listado: si el
   * texto cambió entre medias, se indexa lo que haya y el siguiente pase lo nota.
   */
  async function indexBook(bookId, { title = '' } = {}) {
    const f = await remoteFiles(bookId);
    if (!f) return false;
    const { n, avgdl, postings } = bookPostings(f.search);
    const store = buildStore(f.parts);
    const { offsets } = await io.writeBlocks(storePath(base, bookId), store.blocks);
    const id = randomId();
    await io.write(deltaPath(base, id), encodeFile(new Map([[bookId, postings]]), { sections: true }));
    const m = await updateManifest((m) => {
      m.books[bookId] = {
        toc: f.tocEtag, seg: f.toc.segVersion, title: title || f.toc.title || '', n, avgdl,
        loc: id, chapters: chaptersOf(f.toc), store: { starts: store.starts, offsets },
      };
      m.deltas.push({ id, books: [bookId] });
    });
    if (m && (m.deltas.length > MAX_DELTAS || m.dirty)) await compact();
    return true;
  }

  /** Da de baja un libro: deja de existir para la consulta al momento, y la compactación lo borra. */
  async function removeBook(bookId) {
    const m = await updateManifest((m) => {
      if (!m.books[bookId]) return false;
      delete m.books[bookId];
      m.dirty = true;
    });
    if (m) await compact();
    await io.remove(storePath(base, bookId)).catch(() => {});
  }

  /**
   * Funde la base y los deltas en una generación nueva: solo los postings que el manifiesto da
   * por buenos (cada libro, del fichero de su `loc`). Devuelve true si cambió el manifiesto.
   */
  async function compact() {
    const { m, etag } = await readManifest();
    const parts = Array.from({ length: PARTS }, () => new Map());   // partición → libro → término → postings
    const keep = (bookId, loc) => m.books[bookId]?.loc === loc;
    if (m.gen) {
      for (let p = 0; p < PARTS; p++) {
        const r = await io.read(basePath(base, m.gen, p));
        if (!r) continue;
        for (const [bookId, terms] of decodeFile(r.content)) if (keep(bookId, 'base')) parts[p].set(bookId, terms);
      }
    }
    for (const d of m.deltas) {
      const r = await io.read(deltaPath(base, d.id));
      if (!r) continue;
      for (const [bookId, terms] of decodeFile(r.content)) {
        if (!keep(bookId, d.id)) continue;
        for (const [p, sub] of splitByPartition(terms)) parts[p].set(bookId, sub);
      }
    }
    const gen = randomId();
    const written = [];
    try {
      for (let p = 0; p < PARTS; p++) {
        if (!parts[p].size) continue;
        await io.write(basePath(base, gen, p), encodeFile(parts[p]));
        written.push(basePath(base, gen, p));
      }
      const next = { ...m, gen, deltas: [], dirty: undefined };
      for (const b of Object.values(next.books)) b.loc = 'base';
      await io.write(manifestPath(base), JSON.stringify(next), { ifMatch: etag || undefined });
    } catch (e) {
      // Otro equipo cambió el índice mientras tanto: lo nuestro sobra. Se compactará otra vez.
      for (const path of written) await io.remove(path).catch(() => {});
      if (e.code === 412) return false;
      throw e;
    }
    await sweep();
    return true;
  }

  // Borra lo que el manifiesto ya no nombra: generaciones viejas, deltas fundidos, almacenes de
  // libros dados de baja y restos de un formato anterior o de una carrera entre equipos. Solo lo
  // que tiene más de SWEEP_GRACE_MS: un delta recién escrito por otro equipo aún no está en el
  // manifiesto, y borrarlo dejaría su libro sin postings.
  async function sweep(now = Date.now()) {
    const { m } = await readManifest();
    const live = new Set([manifestPath(base)]);
    for (let p = 0; p < PARTS; p++) live.add(basePath(base, m.gen, p));
    for (const d of m.deltas) live.add(deltaPath(base, d.id));
    for (const id of Object.keys(m.books)) live.add(storePath(base, id));
    for (const f of await io.list(base + DIR)) {
      if (live.has(f.path)) continue;
      if (f.modifiedTime && now - Date.parse(f.modifiedTime) < SWEEP_GRACE_MS) continue;
      await io.remove(f.path).catch(() => {});
    }
  }

  /** Lo que dice el manifiesto (para la cobertura en Ajustes). */
  async function manifest() {
    return (await readManifest()).m;
  }

  /**
   * Pone el índice al día con el texto del servidor: indexa los libros cuyo texto es nuevo o
   * cambió (`remote`: bookId → { etag } de su text/<id>.json) y da de baja los borrados de la
   * biblioteca. `between()` se espera antes de cada libro (la cola de book-text.js: en reposo y
   * nunca con el lector abierto). Devuelve cuántos libros indexó.
   */
  async function refresh({ books, remote, deleted, between = async () => {}, stop = () => false }) {
    const { m } = await readManifest();
    for (const id of Object.keys(m.books)) {
      if (deleted.has(id)) await removeBook(id);
    }
    let n = 0;
    for (const b of books) {
      const r = remote[b.id];
      if (!r || m.books[b.id]?.toc === r.etag) continue;
      if (stop()) break;
      await between();
      if (await indexBook(b.id, { title: b.title })) n++;
    }
    return n;
  }

  return { indexBook, removeBook, compact, sweep, manifest, refresh };
}

// ---- En la app: el proveedor activo (solo el sync de BookReader sabe escribir bloques) -------

export async function forApp() {
  const [Provider, { BASE }] = await Promise.all([import('./provider.js'), import('./layout.js')]);
  if (Provider.activeId() !== 'bookreader' || !Provider.canWriteBlocks()) return null;
  const io = {
    read: Provider.read, write: Provider.write, remove: Provider.remove, list: Provider.list,
    writeBlocks: Provider.writeBlocks,
  };
  return createIndexer(io, BASE);
}
