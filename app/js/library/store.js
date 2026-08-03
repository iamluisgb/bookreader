// Biblioteca persistente: guarda el ARCHIVO completo de cada libro junto a sus
// metadatos (portada, progreso, estado) y las estanterías del usuario. El `id`
// es el mismo hash SHA-256 que usa la capa de IA, así las sesiones/notas/
// subrayados de un libro siguen enlazadas al reabrirlo.
//
// Stores:
//   books   (keyPath id)  -> { id, title, author, format, cover (dataURL),
//                              file (ArrayBuffer|null), size, addedAt, lastOpenedAt,
//                              progress (0..100), lastCfi, status, shelfIds: [],
//                              blob, updatedAt, deleted, deletedAt }
//   shelves (keyPath id)  -> { id, name, order, rule, createdAt, updatedAt, deleted, deletedAt }
//
// Una estantería con `rule` es INTELIGENTE: no guarda miembros, los calcula
// (library/shelves.js). `order` coloca la fila entre sus hermanas del rail y la
// jerarquía sale del propio `name` ("Técnico/ML"): no hay `parentId`, y por eso
// no hay ciclos que reparar tras un merge. El porqué, en shelves.js.
//
// Sync de biblioteca (Fase A): los metadatos viajan entre dispositivos, el
// fichero no necesariamente. De ahí tres cambios sobre el modelo original:
//
//   `file` puede faltar → FICHA FANTASMA: el libro existe en tu biblioteca (lo
//   importaste en otro dispositivo) pero su binario no está aquí. Se descarga
//   bajo demanda (sync/blobs.js). `hasFile()` distingue los dos casos.
//
//   `deleted`/`deletedAt` → tombstone en vez de borrado físico. Sin él, borrar
//   un libro en un dispositivo no se propagaba: el siguiente sync se lo volvía
//   a bajar del remoto (donde seguía vivo) y el libro "resucitaba".
//
//   `updatedAt` → LWW por registro en el merge. Solo lo bumpean los campos
//   SINCRONIZABLES: `lastOpenedAt` o tener o no el fichero descargado son
//   decisiones de ESTE dispositivo y no deben provocar tráfico ni ganar merges.

import * as Shelves from './shelves.js';

const DB_NAME = 'bookreader_library';
const DB_VERSION = 1;

