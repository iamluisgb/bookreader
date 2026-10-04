// P24 F2 · Importar un dossier. Dos pasos, para que el usuario vea QUÉ acepta antes de
// aceptarlo: plan() lee el paquete y decide qué pasaría con cada libro sin escribir
// nada; apply() escribe solo los libros elegidos.
//
// Estado de cada libro frente a TU biblioteca (el id es el hash, así que «el mismo
// libro» significa los mismos bytes, no el mismo título):
//   have    — ya lo tienes con fichero: no se toca, solo se añade a la estantería.
//   attach  — lo tienes como ficha fantasma (fichero en Drive) y el paquete lo trae:
//             se le pone el fichero.
//   new     — no lo tienes y el paquete lo trae: entra en la biblioteca.
//   missing — no lo tienes y el paquete no lo trae: sus notas se guardan igual (se ven
//             en cuanto consigas ese fichero exacto), con `source` si lo hay.
import * as Store from '../library/store.js';
import * as Container from './container.js';
import * as Bundle from './bundle.js';
import * as Shared from './store.js';

export async function plan(fileOrBlob) {
  const { bundle, files, rejected } = await Container.unpack(fileOrBlob);
  const records = await Store.getAllRecords();
  const byId = new Map(records.filter(r => !r.deleted).map(r => [r.id, r]));
  const counts = Bundle.counts(bundle);
  const books = bundle.books.map((b, i) => {
    const mine = byId.get(b.bookId);
    const file = files.get(b.bookId) || null;
    let state;
    if (mine && Store.hasFile(mine)) state = 'have';
    else if (file) state = mine ? 'attach' : 'new';
    else state = 'missing';
    return { entry: b, file, state, counts: counts.per[i], tampered: rejected.includes(b.bookId) };
  });
  return { bundle, books, total: counts.total, key: Shared.dossierKey(bundle) };
}

// Nombre de la estantería que recibe el dossier: el de origen y de quién viene, para
// que no se confunda con una tuya del mismo nombre.
export function shelfNameFor(bundle) {
  const name = bundle.shelf?.name || 'Estantería';
  return bundle.author ? `${name} · ${bundle.author}` : name;
}

async function ensureShelf(name) {
  const existing = (await Store.getShelves()).find(s => s.name === name);
  return existing || Store.addShelf(name);
}

const mimeOf = (format) => (format === 'pdf' ? 'application/pdf' : 'application/epub+zip');

// Escribe los libros elegidos (`ids`; por defecto todos). Devuelve un resumen.
export async function apply(p, ids = p.books.map(b => b.entry.bookId), now = Date.now()) {
  const chosen = p.books.filter(b => ids.includes(b.entry.bookId));
  const shelf = await ensureShelf(shelfNameFor(p.bundle));
  const added = [];

  for (const { entry, file, state } of chosen) {
    if (state === 'new') {
      // Ficha mínima, con la miniatura de portada del dossier. Los dossiers viejos no la
      // traen: entonces sale al abrirlo por primera vez (app.js · backfillCover).
      const raw = await Store.getRaw(entry.bookId);   // un tombstone se resucita, no se duplica
      await Store.putBook({
        ...(raw || {}),
        id: entry.bookId, title: entry.title, author: entry.author || '', format: entry.format,
        fileName: `${entry.title || 'libro'}.${entry.format === 'pdf' ? 'pdf' : 'epub'}`,
        size: file.size, addedAt: now, progress: 0, lastCfi: null, status: 'unread',
        shelfIds: [shelf.id], cover: entry.cover || raw?.cover || '', coverThumb: null,
        file: new Blob([file], { type: mimeOf(entry.format) }),
        deleted: false, deletedAt: 0,
      });
      added.push(entry.bookId);
    } else if (state === 'attach') {
      await Store.patchBook(entry.bookId, { file: new Blob([file], { type: mimeOf(entry.format) }) }, { stamp: false });
      await Store.toggleBookShelf(entry.bookId, shelf.id, true);
    } else if (state === 'have') {
      await Store.toggleBookShelf(entry.bookId, shelf.id, true);
    }
    // Lo que ya tenías sin portada (llegó por sync, o nunca se abrió) la toma del dossier.
    if (entry.cover && (state === 'have' || state === 'attach')) {
      await Store.patchBook(entry.bookId, (cur) => (cur.cover ? {} : { cover: entry.cover }), { stamp: false });
    }
    // missing: no hay ficha que crear (sería un libro sin fichero ni copia en Drive que
    // nadie puede abrir). Sus notas quedan en el carril y aparecen al conseguirlo.
  }

  await Shared.replaceDossier(p.key, chosen.map(({ entry }) => ({
    bookId: entry.bookId,
    shelfId: shelf.id,   // para poder quitarlo desde el menú de esa estantería
    title: entry.title,
    source: entry.source || null,
    from: p.bundle.author || '',
    shelfName: p.bundle.shelf?.name || '',
    importedAt: now,
    highlights: entry.highlights || [],
    notebooks: entry.notebooks || [],
    artifacts: entry.artifacts || [],
    decks: entry.decks || [],
    templates: p.bundle.templates || [],
  })));

  return { shelfId: shelf.id, added: added.length, books: chosen.length };
}
