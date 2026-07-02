const CACHE_NAME = 'bookreader-v41';
const ASSETS = [
  './',
  './index.html',
  './css/main.css',
  './css/reader.css',
  './css/themes.css',
  './js/app.js',
  './js/storage.js',
  './js/backup.js',
  './js/settings.js',
  './js/bookmarks.js',
  './js/highlights.js',
  './js/highlights-ui.js',
  './js/bookmarks-ui.js',
  './js/progress.js',
  './js/epub-reader.js',
  './js/touch-select.js',
  './js/image-zoom.js',
  './js/pdf-reader.js',
  './js/ai/llm.js',
  './js/ai/segment.js',
  './js/ai/db.js',
  './js/ai/templates.js',
  './js/ai/custom-templates.js',
  './js/ai/profiles.js',
  './js/ai/markdown.js',
  './js/ai/render.js',
  './js/ai/attenuation.js',
  './js/ai/context.js',
  './js/ai/retrieval.js',
  './js/ai/panel-template.js',
  './js/ai/panel.js',
  './js/ui/icons.js',
  './js/ui/escape.js',
  './js/ui/app-settings.js',
  './js/library/store.js',
  './js/library/view.js',
  './vendor/jszip-3.10.1.min.js',
  './vendor/epub-0.3.93.min.js',
  './vendor/pdf-3.11.174.min.js',
  './vendor/pdf.worker-3.11.174.min.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Stale-while-revalidate para los assets propios: sirve de caché al instante y
// refresca en segundo plano, así que ya no hay que bumpear CACHE_NAME a mano para
// propagar cambios (el bump solo hace falta al añadir/quitar archivos del precache).
// Solo gestionamos GET http(s) del mismo origen; el POST al LLM, los blob: del
// lector y cualquier tercero pasan directos al navegador.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (req.method !== 'GET' || url.origin !== self.location.origin || !url.protocol.startsWith('http')) {
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
