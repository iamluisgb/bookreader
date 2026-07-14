import * as Storage from './storage.js';
import { newUid, tombstone, revive } from './sync/schema.js';
import { mergeCollections } from './sync/merge.js';

const BOOKMARKS_KEY = 'bookmarks';
let currentBookId = null;
const onChangeCallbacks = [];

export function setBook(bookId) {
  currentBookId = bookId;
}

// Unifica la identidad del libro: fusiona los marcadores guardados bajo ids ANTIGUOS (nombre
// de fichero / book.key() de epub.js) en el id canónico `newId` (hash), sin duplicar (merge
// por uid) y borrando las claves viejas. Idempotente; corre al abrir cada libro.
export function migrateBook(oldIds, newId) {
  if (!newId) return 0;
  let moved = 0;
  for (const oldId of oldIds || []) {
    if (!oldId || oldId === newId) continue;
    const oldKey = BOOKMARKS_KEY + '_' + oldId;
    const old = Storage.get(oldKey, null);
    if (!Array.isArray(old)) continue;
    if (old.length) {
      // Backfill de uid antes de fusionar (mergeCollections descarta los que no lo tengan).
      const withUid = old.map(it => (it && it.uid) ? it : { ...it, uid: (it && (it.cfi || it.id)) || newUid() });
      const targetKey = BOOKMARKS_KEY + '_' + newId;
      Storage.set(targetKey, mergeCollections(Storage.get(targetKey, []), withUid));
      moved += old.length;
    }
    Storage.remove(oldKey);
  }
  return moved;
}

// Aditivo: la UI y el SyncEngine registran cada uno el suyo.
export function setOnChange(cb) {
  onChangeCallbacks.push(cb);
}

function onChangeCallback() {
  for (const cb of onChangeCallbacks) cb();
}

function getKey() {
  return BOOKMARKS_KEY + '_' + currentBookId;
}

// Lista cruda, tombstones incluidos: para mutadores, sync y backup.
export function getAllRaw() {
  return Storage.get(getKey(), []);
}

// Solo los marcadores vivos: lo que consume la UI.
export function getAll() {
  return getAllRaw().filter(b => !b.deleted);
}

export function add(cfi, title, chapter, page) {
  const bookmarks = getAllRaw();
  const existing = bookmarks.find(b => b.cfi === cfi);
  const now = Date.now();
  if (existing) {
    if (!existing.deleted) return false;
    // Re-marcar una posición borrada la resucita conservando el uid (CFI).
    revive(existing, now);
    Storage.set(getKey(), bookmarks);
    if (onChangeCallback) onChangeCallback();
    return true;
  }
  bookmarks.push({
    uid: cfi,                // identidad global: misma posición → mismo uid en todo dispositivo
    cfi,
    title: title || '',
    chapter: chapter || '',
    page: page && page.page ? page.page : null,
    total: page && page.total ? page.total : null,
    timestamp: now,
    updatedAt: now
  });
  Storage.set(getKey(), bookmarks);
  if (onChangeCallback) onChangeCallback();
  return true;
}

// Deja tombstone en vez de filtrar: el borrado se propaga en el sync.
export function remove(cfi) {
  const bookmarks = getAllRaw();
  const b = bookmarks.find(x => !x.deleted && x.cfi === cfi);
  if (!b) return;
  tombstone(b);
  Storage.set(getKey(), bookmarks);
  if (onChangeCallback) onChangeCallback();
}

export function has(cfi) {
  return getAll().some(b => b.cfi === cfi);
}

export function toggle(cfi, title, chapter, page) {
  if (has(cfi)) {
    remove(cfi);
    return false;
  } else {
    add(cfi, title, chapter, page);
    return true;
  }
}
