import { t } from './i18n.js';
import * as Settings from './settings.js';
import * as Bookmarks from './bookmarks.js';
import * as Highlights from './highlights.js';
import * as Storage from './storage.js';
import * as TouchSelect from './touch-select.js';
import { loadEpubJs } from './vendor-loader.js';
import * as AiDB from './ai/db.js';

// En táctil reimplementamos la selección de texto (los tiradores nativos de
// epub.js están rotos en columnas). En escritorio usamos la selección nativa.
const COARSE = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

let book = null;
// El lector en pantalla, que no es lo mismo que "tiene un libro cargado" (ver isLoaded).
// `claimSeq` arbitra entre una carga en vuelo y el lector que se le adelanta.
let active = false;
let claimSeq = 0;
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

// Id CANÓNICO del libro (SHA-256 del fichero, ya resuelto por alias), que app.js pasa a
// load(). Es la clave de todo lo que se guarda por libro. Ver `bookKey()`.
let canonicalId = null;

// Margen mínimo (px por lado) para dibujar la página como hoja sobre el "escritorio".
// Ver sizeContainer() y `.epub-container.has-desk` en main.css.
const DESK_MIN_MARGIN = 120;

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

// Re-paginar al cambiar el tamaño del área de lectura (modo inmersivo/pantalla completa,
// tirador de los paneles, apertura y cierre de la sidebar).
//
// Re-ajusta YA —para que el texto siga al gesto sin latencia— y además AGENDA el reflujo
// anclado al pin. Antes solo hacía lo primero, y esa era la vía por la que se perdía la
// página: el re-ajuste re-pagina, epub.js emite 'relocated' con el inicio de la página
// nueva (que cae ANTES de donde estabas) y, sin pin puesto, ese CFI se adoptaba y se
// guardaba. Medido en pantalla completa: entrar movía la posición de /80 a /58 y salir de
// /58 a /48 — hacia atrás y ACUMULATIVO, un poco en cada alternancia.
export function resize() {
  resizeToContainer();
  scheduleResize();
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
let onSelectMoveCb = () => {};
export function onSelect(cb) { onSelectCb = cb || (() => {}); }
export function onSelectionDismiss(cb) { onSelectDismissCb = cb || (() => {}); }
// La selección se ha movido bajo la barra (reflujo o desplazamiento): la barra la sigue.
export function onSelectionMove(cb) { onSelectMoveCb = cb || (() => {}); }
export function clearSelection() { try { TouchSelect.dismiss(); } catch (e) {} }
export function isCoarsePointer() { return COARSE; }

if (COARSE) {
  TouchSelect.configure({
    onTap: (zone) => onTapCb(zone),
    onImageTap: (img) => onImageTapCb(img),
    onSelect: (sel) => onSelectCb(sel),
    onDismiss: () => onSelectDismissCb(),
    onMove: (rect) => onSelectMoveCb(rect),
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
// Transform REALMENTE aplicado al contenedor (null = ninguno). Hace falta para saber
// cuánto le queda por recorrer a una animación —y para no lanzar una transición hacia
// el sitio donde el contenedor ya está, que no dispararía `transitionend` y dejaría la
// promesa esperando a la red de seguridad.
let swipeAppliedX = null;
// Pases pedidos mientras había uno en curso. Antes se descartaban: medido, cinco gestos
// seguidos daban DOS pases, y hojear —que es leer, no un caso raro— perdía la mitad de lo
// que hacías sin ningún aviso. Se aplican con la página ya fuera de pantalla, donde no hay
// coreografía que ver, así que ponerse al día no cuesta una animación por página.
let swipeQueue = [];
let swipeLayerTimer = 0;

const SWIPE_TURN_MS = 190;       // TECHO: el ritmo de hoy para un arrastre lento y largo
const SWIPE_TURN_MIN_MS = 80;    // SUELO: por debajo el movimiento deja de leerse
// Red de seguridad por si `transitionend` no llega (pestaña en segundo plano, transición
// que el navegador nunca arranca). Generosa a propósito: solo tiene que evitar un cuelgue,
// no marcar el ritmo — ese trabajo es del evento.
const SWIPE_GUARD_MS = 400;
const SWIPE_QUEUE_MAX = 3;       // ponerse al día, sí; convertir el libro en un pase de diapositivas, no
const SWIPE_JITTER = 3;      // px: temblor del dedo quieto que NO se repinta (anti-parpadeo)
const FLICK_VELOCITY = 0.35; // px/ms (~350 px/s): deslizamiento rápido que pasa página aunque sea corto
const FLICK_MIN_DX = 24;     // px mínimos para que un flick cuente como intención
const EDGE_RESIST = 3;       // en el borde del libro el dedo arrastra 1/3: se nota que no hay más

function swipeBox() { return document.getElementById('epub-container'); }
// translate3d (no translateX): fuerza capa de composición en la GPU, así el iframe
// no se repinta en cada frame; clave para que el texto no parpadee al arrastrar.
function tx(x) { return `translate3d(${x}px,0,0)`; }

const swipeDir = (dx) => (dx < 0 ? 'next' : 'prev');

// ¿No hay más libro en esa dirección? epub.js lo publica en `rendition.location`
// (`atStart`/`atEnd`), pero esos flags solo aparecen EXACTAMENTE en el borde, así que se
// respalda con el cálculo equivalente a partir de la sección y la página mostrada — el mismo
// dato, por si una versión de epub.js deja de poner la bandera.
//
// Se calcula UNA VEZ POR GESTO, no en cada `touchmove`: esto se consulta hasta 120 veces por
// segundo mientras el dedo se mueve, y `currentLocation()` no es gratis.
let swipeEdgeCache = null;
function swipeEdges() {
  if (swipeEdgeCache) return swipeEdgeCache;
  const res = { next: false, prev: false };
  try {
    // `rendition.location` es una propiedad ya calculada (la publica reportLocation);
    // `currentLocation()` recalcula, así que solo se usa si la primera no está.
    const loc = rendition && (rendition.location || rendition.currentLocation());
    if (loc) {
      const ini = loc.start, fin = loc.end;
      const ultimo = (book && book.spine && book.spine.spineItems)
        ? book.spine.spineItems.length - 1 : -1;
      res.prev = !!loc.atStart
        || !!(ini && ini.index === 0 && ini.displayed && ini.displayed.page <= 1);
      res.next = !!loc.atEnd
        || !!(fin && fin.index === ultimo && fin.displayed && fin.displayed.page >= fin.displayed.total);
    }
  } catch (e) { /* sin dato fiable: se comporta como si hubiera más libro */ }
  swipeEdgeCache = res;
  return res;
}
function swipeAtEdge(dir) {
  return dir === 'next' ? swipeEdges().next : swipeEdges().prev;
}

// La capa de composición se PIDE al empezar a arrastrar y se suelta con retraso. Antes se
// soltaba (`willChange = ''`) en el mismo frame en que la página nueva se pintaba: destruir
// la capa obliga al iframe a repintarse entero justo ahí, y eso es medio parpadeo. El otro
// medio era la transición cortada (ver swipeAnimate). Además, encadenando pases el temporizador
// se cancela y la capa no llega a irse: hojear no paga una promoción por página.
function swipeHoldLayer(c) {
  if (swipeLayerTimer) { clearTimeout(swipeLayerTimer); swipeLayerTimer = 0; }
  if (c) c.style.willChange = 'transform';
}
function swipeReleaseLayer() {
  if (swipeLayerTimer) clearTimeout(swipeLayerTimer);
  swipeLayerTimer = setTimeout(() => {
    swipeLayerTimer = 0;
    const c = swipeBox();
    if (c && !swipeBusy && swipeAppliedX === null) c.style.willChange = '';
  }, 300);
}

// Duración PROPORCIONAL a lo que falta por recorrer, no fija. Con 190 ms clavados, arrastrar
// el 85 % del ancho y soltar dejaba ese último 15 % tardando lo mismo que un pase entero: la
// página se despegaba del dedo y se iba sola, despacio. El techo es el ritmo de antes (un
// arrastre corto y lento no se acelera), así que esto nunca va MÁS LENTO que como estaba.
function swipeDuration(dist, w, velocity) {
  const nominal = (w || 1) / SWIPE_TURN_MS;                  // px/ms que daban los 190 ms a lo ancho
  const v = Math.max(nominal, Math.abs(velocity || 0));      // si el flick fue más rápido, manda él
  return Math.max(SWIPE_TURN_MIN_MS, Math.min(SWIPE_TURN_MS, Math.round(dist / v)));
}

function swipeMove(dx) {
  if (swipeBusy) return;
  if (getReadingMode() === 'scroll') return;   // en scroll manda el desplazamiento vertical nativo
  // En el borde del libro el arrastre RESISTE en vez de seguir al dedo: es la forma de decir
  // "no hay más" mientras la mano está en ello, y no después con una animación de pase que
  // no ha pasado.
  const raw = swipeAtEdge(swipeDir(dx)) ? dx / EDGE_RESIST : dx;
  const x = Math.round(raw);        // enteros: sin sub-píxel que tiemble
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
    swipeHoldLayer(c);
    c.style.transition = 'none';
    c.style.transform = tx(swipePendingX);
    swipeAppliedX = swipePendingX;
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

// ¿Este gesto pide pasar página? Por DISTANCIA (recorrido corto, estilo Play Books) o por
// FLICK (deslizamiento rápido aunque corto, en el mismo sentido que el recorrido).
function swipeWantsTurn(dx, w, v) {
  const byDistance = Math.abs(dx) >= Math.min(60, w * 0.15);
  const byFlick = Math.abs(dx) >= FLICK_MIN_DX && Math.abs(v) >= FLICK_VELOCITY && (v < 0) === (dx < 0);
  return byDistance || byFlick;
}

async function turnPage(dir) {
  try { await (dir === 'next' ? rendition.next() : rendition.prev()); } catch (e) { /* fin del libro */ }
}

async function swipeEnd(dx) {
  if (getReadingMode() === 'scroll') return;   // sin pasar página con swipe en modo scroll
  const c = swipeBox(); if (!c) return;
  const w = c.clientWidth || window.innerWidth || 1;
  const dir = swipeDir(dx);
  // Mismo amortiguado que en swipeMove: si no, el umbral y la velocidad se medirían sobre un
  // recorrido que la pantalla nunca hizo.
  const x = Math.round(swipeAtEdge(dir) ? dx / EDGE_RESIST : dx);
  const v = swipeVelocity(x);
  const quiere = swipeWantsTurn(x, w, v);

  // Pase en curso: el gesto se ENCOLA en vez de perderse. La cola se aplica luego con la
  // página fuera de pantalla (ver el bucle de abajo).
  if (swipeBusy) {
    if (quiere && !swipeAtEdge(dir) && swipeQueue.length < SWIPE_QUEUE_MAX) swipeQueue.push(dir);
    return;
  }

  swipeCancelPending();            // que un rAF rezagado no pise la animación de salida
  // En el borde no hay pase que valga: vuelve, y punto. Antes se ejecutaba la coreografía
  // COMPLETA —la página salía entera y "otra" entraba por el lado contrario— con el mismo
  // contenido: una animación que afirmaba un pase que no había ocurrido.
  if (!quiere || !rendition || swipeAtEdge(dir)) {
    await swipeAnimate(c, 0, swipeDuration(Math.abs(swipeAppliedX || 0), w, v));
    swipeReset(c);
    return;
  }

  swipeBusy = true;
  swipeHoldLayer(c);
  // Lo que le queda a la página actual para terminar de salir.
  await swipeAnimate(c, dir === 'next' ? -w : w, swipeDuration(w - Math.abs(x), w, v));
  releasePin();   // navegación real del usuario: suelta el pin de giro para volver a seguir la posición
  let ultima = dir;
  await turnPage(ultima);
  swipeEdgeCache = null;   // ya no estamos donde estábamos
  // Gestos encolados mientras la página estaba fuera de pantalla: se aplican SIN animación,
  // porque no hay nada que ver. Ponerse al día cuesta un cambio de página, no un pase entero.
  while (swipeQueue.length) {
    ultima = swipeQueue.shift();
    await turnPage(ultima);
    swipeEdgeCache = null;
  }
  swipeSet(c, ultima === 'next' ? w : -w);          // la nueva se coloca al otro lado
  void c.offsetWidth;                               // reflow para que anime
  await swipeAnimate(c, 0, swipeDuration(w, w, v));  // y entra
  swipeReset(c);
  swipeBusy = false;
  swipeReleaseLayer();
}

function swipeSet(c, x) {
  if (!c) return;
  c.style.transition = 'none';
  c.style.transform = tx(x);
  swipeAppliedX = x;
}
function swipeReset(c) {
  swipeCancelPending();
  lastSwipeX = null;
  swipeTrail = [];
  swipeAppliedX = null;
  swipeEdgeCache = null;   // otra posición: los bordes se vuelven a preguntar
  if (c) { c.style.transition = 'none'; c.style.transform = ''; }
  // `willChange` NO se borra aquí: ver swipeReleaseLayer.
  swipeReleaseLayer();
}

// Anima el contenedor hasta `x` y resuelve cuando la transición TERMINA DE VERDAD.
//
// Antes resolvía con `setTimeout(190 + 20)`, pero la transición arranca un rAF MÁS TARDE que
// ese temporizador: cronometrado, el margen real entre el final de la animación y la limpieza
// era de 4 ms. Cualquier frame que se retrasara por encima de eso metía la limpieza DENTRO de
// la animación —el contenedor saltaba desde donde estuviera— y ese es el parpadeo. Medido con
// la CPU frenada 6× (un móvil de gama media), 3 de cada 10 transiciones se cortaban.
function swipeAnimate(c, x, ms = SWIPE_TURN_MS) {
  return new Promise((res) => {
    if (!c) { res(); return; }
    // Ya está ahí: no habría transición que escuchar y la promesa esperaría a la red de
    // seguridad. Pasa en el rebote de un arrastre tan corto que la banda muerta nunca lo pintó.
    if (swipeAppliedX === null ? x === 0 : Math.round(swipeAppliedX) === Math.round(x)) {
      c.style.transition = 'none';
      res();
      return;
    }
    let hecho = false;
    let guard = 0;
    const acabar = () => {
      if (hecho) return;
      hecho = true;
      c.removeEventListener('transitionend', alAcabar);
      c.removeEventListener('transitioncancel', alAcabar);
      clearTimeout(guard);
      res();
    };
    // `e.target === c`: transitionend BURBUJEA, y dentro del contenedor vive el iframe de
    // epub.js con sus propias transiciones.
    const alAcabar = (e) => { if (e.target === c && e.propertyName === 'transform') acabar(); };
    c.addEventListener('transitionend', alAcabar);
    c.addEventListener('transitioncancel', alAcabar);
    guard = setTimeout(acabar, ms + SWIPE_GUARD_MS);
    c.style.transition = `transform ${ms}ms cubic-bezier(.22,.61,.36,1)`;
    requestAnimationFrame(() => {
      if (hecho) return;
      c.style.transform = tx(x);
      swipeAppliedX = x;
    });
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

// Reflujo anclado, DEBOUNCED. Es el único camino por el que puede re-paginarse sin perder
// la página, y lo comparten todas las causas: giro, barra del navegador, PWA redimensionada,
// pantalla completa, paneles y cambios de ajustes (cuerpo de letra, interlineado, ancho de
// columna). El debounce importa: durante el arrastre de un panel esto se llama en cada
// frame, y re-mostrar el CFI en cada uno sería inasumible — se re-ajusta en caliente y solo
// al parar se ancla.
function scheduleResize() {
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
}

export function init() {
  if (settingsListenerRegistered) return;
  settingsListenerRegistered = true;
  window.addEventListener('settings:changed', () => {
    // Re-ajustar primero para que epub.js re-pagine, luego re-aplicar el tema a los frames
    // nuevos. Y anclar: cambiar el cuerpo de letra reflúa el contenido DENTRO del iframe
    // sin cambiar el tamaño del contenedor, así que `rendition.resize()` se cortocircuita
    // (mismas dimensiones) y la vista se queda medida a lo viejo — medido: el contenido
    // pasaba a 204450 px con el iframe todavía en 90720. El display(pin) del reflujo la
    // rehace y devuelve la página donde estaba.
    resizeToContainer();
    applyTheme();
    scheduleResize();
  });

  // Cualquier cambio de viewport (giro, chrome del navegador que se pliega, PWA
  // redimensionada) entra por el mismo sitio.
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
// Clave de las cosas guardadas por libro (posición, modo de lectura).
//
// El id canónico es el SHA-256 del fichero: el MISMO que usan biblioteca, subrayados,
// marcadores y el sync. Antes se usaba `book.key()` de epub.js —`epubjs:<v>:<dc:identifier
// del OPF>`— y eso metía la posición en un espacio de ids DISTINTO al del resto, con tres
// consecuencias medidas (ver BACKLOG TEC5): viajaba al proveedor como un "libro fantasma"
// sin título, la reconciliación de alias no la alcanzaba (mismo libro de otro mirror: los
// subrayados cruzaban y la página no) y, en EPUB sin `dc:identifier`, `key()` cae a
// `url.filename` —cadena vacía al abrir desde un ArrayBuffer— así que TODOS ellos
// compartían la clave `epubjs:0.3:` y se pisaban la posición entre libros distintos.
//
// `legacyBookKey()` sigue existiendo solo para migrar lo ya guardado (ver migrateLegacyKeys).
function bookKey() {
  return canonicalId || legacyBookKey();
}

function legacyBookKey() {
  try { return (book && book.key) ? book.key() : 'default'; } catch (e) { return 'default'; }
}

// Claves por libro que vivían bajo la clave vieja. `lastPositionAt` viaja con su valor: es
// el sello del LWW de escalares del sync.
const CLAVES_POR_LIBRO = ['lastPosition', 'lastPositionAt', 'readingMode'];

// Traslada lo guardado bajo la clave vieja al id canónico, una vez por libro. Si ya hay
// valor en ambos lados gana el más reciente por `lastPositionAt`, que es exactamente el
// criterio que el sync aplica a estos escalares. La clave vieja se BORRA: si se dejara,
// `buildSnapshot()` la seguiría subiendo como libro fantasma.
function migrateLegacyKeys() {
  const viejo = legacyBookKey();
  if (!canonicalId || viejo === canonicalId) return;
  const tieneViejo = Storage.get('lastPosition_' + viejo) != null;
  if (tieneViejo) {
    const tNuevo = Number(Storage.get('lastPositionAt_' + canonicalId)) || 0;
    const tViejo = Number(Storage.get('lastPositionAt_' + viejo)) || 0;
    if (tViejo > tNuevo) {
      Storage.set('lastPosition_' + canonicalId, Storage.get('lastPosition_' + viejo));
      Storage.set('lastPositionAt_' + canonicalId, tViejo);
    }
  }
  // El modo de lectura no tiene sello; solo se adopta si no había nada elegido aquí.
  const modoViejo = Storage.get('readingMode_' + viejo);
  if (modoViejo != null && Storage.get('readingMode_' + canonicalId) == null) {
    Storage.set('readingMode_' + canonicalId, modoViejo);
  }
  for (const p of CLAVES_POR_LIBRO) Storage.remove(p + '_' + viejo);
}

// Modos: 'paginated' (una columna), 'spread' (doble página, estilo Play Books) y
// 'scroll'. `spread` es paginado + dos columnas; epub.js solo las abre si el
// contenedor llega a minSpreadWidth, así que en ventana estrecha cae solo a una.
const MODES = ['paginated', 'spread', 'scroll'];
// Ancho de contenedor por debajo del cual epub.js vuelve a una sola columna aunque
// el modo sea 'spread'. El suyo por defecto (800) deja fuera casos razonables: con
// el sidebar abierto el contenedor real baja de ahí y el modo se caía solo.
const MIN_SPREAD_WIDTH = 700;

export function getReadingMode() {
  const v = Storage.get('readingMode_' + bookKey(), 'paginated');
  return MODES.includes(v) ? v : 'paginated';
}

export function setReadingMode(mode) {
  const m = MODES.includes(mode) ? mode : 'paginated';
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
  // spread() también aplica en caliente (updateLayout del manager), así que el
  // cambio de modo no recrea el rendition ni pierde anotaciones.
  // El ancho máximo del contenedor cambia con el modo (una página o dos), así que
  // se re-mide ANTES de que el manager recalcule la maquetación.
  const container = document.getElementById('epub-container');
  if (container) sizeContainer(container);
  try { rendition.spread(mode === 'spread' ? 'auto' : 'none', MIN_SPREAD_WIDTH); } catch (e) { /* spread no disponible */ }
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
  // En doble página el ajuste vale por PÁGINA, así que el contenedor cabe dos: si
  // se dejara en `cols` (720 por defecto) el contenedor no llegaría nunca al
  // MIN_SPREAD_WIDTH de epub.js y las dos columnas no se abrirían jamás.
  const pages = getReadingMode() === 'spread' ? 2 : 1;
  const vw = window.innerWidth;
  const maxWidth = vw > 1000 ? cols * pages : Math.max(cols, vw);
  container.style.width = '100%';
  container.style.maxWidth = maxWidth + 'px';
  container.style.margin = '0 auto';

  // ¿Hay escritorio suficiente para que la página se lea como una HOJA apoyada encima?
  // El efecto (fondo propio, esquinas, sombra) necesita aire a los lados: con un margen
  // estrecho deja de leerse como un margen y pasa a leerse como una franja gris pegada
  // al borde —justo lo que pasa con el "Ancho de columna" cerca del máximo—. Por debajo
  // del umbral no se dibuja nada y la página vuelve a ir a sangre.
  const avail = container.parentElement ? container.parentElement.clientWidth : vw;
  const margin = Math.max(0, (avail - Math.min(avail, maxWidth)) / 2);
  container.classList.toggle('has-desk', margin >= DESK_MIN_MARGIN);
}

// "Cargado" = hay libro Y es el lector que está en pantalla. Media app decide el formato
// activo con esto (índice, barra de progreso, flechas), así que un EPUB que ya no se ve no
// puede seguir diciendo que sí — ver deactivate().
export function isLoaded() {
  return book !== null && active;
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

// Deja de ser el lector activo (lo llama app.js al abrir un PDF). Baja la BANDERA, no el
// libro: la carga del EPUB puede seguir en vuelo —el usuario cambia de libro mientras el
// anterior aún se abre— y anular `book` a media carga dejaba al agente sin nada que
// segmentar, con su caché vacía (tests/book-switch.spec.ts). El libro se libera cuando
// otro EPUB ocupa su sitio en load().
export function deactivate() {
  flushLastPosition();   // el rebote no debe cruzarse con el libro que viene detrás
  canonicalId = null;
  active = false;
  claimSeq++;                // una carga en vuelo sabrá que la han jubilado
  lastChapterLabel = null;   // IA2: nuevo libro → reinicia el seguimiento de capítulo
  pinnedCfi = null;
  restoredSaved = false;
}

export async function load(arrayBuffer, onProgress, bookId = null) {
  flushLastPosition();   // vaciar lo del libro anterior ANTES de soltarlo
  const mine = ++claimSeq;
  active = true;
  // Antes de tocar `book`: `flushLastPosition()` de arriba aún tiene que escribir con la
  // clave del libro SALIENTE.
  canonicalId = bookId || null;
  if (book) {
    try { await book.destroy(); } catch(e) { console.warn('Destroy error:', e); }
    book = null;
    rendition = null;
  }
  lastChapterLabel = null;
  pinnedCfi = null;
  restoredSaved = false;

  console.log('Creating ePub book from ArrayBuffer...');
  // epub.js (+ jszip) se carga aquí, no en el arranque: hasta que no se abre un EPUB
  // no hace falta. Ver js/vendor-loader.js.
  const ePub = await loadEpubJs();
  book = ePub(arrayBuffer);

  console.log('Waiting for book.ready...');
  await book.ready;
  console.log('Book ready');

  // Migrar AQUÍ y no más abajo: es el primer punto donde existen a la vez el `book` (del
  // que sale la clave vieja) y el id canónico, y el modo de lectura se lee ya en el
  // renderTo, antes de restaurar la posición.
  try { migrateLegacyKeys(); } catch (e) { console.warn('migración de claves por libro:', e); }

  // Otro lector se llevó la pantalla mientras esto cargaba (abrir un EPUB y, sin
  // esperar, un PDF): NO tocar los contenedores. Seguir adelante escondía el
  // #pdf-container que el PDF acababa de mostrar y dejaba la pantalla en blanco.
  // El libro queda cargado a propósito —`book` sigue en pie—, porque el agente aún
  // tiene que segmentarlo bajo SU id (ver book-switch.spec.ts); lo que se corta es
  // solo el montaje de la UI, que ya no es de este libro.
  if (claimSeq !== mine) { active = false; return book; }

  const container = document.getElementById('epub-container');
  container.innerHTML = '';
  container.style.display = 'block';
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
    spread: readingMode === 'spread' ? 'auto' : 'none',
    minSpreadWidth: MIN_SPREAD_WIDTH,
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

  // Restaurar la última posición de ESTE libro (guardada en cada 'relocated' bajo
  // lastPosition_<id canónico>). Así recordamos dónde íbamos abramos como abramos
  // (archivo, arrastrar o biblioteca). Si el CFI guardado ya no es válido, abrimos por el
  // principio.
  let startCfi = null;
  try {
    startCfi = Storage.get('lastPosition_' + bookKey()) || null;
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
    fadeChapterIn();
  });

  if (claimSeq !== mine) active = false;   // otro lector tomó la pantalla mientras cargaba
  return book;
}

// Entrada de capítulo: un fundido corto al renderizarse una sección nueva (saltar desde
// el índice, una cita, el teclado). Antes el cambio era un corte seco y se notaba barato.
// Dos exclusiones, y son las que importan:
//   - pinnedCfi != null → hay un giro/reflow en curso y 'rendered' se dispara por la
//     REPAGINACIÓN, no por cambio de capítulo: fundir ahí es un parpadeo gratuito.
//   - swipeBusy → el pase de página táctil ya tiene su propia animación de traslación;
//     encadenar un fundido encima la ensucia.
// Solo opacidad (nada de translate): mover el contenedor obligaría al iframe a repintar.
function fadeChapterIn() {
  if (pinnedCfi != null || swipeBusy) return;
  const c = document.getElementById('epub-container');
  if (!c) return;
  c.classList.remove('chapter-in');
  void c.offsetWidth;           // reinicia la animación al encadenar capítulos seguidos
  c.classList.add('chapter-in');
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

// Guardado de la posición, con rebote.
//
// Se llamaba en cada `relocated`, o sea en CADA pase de página, y hace dos
// localStorage.setItem —que son síncronos y bloquean el hilo— más un evento que despierta
// al SyncEngine, justo mientras corre la animación de página. Con rebote se escribe una
// vez cuando el lector se para, que es cuando la posición significa algo.
//
// El rebote NO puede costar la posición: en móvil la PWA muere sin avisar. Por eso se
// vacía al ocultarse la pestaña, igual que ya hacía el progreso en app.js.
const SAVE_POS_MS = 400;
let savePosTimer = 0;

function saveLastPosition() {
  clearTimeout(savePosTimer);
  savePosTimer = setTimeout(flushLastPosition, SAVE_POS_MS);
}

export function flushLastPosition() {
  clearTimeout(savePosTimer);
  savePosTimer = 0;
  if (book && currentCfi) {
    try {
      const key = bookKey();
      Storage.set('lastPosition_' + key, currentCfi);
      // Sello para el LWW del sync (la posición es un escalar sin updatedAt propio)
      Storage.set('lastPositionAt_' + key, Date.now());
      window.dispatchEvent(new CustomEvent('bookreader:data-changed'));
    } catch(e) {
      console.warn('Could not save position:', e);
    }
  }
}

// `pagehide` cubre lo que `visibilitychange` no ve en iOS (volver al escritorio matando
// la app). Ambos son idempotentes: si no hay nada pendiente, no escriben.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushLastPosition();
});
window.addEventListener('pagehide', flushLastPosition);

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

// Página en la que empieza cada entrada del índice, para pintarla junto al título.
// Recibe los href del TOC y devuelve Map<href, página>.
//
// Dos detalles que costaron descubrir:
//  - `cfiBase` NO es un CFI válido por sí solo (epub.js: "not a valid argument for
//    EpubCFI"); hay que componer el CFI del inicio del documento.
//  - Muchos EPUB (los de Gutenberg, por ejemplo) meten decenas de capítulos en un
//    solo fichero y los distinguen por ancla. Quedarse en la sección daría la MISMA
//    página a diez capítulos seguidos, que es peor que no poner número. Por eso se
//    resuelve el ancla: cargar la sección y localizar el elemento cuesta ~2 ms.
//
// Se agrupa por fichero para cargar cada sección una sola vez, y se descarga solo lo
// que hayamos cargado nosotros (una sección ya cargada puede estar renderizándose).
export async function getTocPages(hrefs) {
  const out = new Map();
  try {
    if (!book?.spine || !book.locations?.length?.()) return out;
  } catch (e) { return out; }

  const byFile = new Map();
  for (const href of hrefs) {
    const [file, anchor] = String(href).split('#');
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push({ href, anchor });
  }

  for (const [file, entries] of byFile) {
    let section = null;
    try { section = book.spine.get(file); } catch (e) { /* href no resoluble */ }
    if (!section?.cfiBase) continue;

    const basePage = getPageInfo(`epubcfi(${section.cfiBase}!/4/2)`)?.page ?? null;

    let doc = null, loadedByUs = false;
    if (entries.some((e) => e.anchor)) {
      try {
        if (section.document) doc = section.document;
        else { doc = await section.load(book.load.bind(book)); loadedByUs = true; }
      } catch (e) { /* sin documento: nos quedamos en la página de la sección */ }
    }

    for (const e of entries) {
      let page = basePage;
      if (e.anchor && doc) {
        try {
          const el = doc.getElementById?.(e.anchor);
          if (el) page = getPageInfo(section.cfiFromElement(el))?.page ?? basePage;
        } catch (err) { /* ancla no encontrada: página de la sección */ }
      }
      if (page != null) out.set(e.href, page);
    }

    if (loadedByUs) { try { section.unload(); } catch (e) { /* ya descargada */ } }
  }
  return out;
}

// Qué hay en la fracción [0..1] de la barra, SIN navegar: alimenta la burbuja que
// sigue al dedo mientras se arrastra. Página, total y capítulo si se puede resolver.
export function getSeekPreview(f) {
  try {
    if (!book?.locations?.cfiFromPercentage) return null;
    const frac = Math.min(1, Math.max(0, f));
    const cfi = book.locations.cfiFromPercentage(frac);
    if (!cfi) return null;
    const info = getPageInfo(cfi);
    let chapter = '';
    try {
      const href = book.spine.get(cfi)?.href;
      const item = href && book.navigation?.toc?.find((t) => t.href.includes(href));
      chapter = item?.label?.trim() || '';
    } catch (e) { /* sin capítulo resoluble: la burbuja enseña solo la página */ }
    return { page: info?.page || null, total: info?.total || 0, chapter };
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

// href (tal cual está en el índice) de la entrada que corresponde a lo que se está
// leyendo AHORA, para marcarla en el sidebar. Se recorre el índice —incluidas las
// subentradas— y se devuelve la PRIMERA del fichero actual: cuando un fichero trae
// varias secciones no se sabe por cuál va la lectura sin resolver los anclajes, así
// que se marca la sección que las contiene. '' si no se puede resolver.
export function getCurrentTocHref() {
  if (!book || !rendition) return '';
  const nav = book.navigation;
  if (!nav || !nav.toc) return '';

  const location = rendition.currentLocation();
  if (!location || !location.start) return '';

  const href = location.start.href;
  let match = '';
  const walk = (items) => {
    for (const item of items || []) {
      if (match) return;
      if (item.href && item.href.includes(href)) { match = item.href; return; }
      walk(item.subitems);
    }
  };
  walk(nav.toc);
  return match;
}

// `bookId` es el hash del fichero (el id canónico). Con él, las locations se guardan tras
// generarlas y se reponen en las aperturas siguientes: generarlas recorre el libro ENTERO
// y se rehacía cada vez. Sin id (aperturas sueltas que aún no lo han calculado) se
// comporta como antes y simplemente las genera.
export async function generateLocations(bookId) {
  if (!book) return;
  if (bookId) {
    try {
      const guardadas = await AiDB.loadLocations(bookId);
      // `load()` devuelve las locations ya pobladas; si el formato no le cuadra, lanza y
      // caemos a generarlas, que es el camino de siempre.
      if (guardadas) { book.locations.load(guardadas); if (book.locations.length()) return; }
    } catch (e) { console.warn('locations guardadas no válidas, se regeneran:', e); }
  }
  await book.locations.generate(1024);
  if (bookId) {
    try { await AiDB.saveLocations(bookId, book.locations.save()); }
    catch (e) { console.warn('no se pudieron guardar las locations:', e); }
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
