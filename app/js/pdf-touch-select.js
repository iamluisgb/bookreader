// pdf-touch-select.js — Selección de texto propia para táctil en el PDF.
//
// POR QUÉ. En móvil la selección del PDF era 100 % nativa, y las asas nativas no se dejan
// gobernar: su arrastre NO emite eventos táctiles a la página, así que no hay forma de
// corregirlas desde fuera. Y hacía falta corregirlas, porque la capa de texto de pdf.js son
// spans en absoluto cuyo orden en el DOM es el del flujo del PDF, no el de la página: en
// cuanto el dedo pasaba por un hueco entre líneas, el navegador resolvía el cursor por
// proximidad EN EL DOM y la selección se disparaba. Subrayar tres líneas era una lotería.
//
// Así que se toma el control, como ya se hacía en el EPUB (touch-select.js), con dos
// diferencias que salen de cómo es un PDF:
//
//   1. AJUSTE POR LÍNEAS. Mientras no sales de la línea donde empezaste, la selección va por
//      caracteres. En cuanto la cruzas, pasa a líneas COMPLETAS. Con el dedo, apuntar al
//      carácter exacto tres líneas más abajo es justo lo que no se puede hacer; y «tres
//      líneas» es lo que la gente quiere subrayar. Los tiradores siguen afinando por
//      caracteres después, que es un gesto deliberado y con la selección ya a la vista.
//
//   2. LA SELECCIÓN NO ES UN RANGO DEL DOM. Precisamente porque el orden del DOM no es el de
//      la página, un Range de la línea A a la línea B se tragaría lo que haya entre medias en
//      el DOM. Se modela como un tramo sobre las líneas en orden VISUAL, y el texto y los
//      rectángulos se construyen recorriéndolo.
//
// El subrayado de PDF ya se guarda como rectángulos fraccionales, no como rango, así que
// este modelo encaja con el almacenamiento sin adaptador de por medio.
import * as Engine from './ui/selection-engine.js';
import { cursorEnPagina } from './pdf-text-select.js';
import { rafThrottle } from './ui/raf.js';

const LONGPRESS_MS = 380;   // igual que en el EPUB: el gesto debe sentirse el mismo
const MOVE_CANCEL = 12;     // px que cancelan la pulsación larga (=scroll de la página)
// Auto-desplazamiento al arrastrar contra un borde. La selección NATIVA lo hacía sola; al
// tomar el control había que reponerlo, o un párrafo que se sale por abajo es inseleccionable:
// el dedo llega al borde de la pantalla y ahí se acaba.
const BORDE = 64;           // banda desde el borde en la que empieza a desplazarse
const VELOCIDAD_MAX = 16;   // px por frame pegado al borde (proporcional dentro de la banda)

let callbacks = { onSelect: () => {}, onDismiss: () => {}, onMove: () => {} };
let active = null;   // { pagina, spans, ini, fin, anclaIdx, anclaOff, ajustando }

// --- líneas y orden visual ---------------------------------------------------
// Los spans de una página, agrupados en líneas por solapamiento vertical y ordenados como se
// leen. Se recalcula al empezar cada gesto: entre gesto y gesto la página puede haberse
// re-renderizado (zoom, cambio de página) y los rects de antes ya no valdrían.
function spansEnOrdenVisual(pagina) {
  const items = [];
  for (const s of pagina.querySelectorAll('.textLayer span')) {
    const r = s.getBoundingClientRect();
    const n = s.firstChild;
    if (r.width < 0.5 || r.height < 0.5) continue;
    if (!n || n.nodeType !== 3 || !n.length) continue;
    items.push({ span: s, nodo: n, r });
  }
  items.sort((a, b) => a.r.top - b.r.top);

  // Agrupar en líneas: un span entra en la línea abierta si su centro cae dentro de ella.
  // Agrupar por `top` exacto no vale — dentro de una misma línea conviven tamaños distintos
  // (versalitas, superíndices, cambios de fuente) y cada uno tiene su propio top.
  const lineas = [];
  for (const it of items) {
    const cy = it.r.top + it.r.height / 2;
    const l = lineas[lineas.length - 1];
    if (l && cy >= l.top && cy <= l.bottom) {
      l.items.push(it);
      l.top = Math.min(l.top, it.r.top);
      l.bottom = Math.max(l.bottom, it.r.bottom);
    } else {
      lineas.push({ top: it.r.top, bottom: it.r.bottom, items: [it] });
    }
  }
  for (const l of lineas) l.items.sort((a, b) => a.r.left - b.r.left);

  // Los rects que quedan guardados son la FOTO del momento; tras un desplazamiento están
  // desfasados. No importa: solo se usan para comparaciones RELATIVAS dentro de esta misma
  // foto (agrupar en líneas, decidir si dos spans van pegados), y un desplazamiento las
  // traslada a todas por igual. Lo que sí se mide en vivo —el span bajo el dedo— pasa por
  // cursorEnPunto, que lee getBoundingClientRect en ese instante.
  //
  // Plano, con el número de línea a cuestas: el tramo seleccionado son dos índices aquí.
  const plano = [];
  lineas.forEach((l, li) => l.items.forEach((it) => plano.push({ ...it, linea: li })));
  return plano;
}

