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
//
// v4: una conversación (convo) por objetivo; varias por libro. messages/notes
// se indexan por convoId. Las conversaciones antiguas (sessions, una por libro)
// se migran a una convo en migrateBook().

const DB_NAME = 'bookreader_ai';
const DB_VERSION = 4;

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
  return put('messages', { convoId, role, content, ts: Date.now() });
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
  return tx('notes', 'readonly', s => reqP(s.index('convoId').getAll(convoId)));
}

export function addNote(convoId, fieldKey, content, sourceCfis = []) {
  return put('notes', { convoId, fieldKey, content, sourceCfis, ts: Date.now() });
}

export function updateNote(id, patch) {
  return tx('notes', 'readwrite', async s => {
    const cur = await reqP(s.get(id));
    if (!cur) return;
    return reqP(s.put({ ...cur, ...patch, id }));
  });
}

export function deleteNote(id) {
  return tx('notes', 'readwrite', s => reqP(s.delete(id)));
}

// Relevancia de capítulos vs objetivo ---------------------------------------

export function getRatings(bookId) {
  return get('ratings', bookId);
}

export function saveRatings(bookId, goal, scores) {
  return put('ratings', { bookId, goal, scores });
}

// Libro segmentado ----------------------------------------------------------

export async function loadSegmented(bookId) {
  const [text, anch] = await Promise.all([get('bookText', bookId), get('anchors', bookId)]);
  if (!text || !anch) return null;
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
