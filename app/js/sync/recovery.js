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

// Título de display: los libros bajados de z-library traen sufijos-basura de dominio
// —"(z-library.sk, 1lib.sk, z-lib.sk)", "(z-lib.org)", "(Anna's Archive)"— que ensucian
// la lista de recuperación. Quita SOLO los paréntesis que contengan esos marcadores de
// mirror/dominio; conserva el paréntesis de autores. Pura e idempotente.
const NOISE_PAREN = /\s*\([^()]*(?:z-?lib(?:rary)?|1lib|libgen|anna'?s?[- ]?archive|\.(?:sk|org|se|st|is|gs|li|fun))[^()]*\)/gi;
export function cleanTitle(raw) {
  if (!raw) return '';
  return String(raw).replace(NOISE_PAREN, '').replace(/\s+/g, ' ').trim();
}

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

// Un id canónico de libro es el hash SHA-256 (64 hex) del contenido. Todo lo demás
// (`epubjs:0.3:…` de epub.js, nombres de fichero) son ids de esquemas de identidad viejos.
const isCanonicalId = (id) => /^[0-9a-f]{64}$/i.test(id);

// Purga de mantenimiento: elimina de Drive (manifest + fichero de libro) y de localStorage las
// entradas de "libro" bajo ids NO canónicos —restos de esquemas viejos (epubjs:…, nombre de
// fichero) que ensucian Recuperación con "Sin título". NO toca los ids hash (canónicos: podrían
// ser datos reales de otro dispositivo). Destructivo: pierde subrayados/marcadores viejos que
// nunca se migraron y colgaran de esos ids. Devuelve cuántas entradas se quitaron.
export async function purgeOrphans() {
  const m = await Drive.read(BASE + 'manifest.json');
  const manifest = m ? JSON.parse(m.content) : { books: {} };
  const remoteOrphans = Object.keys(manifest.books || {}).filter(id => !isCanonicalId(id));

  // Reúne también las claves locales huérfanas (aunque no estén en el manifest remoto).
  const ids = new Set(remoteOrphans);
  for (const key of Object.keys(Storage.getAll(''))) {
    const mk = key.match(/^(?:highlights|bookmarks)_(.+)$/);
    if (mk && !isCanonicalId(mk[1])) ids.add(mk[1]);
  }

  // 1) Borra las claves locales para que buildSnapshot no las vuelva a subir.
  for (const id of ids) { Storage.remove('highlights_' + id); Storage.remove('bookmarks_' + id); }

  // 2) Borra de Drive los ficheros de libro huérfanos y quítalos del manifest.
  for (const id of remoteOrphans) {
    try { await Drive.remove(bookPath(id)); } catch { /* puede no existir ya */ }
    delete manifest.books[id];
  }

  // 3) Reescribe el manifest sin los huérfanos (ifMatch: si un sync escribió en medio, falla y se
  //    reintenta en vez de pisarlo).
  if (m && remoteOrphans.length) {
    await Drive.write(BASE + 'manifest.json', JSON.stringify(manifest), { ifMatch: m.etag });
  }
  return { removed: ids.size, ids: [...ids] };
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
