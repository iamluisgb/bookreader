import { t } from './i18n.js';
import * as Settings from './settings.js';
import * as Bookmarks from './bookmarks.js';
import * as Highlights from './highlights.js';
import * as Storage from './storage.js';
import * as TouchSelect from './touch-select.js';

// En táctil reimplementamos la selección de texto (los tiradores nativos de
// epub.js están rotos en columnas). En escritorio usamos la selección nativa.
const COARSE = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

let book = null;
let rendition = null;
let currentCfi = null;
let restoredSaved = false;  // el open restauró lastPosition_ (manda sobre lastCfi de la biblioteca)
let onProgressCallback = null;
let onChapterCallback = null;
let lastChapterLabel = null;   // IA2: último capítulo emitido (para detectar cambio real)
let settingsListenerRegistered = false;

let resizeTimer = null;
// PIN de posición durante un giro/reflow. Mientras `pinnedCfi` no sea null, el handler
// 'relocated' NO mueve currentCfi: al re-paginar (giro de pantalla, cambio de modo de
// lectura) epub.js reporta el INICIO de página, que está ANTES de donde estabas, y eso
// arrastraría la posición atrás giro tras giro. El pin se fija en el CFI real y se
// mantiene hasta que el usuario NAVEGA de verdad (next/prev/goTo) — en paginado, entre
// giros la posición no cambia por ninguna otra vía. Sustituye a la antigua ventana
// temporal de 800 ms, que fallaba si el 'relocated' tardío llegaba pasado ese margen
// (típico en móviles lentos: el reflow asienta más tarde). Ver rotate.spec.ts.
let pinnedCfi = null;

// Libera el pin de posición (lo llama toda navegación real del usuario).
function releasePin() { pinnedCfi = null; clearTimeout(resizeTimer); resizeTimer = null; }

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

// Actividad de puntero DENTRO del iframe de lectura. Los eventos de ratón sobre el
// texto no llegan al document padre (iframe), así que los reemitimos para que el
// auto-ocultar de pantalla completa (escritorio) reaparezca al mover el ratón.
let onActivityCb = () => {};
export function onActivity(cb) { onActivityCb = cb || (() => {}); }

// ---- Toque sobre una imagen (abrir zoom) ----------------------------------
let onImageTapCb = () => {};
export function onImageTap(cb) { onImageTapCb = cb || (() => {}); }

// ---- Selección de texto (táctil) ------------------------------------------
let onSelectCb = () => {};
let onSelectDismissCb = () => {};
export function onSelect(cb) { onSelectCb = cb || (() => {}); }
export function onSelectionDismiss(cb) { onSelectDismissCb = cb || (() => {}); }
export function clearSelection() { try { TouchSelect.dismiss(); } catch (e) {} }
export function isCoarsePointer() { return COARSE; }

if (COARSE) {
  TouchSelect.configure({
    onTap: (zone) => onTapCb(zone),
    onImageTap: (img) => onImageTapCb(img),
    onSelect: (sel) => onSelectCb(sel),
    onDismiss: () => onSelectDismissCb(),
    onSwipeMove: (dx) => swipeMove(dx),
    onSwipeEnd: (dx) => swipeEnd(dx),
  });
}

// ---- Deslizamiento de página (táctil) --------------------------------------
// La página sigue al dedo (translateX de #epub-container, que es nuestro; epub.js
// pinta dentro). Al soltar: si se pasa el umbral, la página termina de salir, se
// cambia con epub.js (con la página fuera de pantalla) y la nueva entra desde el
// lado contrario; si no, vuelve (bounce). El hueco que se revela usa --page-bg
// (fondo real de la página) para que no se vea una franja de otro color.
let swipeBusy = false;
let lastSwipeX = null;   // último translate aplicado (px enteros)
let swipeRaf = 0;        // rAF pendiente (se pinta 1 vez por frame como mucho)
let swipePendingX = null;
let swipeTrail = [];     // muestras {x,t} recientes para detectar el flick al soltar
const SWIPE_TURN_MS = 190;
const SWIPE_JITTER = 3;      // px: temblor del dedo quieto que NO se repinta (anti-parpadeo)
const FLICK_VELOCITY = 0.35; // px/ms (~350 px/s): deslizamiento rápido que pasa página aunque sea corto
const FLICK_MIN_DX = 24;     // px mínimos para que un flick cuente como intención

