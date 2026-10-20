// MCP · El texto de los libros en el sync de BookReader, para que un agente pueda leerlo
// (get_toc, read_chapter, search_book en el MCP del Worker).
//
// El servidor no tiene los libros en claro, y abrir un EPUB allí no cabe en el tiempo de CPU de
// un Worker. Pero la app ya trocea cada libro en pasajes con su ancla `[[aN]]` (ai/segment.js:
// lo usan el agente, la búsqueda y el estudio) y lo guarda en IndexedDB. Ese texto, tal cual,
// se sube cifrado a `bookreader/text/<bookId>…` en el formato de book-text-build.js (índice,
// trozos y búsqueda). Con las anclas, lo que un agente cree (tarjetas, mapas) puede citar el
// pasaje como lo hace la app.
//
// Solo se sube si hay un agente que pueda leerlo (bookreader-auth · bookTextWanted) y con el
// sync de BookReader activo. El motor de sync no lo baja nunca (solo mira books/): es un
// fichero para agentes, no para dispositivos.
//
// IA10 F1 · Todos los libros, no solo los abiertos: `fill` trocea en segundo plano cada libro
// (ai/segment-file.js), de uno en uno, en reposo y nunca con el lector abierto. Si el fichero no
// está en este equipo pero sí en el sync, lo baja solo para trocearlo y no lo guarda
// (blobs.js · fetchForText): el texto no depende de qué equipo tenga qué libros. Qué está subido lo dice el servidor (los índices `text/<id>.json` y su
// versión), no el localStorage de cada equipo: así dos equipos no trocean el mismo libro.
// `coverage` lo cuenta para Ajustes → Datos → Agentes.

import * as Provider from './provider.js';
import * as BRAuth from './bookreader-auth.js';
import * as Storage from '../storage.js';
import { BASE } from './layout.js';
import { buildTextFiles, TEXT_FORMAT } from './book-text-build.js';

const STATE_KEY = 'sync_text_state';   // { [bookId]: huella del texto ya subido } (solo local)
const REMOTE_KEY = 'sync_text_remote'; // { [bookId]: { etag, v, segVersion } } índices remotos ya leídos
const FAILED_KEY = 'sync_text_failed'; // { [bookId]: { seg, why } } no dio texto con esta SEG_VERSION
let running = null;
let quotaFull = false;
const uploading = new Map();           // bookId → Promise: el evento y la cola no suben dos veces
const unfetchable = new Set();         // libros cuyo fichero no se pudo bajar del sync (en esta sesión)

export const pathOf = (bookId) => BASE + 'text/' + bookId + '.json';

async function digest(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}

function enabled() {
  return Provider.activeId() === 'bookreader' && BRAuth.isConnected() && BRAuth.bookTextWanted();
}

// Los capítulos del índice (no las secciones `##` internas): dónde empieza cada uno, por ancla.
// Las anclas `aN` van en orden de lectura y cada una sabe su capítulo (segment.js).
export function chaptersOf(entries) {
  const out = [];
  const sorted = (entries || []).slice().sort((x, y) => Number(x[0].slice(1)) - Number(y[0].slice(1)));
  for (const [id, a] of sorted) {
    const title = (a && a.chapter) || '';
    if (!out.length || out[out.length - 1].title !== title) out.push({ title, from: id });
  }
  return out;
}

// Escribe `content` en `path` pase lo que pase en remoto: el texto de un libro es el mismo en
// todos los dispositivos, así que pisar lo que subió otro no pierde nada.
async function put(path, content) {
  const cur = await Provider.exists(path);
  try {
    await Provider.write(path, content, { ifMatch: cur ? cur.etag : undefined });
  } catch (e) {
    if (e.code !== 412) throw e;
  }
}

// Sube el texto de un libro si cambió desde la última vez. Devuelve true si subió algo.
export function upload(bookId) {
  if (uploading.has(bookId)) return uploading.get(bookId);
  const job = uploadNow(bookId).finally(() => uploading.delete(bookId));
  uploading.set(bookId, job);
  return job;
}

async function uploadNow(bookId) {
  if (!enabled()) return false;
  const DB = await import('../ai/db.js');
  const [text, meta, anch] = await Promise.all([DB.get('bookText', bookId), DB.get('books', bookId), DB.get('anchors', bookId)]);
  if (!text || !text.annotatedText || text.segVersion !== DB.SEG_VERSION) return false;
  const state = Storage.get(STATE_KEY, {}) || {};
  const sum = await digest(TEXT_FORMAT + ':' + text.segVersion + ':' + text.annotatedText);
  if (state[bookId] === sum) return false;
  const files = buildTextFiles(text.annotatedText, chaptersOf(anch && anch.entries), {
    bookId, title: (meta && meta.title) || null, segVersion: text.segVersion,
  });
  const dir = BASE + 'text/' + bookId + '/';
  // Trozos y búsqueda primero; el índice al final, cuando ya existe todo lo que nombra.
  for (const [n, part] of files.parts.entries()) await put(dir + 'p' + n + '.txt', part);
  await put(dir + 'search.txt', files.search);
  const old = await Provider.exists(pathOf(bookId)) ? await Provider.read(pathOf(bookId)).catch(() => null) : null;
  await put(pathOf(bookId), JSON.stringify(files.toc));
  // Si antes había más trozos (otra segmentación), los que sobran se borran.
  const before = old ? (JSON.parse(old.content).parts || 0) : 0;
  for (let n = files.parts.length; n < before; n++) await Provider.remove(dir + 'p' + n + '.txt').catch(() => {});
  Storage.set(STATE_KEY, { ...(Storage.get(STATE_KEY, {}) || {}), [bookId]: sum });
  return true;
}

