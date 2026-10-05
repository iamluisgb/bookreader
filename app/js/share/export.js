// P24 F1 · Exportar el dossier de una estantería. Lee los stores (biblioteca, subrayados,
// capa IA) y se los pasa a bundle.js, que es puro. Aquí no se decide la forma del
// fichero, solo de dónde sale cada cosa.
import * as Storage from '../storage.js';
import * as Store from '../library/store.js';
import * as Shelves from '../library/shelves.js';
import * as DB from '../ai/db.js';
import * as CustomTemplates from '../ai/custom-templates.js';
import * as Bundle from './bundle.js';
import * as Container from './container.js';

const AUTHOR_KEY = 'share_author';

export const getAuthor = () => Storage.get(AUTHOR_KEY, '') || '';
export const setAuthor = (name) => Storage.set(AUTHOR_KEY, String(name || '').trim());

// Libros de la estantería, en el orden en que se ven (título).
export async function shelfBooks(shelfId) {
  const [shelves, records] = await Promise.all([Store.getShelves(), Store.getAllRecords()]);
  const shelf = shelves.find(s => s.id === shelfId) || null;
  const books = Shelves.booksIn(records.filter(r => !r.deleted), shelf)
    .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  return { shelf, books };
}

// Todo lo de UN libro. Los mensajes solo se leen si hacen falta: son lo voluminoso.
async function gatherBook(book, withChat) {
  const [convos, artifacts, decks] = await Promise.all([
    DB.getConvos(book.id), DB.getArtifacts(book.id), DB.getDecks(book.id),
  ]);
  const withNotes = await Promise.all((convos || []).filter(c => !c.deleted).map(async (convo) => ({
    convo,
    notes: await DB.getNotes(convo.id),
    messages: withChat ? await DB.getMessages(convo.id) : [],
  })));
  return {
    book,
    hasFile: Store.hasFile(book),
    highlights: Storage.get('highlights_' + book.id, []) || [],
    convos: withNotes,
    artifacts,
    decks,
  };
}

export async function buildShelfDossier(shelfId, { parts = Bundle.PARTS, author = getAuthor() } = {}) {
  const { shelf, books } = await shelfBooks(shelfId);
  if (!shelf) throw new Error('Estantería no encontrada');
  const withChat = parts.includes('chat');
  const gathered = [];
  const { makeThumb } = await import('../sync/library-sync.js');
  for (const b of books) {
    const g = await gatherBook(b, withChat);   // en serie: IDB no gana nada en paralelo
    // Miniatura (la misma que viaja por el sync): la portada original puede pesar MB.
    g.cover = b.cover ? await makeThumb(b.cover).catch(() => null) : null;
    gathered.push(g);
  }
  return Bundle.build({ shelf, books: gathered, parts, author, customTemplates: CustomTemplates.getAll() });
}

// Un libro suelto (con lo que has sacado de él): el mismo dossier, con un solo libro y
// `scope: 'book'`. El «nombre de la estantería» es el título del libro.
export async function buildBookDossier(bookId, { parts = Bundle.PARTS, author = getAuthor() } = {}) {
  const book = (await Store.getAllRecords()).find(r => r.id === bookId && !r.deleted);
  if (!book) throw new Error('Libro no encontrado');
  const { makeThumb } = await import('../sync/library-sync.js');
  const g = await gatherBook(book, parts.includes('chat'));
  g.cover = book.cover ? await makeThumb(book.cover).catch(() => null) : null;
  return Bundle.build({ shelf: { name: book.title || 'Libro' }, books: [g], parts, author,
    customTemplates: CustomTemplates.getAll(), scope: 'book' });
}

export async function packBook(bookId, opts) {
  return packBundle(await buildBookDossier(bookId, opts));
}

// Binario de un libro como Blob. Se lee de uno en uno con getRaw (no con getAllRecords,
// que suelta el `file` a propósito); los importados antes de la migración a Blob siguen
// con ArrayBuffer.
async function fileOf(bookId, format) {
  const rec = await Store.getRaw(bookId);
  if (!rec || !Store.hasFile(rec)) return null;
  const type = format === 'pdf' ? 'application/pdf' : 'application/epub+zip';
  return rec.file instanceof Blob ? rec.file : new Blob([rec.file], { type });
}

// El paquete listo para mandar: { bundle, blob, name }.
export async function packShelf(shelfId, opts) {
  return packBundle(await buildShelfDossier(shelfId, opts));
}

async function packBundle(bundle) {
  const files = new Map();
  for (const b of bundle.books) {
    if (!b.file) continue;
    const blob = await fileOf(b.bookId, b.format);
    // Pudo liberarse entre leer la lista y empaquetar: va sin fichero, no rompe el envío.
    if (blob) files.set(b.bookId, blob); else b.file = null;
  }
  return { bundle, blob: await Container.pack(bundle, files), name: Bundle.filename(bundle) };
}

// Web Share con el fichero donde lo haya (móvil: WhatsApp, AirDrop…) y descarga en el
// resto. Mismo contrato que exportBook/sharePng: cancelar no es fallar.
// Devuelve 'shared' | 'downloaded' | 'cancelled'.
export async function deliver({ blob, name }) {
  const file = new File([blob], name, { type: Container.MIME });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
      console.warn('No se pudo compartir el dossier, se descarga:', e);
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return 'downloaded';
}
