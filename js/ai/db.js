// Capa de persistencia en IndexedDB para la feature de IA (E4 del backlog).
// Sin dependencias: envoltorio mínimo sobre IndexedDB con promesas.
//
// Stores:
//   books    (keyPath id)      -> { id, title, addedAt }
//   bookText (keyPath bookId)  -> { bookId, annotatedText, tokenEstimate, blockCount }
//   anchors  (keyPath bookId)  -> { bookId, entries: [ [id, {cfi, chapter}], ... ] }
//   messages (keyPath id, ++)  -> { id, bookId, role, content, ts }  [index: bookId]
//   sessions (keyPath bookId)  -> { bookId, templateId, goal, createdAt }
//   notes    (keyPath id, ++)  -> { id, bookId, fieldKey, content, sourceCfis, ts } [index: bookId]
//   ratings  (keyPath bookId)  -> { bookId, goal, scores: {chapterLabel: 0..1} }

const DB_NAME = 'bookreader_ai';
const DB_VERSION = 3;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books'))    db.createObjectStore('books',    { keyPath: 'id' });
      if (!db.objectStoreNames.contains('bookText')) db.createObjectStore('bookText', { keyPath: 'bookId' });
      if (!db.objectStoreNames.contains('anchors'))  db.createObjectStore('anchors',  { keyPath: 'bookId' });
      if (!db.objectStoreNames.contains('messages')) {
        const s = db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
        s.createIndex('bookId', 'bookId', { unique: false });
      }
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'bookId' });
      if (!db.objectStoreNames.contains('notes')) {
        const s = db.createObjectStore('notes', { keyPath: 'id', autoIncrement: true });
        s.createIndex('bookId', 'bookId', { unique: false });
      }
      if (!db.objectStoreNames.contains('ratings')) db.createObjectStore('ratings', { keyPath: 'bookId' });
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

export function put(store, value) {
  return tx(store, 'readwrite', s => reqP(s.put(value)));
}

// Mensajes de chat por libro -------------------------------------------------

export function getMessages(bookId) {
  return tx('messages', 'readonly', s => reqP(s.index('bookId').getAll(bookId)));
}

export function addMessage(bookId, role, content) {
  return put('messages', { bookId, role, content, ts: Date.now() });
}

export function clearMessages(bookId) {
  return tx('messages', 'readwrite', s => new Promise((resolve, reject) => {
    const idx = s.index('bookId');
    const cur = idx.openCursor(IDBKeyRange.only(bookId));
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) { c.delete(); c.continue(); } else resolve();
    };
    cur.onerror = () => reject(cur.error);
  }));
}

// Sesión (objetivo + plantilla) por libro ------------------------------------

export function getSession(bookId) {
  return get('sessions', bookId);
}

export function saveSession(bookId, templateId, goal) {
  return put('sessions', { bookId, templateId, goal, createdAt: Date.now() });
}

// Notas de la libreta por libro ---------------------------------------------

export function getNotes(bookId) {
  return tx('notes', 'readonly', s => reqP(s.index('bookId').getAll(bookId)));
}

export function addNote(bookId, fieldKey, content, sourceCfis = []) {
  return put('notes', { bookId, fieldKey, content, sourceCfis, ts: Date.now() });
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
