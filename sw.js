// Service worker de retirada para el origen viejo (luisgonzalezbernal.com/bookreader).
//
// BookReader vive ahora en https://bookreader.raiatech.com. Quien instaló la PWA desde
// aquí tiene registrado el sw.js antiguo, que sirve la app desde caché: sin esto
// seguiría abriendo una copia congelada para siempre, sin llegar a ver la página
// de redirección ni enterarse de que hay un sitio nuevo.
//
// El navegador comprueba este fichero en cada navegación. Al encontrar un script
// distinto, instala este — que no cachea nada, se borra a sí mismo y recarga las
// ventanas abiertas para que caigan en la redirección.
//
// Va en la rama `gh-pages`, no en `main`: el sw.js de verdad es el de la app.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    } catch (e) { /* borrar la caché es deseable, no imprescindible */ }

    await self.registration.unregister();

    // Recargar lo que esté abierto: sin esto, la pestaña actual sigue viva con la
    // app vieja hasta que alguien la cierre, y el usuario no ve el cambio nunca.
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      try { await client.navigate(client.url); } catch (e) { /* ignora los que no dejan */ }
    }
  })());
});

// Nada se sirve desde caché: todo va a la red, que es donde está la redirección.
self.addEventListener('fetch', () => {});
