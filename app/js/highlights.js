import * as Storage from './storage.js';
import { newUid, tombstone, revive } from './sync/schema.js';
import { mergeCollections } from './sync/merge.js';

const HIGHLIGHTS_KEY = 'highlights';
let currentBookId = null;
const onChangeCallbacks = [];

export function setBook(bookId) {
  currentBookId = bookId;
}

// Unifica la identidad del libro: fusiona los subrayados guardados bajo ids ANTIGUOS (el
// nombre del fichero, o el book.key() de epub.js de versiones viejas) en el id canónico
// `newId` (hash del contenido, el mismo que usan biblioteca/agente/sync), sin duplicar (merge
// por uid) y borrando las claves viejas. Idempotente; corre al abrir cada libro. Devuelve
// cuántos items se fusionaron.
export function migrateBook(oldIds, newId) {
  if (!newId) return 0;
  let moved = 0;
  for (const oldId of oldIds || []) {
    if (!oldId || oldId === newId) continue;
    const oldKey = HIGHLIGHTS_KEY + '_' + oldId;
    const old = Storage.get(oldKey, null);
    if (!Array.isArray(old)) continue;
    if (old.length) {
      // Backfill de uid antes de fusionar: mergeCollections descarta items sin uid, y los datos
      // viejos (o importados) pueden no tenerlo aún. uid = cfi (estable) | id previo | UUID.
      const withUid = old.map(it => (it && it.uid) ? it : { ...it, uid: (it && (it.cfi || it.id)) || newUid() });
      const targetKey = HIGHLIGHTS_KEY + '_' + newId;
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
  return HIGHLIGHTS_KEY + '_' + currentBookId;
}

// Lista cruda, tombstones incluidos. Los mutadores operan SIEMPRE sobre esta
// (si trabajaran sobre la filtrada, cada guardado purgaría los tombstones).
// El sync y el backup también la necesitan para propagar borrados.
export function getAllRaw() {
  return Storage.get(getKey(), []);
}

// Solo los subrayados vivos: lo que consume la UI y el export.
export function getAll() {
  return getAllRaw().filter(h => !h.deleted);
}

export function add(cfi, text, color, chapter, note = '') {
  const highlights = getAllRaw();
  const existing = highlights.find(h => h.cfi === cfi);
  const now = Date.now();
  if (existing) {
    // Mismo pasaje: actualiza color y nota en vez de duplicar. Si estaba
    // borrado, re-subrayarlo lo resucita conservando el uid (CFI).
    existing.color = color || existing.color;
    if (note) existing.note = note;
    if (existing.deleted) revive(existing, now);
    existing.updatedAt = now;
    Storage.set(getKey(), highlights);
    if (onChangeCallback) onChangeCallback();
    return true;
  }
  highlights.push({
    uid: cfi,                // identidad global: mismo pasaje → mismo uid en todo dispositivo
    id: cfi,                 // en EPUB el propio CFI es la identidad
    cfi,
    text: text || '',
    color: color || '#ffeb3b',
    chapter: chapter || '',
    note: note || '',
    timestamp: now,
    updatedAt: now
  });
  Storage.set(getKey(), highlights);
  if (onChangeCallback) onChangeCallback();
  return true;
}

// PDF3 · Subrayado de PDF. El ancla es {page, rects}, donde rects son rectángulos en
// coordenadas FRACCIONALES (0..1) de la página, para re-pintarse nítido a cualquier
// escala/HiDPI. No hay CFI. Identidad = id generado.
export function addPdf(page, rects, text, color, chapter, note = '') {
  const highlights = getAllRaw();
  const id = 'pdf-' + page + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const now = Date.now();
  highlights.push({
    uid: newUid(),           // en PDF no hay clave natural → UUID
    id,
    page,
    rects: rects || [],
    text: text || '',
    color: color || '#ffeb3b',
    chapter: chapter || `Pág. ${page}`,
    note: note || '',
    timestamp: now,
    updatedAt: now
  });
  Storage.set(getKey(), highlights);
  if (onChangeCallback) onChangeCallback();
  return id;
}

// Subrayados de una página concreta (para pintar el overlay al renderizarla).
export function getByPage(page) {
  return getAll().filter(h => h.page === page);
}

// Borra por identidad genérica (id de PDF o CFI de EPUB). Deja tombstone para
// que el borrado se propague en el sync en vez de resucitar en la unión.
export function removeById(id) {
  const highlights = getAllRaw();
  const h = highlights.find(x => !x.deleted && (x.id ?? x.cfi) === id);
  if (!h) return;
  tombstone(h);
  Storage.set(getKey(), highlights);
  if (onChangeCallback) onChangeCallback();
}

export function setNote(cfi, note) {
  const highlights = getAllRaw();
  const h = highlights.find(x => !x.deleted && x.cfi === cfi);
  if (!h) return false;
  h.note = note;
  h.updatedAt = Date.now();
  Storage.set(getKey(), highlights);
  if (onChangeCallback) onChangeCallback();
  return true;
}

export function remove(cfi) {
  const highlights = getAllRaw();
  const h = highlights.find(x => !x.deleted && x.cfi === cfi);
  if (!h) return;
  tombstone(h);
  Storage.set(getKey(), highlights);
  if (onChangeCallback) onChangeCallback();
}

export function getByCfi(cfi) {
  return getAll().find(h => h.cfi === cfi);
}

export function exportJSON(bookTitle) {
  const highlights = getAll();
  if (highlights.length === 0) return null;

  const data = {
    book: bookTitle || 'Sin título',
    bookId: currentBookId,
    exportedAt: new Date().toISOString(),
    count: highlights.length,
    highlights: highlights.map(h => ({
      text: h.text,
      color: h.color,
      note: h.note || null,
      chapter: h.chapter || null,
      page: h.page || null,
      cfi: h.cfi || null,
      timestamp: h.timestamp
    }))
  };

  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  const safeTitle = (bookTitle || 'book').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
  const date = new Date().toISOString().split('T')[0];
  a.href = url;
  a.download = `bookreader-highlights-${safeTitle}-${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return data;
}
