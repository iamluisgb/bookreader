// Capa de persistencia en IndexedDB para la feature de IA (E4 del backlog).
// Sin dependencias: envoltorio mínimo sobre IndexedDB con promesas.
//
// Stores:
//   books    (keyPath id)      -> { id, title, addedAt }
//   bookText (keyPath bookId)  -> { bookId, annotatedText, tokenEstimate, blockCount }
//   anchors  (keyPath bookId)  -> { bookId, entries: [ [id, {cfi, chapter}], ... ] }
//   convos   (keyPath id)      -> { id, bookId, templateId, goal, title, createdAt, lastUsedAt } [index: bookId]
//   messages (keyPath id, ++)  -> { id, convoId, bookId?, role, content, ts }  [index: bookId, convoId]
//   notes    (keyPath id, ++)  -> { id, convoId, bookId?, fieldKey, content, sourceCfis, ts } [index: bookId, convoId]
//   sessions (keyPath bookId)  -> LEGACY (v<=3): { bookId, templateId, goal, createdAt } — solo para migrar
//   ratings  (keyPath bookId)  -> { bookId, goal, scores }  (la clave ahora es convoId)
//   decks    (keyPath id, ++)  -> { id, bookId, name, cardType, scope, cards, createdAt } [index: bookId]
//
// v4: una conversación (convo) por objetivo; varias por libro. messages/notes
// se indexan por convoId. Las conversaciones antiguas (sessions, una por libro)
// se migran a una convo en migrateBook().
// v5: decks — mazos de flashcards generados (feature de export a Anki).

const DB_NAME = 'bookreader_ai';
const DB_VERSION = 5;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const t = req.transaction; // transacción versionchange (acceso a stores existentes)
      if (!db.objectStoreNames.contains('books'))    db.createObjectStore('books',    { keyPath: 'id' });
      if (!db.objectStoreNames.contains('bookText')) db.createObjectStore('bookText', { keyPath: 'bookId' });
      if (!db.objectStoreNames.contains('anchors'))  db.createObjectStore('anchors',  { keyPath: 'bookId' });

      let messages;
      if (!db.objectStoreNames.contains('messages')) {
        messages = db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
        messages.createIndex('bookId', 'bookId', { unique: false });
      } else messages = t.objectStore('messages');
      if (!messages.indexNames.contains('convoId')) messages.createIndex('convoId', 'convoId', { unique: false });

      let notes;
      if (!db.objectStoreNames.contains('notes')) {
        notes = db.createObjectStore('notes', { keyPath: 'id', autoIncrement: true });
        notes.createIndex('bookId', 'bookId', { unique: false });
      } else notes = t.objectStore('notes');
      if (!notes.indexNames.contains('convoId')) notes.createIndex('convoId', 'convoId', { unique: false });

      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'bookId' });
      if (!db.objectStoreNames.contains('ratings'))  db.createObjectStore('ratings',  { keyPath: 'bookId' });
      if (!db.objectStoreNames.contains('convos')) {
        const c = db.createObjectStore('convos', { keyPath: 'id' });
        c.createIndex('bookId', 'bookId', { unique: false });
      }
      if (!db.objectStoreNames.contains('decks')) {
        const d = db.createObjectStore('decks', { keyPath: 'id', autoIncrement: true });
        d.createIndex('bookId', 'bookId', { unique: false });
      }
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

export function get(store, key) {
  return tx(store, 'readonly', s => reqP(s.get(key)));
}

// Todos los registros de un store (para export/backup global, P3).
export function getAll(store) {
  return tx(store, 'readonly', s => reqP(s.getAll()));
}

export function put(store, value) {
  return tx(store, 'readwrite', s => reqP(s.put(value)));
}

// Mensajes de chat por conversación ------------------------------------------

export function getMessages(convoId) {
  return tx('messages', 'readonly', s => reqP(s.index('convoId').getAll(convoId)));
}

export function addMessage(convoId, role, content) {
  const now = Date.now();
  // uid: identidad global para el merge entre dispositivos (el id autoincremental
  // colisiona entre equipos; sigue siendo solo la clave local). Ver SYNC_PLAN.md.
  return put('messages', { uid: crypto.randomUUID(), convoId, role, content, ts: now, updatedAt: now });
}

