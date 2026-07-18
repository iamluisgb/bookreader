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
import * as LibStore from '../library/store.js';
import { mergeCollections } from './merge.js';

export const SCHEMA_VERSION = 1;
export const BASE = 'bookreader/';

// Claves de localStorage particionadas por libro: `<prefijo>_<bookId>`.
// lastPositionAt/pdfLastPageAt son los sellos de tiempo de la posición de
// lectura (escalares LWW): viajan junto a su valor.
const BOOK_PREFIXES = ['highlights', 'bookmarks', 'lastPosition', 'lastPositionAt', 'pdfLastPage', 'pdfLastPageAt', 'readingMode', 'pdfMode'];
// Pareja valor → sello de tiempo, para el LWW de escalares.
const SCALAR_AT = { lastPosition: 'lastPositionAt', pdfLastPage: 'pdfLastPageAt' };
const AT_PREFIXES = Object.values(SCALAR_AT);
// Secretos que jamás salen del dispositivo (mismo criterio que backup.js).
const SECRET_KEYS = ['ai_key', 'drive_refresh_token'];
// Estado puramente local, sin sentido en otro dispositivo.
const SKIP_KEYS = ['sync_schema_migrated', 'sync_state'];

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
  // Título de cada libro para el manifest. Fuente principal: la BIBLIOTECA
  // (siempre tiene título al importar). El meta del agente (ai/db.js) solo existe
  // si el libro se segmentó para IA, así que como ÚNICA fuente dejaba title:null
  // en libros solo-subrayados → el otro dispositivo no podía reconciliar
  // identidad (mismo libro, distinto hash) y los subrayados no se cruzaban.
  const titles = {};
  try {
    for (const b of (await LibStore.getAllBooks()) || []) if (b && b.id && b.title) titles[b.id] = b.title;
  } catch (e) { /* IDB no disponible */ }
  for (const b of meta || []) {
    if (b.title) titles[b.id] = b.title;
    if (books[b.id]) books[b.id].meta = b;
  }

  const now = Date.now();
  const manifest = { schemaVersion: SCHEMA_VERSION, updatedAt: now, settingsUpdatedAt: now, books: {} };
  for (const [id, b] of Object.entries(books)) {
    // La posición de lectura también cuenta como "cambio" del libro (sus sellos *At).
    const positionStamps = Object.entries(b.local)
      .filter(([k]) => AT_PREFIXES.some(p => k.startsWith(p + '_')))
      .map(([, at]) => ({ updatedAt: at }));
    manifest.books[id] = {
      file: 'books/' + id + '.json',
      title: titles[id] || null,
      updatedAt: maxUpdatedAt(b.local['highlights_' + id], b.local['bookmarks_' + id], b.messages, b.notes, positionStamps) || now,
    };
  }
  return { manifest, settings, books };
}

// Colecciones por-item dentro de las claves por-libro: se fusionan con
// mergeCollections; los escalares dependen del modo (ver restoreSnapshot).
const MERGE_PREFIXES = ['highlights_', 'bookmarks_'];

// Aplica las claves por-libro de un snapshot remoto.
//   - Colecciones: siempre mergeCollections (unión por uid + LWW + tombstones).
//   - Posición de lectura (valor + sello *At): LWW por sello; en modo 'restore'
//     gana remoto aunque el sello local sea más nuevo (es la orden explícita).
//   - Escalares sin sello (readingMode/pdfMode): 'restore' → remoto;
//     'merge' (sync automático) → solo si falta en local (no pisar al usuario).
function applyBookLocal(local, mode) {
  let keys = 0;
  for (const [k, v] of Object.entries(local || {})) {
    const bk = splitKey(k);
    if (MERGE_PREFIXES.some(p => k.startsWith(p)) && Array.isArray(v)) {
      Storage.set(k, mergeCollections(Storage.get(k, []), v));
      keys++;
      continue;
    }
    if (bk && AT_PREFIXES.includes(bk.prefix)) continue; // los sellos van con su valor
    if (bk && SCALAR_AT[bk.prefix]) {
      const atKey = SCALAR_AT[bk.prefix] + '_' + bk.bookId;
      const remoteAt = local[atKey] || 0;
      const localAt = Storage.get(atKey, 0);
      if (mode === 'restore' || remoteAt > localAt) {
        Storage.set(k, v);
        Storage.set(atKey, remoteAt || Date.now());
        keys++;
      }
      continue;
    }
    if (mode === 'restore' || Storage.get(k, null) === null) {
      Storage.set(k, v);
      keys++;
    }
  }
  return keys;
}

// Aplica un snapshot remoto FUSIONANDO con lo local (Fase 2 · merge):
//   - subrayados/marcadores: unión por uid, LWW por item, tombstones se propagan
//   - mensajes/notas (IDB): casan por uid conservando el id local (el id
//     autoincremental colisiona entre dispositivos y jamás se importa crudo)
//   - convos: unión por id global; gana el lastUsedAt mayor
//   - escalares: según mode ('restore' explícito | 'merge' del sync automático)
// Nunca borra datos locales que el remoto no conozca.
export async function restoreSnapshot({ settings = {}, books = {} }, { mode = 'restore' } = {}) {
  let keys = 0;
  let records = 0;
  for (const [k, v] of Object.entries(settings)) {
    if (SECRET_KEYS.includes(k) || SKIP_KEYS.includes(k)) continue;
    if (mode === 'restore' || Storage.get(k, null) === null) {
      Storage.set(k, v);
      keys++;
    }
  }
  for (const b of Object.values(books)) {
    keys += applyBookLocal(b.local, mode);
    for (const c of b.convos || []) {
      const cur = await DB.get('convos', c.id);
      if (!cur || (c.lastUsedAt || 0) > (cur.lastUsedAt || 0)) {
        await DB.put('convos', { ...cur, ...c });
        records++;
      }
    }
    records += await DB.mergeRecords('messages', b.messages);
    records += await DB.mergeRecords('notes', b.notes);
    for (const r of b.ratings || []) { await DB.put('ratings', r); records++; }
    if (b.meta) { await DB.put('books', b.meta); records++; }
  }
  return { keys, records };
}
