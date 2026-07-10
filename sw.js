// SW auto-destructor (migración: BookReader se movió de /bookreader/ a /bookreader/app/).
// Los usuarios que instalaron/visitaron la app cuando vivía en la raíz tienen registrado
// este `sw.js` con scope /bookreader/. Al comprobar actualización, el navegador descarga
// ESTE fichero nuevo: se limpia solo (desregistra + borra sus cachés) y recarga la pestaña,
// que ahora sirve el landing. NO toca IndexedDB, así que los libros, notas y tarjetas del
// usuario siguen intactos (IndexedDB es por-origen, no por-ruta). Cuando ya no queden
// clientes antiguos, este archivo se puede eliminar.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((c) => c.navigate(c.url));
  })());
});
