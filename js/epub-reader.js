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

// Re-measure the container and re-paginate. The height tracks the container
// (rendered at '100%'), but the width is pinned to the column width and must be
// re-applied so the page stays centered and capped on viewport changes:
// rotation, mobile URL-bar show/hide, PWA window resize, column-width setting.
function resizeToContainer() {
  if (!rendition) return;
  const container = document.getElementById('epub-container');
  if (!container) return;
  const s = Settings.getAll();
  const viewWidth = s.columnWidth + 60;
  sizeContainer(container, viewWidth);
  // Use the actual (possibly capped at 100%) width so the rendition matches the
  // container exactly on narrow screens — otherwise epub.js paginates wider than
  // the visible area and the page is cut off horizontally.
  rendition.resize(container.clientWidth, container.clientHeight);
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

// Pin the epub container to the exact rendition width and center it, capping at
// the available viewport so it never overflows on narrow screens.
function sizeContainer(container, viewWidth) {
  container.style.width = viewWidth + 'px';
  container.style.maxWidth = '100%';
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

  const settings = Settings.getAll();
  const viewWidth = settings.columnWidth + 60;

  // The container MUST be exactly as wide as the rendition. epub.js positions
  // each paginated page by translating the iframe; if the container is wider
  // than the view width, the page offset no longer lands on a column boundary
  // and a sliver of the adjacent page leaks in (the "2 columns" bug). On narrow
  // screens the container caps at 100%, so read the rendered width back.
  sizeContainer(container, viewWidth);
  const renderWidth = container.clientWidth;

  // Height as a percentage so epub.js tracks the container: a fixed pixel height
  // gets baked into the view and never re-fits (resize/re-display won't change
  // it in 0.3.93), so the page is cut off when the viewport height changes.
  rendition = book.renderTo(container, {
    width: renderWidth,
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
    light:  { bg: '#ffffff', text: '#1c1d22' },
    sepia:  { bg: '#f7f1e3', text: '#4a3f33' },
    dark:   { bg: '#0f1117', text: '#e6e8ec' },
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
    ? 'Georgia, serif'
    : settings.fontFamily === 'sans-serif'
      ? '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
      : 'monospace';
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
    // Typography + colors only. Do NOT set max-width / margin / padding on
    // body: epub.js drives the CSS multi-column pagination off the body
    // dimensions, and overriding them misaligns the page offset so a sliver
    // of the next page leaks in (the "2 columns" bug).
    style.textContent = `
      html, body {
        background: ${colors.bg} !important;
        color: ${colors.text} !important;
      }
      body {
        font-family: ${fontFamily} !important;
        font-size: ${settings.fontSize}px !important;
        line-height: ${settings.lineHeight} !important;
      }
      p, div, span, li, h1, h2, h3, h4, h5, h6, a, blockquote, td, th {
        color: ${colors.text} !important;
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
