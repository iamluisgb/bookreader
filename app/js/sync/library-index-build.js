// IA10 F2 · El índice de toda la biblioteca, para que un agente pregunte a todos los libros a la
// vez (ADR-059). Puro, como book-text-build.js: lo usan la app al construirlo
// (library-index.js) y el MCP al consultarlo (Node y Worker).
//
// El Worker no puede recorrer libros enteros en sus 10 ms de CPU, así que el dispositivo
// construye y el Worker solo lee unos pocos ficheros pequeños:
//
//   index/manifest.json      qué libros están indexados y dónde: su huella, sus estadísticas
//                            (pasajes y longitud media), sus capítulos, el mapa de bloques de su
//                            almacén y en qué fichero están sus postings ('base' o un delta).
//                            Un libro que no está aquí no existe para la consulta: es la lápida.
//   index/b<gen>/<p>.txt     la base: 64 particiones por hash del término.
//   index/d/<id>.txt         un delta por libro añadido desde la última compactación (≤ 4).
//   index/s/<bookId>.bin     el almacén de pasajes: bloques de ~16 KB sellados por separado,
//                            para leer solo los que hacen falta (proveedor · readBlocks).
//
// Formato de una partición o un delta (texto):
//   B<TAB>bookId0<TAB>bookId1…                    los libros que aparecen, por posición
//   término<TAB>0:postings;1:postings…            un término por línea, ordenados
// postings: por pasaje, `delta` (número de pasaje respecto al anterior, en base 36), `*tf` si el
// término aparece más de una vez, y una letra A–Z con la longitud del pasaje (escala log).
// Buscar un término es un `indexOf` de su línea: no se parsea el fichero entero.

export const INDEX_FORMAT = 1;
export const PARTS = 64;
export const MAX_DELTAS = 4;
export const BLOCK_BYTES = 16 * 1024;
export const MAX_TERMS = 16;

export const DIR = 'index/';
export const manifestPath = (base) => base + DIR + 'manifest.json';
export const basePath = (base, gen, p) => `${base}${DIR}b${gen}/${p}.txt`;
export const deltaPath = (base, id) => `${base}${DIR}d/${id}.txt`;
export const storePath = (base, bookId) => `${base}${DIR}s/${bookId}.bin`;

// Palabras vacías en inglés y español (ya plegadas: sin tildes). No aportan a la búsqueda y son
// la mitad de los postings.
const STOP = new Set(`a about above after again against all am an and any are as at be because been
before being below between both but by can could did do does doing down during each few for from
further had has have having he her here hers herself him himself his how i if in into is it its
itself just me more most my myself no nor not now of off on once only or other our ours ourselves out
over own same she should so some such than that the their theirs them themselves then there these
they this those through to too under until up very was we were what when where which while who whom
why will with would you your yours yourself yourselves also may might must shall us via etc
al algo algun alguna algunas alguno algunos ante antes aqui asi aun bien cada como con contra cual
cuales cuando de del desde donde dos el ella ellas ello ellos en entre era eran es esa esas ese eso
esos esta estaba estado estan estar estas este esto estos fue fueron ha habia han hasta hay la las le
les lo los mas me mi mis mucho muy nada ni no nos nosotros o os otra otras otro otros para pero poco
por porque que quien quienes se sea ser si sido sin sobre son su sus tambien tan tanto te tiene
tienen todo todos tu tus un una unas uno unos usted vosotros y ya yo`.split(/\s+/));

// Una raíz ligera, igual para inglés y español: plurales y unas pocas terminaciones. No pretende
// ser un stemmer completo, sino que «ontology» y «ontologies», o «replica» y «replicas», casen.
// Es la MISMA al indexar y al consultar: lo que importa es que sea estable.
export function stem(w) {
  if (w.length <= 3 || /^\d+$/.test(w)) return w;
  let s = w;
  if (s.length > 4 && s.endsWith('ies')) s = s.slice(0, -3) + 'y';
  else if (s.length > 7 && s.endsWith('mente')) s = s.slice(0, -5);
  else if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith('ed') && !s.endsWith('eed')) s = s.slice(0, -2);
  else if (s.length > 4 && s.endsWith('es')) s = s.slice(0, -2);
  else if (s.endsWith('s') && !/(ss|us|is)$/.test(s)) s = s.slice(0, -1);
  if (s.length > 3 && s.endsWith('e')) s = s.slice(0, -1);
  return s;
}

