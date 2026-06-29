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

// Upper bound on the single-column reading width so lines stay legible on large
// desktop screens; smaller viewports (incl. phones in landscape) fill fully.
const MAX_READING_WIDTH = 960;

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

// Single column that fills the viewport width (so landscape uses the whole
// screen instead of a narrow centered column), capped at a legible max on large
// screens and centered with side margins.
function sizeContainer(container) {
  container.style.width = '100%';
  container.style.maxWidth = MAX_READING_WIDTH + 'px';
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
