// Fase 3 · Recuperación de versiones anteriores (red de seguridad del sync).
//
// Drive conserva revisiones de cada fichero. Como los datos se particionan por
// libro (books/<id>.json), la recuperación es POR LIBRO: el usuario ve las
// versiones de un libro, las identifica por fecha + resumen, y restaura una.
//
// Semántica de "restaurar versión" (recovery, no reversión ciega): se re-afirman
// los items VIVOS de esa versión — updatedAt = ahora y sin tombstone — y se
// fusionan con lo local. Así se recupera lo que se borró o se perdió después de
// esa fecha, ganan el próximo sync (se propagan a los otros dispositivos) y se
// conserva lo que hayas añadido desde entonces. Reversible: puedes volver a
// borrar lo recuperado.

import * as Drive from './drive-provider.js';
import * as Storage from '../storage.js';
import * as DB from '../ai/db.js';
import { mergeCollections } from './merge.js';
import { BASE } from './layout.js';

const bookPath = (id) => BASE + 'books/' + id + '.json';
const MERGE_PREFIXES = ['highlights_', 'bookmarks_'];

// Libros con datos en Drive (título + id), leído del manifest.
export async function listBooks() {
  const m = await Drive.read(BASE + 'manifest.json');
  if (!m) return [];
  const manifest = JSON.parse(m.content);
  // title = null cuando el manifest no lo trae (libros que solo tienen subrayados/marcadores,
  // keyed por book.key() de epub.js, sin metadatos de título). La vista los marca "sin título"
  // en vez de mostrar el id crudo. Los identificables van primero.
  return Object.entries(manifest.books || {})
    .map(([id, info]) => ({ id, title: info.title || null, updatedAt: info.updatedAt || 0 }))
    .sort((a, b) => (b.title ? 1 : 0) - (a.title ? 1 : 0) || b.updatedAt - a.updatedAt);
}

// Versiones de un libro, más recientes primero.
export async function listVersions(bookId) {
  const r = await Drive.listRevisions(bookPath(bookId));
  if (!r) return [];
  return r.revisions
    .map(v => ({ id: v.id, fileId: r.fileId, modifiedTime: v.modifiedTime, size: Number(v.size) || 0 }))
    .sort((a, b) => new Date(b.modifiedTime).getTime() - new Date(a.modifiedTime).getTime());
}

function countAlive(book) {
  const local = book.local || {};
  const arrOf = (prefix) => {
    const key = Object.keys(local).find(k => k.startsWith(prefix));
    return (key ? local[key] : []) || [];
  };
  return {
    highlights: arrOf('highlights_').filter(i => !i.deleted).length,
    bookmarks: arrOf('bookmarks_').filter(i => !i.deleted).length,
    notes: (book.notes || []).filter(i => !i.deleted).length,
    messages: (book.messages || []).filter(i => !i.deleted).length,
  };
}

// Resumen de una versión sin aplicarla (para identificar cuál restaurar).
export async function previewVersion(fileId, revisionId) {
  const text = await Drive.readRevision(fileId, revisionId);
  return countAlive(JSON.parse(text));
}

// Re-afirma un item: copia sin tombstone y con updatedAt actual (gana el merge).
function reassert(item, now) {
  const copy = { ...item, updatedAt: now };
  delete copy.deleted;
  delete copy.deletedAt;
  return copy;
}

export async function restoreVersion(bookId, fileId, revisionId) {
  const text = await Drive.readRevision(fileId, revisionId);
  const book = JSON.parse(text);
  const now = Date.now();
  let recovered = 0;

  for (const [key, arr] of Object.entries(book.local || {})) {
    if (!MERGE_PREFIXES.some(p => key.startsWith(p)) || !Array.isArray(arr)) continue;
    const revived = arr.filter(i => !i.deleted).map(i => reassert(i, now));
    if (!revived.length) continue;
    Storage.set(key, mergeCollections(Storage.get(key, []), revived));
    recovered += revived.length;
  }
  for (const store of ['notes', 'messages']) {
    const items = (book[store] || []).filter(i => !i.deleted).map(i => reassert(i, now));
    recovered += await DB.mergeRecords(store, items);
  }
  return { recovered };
}
