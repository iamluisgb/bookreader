// Título y autor editables (los EPUB/PDF traen a menudo «Título: el subtítulo larguísimo»
// o «Apellido, Nombre; Editorial»). Lo que se ve en toda la app es `title`/`author` de la
// ficha; lo que trae el fichero se guarda aparte (`origTitle`/`origAuthor`) para poder
// volver a él, para que la búsqueda encuentre el libro por los dos y para que reabrir el
// fichero no pise lo que el usuario escribió (app.js · persistToLibrary).
import * as Store from './store.js';
import { formBox } from '../ui/dialog.js';
import { t } from '../i18n.js';

// ¿El usuario cambió este campo? Solo si sabemos el original y difiere.
export function isEdited(rec, field) {
  const orig = field === 'title' ? rec?.origTitle : rec?.origAuthor;
  return orig != null && (rec?.[field] || '') !== orig;
}

// Lo que se guarda al (re)abrir el fichero: los metadatos del fichero como original y, como
// visible, lo que el usuario puso si lo cambió.
export function mergeFileMeta(existing, fileTitle, fileAuthor) {
  return {
    title: existing && isEdited(existing, 'title') ? existing.title : fileTitle,
    author: existing && isEdited(existing, 'author') ? existing.author : fileAuthor,
    origTitle: fileTitle,
    origAuthor: fileAuthor,
  };
}

// «Designing Data-Intensive Applications: The Big Ideas…» → «Designing Data-Intensive
// Applications». Corta en el primer «:», « — », « – » o « - »; si lo que queda es muy corto
// (p. ej. «C: …»), no propone nada.
export function withoutSubtitle(title) {
  const s = String(title || '').trim();
  const m = s.match(/^(.+?)\s*(?::|\s[—–-]\s)\s*\S/);
  if (!m) return '';
  const head = m[1].trim();
  return head.length >= 3 && head !== s ? head : '';
}

// «Kleppmann, Martin» → «Martin Kleppmann» (así lo traen muchos EPUB: el orden de catálogo).
// Solo con una coma y sin «;» (varios autores): ahí no se sabe qué invertir.
export function naturalAuthor(author) {
  const m = String(author || '').trim().match(/^([^,;]+),\s*([^,;]+)$/);
  return m ? `${m[2].trim()} ${m[1].trim()}` : '';
}

// Diálogo de edición. Devuelve true si se guardó algo.
export async function editBookMeta(book) {
  if (!book) return false;
  const origTitle = book.origTitle ?? book.title ?? '';
  const origAuthor = book.origAuthor ?? book.author ?? '';
  const short = withoutSubtitle(book.title);
  const titleSugg = [
    ...(short ? [{ label: t('Quitar subtítulo'), value: short }] : []),
    ...(origTitle && origTitle !== book.title ? [{ label: t('Restaurar el original'), value: origTitle }] : []),
  ];
  const natural = naturalAuthor(book.author);
  const authorSugg = [
    ...(natural ? [{ label: natural, value: natural }] : []),
    ...(origAuthor && origAuthor !== (book.author || '') ? [{ label: t('Restaurar el original'), value: origAuthor }] : []),
  ];
  const res = await formBox({
    title: t('Título y autor'),
    fields: [
      { name: 'title', label: 'Título', type: 'text', value: book.title || '', suggestions: titleSugg,
        hint: origTitle && origTitle !== book.title ? t('Original: {v}', { v: origTitle }) : '' },
      { name: 'author', label: 'Autor', type: 'text', value: book.author || '', suggestions: authorSugg,
        hint: origAuthor && origAuthor !== (book.author || '') ? t('Original: {v}', { v: origAuthor }) : '' },
    ],
    okText: t('Guardar'),
  });
  if (!res) return false;
  // Vacío = el del fichero: un libro sin título no se encuentra ni se distingue.
  const title = (res.title || '').trim() || origTitle;
  const author = (res.author || '').trim();
  if (title === book.title && author === (book.author || '')) return false;
  // metaAt: sello propio del título/autor, para que en el sync no lo pise otro dispositivo
  // que solo avanzó de página (sync/merge.js · stamped).
  await Store.updateBook(book.id, { title, author, origTitle, origAuthor, metaAt: Date.now() });
  window.dispatchEvent(new CustomEvent('book:renamed', { detail: { id: book.id, title, author } }));
  return true;
}
