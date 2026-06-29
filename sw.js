const CACHE_NAME = 'bookreader-v5';
const ASSETS = [
  './',
  './index.html',
  './css/main.css',
  './css/reader.css',
  './css/themes.css',
  './js/app.js',
  './js/storage.js',
  './js/settings.js',
  './js/bookmarks.js',
  './js/highlights.js',
  './js/epub-reader.js',
  './js/pdf-reader.js',
  './js/ai/llm.js',
  './js/ai/segment.js',
  './js/ai/db.js',
  './js/ai/templates.js',
  './js/ai/markdown.js',
  './js/ai/panel.js',
  './js/ui/icons.js',
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

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then(response => response || fetch(event.request))
  );
});