function swipeBox() { return document.getElementById('epub-container'); }
// translate3d (no translateX): fuerza capa de composición en la GPU, así el iframe
// no se repinta en cada frame; clave para que el texto no parpadee al arrastrar.
function tx(x) { return `translate3d(${x}px,0,0)`; }

function swipeMove(dx) {
  if (swipeBusy) return;
  if (getReadingMode() === 'scroll') return;   // en scroll manda el desplazamiento vertical nativo
  const x = Math.round(dx);        // enteros: sin sub-píxel que tiemble
  trackSwipe(x);
  // Dedo (casi) quieto: el jitter de ±1-2px del sensor táctil alternaría el
  // transform en cada evento (hasta 120/s) y el texto parpadea. Banda muerta.
  if (lastSwipeX !== null && Math.abs(x - lastSwipeX) < SWIPE_JITTER) return;
  // Coalescer a 1 repintado por frame: touchmove dispara más rápido que el refresco.
  swipePendingX = x;
  if (swipeRaf) return;
  swipeRaf = requestAnimationFrame(() => {
    swipeRaf = 0;
    if (swipePendingX === null || swipeBusy) return;
    const c = swipeBox(); if (!c) return;
    lastSwipeX = swipePendingX;
    c.style.transition = 'none';
    c.style.transform = tx(swipePendingX);
    c.style.willChange = 'transform';
  });
}

// Ventana corta de muestras del arrastre: al soltar, la pendiente de la ventana
// da la velocidad (flick). Si el dedo se paró antes de soltar, la ventana queda
// vacía y la velocidad es 0 → decide solo la distancia.
function trackSwipe(x) {
  const t = performance.now();
  swipeTrail.push({ x, t });
  while (swipeTrail.length && t - swipeTrail[0].t > 160) swipeTrail.shift();
}

function swipeVelocity(xEnd) {
  const t = performance.now();
  const s = swipeTrail.find((p) => t - p.t <= 200);
  if (!s || t - s.t <= 0) return 0;
  return (xEnd - s.x) / (t - s.t);   // px/ms
}

function swipeCancelPending() {
  if (swipeRaf) { cancelAnimationFrame(swipeRaf); swipeRaf = 0; }
  swipePendingX = null;
}

async function swipeEnd(dx) {
  if (swipeBusy) return;           // animación en curso: ignora, no la interrumpas
  if (getReadingMode() === 'scroll') return;   // sin pasar página con swipe en modo scroll
  const c = swipeBox(); if (!c) return;
  swipeCancelPending();            // que un rAF rezagado no pise la animación de salida
  const w = c.clientWidth || window.innerWidth || 1;
  // Pasa página por DISTANCIA (recorrido corto, estilo Play Books) o por FLICK
  // (deslizamiento rápido aunque corto, en el mismo sentido que el recorrido).
  const v = swipeVelocity(Math.round(dx));
  const byDistance = Math.abs(dx) >= Math.min(60, w * 0.15);
  const byFlick = Math.abs(dx) >= FLICK_MIN_DX && Math.abs(v) >= FLICK_VELOCITY && (v < 0) === (dx < 0);
  if ((!byDistance && !byFlick) || !rendition) {   // no llega → vuelve
    await swipeAnimate(c, 0);
    swipeReset(c);
    return;
  }
  swipeBusy = true;
  const dir = dx < 0 ? 'next' : 'prev';
  await swipeAnimate(c, dir === 'next' ? -w : w);   // la actual termina de salir
  releasePin();   // navegación real del usuario: suelta el pin de giro para volver a seguir la posición
  try { await (dir === 'next' ? rendition.next() : rendition.prev()); } catch (e) { /* fin del libro */ }
  swipeSet(c, dir === 'next' ? w : -w);             // la nueva se coloca al otro lado
  void c.offsetWidth;                               // reflow para que anime
  await swipeAnimate(c, 0);                          // y entra
  swipeReset(c);
  swipeBusy = false;
}