// Campos que viajan en library.json. Un cambio en cualquiera de ellos bumpea
// `updatedAt`; un cambio en el resto (lastOpenedAt, lastCfi, file…) no.
const SYNCED_FIELDS = ['title', 'author', 'format', 'fileName', 'fileBaseId', 'size',
  'addedAt', 'status', 'progress', 'shelfIds', 'blob', 'deleted', 'deletedAt'];

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books'))   db.createObjectStore('books',   { keyPath: 'id' });
      if (!db.objectStoreNames.contains('shelves')) db.createObjectStore('shelves', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; }).catch(reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const reqP = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

// ---- Libros ----------------------------------------------------------------

// ¿El binario está en ESTE dispositivo? Un registro sin `file` es una ficha
// fantasma: se ve en la rejilla, pero hay que descargarlo para leerlo.
// Los registros que vienen de getAllBooks/getAllRecords traen `hasLocalFile` en
// vez del binario (ver más abajo), y ambos casos se responden igual.
export function hasFile(record) {
  if (!record) return false;
  if (typeof record.hasLocalFile === 'boolean') return record.hasLocalFile;
  return !!(record.file && (record.file.byteLength || record.file.size));
}

export function isGhost(record) {
  return !!record && !record.deleted && !hasFile(record);
}

// Registro COMPLETO (con el binario), tombstones incluidos. Para abrir un libro
// o subirlo: nunca para listar.
export function getRaw(id) {
  return tx('books', 'readonly', s => reqP(s.get(id)));
}

export function getBook(id) {
  return getRaw(id).then(r => (r && r.deleted ? null : r));
}

const byRecent = (a, b) => (b.lastOpenedAt || b.addedAt || 0) - (a.lastOpenedAt || a.addedAt || 0);

export function getAllBooks() {
  return getAllRecords().then(list => list.filter(b => !b.deleted).sort(byRecent));
}

// TODOS los registros SIN el binario, tombstones incluidos.
//
// Va con cursor y suelta `file` en cuanto lee cada registro, en vez de
// `getAll()`: getAll deserializa la tabla entera de golpe, así que pintar la
// rejilla metía en memoria el ArrayBuffer de CADA libro de la biblioteca —
// cientos de MB para mostrar unas portadas. Con cursor solo hay un binario vivo
// a la vez, y se descarta al momento.
export function getAllRecords() {
  return tx('books', 'readonly', s => new Promise((resolve, reject) => {
    const out = [];
    const req = s.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve(out);
      const { file, ...meta } = cur.value;
      meta.hasLocalFile = !!(file && (file.byteLength || file.size));
      out.push(meta);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  }));
}

function syncedChanged(prev, next) {
  if (!prev) return true;
  return SYNCED_FIELDS.some(f => JSON.stringify(prev[f]) !== JSON.stringify(next[f]));
}

// Avisa al SyncEngine de que hay algo que subir. Se emite desde AQUÍ, el único
// punto de escritura, en vez de desde cada pantalla que toca la biblioteca:
// así ninguna acción nueva se olvida de sincronizar. El engine ignora el evento
// mientras está aplicando datos remotos (applyingRemote), que es lo que evita
// el eco de un merge convertido en push.
function notifyChanged() {
  try {
    window.dispatchEvent(new Event('bookreader:data-changed'));
  } catch (e) { /* sin DOM (tests unitarios) */ }
}

// Inserta o actualiza el registro completo de un libro. Sella `updatedAt` solo
// si cambió algo sincronizable (o si viene impuesto por el merge remoto).
//
// Guarda contra un pie en el que es fácil dispararse: los registros de
// getAllRecords() vienen SIN binario y marcados con `hasLocalFile`. Reescribir
// uno de ellos tal cual (lo hace el merge de biblioteca al aplicar metadatos
// remotos) habría borrado el fichero del libro. Si el registro viene marcado y
// no trae `file` explícito, se conserva el que ya estaba guardado.
export async function putBook(record, { stamp = true } = {}) {
  const next = { ...record };
  const stripped = typeof next.hasLocalFile === 'boolean';
  delete next.hasLocalFile;

  const prev = (stamp || stripped) ? await getRaw(next.id) : null;
  if (stripped && next.file === undefined && prev) next.file = prev.file;
  let changed = false;
  if (stamp) {
    changed = syncedChanged(prev, next);
    if (changed) next.updatedAt = Date.now();
    else if (prev && !next.updatedAt) next.updatedAt = prev.updatedAt;
  }
  await tx('books', 'readwrite', s => reqP(s.put(next)));
  if (changed) notifyChanged();
  return next;
}

// Aplica un parche parcial a un libro existente (progreso, estado, estanterías…).
export async function updateBook(id, patch, opts) {
  const cur = await getRaw(id);
  if (!cur) return null;
  return putBook({ ...cur, ...patch }, opts);
}

// Borrado LÓGICO: el registro sobrevive como tombstone para que el borrado se
// propague al resto de dispositivos. Suelta el binario y la portada (que es lo
// que ocupa) y conserva solo lo justo para identificarlo. La purga física la
// hace purgeDeleted() pasado el TTL, cuando todos han visto el borrado.
export async function deleteBook(id) {
  const cur = await getRaw(id);
  if (!cur) return null;
  const now = Date.now();
  const rec = await putBook({
    id, title: cur.title || '', format: cur.format || '',
    blob: cur.blob || null,       // lo necesita blobs.js para borrarlo del remoto
    deleted: true, deletedAt: now, updatedAt: now,
  }, { stamp: false });
  notifyChanged();   // stamp:false no lo emite, pero borrar SÍ es un cambio a propagar
  return rec;
}

// Libera el binario de ESTE dispositivo dejando la ficha fantasma. Es una
// decisión local: no toca `updatedAt` ni viaja en el sync (si lo hiciera, el
// resto de dispositivos perderían su copia descargada).
export async function removeDownload(id) {
  const cur = await getRaw(id);
  if (!cur || !hasFile(cur)) return null;
  return putBook({ ...cur, file: null }, { stamp: false });
}

// Purga física de tombstones ya propagados (mismo TTL que sync/schema.js).
export async function purgeDeleted(before) {
  const gone = (await getAllRecords()).filter(b => b.deleted && (b.deletedAt || 0) < before);
  await Promise.all(gone.map(b => tx('books', 'readwrite', s => reqP(s.delete(b.id)))));
  return gone.length;
}

// Estado de lectura derivado del progreso, sin pisar "finished" manual.
export function statusFor(progress, prev) {
  if (prev === 'finished') return 'finished';
  if (progress >= 97) return 'finished';
  if (progress > 0) return 'reading';
  return 'unread';
}

// ---- Estanterías -----------------------------------------------------------

// Estanterías vivas, ordenadas por `order` y, a falta de él (las creadas antes
// de que existiera el orden manual), por antigüedad. El rail las reagrupa
// después en árbol según el nombre; este orden es el de las hermanas.
export function getShelves() {
  return getAllShelfRecords()
    .then(list => list.filter(s => !s.deleted).sort((a, b) => {
      const oa = Number.isFinite(a.order) ? a.order : Number.POSITIVE_INFINITY;
      const ob = Number.isFinite(b.order) ? b.order : Number.POSITIVE_INFINITY;
      return oa - ob || (a.createdAt || 0) - (b.createdAt || 0);
    }));
}

export function getAllShelfRecords() {
  return tx('shelves', 'readonly', s => reqP(s.getAll())).then(list => list || []);
}

export async function putShelf(shelf) {
  const r = await tx('shelves', 'readwrite', s => reqP(s.put(shelf)));
  notifyChanged();
  return r;
}

export async function addShelf(name, { rule = null } = {}) {
  const now = Date.now();
  // El id lleva sufijo aleatorio: dos dispositivos creando una estantería en el
  // mismo milisegundo generaban el MISMO id y el merge las fusionaba en una.
  const shelf = {
    id: 'sh_' + now.toString(36) + Math.random().toString(36).slice(2, 6),
    name: name.trim(), createdAt: now, updatedAt: now,
  };
  const clean = Shelves.cleanRule(rule);
  if (Object.keys(clean).length) shelf.rule = clean;
  await putShelf(shelf);
  return shelf;
}

export async function renameShelf(id, name) {
  return updateShelf(id, { name: name.trim() });
}

// Parche sobre una estantería existente (nombre, regla, orden). `rule: null`
// la convierte en manual: se borra el campo en vez de guardar un objeto vacío,
// que en el sync es un valor distinto de "no hay regla".
export async function updateShelf(id, patch = {}) {
  const sh = await tx('shelves', 'readonly', s => reqP(s.get(id)));
  if (!sh) return null;
  const next = { ...sh, ...patch, updatedAt: Date.now() };
  if ('rule' in patch) {
    const clean = Shelves.cleanRule(patch.rule);
    if (Object.keys(clean).length) next.rule = clean; else delete next.rule;
  }
  return putShelf(next);
}

// Sube o baja una estantería entre sus hermanas del rail (delta -1 / +1).
export async function moveShelf(id, delta) {
  const shelves = await getShelves();
  const patches = Shelves.reorder(shelves, id, delta);
  const byId = new Map(shelves.map(s => [s.id, s]));
  // Un solo `updatedAt` para todo el lote: reordenar es UN cambio, y con
  // timestamps distintos un merge a medias podría dejar el nivel entrelazado.
  const now = Date.now();
  await Promise.all(patches.map(p => putShelf({ ...byId.get(p.id), order: p.order, updatedAt: now })));
  return patches.length;
}

// Borra la estantería (tombstone) y la quita de todos los libros (no borra los
// libros) y de las reglas que la citaran: una estantería inteligente que apunte
// a una borrada se quedaría filtrando por un id fantasma, sin miembros posibles
// y sin forma de verlo desde la UI.
export async function deleteShelf(id) {
  const sh = await tx('shelves', 'readonly', s => reqP(s.get(id)));
  const now = Date.now();
  if (sh) await putShelf({ ...sh, deleted: true, deletedAt: now, updatedAt: now });
  const books = await getAllBooks();
  await Promise.all(books
    .filter(b => (b.shelfIds || []).includes(id))
    .map(b => updateBook(b.id, { shelfIds: b.shelfIds.filter(x => x !== id) })));
  const others = (await getShelves()).filter(s => (s.rule && s.rule.shelfIds || []).includes(id));
  await Promise.all(others.map(s =>
    updateShelf(s.id, { rule: { ...s.rule, shelfIds: s.rule.shelfIds.filter(x => x !== id) } })));
}

export async function purgeDeletedShelves(before) {
  const gone = (await getAllShelfRecords()).filter(s => s.deleted && (s.deletedAt || 0) < before);
  await Promise.all(gone.map(s => tx('shelves', 'readwrite', st => reqP(st.delete(s.id)))));
  return gone.length;
}

export async function toggleBookShelf(bookId, shelfId, on) {
  const book = await getBook(bookId);
  if (!book) return;
  const set = new Set(book.shelfIds || []);
  if (on) set.add(shelfId); else set.delete(shelfId);
  await updateBook(bookId, { shelfIds: [...set] });
}
