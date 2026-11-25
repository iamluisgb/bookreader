// Abrir un libro libre desde la propia URL: `/app/?sample=<id>`.
//
// Cinco clases de id, las cinco resueltas SOLO contra catálogos nuestros (una URL arbitraria en el
// enlace no se baja nunca: un enlace no puede meterle a nadie un fichero cualquiera en la biblioteca):
//   - `niebla`                   → muestra propia, fichero estático en `assets/muestra/` (manifest.json)
//   - `se:mary-shelley/frankenstein` → Standard Ebooks; el navegador lo baja de su web (manda CORS)
//   - `tec:progit-en`            → técnico con licencia abierta (`assets/muestra/tecnicos.json`): directo
//                                  si la fuente manda CORS, o por el Worker `bookreader-libros`
//   - `pg:2000`                  → Project Gutenberg (dominio público en España), por el Worker: su
//                                  espejo no manda CORS y www.gutenberg.org está caído para el lector
//   - `el:20`                    → Elejandría, por el Worker: su descarga exige `Referer`
// Los tres últimos se validan contra los ids del catálogo (`assets/muestra/catalogo.json`), que NO
// guarda los libros: solo la lista de ids que se pueden pedir y de dónde se baja cada uno
// (scripts/catalogo-libros.mjs). El `&t=` del enlace es solo el título del aviso, nunca una ruta.
//
// Una vez bajado, el fichero se envuelve en un `File` y va al MISMO `loadFile` que «Subir
// archivos». No hay estado nuevo: el `bookId` es el SHA-256 del contenido, así que si el libro ya
// estaba en la biblioteca se reabre (no se duplica). La marca de la URL se quita antes de cargar
// nada, así que recargar no vuelve a importar.
import { t } from './i18n.js';

const MANIFEST = new URL('../../assets/muestra/manifest.json', import.meta.url);
const CATALOGO = new URL('../../assets/muestra/catalogo.json', import.meta.url);
const WIKISOURCE = new URL('../../assets/muestra/wikisource.json', import.meta.url);
export const LIBROS_WORKER = 'https://bookreader-libros.luisgonzalezb93.workers.dev';
const TIPOS = { epub: 'application/epub+zip', pdf: 'application/pdf' };

export async function manifest() {
  const res = await fetch(MANIFEST);
  if (!res.ok) throw new Error(`manifiesto de muestra: ${res.status}`);
  const { books = [] } = await res.json();
  return books.map((b) => ({ ...b, href: new URL(b.url, MANIFEST).href }));
}

async function catalogo() {
  const res = await fetch(CATALOGO);
  if (!res.ok) throw new Error(`catálogo libre: ${res.status}`);
  return res.json();
}

// URL de descarga del EPUB de Standard Ebooks a partir de la ruta del libro en su web.
// `?source=download` pide el fichero; sin él devuelven la página de «gracias por descargar».
export function standardEbooksUrl(path) {
  return `https://standardebooks.org/ebooks/${path}/downloads/${path.replaceAll('/', '_')}.epub?source=download`;
}