function swipeSet(c, x) { if (c) { c.style.transition = 'none'; c.style.transform = tx(x); } }
function swipeReset(c) {
  swipeCancelPending();
  lastSwipeX = null;
  swipeTrail = [];
  if (c) { c.style.transition = 'none'; c.style.transform = ''; c.style.willChange = ''; }
}
function swipeAnimate(c, x) {
  return new Promise(res => {
    if (!c) { res(); return; }
    c.style.transition = `transform ${SWIPE_TURN_MS}ms cubic-bezier(.22,.61,.36,1)`;
    requestAnimationFrame(() => { c.style.transform = tx(x); });
    setTimeout(res, SWIPE_TURN_MS + 20);
  });
}

// Expone el fondo real de la página como variable CSS para que el hueco que se
// revela al arrastrar no muestre una franja de otro color (ver CSS de body.reading).
function syncPageBg() {
  try { document.documentElement.style.setProperty('--page-bg', getThemeColors().bg); } catch (e) { /* sin tema */ }
}

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
  return f < 0.2 ? 'prev' : f > 0.8 ? 'next' : 'center';
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
  doc.addEventListener('click', (e) => {
    if (Date.now() - lastTouchEnd < 700) return;    // clic sintetizado por touch
    if (hasSelection(win)) return;
    const img = e.target && e.target.closest && e.target.closest('img');
    if (img) { onImageTapCb(img); return; }         // clic en imagen → zoom
    onTapCb('click');
  });

  // Mover el ratón sobre el texto = actividad → reaparecen las barras en fullscreen.
  doc.addEventListener('mousemove', () => onActivityCb(), { passive: true });
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
    // Al girar la pantalla, rendition.resize() re-pagina pero epub.js conserva el
    // OFFSET visual, no la posición: a otro ancho ese mismo offset cae en otro punto
    // del texto (casi siempre antes) → parece que "salta varias páginas atrás".
    // Un giro real dispara una RÁFAGA de 'resize' (la animación, la barra del navegador),
    // así que fijamos el PIN al CFI del INICIO de la ráfaga (solo el primer evento) y lo
    // mantenemos hasta que el usuario navegue. Así ni los reflows intermedios ni un
    // 'relocated' tardío (que llega tras asentar, a veces mucho después en móviles
    // lentos) pueden mover currentCfi hacia atrás.
    if (pinnedCfi == null) pinnedCfi = currentCfi;
    resizeTimer = setTimeout(async () => {
      resizeTimer = null;
      resizeToContainer();
      updateReaderScale();
      if (pinnedCfi && rendition) {
        // display(pinnedCfi) muestra la página que CONTIENE el pin. Su 'relocated' (y
        // cualquiera posterior por el reflow) queda IGNORADO mientras el pin siga puesto,
        // así que currentCfi no deriva. El pin se libera en la próxima navegación real.
        try { await rendition.display(pinnedCfi); }
        catch (e) { /* CFI inválido tras el reflow */ }
        currentCfi = pinnedCfi;
        saveLastPosition();
      }
    }, 250);
  };
  window.addEventListener('resize', scheduleResize);
  window.addEventListener('orientationchange', scheduleResize);
}

// MÓVIL (estilo Play Books): las barras son overlay y por defecto están ocultas
// (texto a pantalla completa). Al MOSTRARLAS no tapamos ni re-paginamos el texto:
// ENCOGEMOS visualmente el área de lectura (transform scale sobre #reader-viewport)
// para que la MISMA página quepa entre las barras. Como es solo transform, epub.js NO
// re-pagina → el texto de la página no cambia y no se pierde la posición. La escala va
// en el viewport (ancestro), no en #epub-container, para no chocar con el swipe. En
// escritorio no aplica (allí las barras van en flujo / fullscreen).
export function updateReaderScale() {
  const vp = document.getElementById('reader-viewport');
  if (!vp) return;
  // El encogido del viewport es un truco SOLO para el texto EPUB paginado (que quepa entre
  // las barras). Con un PDF a la vista, el pdf-container es hijo del viewport: escalarlo
  // deformaría/encogería el PDF. En PDF no se toca el viewport (las barras son overlay).
  const pdf = document.getElementById('pdf-container');
  if (pdf && pdf.style.display && pdf.style.display !== 'none') {
    vp.style.transform = ''; vp.style.transformOrigin = ''; return;
  }
  const b = document.body.classList;
  // En modo scroll no encogemos el texto: el contenido se desplaza en vertical y las barras
  // (si se muestran) reservan hueco por CSS. Encoger rompería las métricas de scroll.
  const barsShown = COARSE && b.contains('reading') && !b.contains('immersive') && getReadingMode() !== 'scroll';
  if (!barsShown) { vp.style.transform = ''; vp.style.transformOrigin = ''; return; }
  const header = document.getElementById('reader-header');
  const footer = document.getElementById('reader-footer');
  const H = vp.clientHeight || window.innerHeight || 1;
  const hH = header ? header.offsetHeight : 0;
  const fH = footer ? footer.offsetHeight : 0;
  const s = Math.max(0.5, (H - hH - fH) / H);
  vp.style.transformOrigin = '50% 0';
  vp.style.transform = `translateY(${hH}px) scale(${s})`;
}