/** Texto ya plegado (foldSearch) → raíces sin palabras vacías, en orden. */
export function terms(folded) {
  const out = [];
  for (const w of String(folded || '').split(' ')) {
    if (w.length < 2 || STOP.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

/** FNV-1a: la partición de un término. */
export function partitionOf(term) {
  let h = 0x811c9dc5;
  for (let i = 0; i < term.length; i++) { h ^= term.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) % PARTS;
}

// Longitud del pasaje en 26 cubos logarítmicos (una letra): para BM25 basta con la escala.
const LEN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const lenBucket = (dl) => Math.min(25, Math.floor(Math.log2(dl + 1) * 3));
const LENS = Array.from({ length: 26 }, (_, b) => Math.max(1, 2 ** (b / 3) - 1));
export const bucketLen = (b) => LENS[b];

const num = (id) => Number(String(id).slice(1));

function encodePostings(list) {
  let prev = 0;
  return list.map(([n, tf, b]) => {
    const s = (n - prev).toString(36) + (tf > 1 ? '*' + tf : '') + LEN[b];
    prev = n;
    return s;
  }).join(',');
}

// [[pasaje, tf, cubo]…]. A mano y sin regex: es lo más caliente de una consulta en el Worker.
export function decodePostings(s) {
  const out = [];
  let n = 0;
  let i = 0;
  const len = s.length;
  while (i < len) {
    let d = 0;
    let c = s.charCodeAt(i);
    while ((c >= 48 && c <= 57) || (c >= 97 && c <= 122)) {   // 0-9 a-z: el delta en base 36
      d = d * 36 + (c <= 57 ? c - 48 : c - 87);
      c = s.charCodeAt(++i);
    }
    let tf = 1;
    if (c === 42) {   // '*'
      tf = 0;
      c = s.charCodeAt(++i);
      while (c >= 48 && c <= 57) { tf = tf * 10 + c - 48; c = s.charCodeAt(++i); }
    }
    n += d;
    out.push([n, tf, c - 65]);   // A-Z: el cubo de longitud
    i += 2;                      // la letra y la coma
  }
  return out;
}

/**
 * El `search.txt` de un libro (book-text-build.js) → sus postings y estadísticas.
 * Devuelve { n, avgdl, postings: Map(término → texto codificado) }.
 */
export function bookPostings(search) {
  const byTerm = new Map();
  let n = 0;
  let total = 0;
  for (const line of String(search || '').split('\n')) {
    if (!line) continue;
    const t1 = line.indexOf('\t');
    const t2 = line.indexOf('\t', t1 + 1);
    if (t1 < 0 || t2 < 0) continue;
    const id = num(line.slice(0, t1));
    const ts = terms(line.slice(t2 + 1));
    n++;
    total += ts.length;
    if (!ts.length) continue;
    const tf = new Map();
    for (const t of ts) tf.set(t, (tf.get(t) || 0) + 1);
    const b = lenBucket(ts.length);
    for (const [t, c] of tf) {
      if (!byTerm.has(t)) byTerm.set(t, []);
      byTerm.get(t).push([id, c, b]);
    }
  }
  const postings = new Map();
  for (const t of [...byTerm.keys()].sort()) postings.set(t, encodePostings(byTerm.get(t).sort((x, y) => x[0] - y[0])));
  return { n, avgdl: n ? total / n : 0, postings };
}

/**
 * Postings de varios libros → el texto de un fichero (partición o delta).
 * `books`: Map(bookId → Map(término → postings)). Determinista: libros y términos ordenados.
 * Un delta lleva TODAS las particiones: sus líneas van por partición y una segunda línea
 * `P<TAB>inicio0,inicio1…` dice dónde empieza cada una (en caracteres), para que buscar un
 * término no recorra el fichero entero.
 */
export function encodeFile(books, { sections = false } = {}) {
  const ids = [...books.keys()].sort();
  const byTerm = new Map();
  ids.forEach((id, bi) => {
    for (const [t, p] of books.get(id)) {
      if (!byTerm.has(t)) byTerm.set(t, []);
      byTerm.get(t).push(bi + ':' + p);
    }
  });
  const head = 'B\t' + ids.join('\t');
  const sorted = [...byTerm.keys()].sort();
  if (!sections) return [head, ...sorted.map((t) => t + '\t' + byTerm.get(t).join(';'))].join('\n') + '\n';
  const groups = Array.from({ length: PARTS }, () => []);
  for (const t of sorted) groups[partitionOf(t)].push(t + '\t' + byTerm.get(t).join(';') + '\n');
  // Los inicios cuentan desde el final de la línea P; su longitud depende de ellos mismos, así
  // que se miden relativos y se suman al final.
  const rel = [];
  let at = 0;
  for (const g of groups) { rel.push(at); at += g.reduce((a, l) => a + l.length, 0); }
  rel.push(at);
  return head + '\nP\t' + rel.join(',') + '\n' + groups.map((g) => g.join('')).join('');
}

/** Un fichero entero → Map(bookId → Map(término → postings)). Para compactar. */
export function decodeFile(text) {
  const lines = String(text || '').split('\n');
  const ids = (lines[0] || '').split('\t').slice(1);
  const books = new Map(ids.map((id) => [id, new Map()]));
  for (const line of lines.slice(1)) {
    const tab = line.indexOf('\t');
    if (tab < 0 || line.startsWith('P\t')) continue;
    const t = line.slice(0, tab);
    for (const e of line.slice(tab + 1).split(';')) {
      const c = e.indexOf(':');
      books.get(ids[Number(e.slice(0, c))]).set(t, e.slice(c + 1));
    }
  }
  return books;
}

/** Las entradas de UN término en un fichero, sin parsear el resto: [{ bookId, postings }]. */
export function lookup(text, term) {
  const head = text.indexOf('\n');
  if (head < 0) return [];
  let from = head;
  let to = text.length;
  if (text.startsWith('P\t', head + 1)) {
    const end = text.indexOf('\n', head + 1);
    const rel = text.slice(head + 3, end).split(',');
    const p = partitionOf(term);
    from = end + Number(rel[p]);
    to = end + 1 + Number(rel[p + 1]);
  }
  const key = '\n' + term + '\t';
  const at = text.indexOf(key, from);
  if (at < 0 || at >= to) return [];
  const end = text.indexOf('\n', at + key.length);
  const ids = text.slice(0, head).split('\t');
  return text.slice(at + key.length, end < 0 ? undefined : end).split(';').map((e) => {
    const c = e.indexOf(':');
    return { bookId: ids[1 + Number(e.slice(0, c))], postings: e.slice(c + 1) };
  });
}

/** Postings de un libro → Map(partición → Map(término → postings)). */
export function splitByPartition(postings) {
  const out = new Map();
  for (const [t, p] of postings) {
    const k = partitionOf(t);
    if (!out.has(k)) out.set(k, new Map());
    out.get(k).set(t, p);
  }
  return out;
}

// ---- Almacén de pasajes ----------------------------------------------------------------------

const PASSAGE = /^\[\[a(\d+)\]\]\s?(.*)$/;

/**
 * Los trozos del libro (`p<n>.txt`) → bloques de ~16 KB con líneas `número<TAB>pasaje`, en
 * orden. Un pasaje no se parte entre bloques. Devuelve { blocks: [Uint8Array], starts }, con
 * `starts[i]` = el primer pasaje del bloque i.
 */
export function buildStore(parts) {
  const enc = new TextEncoder();
  const blocks = [];
  const starts = [];
  let cur = [];
  let size = 0;
  let first = null;
  const flush = () => {
    if (!cur.length) return;
    blocks.push(enc.encode(cur.join('\n') + '\n'));
    starts.push(first);
    cur = []; size = 0; first = null;
  };
  for (const part of parts || []) {
    for (const raw of String(part).split('\n')) {
      const m = PASSAGE.exec(raw.trim());
      if (!m) continue;
      const line = m[1] + '\t' + m[2];
      const bytes = enc.encode(line).length + 1;
      if (size && size + bytes > BLOCK_BYTES) flush();
      if (first === null) first = Number(m[1]);
      cur.push(line);
      size += bytes;
    }
  }
  flush();
  return { blocks, starts };
}

/** El bloque que tiene el pasaje `n` (búsqueda binaria en `starts`). */
export function blockOf(starts, n) {
  let lo = 0;
  let hi = starts.length - 1;
  if (hi < 0 || n < starts[0]) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= n) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** El texto del pasaje `n` dentro de su bloque, o null. */
export function passageIn(blockText, n) {
  const key = n + '\t';
  let at = 0;
  if (!blockText.startsWith(key)) {
    at = blockText.indexOf('\n' + key);
    if (at < 0) return null;
    at++;
  }
  const end = blockText.indexOf('\n', at);
  return blockText.slice(at + key.length, end < 0 ? undefined : end);
}

/** El capítulo del pasaje `n`: `chapters` es [[primer pasaje, título]] en orden. */
export function chapterOf(chapters, n) {
  let title = '';
  for (const [from, t] of chapters || []) { if (from <= n) title = t; else break; }
  return title;
}

// ---- Manifiesto ----------------------------------------------------------------------------

export function emptyManifest() {
  return { v: INDEX_FORMAT, gen: 0, books: {}, deltas: [] };
}

// ---- Consulta --------------------------------------------------------------------------------

const K1 = 1.2;
const B = 0.75;

/** Las raíces de una consulta en lenguaje natural, sin repetir. */
export function queryTerms(q) {
  const fold = String(q || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
  return [...new Set(terms(fold))];
}

/** Los `k` pasajes de mayor `score[n]` (a igualdad, el de menor número), sin ordenar todos. */
export function topK(ns, score, k) {
  const better = (a, b) => score[a] > score[b] || (score[a] === score[b] && a < b);
  const top = [];
  for (const n of ns) {
    if (top.length === k && !better(n, top[k - 1])) continue;
    let j = Math.min(top.length, k - 1);
    while (j > 0 && better(n, top[j - 1])) { top[j] = top[j - 1]; j--; }
    top[j] = n;
  }
  return top;
}

/**
 * Busca `queries` (hasta 5 frases) en el índice. `read(path)` devuelve el texto de un fichero
 * o null; se piden solo las particiones de los términos y los deltas.
 *
 * Puntuación (ADR-059 §3): BM25 con las estadísticas de CADA libro (su longitud media) y un
 * peso por término común a todos (idf de la biblioteca). Un libro se ordena por sus mejores
 * pasajes y por cuánto habla del tema (`focus`, la parte de sus pasajes que lo nombran), no por
 * cuántos aciertos suma: contar premia los libros grandes.
 *
 * Devuelve { books: [{ bookId, score, passages: [{ n, score }] }], terms, reads, truncated }.
 */
export async function searchIndex(read, base, manifest, queries, { perBook = 3, books = 8 } = {}) {
  const qs = (Array.isArray(queries) ? queries : [queries]).slice(0, 5).map(queryTerms).filter((q) => q.length);
  let all = [...new Set(qs.flat())];
  const truncated = all.length > MAX_TERMS;
  all = all.slice(0, MAX_TERMS);
  const known = manifest.books || {};
  const files = [
    ...[...new Set(all.map(partitionOf))].map((p) => ({ path: basePath(base, manifest.gen, p), loc: 'base', p })),
    ...(manifest.deltas || []).map((d) => ({ path: deltaPath(base, d.id), loc: d.id, p: null })),
  ];
  const texts = await Promise.all(files.map((f) => read(f.path)));
  // término → libro → postings (solo los del fichero que el manifiesto da por bueno)
  const hits = new Map(all.map((t) => [t, new Map()]));
  files.forEach((f, i) => {
    const text = texts[i];
    if (!text) return;
    for (const t of all) {
      if (f.p !== null && partitionOf(t) !== f.p) continue;
      for (const { bookId, postings } of lookup(text, t)) {
        if (known[bookId]?.loc === f.loc) hits.get(t).set(bookId, decodePostings(postings));
      }
    }
  });
  // idf de la biblioteca: el mismo peso de un término para todos los libros.
  const N = Object.values(known).reduce((a, b) => a + (b.n || 0), 0) || 1;
  const idf = new Map(all.map((t) => {
    const df = [...hits.get(t).values()].reduce((a, p) => a + p.length, 0);
    return [t, Math.log(1 + (N - df + 0.5) / (df + 0.5))];
  }));

  const ranked = [];
  for (const bookId of new Set([...hits.values()].flatMap((m) => [...m.keys()]))) {
    const meta = known[bookId];
    const avgdl = meta.avgdl || 1;
    // Puntuaciones en arrays por número de pasaje (no Maps): una consulta grande suma decenas
    // de miles de postings y en el Worker cada milisegundo cuenta.
    let size = 0;
    for (const t of all) { const l = hits.get(t).get(bookId); if (l && l.length) size = Math.max(size, l[l.length - 1][0] + 1); }
    const best = new Float64Array(size);
    const score = new Float64Array(size);
    const touched = [];
    let focus = 0;
    for (const q of qs) {
      const wsum = q.reduce((a, t) => a + (idf.get(t) || 0), 0) || 1;
      let qfocus = 0;
      const mine = [];
      for (const t of q) {
        const list = hits.get(t)?.get(bookId);
        if (!list) continue;
        const w = (idf.get(t) || 0) / wsum;
        qfocus += w * Math.min(1, list.length / Math.max(1, 0.02 * meta.n));
        for (const [n, tf, b] of list) {
          const sat = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * bucketLen(b) / avgdl)) / (K1 + 1);
          if (score[n] === 0) mine.push(n);
          score[n] += w * sat;
        }
      }
      focus = Math.max(focus, qfocus);
      for (const n of mine) {
        if (best[n] === 0) touched.push(n);
        if (score[n] > best[n]) best[n] = score[n];
        score[n] = 0;
      }
    }
    // Los K mejores sin ordenar todos los tocados (pueden ser miles): selección lineal.
    const top = topK(touched, best, Math.max(3, perBook));
    const [s1 = 0, s2 = 0, s3 = 0] = top.map((n) => best[n]);
    const bookScore = ((s1 + 0.5 * s2 + 0.25 * s3) / 1.75) * (1 + 0.5 * focus);
    ranked.push({ bookId, score: bookScore, passages: top.slice(0, perBook).map((n) => ({ n, score: best[n] })) });
  }
  ranked.sort((x, y) => y.score - x.score || (x.bookId < y.bookId ? -1 : 1));
  return { books: ranked.slice(0, books), terms: all, reads: files.length, truncated };
}
