const CACHE_NAME = 'bookreader-v119';
const ASSETS = [
  './',
  './index.html',
  './js/analytics.js',
  './auth/callback.html',
  './auth/callback.js',
  './js/sync/schema.js',
  './js/sync/merge.js',
  './js/sync/engine.js',
  './js/sync/aliases.js',
  './js/pdf-locate.js',
  './js/pdf-axis-lock.js',
  './js/nav-debug.js',
  './js/sync/recovery.js',
  './js/sync/drive-auth.js',
  './js/sync/drive-provider.js',
  './js/sync/net.js',
  './js/sync/layout.js',
  './js/sync/drive-sync.js',
  './js/sync/library-sync.js',
  './js/sync/blobs.js',
  './css/main.css',
  './css/main-late.css',
  './css/agent.css',
  './css/reader.css',
  './css/themes.css',
  './css/fonts.css',
  './fonts/inter-400.woff2',
  './fonts/inter-500.woff2',
  './fonts/inter-600.woff2',
  './fonts/source-serif-4-400.woff2',
  './fonts/source-serif-4-600.woff2',
  // Literata: la serif de lectura POR DEFECTO. Precacheada a propósito — mientras se pedía a
  // Google Fonts llegaba tarde en frío y el capítulo se re-maquetaba con el lector ya dentro,
  // moviéndole la página hacia atrás. Solo el subconjunto `latin`, que es el que usa casi todo
  // libro; `latin-ext` y las cursivas de ese subconjunto se cachean al primer uso (cache-first,
  // mismo origen), que es barato y evita meter 65 KB más en el precache de todos.
  './fonts/literata-latin.woff2',
  './fonts/literata-italic-latin.woff2',
  './js/app.js',
  './js/css-loader.js',
  './js/ui/raf.js',
  './js/ui/frame-rect.js',
  './js/ui/selection-engine.js',
  './js/vendor-loader.js',
  './js/ai/sheet-height.js',
  './js/ai/gateway-repair.js',
  './js/i18n.js',
  './js/storage.js',
  './js/license.js',
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
  './js/ai/mic.js',
  './js/ai/dictation-engine.js',
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
  './js/ai/mindmap-render.js',
  './js/ai/jobs.js',
  './js/ai/jobs-ui.js',
  './js/ai/studio.js',
  './js/ai/toast.js',
  './js/ai/anki-export.js',
  './js/ai/srs.js',
  './js/ai/study.js',
  './js/region-select.js',
  './js/pdf-text-select.js',
  './js/pdf-touch-select.js',
  './js/ai/feynman.js',
  './js/ai/math.js',
  './js/ai/catalog.js',
  './js/ui/text.js',
  './js/ui/when.js',
  './js/ui/icons.js',
  './js/ui/escape.js',
  './js/ui/svg-fonts.js',
  './js/ui/dialog.js',
  './js/ui/paywall.js',
  './js/ui/app-settings.js',
  './js/library/store.js',
  './js/library/view.js',
  './js/library/shelves.js',
  './vendor/jszip-3.10.1.min.js',
  './vendor/epub-0.3.93.min.js',
  './vendor/pdf-3.11.174.min.js',
  './vendor/pdf.worker-3.11.174.min.js',
  './vendor/sql-wasm-1.13.0.min.js',
  './vendor/sql-wasm-1.13.0.wasm',
  // Temml solo se carga cuando aparece una fórmula, pero se precachea para que ese momento
  // también funcione sin red (es un lector offline: la primera fórmula puede ser en el metro).
  './vendor/temml-0.13.3.min.js',
  './css/temml.css',
  './css/Temml.woff2',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png'
];

// DOS cachés, a propósito:
//
//   CACHE_NAME     versionada a mano por despliegue. Código de la app.
//   STATIC_CACHE   permanente. SOLO vendor/, que va versionado EN EL NOMBRE del fichero
//                  (pdf-3.11.174.min.js): dos versiones distintas nunca comparten URL,
//                  así que no hay nada que invalidar y guardarlo para siempre es exacto.
//
// Antes había una sola, y `activate` la purgaba entera en cada despliegue: cambiar una
// línea de un .js obligaba a volver a bajar pdf.worker (1 MB), sql-wasm.wasm (648 KB) y
// el resto de vendor. 2,5 MB reconstruidos para no cambiar ninguno de ellos.
//
// Lo que NO entra en la permanente, y es deliberado: fuentes e iconos (sus nombres NO
// llevan versión: cambiar icon-192.png reutiliza la URL, y en una caché permanente
// cache-first el icono viejo se quedaría para siempre), y build.json/manifest.json, que
// cambian sin cambiar de nombre —build.json lleva el commit desplegado, que es justo lo
// que comprueba el humo—. Todo eso sigue en la caché versionada, que un despliegue
// renueva; son 116 KB de fuentes y unos iconos, no los megas que costaba vendor. El
// tráfico de esos sí se recorta, pero por cabeceras HTTP (ver `_headers`).
const STATIC_CACHE = 'bookreader-static';

function esAssetVersionado(pathname) {
  return /\/vendor\//.test(pathname);
}

self.addEventListener('install', (event) => {
  event.waitUntil(Promise.all([
    caches.open(CACHE_NAME).then(c => precache(c, ASSETS.filter(u => !esAssetVersionado(u)))),
    caches.open(STATIC_CACHE).then(c => precache(c, ASSETS.filter(esAssetVersionado), { soloSiFalta: true })),
  ]));
  self.skipWaiting();
});

// Uno a uno, no `addAll`. addAll es ATÓMICO: un solo recurso que falle —una entrada
// que quedó obsoleta al renombrar un fichero, un 404 puntual— aborta el precache
// ENTERO y deja al usuario sin NADA offline. En un lector offline eso es perder la
// app por perder un icono. Aquí un fallo cuesta ese recurso y ya; los demás se
// guardan igual, y lo que faltó se avisa en consola.
//
// Que la lista no se quede corta lo vigila tests/sw-precache.spec.ts: es a mano, y
// ya se había desincronizado (tres módulos en uso sin precachear).
//
// `soloSiFalta` es lo que hace barato el despliegue en la caché permanente: lo que ya
// está guardado bajo esa URL es, por definición, el mismo contenido, así que no se
// vuelve a pedir. Sin esto, dos cachés no ahorrarían nada.
async function precache(cache, urls, { soloSiFalta = false } = {}) {
  const fallidos = [];
  await Promise.all(urls.map(async (url) => {
    try {
      if (soloSiFalta && await cache.match(url)) return;
      await cache.add(url);
    } catch { fallidos.push(url); }
  }));
  if (fallidos.length) console.warn('[sw] no se pudieron precachear:', fallidos);
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      // Se purgan las generaciones VIEJAS de la caché de código. La permanente
      // (STATIC_CACHE) sobrevive: su contenido no puede quedar obsoleto sin cambiar
      // de URL, y rehacerla era el grueso del coste de cada despliegue.
      Promise.all(keys
        .filter(k => k !== CACHE_NAME && k !== STATIC_CACHE)
        .map(k => caches.delete(k)))
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
  const nombreCache = esAssetVersionado(p) ? STATIC_CACHE : CACHE_NAME;
  event.respondWith(
    caches.open(nombreCache).then(cache => isAppCode ? networkFirst(req, cache) : cacheFirst(req, cache)),
  );
});