function indiceDe(spans, nodo) {
  for (let i = 0; i < spans.length; i++) if (spans[i].nodo === nodo) return i;
  return -1;
}

// Punto de pantalla → { idx, off } sobre el orden visual. Pasa por cursorEnPagina, que pega
// el punto a la mancha de texto de ESA página (ver pdf-text-select.js): sin eso, un dedo en un
// hueco vuelve a resolver por orden del DOM y estamos donde estábamos, y un dedo más allá del
// final de la página se iría a la siguiente, donde esta selección no puede continuar.
function posicionEn(x, y, pagina, spans) {
  const c = cursorEnPagina(x, y, pagina);
  if (!c) return null;
  const idx = indiceDe(spans, c.node);
  if (idx < 0) return null;
  return { idx, off: Math.min(c.offset, spans[idx].nodo.length) };
}

function ordenar(a, b) {
  return a.idx < b.idx || (a.idx === b.idx && a.off <= b.off) ? [a, b] : [b, a];
}

// Extiende un tramo a líneas completas. Es la regla del punto 1 de la cabecera.
function aLineasCompletas(spans, ini, fin) {
  let i = ini.idx, f = fin.idx;
  while (i > 0 && spans[i - 1].linea === spans[i].linea) i--;
  while (f < spans.length - 1 && spans[f + 1].linea === spans[f].linea) f++;
  return [{ idx: i, off: 0 }, { idx: f, off: spans[f].nodo.length }];
}

// --- lo que sale del tramo: rectángulos y texto -------------------------------
// Un rango POR SPAN, nunca uno que los cruce: cruzarlos volvería a meter en la selección lo
// que haya entre medias en el DOM.
function rangoDeTrozo(spans, i, ini, fin) {
  const it = spans[i];
  const r = document.createRange();
  r.setStart(it.nodo, i === ini.idx ? ini.off : 0);
  r.setEnd(it.nodo, i === fin.idx ? fin.off : it.nodo.length);
  return r;
}

function rectsDelTramo(spans, ini, fin) {
  const out = [];
  for (let i = ini.idx; i <= fin.idx; i++) {
    for (const r of rangoDeTrozo(spans, i, ini, fin).getClientRects()) {
      if (r.width >= 0.5 && r.height >= 0.5) out.push(r);
    }
  }
  return out;
}

function textoDelTramo(spans, ini, fin) {
  let txt = '';
  let derechaPrevia = null;
  for (let i = ini.idx; i <= fin.idx; i++) {
    const it = spans[i];
    const trozo = rangoDeTrozo(spans, i, ini, fin).toString();
    if (!trozo) continue;
    // Un espacio entre spans SALVO si van pegados: pdf.js parte una palabra en varios spans
    // cuando cambia la fuente a media palabra, y ahí un espacio la rompería.
    if (txt && !(derechaPrevia !== null && Math.abs(it.r.left - derechaPrevia) < 1)) txt += ' ';
    txt += trozo;
    derechaPrevia = it.r.right;
  }
  return txt.replace(/\s+/g, ' ').trim();
}

