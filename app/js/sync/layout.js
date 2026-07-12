// Layout por-libro en el proveedor (SYNC_PLAN.md · "Layout en el proveedor"):
//
//   bookreader/manifest.json      índice { schemaVersion, books: { id: {file, title, updatedAt} } }
//   bookreader/settings.json      ajustes globales + plantillas propias
//   bookreader/books/<id>.json    subrayados, marcadores, posición, convos, mensajes, notas, ratings
//
// Un blob único global es lo que hace mal arete (todo o nada, pisa cambios).
// Particionar por libro aísla los conflictos y evita re-subir lo que no cambió.

import * as Storage from '../storage.js';
import * as DB from '../ai/db.js';

export const SCHEMA_VERSION = 1;
export const BASE = 'bookreader/';

// Claves de localStorage particionadas por libro: `<prefijo>_<bookId>`.
const BOOK_PREFIXES = ['highlights', 'bookmarks', 'lastPosition', 'pdfLastPage', 'readingMode', 'pdfMode'];
// Secretos que jamás salen del dispositivo (mismo criterio que backup.js).
const SECRET_KEYS = ['ai_key', 'drive_refresh_token'];
// Estado puramente local, sin sentido en otro dispositivo.
const SKIP_KEYS = ['sync_schema_migrated'];

function splitKey(key) {
  for (const p of BOOK_PREFIXES) {
    if (key.startsWith(p + '_')) return { prefix: p, bookId: key.slice(p.length + 1) };
  }
  return null;
}

function maxUpdatedAt(...lists) {
  let max = 0;
  for (const list of lists) {
    for (const it of list || []) if ((it.updatedAt || 0) > max) max = it.updatedAt;
  }
  return max;
}

// Estado local completo, particionado: { manifest, settings, books: { id: data } }.
// Los arrays de highlights/bookmarks van CRUDOS (con tombstones): el borrado
// también debe viajar.
export async function buildSnapshot() {
  const settings = {};
  const books = {};
  const bookOf = (id) => (books[id] = books[id] || { local: {}, convos: [], messages: [], notes: [], ratings: [], meta: null });

  for (const [key, value] of Object.entries(Storage.getAll(''))) {
    if (SECRET_KEYS.includes(key) || SKIP_KEYS.includes(key)) continue;
    const bk = splitKey(key);
    if (bk) bookOf(bk.bookId).local[key] = value;
    else settings[key] = value;
  }

  const [convos, messages, notes, ratings, meta] = await Promise.all([
    DB.getAll('convos'), DB.getAll('messages'), DB.getAll('notes'), DB.getAll('ratings'), DB.getAll('books'),
  ]);
  const convoBook = Object.fromEntries((convos || []).map(c => [c.id, c.bookId]));
  for (const c of convos || []) if (c.bookId) bookOf(c.bookId).convos.push(c);
  for (const m of messages || []) {
    const b = m.bookId || convoBook[m.convoId];
    if (b) bookOf(b).messages.push(m);
  }
  for (const n of notes || []) {
    const b = n.bookId || convoBook[n.convoId];
    if (b) bookOf(b).notes.push(n);
  }
  // ratings: keyPath `bookId` pero la clave real hoy es el convoId (ver db.js).
  for (const r of ratings || []) {
    const b = convoBook[r.bookId] || (books[r.bookId] ? r.bookId : null);
    if (b) bookOf(b).ratings.push(r);
  }
  const titles = {};
  for (const b of meta || []) {
    titles[b.id] = b.title;
    if (books[b.id]) books[b.id].meta = b;
  }

  const now = Date.now();
  const manifest = { schemaVersion: SCHEMA_VERSION, updatedAt: now, settingsUpdatedAt: now, books: {} };
  for (const [id, b] of Object.entries(books)) {
    manifest.books[id] = {
      file: 'books/' + id + '.json',
      title: titles[id] || null,
      updatedAt: maxUpdatedAt(b.local['highlights_' + id], b.local['bookmarks_' + id], b.messages, b.notes) || now,
    };
  }
  return { manifest, settings, books };
}

// Aplica un snapshot remoto encima del estado local. Fusiona clave a clave
// (sobrescribe lo que coincide, no borra el resto) — misma semántica que el
// import de backup. El merge fino por item llega con el SyncEngine (Fase 2).
export async function restoreSnapshot({ settings = {}, books = {} }) {
  let keys = 0;
  let records = 0;
  for (const [k, v] of Object.entries(settings)) {
    if (SECRET_KEYS.includes(k) || SKIP_KEYS.includes(k)) continue;
    Storage.set(k, v);
    keys++;
  }
  for (const b of Object.values(books)) {
    for (const [k, v] of Object.entries(b.local || {})) {
      Storage.set(k, v);
      keys++;
    }
    for (const c of b.convos || []) { await DB.put('convos', c); records++; }
    for (const m of b.messages || []) { await DB.put('messages', m); records++; }
    for (const n of b.notes || []) { await DB.put('notes', n); records++; }
    for (const r of b.ratings || []) { await DB.put('ratings', r); records++; }
    if (b.meta) { await DB.put('books', b.meta); records++; }
  }
  return { keys, records };
}