function clearByIndex(store, index, key) {
  return tx(store, 'readwrite', s => new Promise((resolve, reject) => {
    const cur = s.index(index).openCursor(IDBKeyRange.only(key));
    cur.onsuccess = () => { const c = cur.result; if (c) { c.delete(); c.continue(); } else resolve(); };
    cur.onerror = () => reject(cur.error);
  }));
}

export function clearMessages(convoId) {
  return clearByIndex('messages', 'convoId', convoId);
}

// Conversaciones (objetivo + plantilla); varias por libro --------------------

export function getConvos(bookId) {
  return tx('convos', 'readonly', s => reqP(s.index('bookId').getAll(bookId)))
    .then(list => (list || []).sort((a, b) => (b.lastUsedAt || b.createdAt || 0) - (a.lastUsedAt || a.createdAt || 0)));
}

export function getConvo(id) {
  return get('convos', id);
}

export async function createConvo(bookId, templateId, goal, title = null, createdAt = null) {
  const now = Date.now();
  const convo = { id: 'cv_' + now.toString(36) + Math.random().toString(36).slice(2, 6),
    bookId, templateId, goal, title, createdAt: createdAt || now, lastUsedAt: now };
  await put('convos', convo);
  return convo;
}

export async function updateConvo(id, patch) {
  const cur = await getConvo(id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  await put('convos', next);
  return next;
}

export function touchConvo(id) {
  return updateConvo(id, { lastUsedAt: Date.now() });
}

// Borra la conversación y todo lo suyo (mensajes, notas, relevancia).
export async function deleteConvo(id) {
  await tx('convos', 'readwrite', s => reqP(s.delete(id)));
  await clearByIndex('messages', 'convoId', id);
  await clearByIndex('notes', 'convoId', id);
  await tx('ratings', 'readwrite', s => reqP(s.delete(id)));
}

// Migra la sesión antigua (una por libro) a una conversación, reasignando sus
// mensajes y notas. Idempotente: si el libro ya tiene conversaciones, no hace nada.
export async function migrateBook(bookId) {
  const convos = await getConvos(bookId);
  if (convos.length) return;
  const ses = await get('sessions', bookId);
  if (!ses) return;
  const convo = await createConvo(bookId, ses.templateId, ses.goal, null, ses.createdAt);
  await reassign('messages', bookId, convo.id);
  await reassign('notes', bookId, convo.id);
}

function reassign(store, bookId, convoId) {
  return tx(store, 'readwrite', s => new Promise((resolve, reject) => {
    const cur = s.index('bookId').openCursor(IDBKeyRange.only(bookId));
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) { const v = c.value; if (!v.convoId) { v.convoId = convoId; c.update(v); } c.continue(); }
      else resolve();
    };
    cur.onerror = () => reject(cur.error);
  }));
}

// Notas de la libreta por conversación --------------------------------------

export function getNotes(convoId) {
  return tx('notes', 'readonly', s => reqP(s.index('convoId').getAll(convoId)))
    .then(list => (list || []).filter(n => !n.deleted));
}

export function addNote(convoId, fieldKey, content, sourceCfis = []) {
  const now = Date.now();
  return put('notes', { uid: crypto.randomUUID(), convoId, fieldKey, content, sourceCfis, ts: now, updatedAt: now });
}

export function updateNote(id, patch) {
  return tx('notes', 'readwrite', async s => {
    const cur = await reqP(s.get(id));
    if (!cur) return;
    return reqP(s.put({ ...cur, ...patch, id, updatedAt: Date.now() }));
  });
}

// Borrado lógico (tombstone): el borrado se propaga en el sync en vez de
// resucitar en la unión. La purga física la hace purgeDeletedNotes().
export function deleteNote(id) {
  return tx('notes', 'readwrite', async s => {
    const cur = await reqP(s.get(id));
    if (!cur) return;
    const now = Date.now();
    return reqP(s.put({ ...cur, deleted: true, deletedAt: now, updatedAt: now }));
  });
}

