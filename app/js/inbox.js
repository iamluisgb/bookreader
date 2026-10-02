// Ficheros que llegan a BookReader desde FUERA de la app, sin pasar por «Subir archivos»:
//
//   - Share target (Android): «Compartir → BookReader» desde WhatsApp, Archivos, Gmail…
//     El sistema hace un POST multipart a ./share-target; el service worker guarda el
//     fichero en la caché INBOX y redirige a ./?inbox=1. Aquí se recoge. Va por caché y
//     no por postMessage porque, cuando llega el POST, la página aún no existe.
//   - File handler (Chrome de escritorio con la PWA instalada): doble clic en un .epub,
//     .pdf o .bookreader abre la app con el fichero en `launchQueue`.
//
// En los dos casos el fichero acaba en el mismo loadFile que «Subir archivos», así que
// un dossier pasa por su pantalla de revisión y un libro se abre como siempre.

export const INBOX = 'bookreader-inbox';

async function drain(handle) {
  if (!('caches' in window)) return;
  const cache = await caches.open(INBOX);
  for (const req of await cache.keys()) {
    const res = await cache.match(req);
    await cache.delete(req);   // antes de abrirlo: un fichero que rompe no se reintenta en bucle
    if (!res) continue;
    const name = decodeURIComponent(res.headers.get('X-File-Name') || 'fichero');
    const blob = await res.blob();
    await handle(new File([blob], name, { type: blob.type }));
  }
}

export function init(handle) {
  const url = new URL(location.href);
  if (url.searchParams.has('inbox')) {
    // La marca se quita YA: recargar no debe volver a importar lo mismo.
    url.searchParams.delete('inbox');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    drain(handle).catch(e => console.warn('No se pudo recoger el fichero compartido:', e));
  }
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      for (const fh of params.files || []) {
        try { await handle(await fh.getFile()); } catch (e) { console.warn('No se pudo abrir el fichero:', e); }
      }
    });
  }
}
