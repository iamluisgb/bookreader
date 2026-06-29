import * as Settings from './settings.js';
import * as Bookmarks from './bookmarks.js';
import * as Highlights from './highlights.js';
import * as Storage from './storage.js';

let book = null;
let rendition = null;
let currentCfi = null;
let onProgressCallback = null;
let onChapterCallback = null;
let settingsListenerRegistered = false;

let resizeTimer = null;

// Re-apply the container width and re-fit. Width/height both track the
// container (rendered at '100%'), so this mainly re-applies the max-width cap;
// epub.js itself re-fits on viewport changes (rotation, URL-bar, PWA resize).
function resizeToContainer() {
  if (!rendition) return;
  const container = document.getElementById('epub-container');
  if (!container) return;
  sizeContainer(container);
  rendition.resize(container.clientWidth, container.clientHeight);
}

// Re-paginar al cambiar el tamaño del área de lectura (p. ej. al entrar/salir
// del modo inmersivo, que libera el alto de la cabecera y el pie).
export function resize() {
  resizeToContainer();
}

// ---- Navegación táctil sobre el contenido ---------------------------------
let onTapCb = () => {};
export function onTap(cb) { onTapCb = cb || (() => {}); }

function hasSelection(win) {
  try { return !!(win.getSelection && win.getSelection().toString().trim()); } catch (e) { return false; }
}
function tapZone(x) {
  // epub.js dispone las páginas en una tira horizontal y traslada el contenido,
  // así que clientX incluye el desplazamiento de la página (p. ej. 2*ancho + x).
  // La posición DENTRO de la página visible es clientX % anchoPágina, y el ancho
  // de página = ancho del contenedor (estable, leído desde el documento padre).
  const cont = document.getElementById('epub-container');
  const w = (cont && cont.clientWidth) || window.innerWidth || 1;
  const within = ((x % w) + w) % w;
  const f = within / w;
  return f < 0.28 ? 'prev' : f > 0.72 ? 'next' : 'center';
}

// Distingue un toque (navegar) de una selección (mantener pulsado / arrastrar)
// y de un scroll. Se registra en cada iframe de contenido que crea epub.js.
function registerTapHandler(contents) {
  const doc = contents.document, win = contents.window;
  let sx = 0, sy = 0, st = 0, moved = false, lastTouchEnd = 0;

  doc.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { moved = true; return; }
    const t = e.touches[0]; sx = t.clientX; sy = t.clientY; st = Date.now(); moved = false;
  }, { passive: true });

  doc.addEventListener('touchmove', (e) => {
    const t = e.touches[0]; if (!t) return;
    if (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10) moved = true;
  }, { passive: true });

  doc.addEventListener('touchend', (e) => {
    lastTouchEnd = Date.now();
    if (moved || Date.now() - st > 500) return;     // arrastre o pulsación larga
    if (hasSelection(win)) return;                  // hubo selección → no navegar
    const t = e.changedTouches[0]; if (!t) return;
    onTapCb(tapZone(t.clientX));
  }, { passive: true });

  // Escritorio: un clic en el libro (no sintetizado por un toque) solo sirve
  // para cerrar la barra de selección, no para navegar.
  doc.addEventListener('click', () => {
    if (Date.now() - lastTouchEnd < 700) return;    // clic sintetizado por touch
    if (hasSelection(win)) return;
    onTapCb('click');
  });
}

export function init() {
  if (settingsListenerRegistered) return;
  settingsListenerRegistered = true;
  window.addEventListener('settings:changed', (e) => {
    // Resize first so epub.js re-paginates, then re-apply theme to the new frames
    resizeToContainer();
    applyTheme();
  });

  // Re-paginate on any viewport change (debounced). Covers rotation, the mobile
  // browser chrome collapsing/expanding, and resizing the standalone PWA window.
  const scheduleResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resizeToContainer, 150);
  };
  window.addEventListener('resize', scheduleResize);
  window.addEventListener('orientationchange', scheduleResize);
}

// Single column that fills the viewport width up to the user's column-width
// setting (the "Ancho de columna" slider), centered with side margins. On
// screens narrower than the setting (e.g. a phone) it just fills the width.
function sizeContainer(container) {
  const cols = Settings.getAll().columnWidth;
  // Como Play Books: en móvil (incl. horizontal) la página llena el ancho con un
  // margen mínimo; el "Ancho de columna" solo limita la longitud de línea en
  // pantallas grandes (escritorio / tablet ancha), donde las líneas largas cansan.
  const vw = window.innerWidth;
  const maxWidth = vw > 1000 ? cols : Math.max(cols, vw);
  container.style.width = '100%';
  container.style.maxWidth = maxWidth + 'px';
  container.style.margin = '0 auto';
}