function pintar() {
  if (!active) return;
  Engine.draw(rectsDelTramo(active.spans, active.ini, active.fin), Engine.IDENTIDAD);
}

// El resaltado se pinta en una capa `fixed`, en coordenadas de PANTALLA, y el PDF vive en un
// contenedor con `overflow: auto`. Sin esto, desplazarse con la selección puesta dejaba las
// bandas azules clavadas donde estaban —a un lado del texto— y la barra de acciones flotando
// lejos de lo marcado. Una pasada por frame: el scroll llega en ráfaga.
const alDesplazar = rafThrottle(() => {
  if (!active) return;
  pintar();
  const rects = rectsDelTramo(active.spans, active.ini, active.fin);
  if (rects[0]) callbacks.onMove(rects[0]);
});

function entregar() {
  if (!active) return;
  const { spans, ini, fin, pagina } = active;
  const texto = textoDelTramo(spans, ini, fin);
  if (!texto) { dismiss(); return; }
  const rects = rectsDelTramo(spans, ini, fin);
  callbacks.onSelect({
    text: texto,
    rect: rects[0] || null,             // la barra se ancla en la PRIMERA línea
    rectsPantalla: rects,
    wrapper: pagina,
    page: +pagina.dataset.page || 1,
  });
}

// Sin selección no hay nada que soltar NI A QUIÉN AVISAR, y ese `return` no es una micro
// optimización: `hideHighlightTooltip` llama aquí, y `onDismiss` vuelve a llamar a
// `hideHighlightTooltip`. Sin corte, cerrar la barra encadenaba 5047 llamadas anidadas
// (medido) hasta reventar la pila — y no se veía, porque la llamada va dentro de un
// `try/catch` que se tragaba el RangeError. El EPUB tenía el mismo ciclo.
export function dismiss() {
  pararAutoscroll();
  ultimoPunto = null;
  if (!active) return;
  active = null;
  Engine.hideOverlay();
  callbacks.onDismiss();
}

export function hasSelection() { return !!active; }

// --- auto-desplazamiento ------------------------------------------------------
let ultimoPunto = null;   // último sitio donde estaba el dedo, para seguir tirando sin moverlo
let rafAuto = 0;

function velocidad(dentro) {
  return Math.ceil((Math.min(dentro, BORDE) / BORDE) * VELOCIDAD_MAX);
}

function pararAutoscroll() {
  if (rafAuto) cancelAnimationFrame(rafAuto);
  rafAuto = 0;
}

function pasoAutoscroll() {
  rafAuto = 0;
  if (!active || !ultimoPunto) return;
  const sc = document.getElementById('pdf-container');
  if (!sc) return;
  const r = sc.getBoundingClientRect();
  const { x, y } = ultimoPunto;
  let dy = 0, dx = 0;
  if (y < r.top + BORDE) dy = -velocidad(r.top + BORDE - y);
  else if (y > r.bottom - BORDE) dy = velocidad(y - (r.bottom - BORDE));
  if (x < r.left + BORDE) dx = -velocidad(r.left + BORDE - x);
  else if (x > r.right - BORDE) dx = velocidad(x - (r.right - BORDE));
  if (!dx && !dy) return;

  const t0 = sc.scrollTop, l0 = sc.scrollLeft;
  sc.scrollTop += dy;
  sc.scrollLeft += dx;
  if (sc.scrollTop === t0 && sc.scrollLeft === l0) return;   // se acabó el recorrido

  // El dedo no se ha movido, pero el contenido sí: bajo el mismo punto de pantalla hay ahora
  // otro texto, así que la selección crece sola mientras se sostiene contra el borde.
  extender(x, y);
  rafAuto = requestAnimationFrame(pasoAutoscroll);
}

function quizaAutoscroll(x, y) {
  ultimoPunto = { x, y };
  if (!rafAuto) rafAuto = requestAnimationFrame(pasoAutoscroll);
}

