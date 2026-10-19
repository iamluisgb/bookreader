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
// sync de BookReader activo. Un libro sin trocear aún no tiene texto: se sube en cuanto se
// trocea (al usar el agente, la búsqueda o el estudio en él). El motor de sync no lo baja nunca
// (solo mira books/): es un fichero para agentes, no para dispositivos.

import * as Provider from './provider.js';
import * as BRAuth from './bookreader-auth.js';
import * as Storage from '../storage.js';
import { BASE } from './layout.js';
import { buildTextFiles, TEXT_FORMAT } from './book-text-build.js';

const STATE_KEY = 'sync_text_state';   // { [bookId]: huella del texto ya subido } (solo local)
let running = null;

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
export async function upload(bookId) {
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

// Todo lo ya troceado en este dispositivo que aún no esté subido, de uno en uno.
export function backfill() {
  if (!enabled()) return Promise.resolve(0);
  if (running) return running;
  running = (async () => {
    const DB = await import('../ai/db.js');
    const all = await DB.getAll('bookText');
    let n = 0;
    for (const t of all || []) {
      try { if (await upload(t.bookId)) n++; } catch (e) { console.warn('book-text:', e.message); break; }
    }
    return n;
  })().finally(() => { running = null; });
  return running;
}

export function start() {
  window.addEventListener('bookreader:segmented', (e) => { upload(e.detail.bookId).catch(err => console.warn('book-text:', err.message)); });
  window.addEventListener('bookreader:book-text-wanted', () => { backfill(); });
  // Tras cada ciclo de sync bien acabado (y con él, un token que dice si algún agente lo quiere).
  window.addEventListener('bookreader:sync-status', (e) => { if (e.detail === 'ok') backfill(); });
}