// ---- Modo de lectura: paginado vs scroll continuo -------------------------
// Se recuerda POR LIBRO (mismo id que lastPosition_), default 'paginated'. El scroll
// continuo es mejor para libros técnicos (code blocks, tablas, figuras sin cortes).
function bookKey() {
  try { return (book && book.key) ? book.key() : 'default'; } catch (e) { return 'default'; }
}

export function getReadingMode() {
  return Storage.get('readingMode_' + bookKey(), 'paginated') === 'scroll' ? 'scroll' : 'paginated';
}

export function setReadingMode(mode) {
  const m = mode === 'scroll' ? 'scroll' : 'paginated';
  Storage.set('readingMode_' + bookKey(), m);
  applyReadingMode();
}

// Aplica el modo al rendition EN CALIENTE: epub.js 0.3.93 permite cambiar el flujo sin
// recrear el rendition, así que se conservan listeners (selected/relocated/rendered) y
// anotaciones. Re-anclamos al CFI actual (el cambio de flujo resetea el scroll).
export function applyReadingMode() {
  const mode = getReadingMode();
  document.body.classList.toggle('scroll-mode', mode === 'scroll');
  if (!rendition) return;
  const cfi = currentCfi;
  try { rendition.flow(mode === 'scroll' ? 'scrolled-doc' : 'paginated'); } catch (e) { /* flow no disponible */ }
  updateReaderScale();
  if (cfi) {
    pinnedCfi = cfi;   // fija hasta la próxima navegación (ignora el relocated del re-display)
    Promise.resolve(rendition.display(cfi)).catch(() => {});
  }
  window.dispatchEvent(new CustomEvent('reader:flow-changed'));
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

// ¿El open restauró la posición guardada (lastPosition_)? La usa openBookRecord para
// NO pisarla con el lastCfi de la biblioteca, que va con rebote y puede estar rancio
// (en móvil el rebote muere al cerrar la PWA). lastCfi queda solo como fallback.
export function restoredSavedPosition() {
  return restoredSaved;
}

export async function load(arrayBuffer, onProgress) {
  if (book) {
    try { await book.destroy(); } catch(e) { console.warn('Destroy error:', e); }
    book = null;
    rendition = null;
  }
  lastChapterLabel = null;   // IA2: nuevo libro → reinicia el seguimiento de capítulo
  pinnedCfi = null;
  restoredSaved = false;

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
  syncPageBg();

  // Width AND height as percentages so epub.js tracks the container and re-fits
  // on viewport changes (rotation, URL-bar, resize). spread:'none' keeps a
  // single column; the container fills the width so landscape uses the screen.
  // Modo de lectura recordado para ESTE libro (paginado por defecto; scroll para técnicos).
  const readingMode = getReadingMode();
  document.body.classList.toggle('scroll-mode', readingMode === 'scroll');
  rendition = book.renderTo(container, {
    width: '100%',
    height: '100%',
    spread: 'none',
    flow: readingMode === 'scroll' ? 'scrolled-doc' : 'paginated'
  });

  // Sandbox del iframe de contenido (defensa de la API key BYOK, ver DECISIONS/CHANGELOG).
  // epub.js necesita `allow-same-origin` para paginar y para que nosotros inyectemos tema,
  // selección y navegación por teclado desde el documento padre. NO añadimos `allow-scripts`:
  // el combo `allow-same-origin allow-scripts` permitiría a un <script> DENTRO de un EPUB
  // malicioso leer `parent.localStorage` (la key) y, con connect-src abierto, exfiltrarla.
  // Sin `allow-scripts` ese script simplemente no corre. La paginación de texto reflowable no
  // usa scripts del propio EPUB, así que no perdemos funcionalidad (verificado en la suite).
  // Si algún día se soportan EPUB fixed-layout con JS, hacerlo opt-in explícito por libro.
  rendition.hooks.content.register((contents) => {
    const doc = contents.document;
    if (doc && doc.defaultView && doc.defaultView.frameElement) {
      const iframe = doc.defaultView.frameElement;
      const current = iframe.getAttribute('sandbox') || '';
      if (current.includes('allow-scripts')) {
        iframe.setAttribute('sandbox', current.replace(/\s*allow-scripts/g, '').trim());
      }
    }
    // Also inject theme directly into the content document
    injectThemeIntoContent(contents);
    // Táctil: módulo de selección propia (mantener pulsado = palabra, arrastrar
    // tiradores = extender) que además gestiona los toques de navegación.
    // Escritorio: selección nativa + toques/clics para navegar.
    if (COARSE) TouchSelect.attach(contents);
    else registerTapHandler(contents);

    // Flechas ←/→ para pasar página TAMBIÉN cuando el foco está dentro del iframe
    // de lectura (sus teclas no llegan al document padre, donde también se escuchan).
    // Se ignoran con modificadores (Alt+← = atrás del navegador, Shift+← = selección).
    doc.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
    });
  });

  // Restaurar la última posición de ESTE libro (guardada en cada 'relocated'
  // bajo lastPosition_<book.key()>, estable entre sesiones). Así recordamos
  // dónde íbamos abramos como abramos (archivo, arrastrar o biblioteca). Si el
  // CFI guardado ya no es válido, abrimos por el principio.
  let startCfi = null;
  try {
    const key = book.key ? book.key() : 'default';
    startCfi = Storage.get('lastPosition_' + key) || null;
  } catch (e) { /* sin posición guardada */ }
  try {
    await rendition.display(startCfi || undefined);
  } catch (e) {
    console.warn('CFI guardado no válido, abriendo al principio:', e);
    startCfi = null;
    await rendition.display();
  }
  restoredSaved = !!startCfi;
  console.log('Book displayed');

  // Track location changes
  rendition.on('relocated', (location) => {
    if (location && location.start) {
      // Con el PIN puesto (giro/reflow en curso) NO movemos currentCfi: la relocation
      // reporta el inicio de página y arrastraría la posición atrás (ver scheduleResize).
      if (pinnedCfi == null) { currentCfi = location.start.cfi; saveLastPosition(); }
      updateProgress(location);
    }
  });

  // Chapter change. Refresh currentCfi here too: 'relocated' may not have
  // fired yet when returning to an already-rendered (e.g. bookmarked) page,
  // so the bookmark button can read a stale CFI without this.
  rendition.on('rendered', () => {
    if (pinnedCfi == null) {
      try {
        const loc = rendition.currentLocation();
        if (loc && loc.start) currentCfi = loc.start.cfi;
      } catch (e) { /* currentLocation not ready yet */ }
    }
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
  syncPageBg();
  try {
    rendition.getContents().forEach((contents) => injectThemeIntoContent(contents));
  } catch (e) {
    console.warn('Could not apply theme to contents:', e);
  }
}

function getFontFamily(settings) {
  switch (settings.fontFamily) {
    case 'source-serif':                          // opción de lectura (Fase 2), no por defecto
      return "'Source Serif 4', Georgia, ui-serif, serif";
    case 'sans-serif':
      return '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    case 'monospace':
      return 'ui-monospace, Menlo, monospace';
    case 'serif':
    default:
      return "'Literata', ui-serif, Georgia, serif";   // por defecto (misma serif que hoy)
  }
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
  const pageEl = document.getElementById('progress-page');
  if (bar) bar.style.width = pct + '%';
  if (text) text.textContent = pct + '%';
  if (pageEl) {
    // "Página" por localizaciones de epub.js (~1024 chars cada una). Si el índice no
    // viene en la ubicación, se estima desde el porcentaje. Sin localizaciones aún: —.
    let total = 0;
    try { total = book.locations && book.locations.length ? book.locations.length() : 0; } catch (e) { /* sin locs */ }
    let cur = location.start.location || 0;
    if (!cur && total) cur = Math.max(1, Math.round((pct / 100) * total));
    pageEl.textContent = total ? t('Pág. {n} / {total}', { n: cur, total }) : '—';
  }

  if (onProgressCallback) onProgressCallback(pct);
}

// Salto por fracción [0..1] de la barra de progreso: convierte a CFI con las
// localizaciones y muestra esa parte del libro. No-op si aún no hay localizaciones.
export async function seekToFraction(f) {
  if (!rendition || !book) return;
  const frac = Math.min(1, Math.max(0, f));
  let cfi = null;
  try {
    if (book.locations && book.locations.cfiFromPercentage) cfi = book.locations.cfiFromPercentage(frac);
  } catch (e) { /* sin localizaciones */ }
  if (cfi) { try { await rendition.display(cfi); } catch (e) { /* CFI no válido */ } }
}

function updateChapterInfo() {
  if (!rendition || !book) return;
  const nav = book.navigation;
  if (!nav || !nav.toc) return;

  const location = rendition.currentLocation();
  if (!location || !location.start) return;

  const href = location.start.href;
  const chapter = nav.toc.find(t => t.href.includes(href));
  const label = chapter?.label?.trim();
  if (label && onChapterCallback) onChapterCallback(label);
  // IA2 · Emitir SOLO en cambio real de capítulo (updateChapterInfo se llama en cada
  // render). Lo escucha el panel para el repaso al terminar capítulo (Pepito Grillo).
  if (label && label !== lastChapterLabel) {
    lastChapterLabel = label;
    window.dispatchEvent(new CustomEvent('reader:chapter-changed', { detail: { label } }));
  }
}

function saveLastPosition() {
  if (book && currentCfi) {
    try {
      const key = book.key ? book.key() : 'default';
      Storage.set('lastPosition_' + key, currentCfi);
      // Sello para el LWW del sync (la posición es un escalar sin updatedAt propio)
      Storage.set('lastPositionAt_' + key, Date.now());
      window.dispatchEvent(new CustomEvent('bookreader:data-changed'));
    } catch(e) {
      console.warn('Could not save position:', e);
    }
  }
}

export function prev() {
  releasePin();
  if (rendition) rendition.prev();
}

export function next() {
  releasePin();
  if (rendition) rendition.next();
}

export async function goTo(cfi) {
  releasePin();
  if (!rendition) return;
  await rendition.display(cfi);
  // epub.js mal-pagina a veces el PRIMER display dentro de una sección larga recién
  // maquetada: calcula la posición antes de que asienten las columnas y el objetivo cae
  // en otra página (síntoma: las citas del agente no llevaban a la frase referida). Un
  // segundo display, ya con el layout estable, lo corrige — verificado E2E: 10/16 → 15/16
  // de citas caen en la página correcta. Barato: la sección ya está cargada; si el primero
  // acertó, el segundo es un no-op sin salto visible.
  await new Promise(r => requestAnimationFrame(() => r()));
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

// Nº de página (índice de localización de epub.js, ~1024 chars) y total, a partir de
// un CFI. Sirve para mostrar la página de un marcador. Devuelve null si aún no hay
// localizaciones generadas o el CFI no es resoluble.
export function getPageInfo(cfi) {
  try {
    if (!book || !book.locations || !book.locations.length) return null;
    const total = book.locations.length();
    if (!total) return null;
    let page = book.locations.locationFromCfi(cfi);
    if (page == null || page < 0) {
      // Sin índice directo: estimar por porcentaje.
      const pct = book.locations.percentageFromCfi(cfi);
      page = Math.max(1, Math.round(pct * total));
    }
    return { page: page || 1, total };
  } catch (e) {
    return null;
  }
}

export function getTitle() {
  return book?.packaging?.metadata?.title || t('Sin título');
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

// Recalcula el progreso desde la posición actual. Necesario tras restaurar la
// posición al abrir: el display() ocurre antes de generar las localizaciones,
// así que el % saldría 0 hasta moverse; lo refrescamos una vez generadas.
export function refreshProgress() {
  if (!rendition) return;
  try {
    const loc = rendition.currentLocation();
    if (loc && loc.start) updateProgress(loc);
  } catch (e) { /* currentLocation no lista */ }
}
