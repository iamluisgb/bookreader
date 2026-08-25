// pdf-axis-lock.js — Eje dominante durante el gesto (ADR-034).
//
// POR QUÉ. Con «Ajustar al texto» la mancha llena el ancho a zoom 1 y no queda recorrido
// horizontal que descolocar (ADR-033). Pero en cuanto se amplía —una tabla, un escaneo
// torcido, un PDF a dos columnas, uno donde el recorte tocó su tope de seguridad— el
// contenido vuelve a exceder el viewport POR CONSTRUCCIÓN, y leyendo en vertical cualquier
// desvío del dedo o del trackpad se lleva la columna de lado.
//
// Lo que NO se hace es el candado que se pidió en su día. Un modo persistente deja una vista
// permanentemente descentrada de la que el usuario de teclado no puede salir, y en móvil
// —sin rueda ni teclado— el dedo es el ÚNICO modo de alcanzar lo que queda fuera del
// viewport: a zoom 4 eso es una trampa. Lo que se hace es decidir el eje POR GESTO: si el
// arranque del arrastre es claramente vertical, la componente X de ESE gesto se ignora; el
// siguiente arrastre panea con total normalidad. No hay estado que recordar, sincronizar ni
// explicar, y no hay nada que quede fuera de alcance.
//
// CÓMO. `touch-action` se fija cuando el dedo baja y no se puede cambiar a mitad de gesto, y
// el scroll táctil lo lleva el compositor: no existe forma declarativa de quitar un eje una
// vez empezado el arrastre. Así que se deja scrollear nativo y se REPONE `scrollLeft` en el
// evento `scroll` mientras dura el gesto. Que sea "mientras dura el gesto" es justo lo que lo
// distingue del candado: fuera de él, `scrollIntoView`, el anclaje del zoom y el
// auto-desplazamiento de la selección mueven el eje X sin encontrarse nada enfrente.

const START_PX = 12;     // recorrido antes de clasificar. Es el MOVE_CANCEL de
                         // pdf-touch-select: por debajo, el gesto todavía puede ser una
                         // pulsación larga y no un scroll.
const RATIO = 1.5;       // |dy| ≥ RATIO·|dx| → vertical "claro" (~34° de la vertical). Si no
                         // llega, el gesto es diagonal a propósito y se deja libre.
const SETTLE_MS = 140;   // sin eventos de scroll: se acabó la inercia (o la ráfaga de rueda).

let container = null;
// 'idle'    — no hay gesto en curso.
// 'pending' — hay gesto, aún sin veredicto (no se ha recorrido START_PX).
// 'locked'  — vertical: se repone scrollLeft en cada scroll.
// 'free'    — diagonal u horizontal: este módulo no toca nada hasta el siguiente gesto.
let phase = 'idle';
let x0 = 0, y0 = 0;
let lockX = 0;
let settleTimer = 0;     // >0 solo tras soltar: la inercia sigue y hay que soltarla al parar
let wheelX = 0, wheelY = 0;

// Sin recorrido horizontal no hay nada que bloquear (el caso normal: zoom 1 con recorte).
function hayEjeX() {
  return !!container && container.scrollWidth - container.clientWidth > 1;
}

// Suelta el eje: el siguiente gesto vuelve a decidir desde cero. Público porque el zoom
// mueve scrollLeft a mano al anclar al foco (ver setZoom) y no debe encontrarse resistencia.
export function release() {
  clearTimeout(settleTimer);
  settleTimer = 0;
  phase = 'idle';
  wheelX = wheelY = 0;
}

// Veredicto sobre un desplazamiento acumulado. `true` cuando ya lo hay.
function classify(dx, dy) {
  if (Math.hypot(dx, dy) < START_PX) return false;
  if (Math.abs(dy) >= Math.abs(dx) * RATIO && hayEjeX()) {
    phase = 'locked';
    lockX = container.scrollLeft;
  } else {
    phase = 'free';
  }
  return true;
}

// Rearma la ventana de inercia. Solo tras soltar: con el dedo abajo el gesto no caduca.
function settle() {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(release, SETTLE_MS);
}

function onTouchStart(e) {
  release();                            // un dedo nuevo reabre la decisión
  if (e.touches.length !== 1) return;   // dos dedos son el pinch, y ese gesto no es nuestro
  x0 = e.touches[0].clientX;
  y0 = e.touches[0].clientY;
  phase = 'pending';
}

function onTouchMove(e) {
  if (phase === 'idle') return;
  // Alguien reclamó el gesto (pinch, selección táctil): no hay scroll nativo que gobernar.
  // Se mira el evento ANTERIOR y no este —el flag llega tarde si su listener se registró
  // después—, y da igual: quien previene lo hace en TODOS los touchmove del gesto, así que
  // como mucho se repone una vez de más antes de soltar.
  if (e.defaultPrevented) { release(); return; }
  if (phase !== 'pending') return;
  const t = e.touches[0];
  if (t) classify(t.clientX - x0, t.clientY - y0);
}

function onTouchEnd() {
  if (phase === 'locked') settle();   // la inercia sigue el gesto: el eje sigue decidido
  else release();
}

// Trackpad. La "ráfaga" hace de gesto: se clasifica con los primeros deltas y se cierra por
// inactividad. Ctrl/⌘+rueda es zoom (lo lleva pdf-reader) y ahí no hay eje que decidir.
function onWheel(e) {
  if (e.ctrlKey || e.metaKey) { release(); return; }
  if (phase === 'idle') { phase = 'pending'; wheelX = wheelY = 0; }
  if (phase === 'pending') {
    // deltaMode: 0 = píxeles, 1 = líneas, 2 = páginas. Los dos ejes comparten modo, así que
    // solo afecta al umbral, no al veredicto.
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    wheelX += e.deltaX * k;
    wheelY += e.deltaY * k;
    classify(wheelX, wheelY);
  }
  settle();
}

function onScroll() {
  if (phase !== 'locked') return;
  if (container.scrollLeft !== lockX) container.scrollLeft = lockX;
  if (settleTimer) settle();   // en inercia: se suelta cuando el scroll para, no antes
}

export function install(el) {
  if (!el || el.dataset.axisLockWired) return;
  el.dataset.axisLockWired = '1';
  container = el;
  el.addEventListener('touchstart', onTouchStart, { passive: true });
  el.addEventListener('touchmove', onTouchMove, { passive: true });
  el.addEventListener('touchend', onTouchEnd, { passive: true });
  el.addEventListener('touchcancel', onTouchEnd, { passive: true });
  el.addEventListener('wheel', onWheel, { passive: true });
  el.addEventListener('scroll', onScroll, { passive: true });
}
