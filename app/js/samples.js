// Abrir un libro libre desde la propia URL: `/app/?sample=<id>`.
//
// Tres clases de id, las tres resueltas SOLO contra catálogos nuestros (una URL arbitraria en el
// enlace no se baja nunca: un enlace no puede meterle a nadie un fichero cualquiera en la biblioteca):
//   - `niebla`                   → muestra propia, fichero estático en `assets/muestra/` (manifest.json)
//   - `se:mary-shelley/frankenstein` → Standard Ebooks; el navegador lo baja de su web (manda CORS)
//   - `tec:progit-en`            → técnico con licencia abierta (`assets/muestra/tecnicos.json`): directo
//                                  si la fuente manda CORS, o por el Worker `bookreader-libros`, que
//                                  reenvía sin guardar (workers/libros)
// Los dos últimos viven en `assets/muestra/catalogo.json` (scripts/catalogo-libros.mjs). Ningún
// libro del catálogo se guarda en este sitio: se baja de su fuente en el navegador del lector.
//
// Una vez bajado, el fichero se envuelve en un `File` y va al MISMO `loadFile` que «Subir
// archivos». No hay estado nuevo: el `bookId` es el SHA-256 del contenido, así que si el libro ya
// estaba en la biblioteca se reabre (no se duplica). La marca de la URL se quita antes de cargar
// nada, así que recargar no vuelve a importar.
import { t } from './i18n.js';

const MANIFEST = new URL('../../assets/muestra/manifest.json', import.meta.url);
const CATALOGO = new URL('../../assets/muestra/catalogo.json', import.meta.url);
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
  const book = (await manifest()).find((b) => b.id === id);
  if (!book) return null;
  return { title: book.title, href: book.href, file: book.file || `${id}.epub`, type: TIPOS.epub };
}

export async function init(handle) {
  const url = new URL(location.href);
  const id = url.searchParams.get('sample');
  if (!id) return;
  // La marca se quita YA: recargar no debe volver a importar lo mismo.
  url.searchParams.delete('sample');
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
    await handle(new File([blob], book.file, { type: book.type }));
  } catch (e) {
    dismiss();
    console.warn('Muestra: no se pudo abrir', id, e);
    const { alertBox } = await import('./ui/dialog.js');
    await alertBox(t('No se pudo abrir el libro. Comprueba la conexión e inténtalo otra vez.'));
  }
}
