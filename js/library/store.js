// Biblioteca persistente: guarda el ARCHIVO completo de cada libro junto a sus
// metadatos (portada, progreso, estado) y las estanterías del usuario. El `id`
// es el mismo hash SHA-256 que usa la capa de IA, así las sesiones/notas/
// subrayados de un libro siguen enlazadas al reabrirlo.
//
// Stores:
//   books   (keyPath id)  -> { id, title, author, format, cover (dataURL),
//                              file (ArrayBuffer), size, addedAt, lastOpenedAt,
//                              progress (0..100), lastCfi, status, shelfIds: [] }
//   shelves (keyPath id)  -> { id, name, createdAt }

const DB_NAME = 'bookreader_library';
const DB_VERSION = 1;

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

export function getBook(id) {
  return tx('books', 'readonly', s => reqP(s.get(id)));
}

export function getAllBooks() {
  return tx('books', 'readonly', s => reqP(s.getAll()))
    .then(list => (list || []).sort((a, b) => (b.lastOpenedAt || b.addedAt || 0) - (a.lastOpenedAt || a.addedAt || 0)));
}

// Inserta o actualiza el registro completo de un libro.
export function putBook(record) {
  return tx('books', 'readwrite', s => reqP(s.put(record)));
}

// Aplica un parche parcial a un libro existente (progreso, estado, estanterías…).
export async function updateBook(id, patch) {
  const cur = await getBook(id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  await putBook(next);
  return next;
}

export function deleteBook(id) {
  return tx('books', 'readwrite', s => reqP(s.delete(id)));
}

// Estado de lectura derivado del progreso, sin pisar "finished" manual.
export function statusFor(progress, prev) {
  if (prev === 'finished') return 'finished';
  if (progress >= 97) return 'finished';
  if (progress > 0) return 'reading';
  return 'unread';
}

// ---- Estanterías -----------------------------------------------------------

export function getShelves() {
  return tx('shelves', 'readonly', s => reqP(s.getAll()))
    .then(list => (list || []).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)));
}

export async function addShelf(name) {
  const shelf = { id: 'sh_' + Date.now().toString(36), name: name.trim(), createdAt: Date.now() };
  await tx('shelves', 'readwrite', s => reqP(s.put(shelf)));
  return shelf;
}

export function renameShelf(id, name) {
  return tx('shelves', 'readwrite', async s => {
    const sh = await reqP(s.get(id));
    if (sh) { sh.name = name.trim(); await reqP(s.put(sh)); }
  });
}

// Borra la estantería y la quita de todos los libros (no borra los libros).
export async function deleteShelf(id) {
  await tx('shelves', 'readwrite', s => reqP(s.delete(id)));
  const books = await getAllBooks();
  await Promise.all(books
    .filter(b => (b.shelfIds || []).includes(id))
    .map(b => updateBook(b.id, { shelfIds: b.shelfIds.filter(x => x !== id) })));
}

export async function toggleBookShelf(bookId, shelfId, on) {
  const book = await getBook(bookId);
  if (!book) return;
  const set = new Set(book.shelfIds || []);
  if (on) set.add(shelfId); else set.delete(shelfId);
  await updateBook(bookId, { shelfIds: [...set] });
}