// id → { title, href, file, type } o null si el id no está en ningún catálogo nuestro.
export async function resolve(id) {
  if (id.startsWith('se:')) {
    const path = id.slice(3);
    const book = (await catalogo()).se.find((b) => b.p === path);
    if (!book) return null;
    return { title: book.t, href: standardEbooksUrl(path), file: `${path.replaceAll('/', '_')}.epub`, type: TIPOS.epub };
  }
  if (id.startsWith('tec:')) {
    const key = id.slice(4);
    const book = (await catalogo()).tecnicos.find((b) => b.id === key);
    if (!book) return null;
    const href = book.via === 'proxy' ? `${LIBROS_WORKER}/libro/${encodeURIComponent(book.id)}` : book.url;
    return { title: book.title, href, file: `${book.id}.${book.format}`, type: TIPOS[book.format] || TIPOS.epub };
  }
  // Gutenberg y Elejandría: el id solo sirve si está en la lista blanca del catálogo, y la URL la
  // construye el Worker a partir de ese número (nunca se le pasa una URL).
  if (id.startsWith('pg:')) {
    const n = Number(id.slice(3));
    const c = await catalogo();
    if (!Number.isInteger(n) || !(c.pgIds || []).includes(n)) return null;
    return { title: `Gutenberg #${n}`, href: `${LIBROS_WORKER}/pg/${n}`, file: `gutenberg-${n}.epub`, type: TIPOS.epub };
  }
  if (id.startsWith('el:')) {
    const key = id.slice(3);
    const c = await catalogo();
    if (!/^\d+$/.test(key) || !(c.elIds || []).includes(key)) return null;
    // Algunas fichas solo ofrecen PDF (casi todas clásicos sin ePub): el catálogo lo dice para que
    // el fichero se abra con el lector correcto en vez de con el de EPUB.
    const pdf = (c.elPdfIds || []).includes(key);
    return {
      title: `Elejandría #${key}`,
      href: `${LIBROS_WORKER}/el/${key}`,
      file: `elejandria-${key}.${pdf ? 'pdf' : 'epub'}`,
      type: pdf ? TIPOS.pdf : TIPOS.epub,
    };
  }
  // Obras compuestas por nosotros a partir de Wikisource: el EPUB es un fichero estático del sitio,
  // con su atribución dentro (dc:source y dc:rights).
  if (id.startsWith('ws:')) {
    const key = id.slice(3);
    const res = await fetch(WIKISOURCE);
    if (!res.ok) return null;
    const { books = [] } = await res.json();
    const w = books.find((b) => b.id === key);
    if (!w) return null;
    return { title: w.title, href: new URL(w.file, WIKISOURCE).href, file: `${w.id}.${w.format || 'epub'}`, type: TIPOS[w.format] || TIPOS.epub };
  }
  const book = (await manifest()).find((b) => b.id === id);
  if (!book) return null;
  return { title: book.title, href: book.href, file: book.file || `${id}.epub`, type: TIPOS.epub };
}

export async function init(handle) {
  const url = new URL(location.href);
  const id = url.searchParams.get('sample');
  if (!id) return;
  // `t` es el título que manda la landing: no decide de dónde se baja nada, pero sí sirve para
  // nombrar el fichero (sin él, un libro de Gutenberg entraba en la biblioteca como «pg:1619»).
  const titulo = url.searchParams.get('t') || '';
  // La marca se quita YA: recargar no debe volver a importar lo mismo.
  url.searchParams.delete('sample');
  url.searchParams.delete('t');
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  let dismiss = () => {};
  try {
    const book = await resolve(id);
    if (!book) throw new Error(`no hay libro «${id}» en el catálogo`);
    // Los técnicos pesan hasta 40 MB: sin aviso, la espera parece la app colgada.
    const { toast } = await import('./ai/toast.js');
    dismiss = toast({ message: t('Descargando «{title}»…', { title: book.title }), timeout: 0 });
    // Un reintento: el Worker recién desplegado y las releases de GitHub dan a veces un fallo
    // suelto (medido: un 404 «error code: 1042» de Cloudflare que al segundo intento es 200).
    let res = await fetch(book.href).catch(() => null);
    if (!res?.ok) res = await fetch(book.href);
    if (!res.ok) throw new Error(`descarga del libro: ${res.status}`);
    const blob = await res.blob();
    dismiss();
    // El nombre del fichero es el título que verá el lector en su biblioteca. El del catálogo es el
    // id (`pg:1619.epub`), así que si la landing mandó título se usa ese, saneado: el nombre acaba
    // en IndexedDB y se pinta en la estantería.
    const ext = book.file.split('.').pop();
    const limpio = titulo.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    await handle(new File([blob], limpio ? `${limpio}.${ext}` : book.file, { type: book.type }));
  } catch (e) {
    dismiss();
    console.warn('Muestra: no se pudo abrir', id, e);
    const { alertBox } = await import('./ui/dialog.js');
    await alertBox(t('No se pudo abrir el libro. Comprueba la conexión e inténtalo otra vez.'));
  }
}
