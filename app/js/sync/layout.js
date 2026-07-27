// Layout por-libro en el proveedor (SYNC_PLAN.md · "Layout en el proveedor"):
//
//   bookreader/manifest.json      índice { schemaVersion, books: { id: {file, title, updatedAt} } }
//   bookreader/settings.json      ajustes globales + plantillas propias
//   bookreader/books/<id>.json    subrayados, marcadores, posición, convos, mensajes, notas,
//                                 ratings, artefactos del Studio (resúmenes / mapas mentales)
//                                 y mazos de flashcards con su estado de repaso
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

// Serialización con claves ordenadas (la usan el digest de aquí y las huellas del
// engine): con JSON.stringify normal, dos objetos idénticos con las claves en distinto
// orden dan huellas distintas → push infinito entre dispositivos.
export function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

// Huella del CONTENIDO FUSIONABLE de un libro, para responder a "¿tengo algo que el
// remoto no tenga?" cuando los sellos de tiempo no bastan.
//
// Hace falta porque el push se decide por `updatedAt`, y tras fusionar, el updatedAt
// local pasa a ser el del remoto: lo que este dispositivo hizo ANTES (repasar en el
// bus mientras el otro editaba) queda por debajo del umbral y no se sube jamás.
//
// Es determinista entre dispositivos: se ordenan los items (el merge los deja en
// distinto orden en cada lado) y se ignora todo lo que es local por naturaleza —
// el `id` autoincremental, que colisiona, y los escalares (posición, modo de lectura),
// que no se fusionan por unión y harían rebotar el push para siempre.
const DIGEST_STORES = ['convos', 'messages', 'notes', 'ratings', 'artifacts', 'decks'];
// Stores con id autoincremental: el id NO viaja (es local) y un registro sin uid no es
// mergeable, así que el otro dispositivo nunca lo aceptará. Contar cualquiera de las dos
// cosas dejaría el digest permanentemente distinto en los dos lados → push en bucle.
const LOCAL_ID_STORES = new Set(['messages', 'notes', 'decks']);

function digestItem(store, it) {
  if (LOCAL_ID_STORES.has(store)) {
    if (!it.uid) return null;
    const { id, cards, ...rest } = it;
    // Las tarjetas se fusionan por su cuenta y cada dispositivo puede acabar con el
    // mismo conjunto en distinto ORDEN; se ordenan para que el digest no lo note.
    if (!cards) return stable(rest);
    return stable(rest) + '#' + (cards || []).map(stable).sort().join(',');
  }
  return stable(it);
}

export function bookDigest(book) {
  if (!book) return '0';
  const parts = [];
  for (const store of DIGEST_STORES) {
    for (const it of book[store] || []) {
      if (!it) continue;
      const d = digestItem(store, it);
      if (d) parts.push(d);
    }
  }
  for (const [k, v] of Object.entries(book.local || {})) {
    if (!MERGE_PREFIXES.some(p => k.startsWith(p)) || !Array.isArray(v)) continue;
    for (const it of v) if (it && it.uid) parts.push(stable(it));
  }
  parts.sort();
  const s = parts.join('|');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0) + ':' + parts.length;
}

// Racha de estudio ({count, lastDay}): gana el día mayor; en empate, el contador mayor
// (repasar en dos dispositivos el mismo día no debe partir la racha). Devuelve null si
// lo local ya es igual o mejor, para no escribir de más.
const STREAK_KEY = 'study_streak';
export function mergeStreak(local, remote) {
  if (!remote || !remote.lastDay) return null;
  if (!local || !local.lastDay) return remote;
  if (remote.lastDay > local.lastDay) return remote;
  if (remote.lastDay === local.lastDay && (remote.count || 0) > (local.count || 0)) return remote;
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
  const bookOf = (id) => (books[id] = books[id] || { local: {}, convos: [], messages: [], notes: [], ratings: [], artifacts: [], decks: [], meta: null });

  for (const [key, value] of Object.entries(Storage.getAll(''))) {
    if (SECRET_KEYS.includes(key) || SKIP_KEYS.includes(key)) continue;
    const bk = splitKey(key);
    if (bk) bookOf(bk.bookId).local[key] = value;
    else settings[key] = value;
  }

  const [convos, messages, notes, ratings, artifacts, decks, meta] = await Promise.all([
    DB.getAll('convos'), DB.getAll('messages'), DB.getAll('notes'), DB.getAll('ratings'),
    DB.getAll('artifacts'), DB.getAll('decks'), DB.getAll('books'),
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
  // Artefactos del Studio (resúmenes, mapas mentales): generarlos cuesta llamadas al
  // modelo, así que NO tenerlos aquí significaba pagarlos dos veces al cambiar de
  // dispositivo. Viajan crudos, con sus tombstones (el borrado también se propaga).
  for (const a of artifacts || []) if (a.bookId) bookOf(a.bookId).artifacts.push(a);
  // Mazos de flashcards: se leen en un sitio y se repasan en otro (el caso real es
  // preparar el libro en el PC y estudiar en el móvil). Viajan CRUDOS, con el estado
  // de repaso dentro de cada tarjeta y con los tombstones de mazo y de tarjeta.
  for (const d of decks || []) if (d.bookId) bookOf(d.bookId).decks.push(d);
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
      updatedAt: maxUpdatedAt(b.local['highlights_' + id], b.local['bookmarks_' + id], b.messages, b.notes, b.artifacts, b.decks, positionStamps) || now,
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
    // La racha de estudio no es una preferencia: es un contador que avanza en el
    // dispositivo donde repasas. Con la regla general ("solo si falta en local") el PC
    // se quedaría clavado mientras estudias en el móvil, que es el uso previsto.
    if (k === STREAK_KEY) {
      const merged = mergeStreak(Storage.get(k, null), v);
      if (merged) { Storage.set(k, merged); keys++; }
      continue;
    }
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
    // Artefactos: merge por `key` (ya global), no por uid — ver mergeArtifacts.
    records += await DB.mergeArtifacts(b.artifacts);
    // Mazos: casan por uid como messages/notes, pero sus TARJETAS se fusionan una a una
    // (el estado de repaso vive dentro) — ver mergeDecks.
    records += await DB.mergeDecks(b.decks);
    for (const r of b.ratings || []) { await DB.put('ratings', r); records++; }
    if (b.meta) { await DB.put('books', b.meta); records++; }
  }
  return { keys, records };
}
