// P24 F2 · El carril ajeno: lo que llega en un dossier de otra persona. Base propia
// (`bookreader_shared`), no un store más en `bookreader_ai`:
//   - no se mezcla con lo tuyo: en EPUB uid = cfi, y meter subrayados ajenos en tu lista
//     haría que mergeCollections pisara los tuyos del mismo pasaje;
//   - queda fuera del sync de Drive y del backup sin tocar ninguno de los dos (ambos
//     enumeran sus stores a mano);
//   - no obliga a subir la versión de la base del agente (con otra pestaña abierta, un
//     upgrade se bloquea).
// Coste aceptado en v1: lo importado no viaja entre tus dispositivos; se reimporta.
//
// Un registro por (dossier, libro):
//   { id: `${dossierKey}::${bookId}`, dossierKey, bookId, shelfId, from, shelfName, importedAt,
//     title, highlights, notebooks, artifacts, decks, templates }

const DB_NAME = 'bookreader_shared';
const DB_VERSION = 1;
const STORE = 'items';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore(STORE, { keyPath: 'id' });
      s.createIndex('bookId', 'bookId', { unique: false });
      s.createIndex('dossierKey', 'dossierKey', { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

function run(mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

// Identidad de un dossier para REEMPLAZAR, no mezclar: reenviar «Knowledge graphs» de
// Luis sustituye lo anterior de Luis con ese nombre. El autor es texto libre del
// fichero (no una identidad verificada), así que esto ordena, no autentica.
export function dossierKey(bundle) {
  const norm = (s) => String(s || '').trim().toLowerCase();
  // Un libro suelto no choca con una estantería de la misma persona que se llame igual.
  const name = bundle.scope === 'book' ? `libro:${norm(bundle.shelf?.name)}` : norm(bundle.shelf?.name);
  return `${norm(bundle.author)}|${name}`;
}

// Sustituye todo lo de un dossier por `records`, en una transacción: o queda lo nuevo
// entero o lo viejo entero.
export function replaceDossier(key, records) {
  return run('readwrite', (s) => {
    const req = s.index('dossierKey').openCursor(IDBKeyRange.only(key));
    req.onsuccess = () => {
      const c = req.result;
      if (c) { c.delete(); c.continue(); return; }
      for (const r of records) s.put({ ...r, id: `${key}::${r.bookId}`, dossierKey: key });
    };
  });
}

export function forBook(bookId) {
  return run('readonly', s => s.index('bookId').getAll(bookId)).then(list => list || []);
}

export function getAll() {
  return run('readonly', s => s.getAll()).then(list => list || []);
}

// Dossiers que llegaron a una estantería: [{ key, from, shelfName, books }]. Lo usa el
// menú de la estantería para ofrecer quitarlos.
export async function dossiersForShelf(shelfId) {
  const out = new Map();
  for (const r of await getAll()) {
    if (r.shelfId !== shelfId) continue;
    const d = out.get(r.dossierKey) || { key: r.dossierKey, from: r.from || '', shelfName: r.shelfName || '', books: 0 };
    d.books++;
    out.set(r.dossierKey, d);
  }
  return [...out.values()];
}

// Libros sueltos compartidos contigo que tocan a este libro: [{ key, from }]. Lo usa el menú
// del libro para ofrecer quitarlos (no tienen estantería desde la que hacerlo).
export async function bookDossiersFor(bookId) {
  const out = new Map();
  for (const r of await getAll()) {
    if (r.bookId !== bookId || r.scope !== 'book') continue;
    out.set(r.dossierKey, { key: r.dossierKey, from: r.from || '', books: 1 });
  }
  return [...out.values()];
}

export function removeDossier(key) {
  return replaceDossier(key, []);
}
