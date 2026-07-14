const CACHE_NAME = 'bookreader-v76';
const ASSETS = [
  './',
  './index.html',
  './auth/callback.html',
  './auth/callback.js',
  './js/sync/schema.js',
  './js/sync/merge.js',
  './js/sync/engine.js',
  './js/pdf-locate.js',
  './js/sync/recovery.js',
  './js/sync/drive-auth.js',
  './js/sync/drive-provider.js',
  './js/sync/layout.js',
  './js/sync/drive-sync.js',
  './css/main.css',
  './css/reader.css',
  './css/themes.css',
  './css/fonts.css',
  './fonts/inter-400.woff2',
  './fonts/inter-500.woff2',
  './fonts/inter-600.woff2',
  './fonts/source-serif-4-400.woff2',
  './fonts/source-serif-4-600.woff2',
  './js/app.js',
  './js/storage.js',
  './js/backup.js',
  './js/settings.js',
  './js/bookmarks.js',
  './js/highlights.js',
  './js/highlights-ui.js',
  './js/share-card.js',
  './js/search.js',
  './js/bookmarks-ui.js',
  './js/progress.js',
  './js/epub-reader.js',
  './js/touch-select.js',
  './js/image-zoom.js',
  './js/pdf-reader.js',
  './js/ai/llm.js',
  './js/ai/segment.js',
  './js/ai/segment-pdf.js',
  './js/ai/db.js',
  './js/ai/templates.js',
  './js/ai/custom-templates.js',
  './js/ai/profiles.js',
  './js/ai/markdown.js',
  './js/ai/render.js',
  './js/ai/attenuation.js',
  './js/ai/context.js',
  './js/ai/retrieval.js',
  './js/ai/query-expand.js',
  './js/ai/panel-template.js',
  './js/ai/panel.js',
  './js/ai/flashcards.js',
  './js/ai/summary.js',
  './js/ai/mindmap.js',
  './js/ai/jobs.js',
  './js/ai/jobs-ui.js',
  './js/ai/toast.js',
  './js/ai/anki-export.js',
  './js/ai/srs.js',
  './js/ai/study.js',
  './js/ui/icons.js',
  './js/ui/escape.js',
  './js/ui/dialog.js',
  './js/ui/app-settings.js',
  './js/library/store.js',
  './js/library/view.js',
  './vendor/jszip-3.10.1.min.js',
  './vendor/epub-0.3.93.min.js',
  './vendor/pdf-3.11.174.min.js',
  './vendor/pdf.worker-3.11.174.min.js',
  './vendor/sql-wasm-1.13.0.min.js',
  './vendor/sql-wasm-1.13.0.wasm',
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

// Estrategia por tipo de recurso (solo GET http(s) del mismo origen; el POST al LLM, los
// blob: del lector y cualquier tercero pasan directos al navegador):
//
//  - CÓDIGO DE LA APP (navegaciones + HTML/JS/CSS propios): NETWORK-FIRST con fallback a
//    caché. Antes con stale-while-revalidate un despliegue podía servir una MEZCLA de
//    módulos de dos generaciones (unos revalidados, otros no) → la app quedaba medio rota
//    tras actualizar (p. ej. paginación/scroll sin responder). Network-first garantiza que,
//    estando online, se sirve SIEMPRE la última versión y COHERENTE; offline sigue desde caché.
//  - LIBS Y ASSETS INMUTABLES (vendor/, fuentes, iconos, wasm): CACHE-FIRST. Van versionados
//    por nombre de archivo (p. ej. pdf-3.11.174.min.js): solo cambian al añadir uno nuevo, lo
//    que ya obliga a bumpear CACHE_NAME. Cache-first = arranque rápido y offline.
function isImmutableAsset(pathname) {
  return /\/(?:vendor|fonts|icons)\//.test(pathname) || /\.(?:woff2?|wasm|png|svg|json)$/.test(pathname);
}

async function networkFirst(req, cache) {
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    // Sin red: caché exacta, y para navegaciones el fallback al shell (index.html).
    return (await cache.match(req)) || (req.mode === 'navigate'
      ? (await cache.match('./index.html')) || (await cache.match('./'))
      : undefined) || Response.error();
  }
}

async function cacheFirst(req, cache) {
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (req.method !== 'GET' || url.origin !== self.location.origin || !url.protocol.startsWith('http')) {
    return;
  }
  const p = url.pathname;
  const isAppCode = !isImmutableAsset(p) &&
    (req.mode === 'navigate' || p.endsWith('/') || /\.(?:html|js|css)$/.test(p));
  event.respondWith(
    caches.open(CACHE_NAME).then(cache => isAppCode ? networkFirst(req, cache) : cacheFirst(req, cache)),
  );
});