// Qué libros tienen texto en el servidor, y con qué versión. Lista los nombres (D1, sin tocar
// R2) y solo lee los índices que cambiaron desde la última vez (por etag).
async function remoteTexts() {
  const dir = BASE + 'text/';
  const files = await Provider.list(dir);
  const cache = Storage.get(REMOTE_KEY, {}) || {};
  const next = {};
  for (const f of files) {
    const m = /^([^/]+)\.json$/.exec(f.path.slice(dir.length));
    if (!m) continue;
    let r = cache[m[1]];
    if (!r || r.etag !== f.etag) {
      try {
        const toc = JSON.parse((await Provider.read(f.path)).content);
        r = { etag: f.etag, v: toc.v, segVersion: toc.segVersion };
      } catch { continue; }
    }
    next[m[1]] = r;
  }
  Storage.set(REMOTE_KEY, next);
  return next;
}

const fresh = (r, segVersion) => !!r && r.v === TEXT_FORMAT && r.segVersion === segVersion;

function markFailed(bookId, seg, why) {
  Storage.set(FAILED_KEY, { ...(Storage.get(FAILED_KEY, {}) || {}), [bookId]: { seg, why } });
}

function forget(bookId) {
  const state = Storage.get(STATE_KEY, {}) || {};
  if (!(bookId in state)) return;
  delete state[bookId];
  Storage.set(STATE_KEY, state);
}

const progress = () => window.dispatchEvent(new CustomEvent('bookreader:book-text-progress'));

// Espera a un momento tranquilo: nunca con un libro abierto (trocear compite con el lector por
// la CPU y la memoria) y, si el navegador lo sabe, cuando esté ocioso.
function idle() {
  return new Promise((resolve) => {
    const go = () => {
      if (window.requestIdleCallback) window.requestIdleCallback(() => resolve(), { timeout: 5000 });
      else setTimeout(resolve, 200);
    };
    const body = document.body;
    if (!body.classList.contains('reading')) { go(); return; }
    const watch = new MutationObserver(() => {
      if (body.classList.contains('reading')) return;
      watch.disconnect();
      go();
    });
    watch.observe(body, { attributes: true, attributeFilter: ['class'] });
  });
}

// Lo que ocupa en el servidor el texto de un libro: los trozos más la búsqueda, casi dos veces el
// texto, y algo de cifrado. Basta para no empezar una subida que no cabe.
const estimate = (annotatedText) => Math.ceil(annotatedText.length * 2.2);

// Su fichero se puede bajar del sync para trocearlo (y no falló ya en esta sesión).
const inSync = (b, Blobs) => !unfetchable.has(b.id) && !!(b.blob && b.blob.path) && Blobs.canTransfer();