// --- extender la selección hasta un punto -------------------------------------
// Sale del manejador de touchmove porque el auto-desplazamiento la llama también, con el
// dedo quieto.
function extender(x, y) {
  if (!active) return;
  const pos = posicionEn(x, y, active.pagina, active.spans);
  if (!pos) return;
  let [ini, fin] = ordenar({ idx: active.anclaIdx, off: active.anclaOff }, pos);
  // El ajuste por líneas solo en el arrastre INICIAL, y solo al salir de la línea.
  if (!active.ajustando && active.spans[ini.idx].linea !== active.spans[fin.idx].linea) {
    [ini, fin] = aLineasCompletas(active.spans, ini, fin);
  }
  active.ini = ini; active.fin = fin;
  pintar();
}

// --- gesto --------------------------------------------------------------------
export function install(container, cbs) {
  callbacks = { ...callbacks, ...(cbs || {}) };
  if (container.dataset.touchSelWired) return;
  container.dataset.touchSelWired = '1';
  container.addEventListener('scroll', alDesplazar, { passive: true });
  window.addEventListener('scroll', alDesplazar, { passive: true });
  window.addEventListener('resize', alDesplazar);

  let downX = 0, downY = 0, movido = false;
  let lpTimer = null, lpIniciado = false, tirador = null;
  const limpiarLP = () => { clearTimeout(lpTimer); lpTimer = null; };

  container.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { limpiarLP(); movido = true; return; }
    const t = e.touches[0];
    downX = t.clientX; downY = t.clientY;
    movido = false; lpIniciado = false; tirador = null;

    // ¿Agarra un tirador de la selección que ya hay? → afinar ese extremo por caracteres.
    if (active) {
      const rects = rectsDelTramo(active.spans, active.ini, active.fin);
      const cual = Engine.hitHandle(rects, Engine.IDENTIDAD, t.clientX, t.clientY);
      if (cual) {
        tirador = cual;
        // El ancla es el extremo OPUESTO al que se arrastra.
        const op = cual === 'end' ? active.ini : active.fin;
        active.anclaIdx = op.idx; active.anclaOff = op.off;
        active.ajustando = true;   // afinar NO vuelve a ajustar por líneas
        e.preventDefault();
        return;
      }
    }

    lpTimer = setTimeout(() => {
      lpTimer = null;
      if (movido) return;
      const pagina = document.elementFromPoint(downX, downY)?.closest?.('#pdf-container .pdf-page');
      if (!pagina) return;
      const spans = spansEnOrdenVisual(pagina);
      const pos = posicionEn(downX, downY, pagina, spans);
      if (!pos) return;
      // Arranca en la PALABRA bajo el dedo, como en el EPUB: una selección de un carácter no
      // se ve y no se puede agarrar.
      const palabra = Engine.expandToWord(document, spans[pos.idx].nodo, pos.off);
      const ini = { idx: pos.idx, off: palabra ? palabra.startOffset : pos.off };
      const fin = { idx: pos.idx, off: palabra ? palabra.endOffset : pos.off };
      active = { pagina, spans, ini, fin, anclaIdx: ini.idx, anclaOff: ini.off, ajustando: false };
      lpIniciado = true;
      pintar();
    }, LONGPRESS_MS);
  }, { passive: false });

  container.addEventListener('touchmove', (e) => {
    const t = e.touches[0]; if (!t) return;
    if (Math.abs(t.clientX - downX) > MOVE_CANCEL || Math.abs(t.clientY - downY) > MOVE_CANCEL) movido = true;
    if (lpTimer && movido) { limpiarLP(); return; }   // se movió antes de tiempo → es scroll
    if (!active || (!tirador && !lpIniciado)) return;

    e.preventDefault();
    extender(t.clientX, t.clientY);
    quizaAutoscroll(t.clientX, t.clientY);
  }, { passive: false });

  container.addEventListener('touchend', () => {
    limpiarLP();
    pararAutoscroll();
    ultimoPunto = null;
    if (tirador || lpIniciado) { tirador = null; lpIniciado = false; entregar(); return; }
    // Un toque suelto con selección a la vista la descarta; el resto de toques (pasar página,
    // alternar barras) los sigue llevando app.js.
    if (active && !movido) dismiss();
  }, { passive: true });
}