export function isLoaded() {
  return book !== null;
}

export function getCurrentCfi() {
  return currentCfi;
}

export async function load(arrayBuffer, onProgress) {
  if (book) {
    try { await book.destroy(); } catch(e) { console.warn('Destroy error:', e); }
    book = null;
    rendition = null;
  }

  console.log('Creating ePub book from ArrayBuffer...');
  book = ePub(arrayBuffer);

  console.log('Waiting for book.ready...');
  await book.ready;
  console.log('Book ready');

  const container = document.getElementById('epub-container');
  container.innerHTML = '';
  container.style.display = 'block';
  document.getElementById('landing').style.display = 'none';
  document.getElementById('pdf-container').style.display = 'none';

  console.log('Rendering book...');

  sizeContainer(container);

  // Width AND height as percentages so epub.js tracks the container and re-fits
  // on viewport changes (rotation, URL-bar, resize). spread:'none' keeps a
  // single column; the container fills the width so landscape uses the screen.
  rendition = book.renderTo(container, {
    width: '100%',
    height: '100%',
    spread: 'none',
    flow: 'paginated'
  });

  // Fix sandbox on every new content iframe epub.js creates
  rendition.hooks.content.register((contents) => {
    const doc = contents.document;
    if (doc && doc.defaultView && doc.defaultView.frameElement) {
      const iframe = doc.defaultView.frameElement;
      const current = iframe.getAttribute('sandbox') || '';
      if (!current.includes('allow-scripts')) {
        iframe.setAttribute('sandbox', current + ' allow-scripts');
      }
    }
    // Also inject theme directly into the content document
    injectThemeIntoContent(contents);
    // Navegación táctil sobre el propio contenido (sin capa que bloquee la
    // selección): toque rápido en bordes = pasar página, centro = pantalla
    // completa; mantener pulsado / arrastrar = seleccionar.
    registerTapHandler(contents);
  });

  await rendition.display();
  console.log('Book displayed');

  // Track location changes
  rendition.on('relocated', (location) => {
    if (location && location.start) {
      currentCfi = location.start.cfi;
      updateProgress(location);
      saveLastPosition();
    }
  });

  // Chapter change. Refresh currentCfi here too: 'relocated' may not have
  // fired yet when returning to an already-rendered (e.g. bookmarked) page,
  // so the bookmark button can read a stale CFI without this.
  rendition.on('rendered', () => {
    try {
      const loc = rendition.currentLocation();
      if (loc && loc.start) currentCfi = loc.start.cfi;
    } catch (e) { /* currentLocation not ready yet */ }
    updateChapterInfo();
  });

  return book;
}

function getThemeColors() {
  // En modo "sistema" (sin data-theme) resolvemos según prefers-color-scheme.
  let theme = document.documentElement.getAttribute('data-theme');
  if (!theme || theme === 'system') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  const themes = {
    light:  { bg: '#ffffff', text: '#1c1c1e' },
    sepia:  { bg: '#fbf6ea', text: '#4a3f33' },
    dark:   { bg: '#1c1c1e', text: '#f2f2f7' },
  };
  return themes[theme] || themes.light;
}

// Single source of truth for theming: re-inject the same <style> into every
// iframe epub.js currently has rendered. New iframes are handled by the
// rendition.hooks.content registration in load().
function applyTheme() {
  if (!rendition) return;
  try {
    rendition.getContents().forEach((contents) => injectThemeIntoContent(contents));
  } catch (e) {
    console.warn('Could not apply theme to contents:', e);
  }
}

function getFontFamily(settings) {
  return settings.fontFamily === 'serif'
    ? "'Literata', ui-serif, Georgia, serif"   // misma serif que Google Play Books
    : settings.fontFamily === 'sans-serif'
      ? '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
      : 'ui-monospace, Menlo, monospace';
}