// Trocea y sube, de uno en uno, cada libro de la biblioteca sin texto actual en el servidor.
// Se para si se apaga el permiso, si no cabe (avisa en Ajustes, no bloquea nada) o ante un error
// de red: el siguiente sync bien acabado lo retoma donde quedó.
export function backfill() {
  if (!enabled()) return Promise.resolve(0);
  if (running) return running;
  running = (async () => {
    const [DB, Store, SegmentFile, Blobs] = await Promise.all([
      import('../ai/db.js'), import('../library/store.js'), import('../ai/segment-file.js'), import('./blobs.js'),
    ]);
    quotaFull = false;
    const remote = await remoteTexts();
    const failed = Storage.get(FAILED_KEY, {}) || {};
    let room = Infinity;
    try {
      const st = await BRAuth.status();
      room = st.quota.data - st.used.data - st.used.versions;
    } catch { /* sin estado, el servidor dirá 'quota' si no cabe */ }
    let n = 0;
    for (const b of await Store.getAllBooks()) {
      if (!enabled()) break;
      if (fresh(remote[b.id], DB.SEG_VERSION) || failed[b.id]?.seg === DB.SEG_VERSION) continue;
      const local = await DB.get('bookText', b.id);
      const ready = !!local && local.segVersion === DB.SEG_VERSION;
      const here = Store.hasFile(b);
      if (!ready && !here && !inSync(b, Blobs)) continue;
      forget(b.id);   // el servidor no lo tiene: lo que diga este equipo ya no vale
      if (!ready) {
        await idle();
        let file = null;
        if (!here) {
          try { file = await Blobs.fetchForText(b); } catch (e) { console.warn('book-text:', e.message); break; }
          if (!file) { unfetchable.add(b.id); progress(); continue; }
        }
        const ok = await SegmentFile.ensureSegmented(b.id, null, { file });
        file = null;   // el fichero bajado no se guarda: solo hacía falta para trocearlo
        if (!ok) { markFailed(b.id, DB.SEG_VERSION, 'parse'); progress(); continue; }
      }
      const text = ready ? local : await DB.get('bookText', b.id);
      if (!text || !text.annotatedText || !text.annotatedText.trim()) { markFailed(b.id, DB.SEG_VERSION, 'empty'); progress(); continue; }
      const size = estimate(text.annotatedText);
      if (size > room) { quotaFull = true; break; }
      try {
        if (await upload(b.id)) { n++; room -= size; }
      } catch (e) {
        if (Provider.isQuotaError(e)) quotaFull = true;
        else console.warn('book-text:', e.message);
        break;
      }
      progress();
    }
    if (!quotaFull && enabled()) {
      try { n += await refreshIndex(DB, Store); } catch (e) {
        if (Provider.isQuotaError(e)) quotaFull = true;
        else console.warn('library-index:', e.message);
      }
    }
    return n;
  })().finally(() => { running = null; progress(); });
  return running;
}

// IA10 F2 · Tras el texto, el índice de la biblioteca (library-index.js): los libros con texto
// al día que aún no están indexados, y fuera los borrados (su índice y su texto).
async function refreshIndex(DB, Store) {
  const indexer = await (await import('./library-index.js')).forApp();
  if (!indexer) return 0;
  const remote = await remoteTexts();
  const records = await Store.getAllRecords();
  const deleted = new Set(records.filter(r => r.deleted).map(r => r.id));
  for (const id of Object.keys(remote)) if (deleted.has(id)) await removeText(id);
  const current = Object.fromEntries(Object.entries(remote).filter(([, r]) => fresh(r, DB.SEG_VERSION)));
  const books = records.filter(r => !r.deleted);
  const n = await indexer.refresh({
    books, remote: current, deleted, stop: () => !enabled(),
    between: async () => { await idle(); progress(); },
  });
  progress();
  return n;
}

// Un libro borrado de la biblioteca: su texto se va del servidor.
async function removeText(bookId) {
  for (const f of await Provider.list(BASE + 'text/' + bookId + '/')) await Provider.remove(f.path).catch(() => {});
  await Provider.remove(pathOf(bookId)).catch(() => {});
  forget(bookId);
}

// Para Ajustes → Datos → Agentes: cuántos libros puede leer un agente y por qué faltan los demás.
// `why`: 'pending' (en cola), 'file' (el fichero no está ni en este equipo ni en el sync), 'parse' (no se pudo
// abrir) o 'empty' (no tiene texto: un PDF escaneado, por ejemplo).
export async function coverage() {
  const [DB, Store, Blobs] = await Promise.all([import('../ai/db.js'), import('../library/store.js'), import('./blobs.js')]);
  const [books, remote] = await Promise.all([Store.getAllBooks(), remoteTexts()]);
  const failed = Storage.get(FAILED_KEY, {}) || {};
  const missing = [];
  let ok = 0;
  for (const b of books) {
    if (fresh(remote[b.id], DB.SEG_VERSION)) { ok++; continue; }
    const f = failed[b.id]?.seg === DB.SEG_VERSION ? failed[b.id].why : null;
    const local = !f && await DB.get('bookText', b.id);
    const why = f || (Store.hasFile(b) || inSync(b, Blobs) || (local && local.segVersion === DB.SEG_VERSION) ? 'pending' : 'file');
    missing.push({ id: b.id, title: b.title || '', why });
  }
  let indexed = 0;
  try {
    const indexer = await (await import('./library-index.js')).forApp();
    if (indexer) {
      const m = await indexer.manifest();
      indexed = books.filter(b => remote[b.id] && m.books[b.id]?.toc === remote[b.id].etag).length;
    }
  } catch { /* sin índice todavía */ }
  return { total: books.length, ok, indexed, missing, quotaFull, running: !!running };
}

export function start() {
  window.addEventListener('bookreader:segmented', (e) => { upload(e.detail.bookId).catch(err => console.warn('book-text:', err.message)); });
  window.addEventListener('bookreader:book-text-wanted', () => { backfill(); });
  // Tras cada ciclo de sync bien acabado (y con él, un token que dice si algún agente lo quiere).
  window.addEventListener('bookreader:sync-status', (e) => { if (e.detail === 'ok') backfill(); });
}