// Purga física de tombstones de notas anteriores a `olderThan` (ms epoch).
export function purgeDeletedNotes(olderThan) {
  return tx('notes', 'readwrite', s => new Promise((resolve, reject) => {
    const cur = s.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      if (c.value.deleted && (c.value.deletedAt || 0) < olderThan) c.delete();
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  }));
}

// Sync Fase 0 · Backfill de uid/updatedAt en los stores con id autoincremental
// (messages, notes, decks): el id entero colisiona entre dispositivos, el merge
// va por uid. Idempotente: solo escribe campos ausentes.
export function backfillSyncFields(now = Date.now()) {
  const backfill = (store) => tx(store, 'readwrite', s => new Promise((resolve, reject) => {
    const cur = s.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      const v = c.value;
      let changed = false;
      if (!v.uid) { v.uid = crypto.randomUUID(); changed = true; }
      if (!v.updatedAt) { v.updatedAt = v.ts || v.createdAt || now; changed = true; }
      if (changed) c.update(v);
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  }));
  return Promise.all(['messages', 'notes', 'decks'].map(backfill));
}

// Mazos de flashcards (export a Anki) ----------------------------------------

export function getDecks(bookId) {
  return tx('decks', 'readonly', s => reqP(s.index('bookId').getAll(bookId)))
    .then(list => (list || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
}

// Todos los mazos (la cola diaria del modo Estudiar cruza todos los libros).
export function getAllDecks() {
  return getAll('decks').then(list => (list || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
}

export function addDeck(deck) {
  const now = Date.now();
  return tx('decks', 'readwrite', s => reqP(s.put({ uid: crypto.randomUUID(), ...deck, createdAt: now, updatedAt: now })));
}

export function updateDeck(id, patch) {
  return tx('decks', 'readwrite', async s => {
    const cur = await reqP(s.get(id));
    if (!cur) return;
    return reqP(s.put({ ...cur, ...patch, id, updatedAt: Date.now() }));
  });
}

export function deleteDeck(id) {
  return tx('decks', 'readwrite', s => reqP(s.delete(id)));
}

// Relevancia de capítulos vs objetivo ---------------------------------------

export function getRatings(bookId) {
  return get('ratings', bookId);
}

export function saveRatings(bookId, goal, scores) {
  return put('ratings', { bookId, goal, scores });
}

// Libro segmentado ----------------------------------------------------------

// Versión del esquema de segmentación. Al subirla, las segmentaciones cacheadas
// con una versión anterior se ignoran y el libro se re-segmenta. v2: las anclas
// EPUB se registran SIEMPRE (antes solo si había CFI → citas huérfanas que salían
// crudas); ahora llevan href/capítulo de fallback. v3: purga cachés ENVENENADAS por
// la carrera al segmentar (el saveSegmented viejo pudo guardar el contenido de un
// libro bajo el id de otro); el guard de prepareBook ya evita nuevas contaminaciones.
// v4: en PDFs "Part → Chapter" los capítulos reales son los hijos de la Part (antes
// todo se atribuía a la Part) → re-segmentar para recuperar la granularidad de capítulo.
const SEG_VERSION = 4;

export async function loadSegmented(bookId) {
  const [text, anch] = await Promise.all([get('bookText', bookId), get('anchors', bookId)]);
  if (!text || !anch || text.segVersion !== SEG_VERSION) return null;   // stale → re-segmentar
  return {
    annotatedText: text.annotatedText,
    tokenEstimate: text.tokenEstimate,
    blockCount: text.blockCount,
    anchors: new Map(anch.entries),
  };
}

export async function saveSegmented(bookId, title, seg) {
  await put('books', { id: bookId, title, addedAt: Date.now() });
  await put('bookText', {
    bookId,
    segVersion: SEG_VERSION,
    annotatedText: seg.annotatedText,
    tokenEstimate: seg.tokenEstimate,
    blockCount: seg.blockCount,
  });
  await put('anchors', { bookId, entries: [...seg.anchors.entries()] });
}

// Utilidad: SHA-256 del arrayBuffer del fichero -> id estable del libro.
export async function hashBuffer(arrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