function injectThemeIntoContent(contents) {
  const settings = Settings.getAll();
  const colors = getThemeColors();
  const fontFamily = getFontFamily(settings);

  try {
    const doc = contents.document;
    if (!doc || !doc.head) return;

    // Remove old theme style if exists
    const oldStyle = doc.getElementById('bookreader-theme');
    if (oldStyle) oldStyle.remove();

    const style = doc.createElement('style');
    style.id = 'bookreader-theme';
    const isSerif = settings.fontFamily === 'serif';
    // No tocar el ancho ni el padding HORIZONTAL del body: epub.js calcula la
    // paginación multi-columna a partir del ancho del body y alterarlo deja
    // colarse una franja de la página siguiente (el bug de "2 columnas"). Sí
    // reducimos el padding VERTICAL para aprovechar la altura (sobre todo en
    // horizontal). line-height y font-family se fuerzan también en los párrafos
    // porque muchos EPUB los fijan en su propio CSS y ganarían al de body.
    style.textContent = `
      ${isSerif ? "@import url('https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,400;0,7..72,600;1,7..72,400;1,7..72,600&display=swap');" : ''}
      html, body {
        background: ${colors.bg} !important;
        color: ${colors.text} !important;
      }
      body {
        font-family: ${fontFamily} !important;
        font-size: ${settings.fontSize}px !important;
        line-height: ${settings.lineHeight} !important;
        padding: 6px 16px !important;   /* margen mínimo tipo Play Books */
        -webkit-touch-callout: none;    /* evita el menú nativo de iOS al seleccionar */
      }
      p, div, span, li, h1, h2, h3, h4, h5, h6, a, blockquote, td, th, em, strong, i, b {
        color: ${colors.text} !important;
        font-family: ${fontFamily} !important;
        line-height: ${settings.lineHeight} !important;
      }
      p { margin-bottom: 0.8em !important; }
    `;
    doc.head.appendChild(style);
    doc.body.style.background = colors.bg;
  } catch(e) {
    console.warn('Could not inject theme into content:', e);
  }
}

function updateProgress(location) {
  if (!book || !location || !location.start) return;

  let pct = 0;
  try {
    if (book.locations && book.locations.percentageFromCfi) {
      pct = Math.round(book.locations.percentageFromCfi(location.start.cfi) * 100);
    }
  } catch(e) {
    // Locations not generated yet
  }

  const bar = document.getElementById('progress-bar');
  const text = document.getElementById('progress-text');
  if (bar) bar.style.width = pct + '%';
  if (text) text.textContent = pct + '%';

  if (onProgressCallback) onProgressCallback(pct);
}

function updateChapterInfo() {
  if (!rendition || !book) return;
  const nav = book.navigation;
  if (!nav || !nav.toc) return;

  const location = rendition.currentLocation();
  if (!location || !location.start) return;

  const href = location.start.href;
  const chapter = nav.toc.find(t => t.href.includes(href));
  if (chapter && onChapterCallback) {
    onChapterCallback(chapter.label.trim());
  }
}

function saveLastPosition() {
  if (book && currentCfi) {
    try {
      const key = book.key ? book.key() : 'default';
      Storage.set('lastPosition_' + key, currentCfi);
    } catch(e) {
      console.warn('Could not save position:', e);
    }
  }
}

export function prev() {
  if (rendition) rendition.prev();
}

export function next() {
  if (rendition) rendition.next();
}

export async function goTo(cfi) {
  if (rendition) await rendition.display(cfi);
}

export function getRendition() {
  return rendition;
}

export function getBook() {
  return book;
}

export function getNavigation() {
  return book?.navigation || null;
}

export function getTitle() {
  return book?.packaging?.metadata?.title || 'Sin título';
}

export function getAuthor() {
  return book?.packaging?.metadata?.creator || '';
}

// Portada del epub como dataURL (para guardarla en la biblioteca). '' si no hay.
export async function getCoverDataUrl() {
  try {
    if (!book) return '';
    const url = await book.coverUrl();
    if (!url) return '';
    const blob = await fetch(url).then(r => r.blob());
    return await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => resolve('');
      fr.readAsDataURL(blob);
    });
  } catch { return ''; }
}

export function onProgress(cb) {
  onProgressCallback = cb;
}

export function onChapter(cb) {
  onChapterCallback = cb;
}

export function getCurrentChapterLabel() {
  if (!book || !rendition) return '';
  const nav = book.navigation;
  if (!nav || !nav.toc) return '';

  const location = rendition.currentLocation();
  if (!location || !location.start) return '';

  const href = location.start.href;
  const chapter = nav.toc.find(t => t.href.includes(href));
  return chapter ? chapter.label.trim() : '';
}

export async function generateLocations() {
  if (book) {
    await book.locations.generate(1024);
  }
}
