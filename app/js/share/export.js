// P24 F1 · Exportar el dossier de una estantería. Lee los stores (biblioteca, subrayados,
// capa IA) y se los pasa a bundle.js, que es puro. Aquí no se decide la forma del
// fichero, solo de dónde sale cada cosa.
import * as Storage from '../storage.js';
import * as Store from '../library/store.js';
import * as Shelves from '../library/shelves.js';
import * as DB from '../ai/db.js';
import * as CustomTemplates from '../ai/custom-templates.js';
import * as Bundle from './bundle.js';

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
  for (const b of books) gathered.push(await gatherBook(b, withChat));   // en serie: IDB no gana nada en paralelo
  return Bundle.build({ shelf, books: gathered, parts, author, customTemplates: CustomTemplates.getAll() });
}

// Web Share con el fichero donde lo haya (móvil: WhatsApp, AirDrop…) y descarga en el
// resto. Mismo contrato que exportBook/sharePng: cancelar no es fallar.
// Devuelve 'shared' | 'downloaded' | 'cancelled'.
export async function deliver(bundle) {
  const name = Bundle.filename(bundle);
  const blob = new Blob([Bundle.serialize(bundle)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
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
