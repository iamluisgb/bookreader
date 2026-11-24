// Abrir un libro de la muestra pública desde la propia URL: `/app/?sample=niebla`.
//
// Los libros de muestra viven como ficheros estáticos del sitio (`assets/muestra/`), listados en
// `assets/muestra/manifest.json`. Con `?sample=<id>` la app los pide por la red, los envuelve en un
// `File` y los pasa al MISMO `loadFile` que «Subir archivos»: el usuario pulsa en la página
// pública y el libro se abre, sin descargar nada al disco ni elegir fichero.
//
// No hay estado nuevo ni registro: si el libro ya estaba en la biblioteca, el `bookId` es el
// SHA-256 del contenido y se reabre (no se duplica). La marca de la URL se quita antes de cargar
// nada, así que recargar no vuelve a importar.

const MANIFEST = new URL('../../assets/muestra/manifest.json', import.meta.url);

export async function manifest() {
  const res = await fetch(MANIFEST);
  if (!res.ok) throw new Error(`manifiesto de muestra: ${res.status}`);
  const { books = [] } = await res.json();
  return books.map((b) => ({ ...b, href: new URL(b.url, MANIFEST).href }));
}

export async function init(handle) {
  const url = new URL(location.href);
  const id = url.searchParams.get('sample');
  if (!id) return;
  // La marca se quita YA: recargar no debe volver a importar lo mismo.
  url.searchParams.delete('sample');
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  try {
    const book = (await manifest()).find((b) => b.id === id);
    if (!book) throw new Error(`no hay libro de muestra «${id}» en el manifiesto`);
    const res = await fetch(book.href);
    if (!res.ok) throw new Error(`descarga del libro: ${res.status}`);
    const blob = await res.blob();
    const name = book.file || `${id}.epub`;
    await handle(new File([blob], name, { type: 'application/epub+zip' }));
  } catch (e) {
    console.warn('Muestra: no se pudo abrir', id, e);
    const { alertBox } = await import('./ui/dialog.js');
    await alertBox('No se pudo abrir el libro de muestra. Comprueba la conexión e inténtalo otra vez.');
  }
}
