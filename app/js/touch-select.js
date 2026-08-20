// touch-select.js — Selección de texto propia para táctil.
//
// epub.js maqueta el contenido en columnas CSS y, en táctil, los tiradores de
// selección NATIVOS del navegador se rompen (la selección se colapsa a un
// carácter y no se puede extender — bug conocido de epub.js #904). Además la
// selección nativa arrastra los menús del SO (Copiar/Compartir, buscador de
// Google) que tapan nuestra barra.
//
// Aquí tomamos el control total SOLO en táctil: desactivamos la selección
// nativa y la reimplementamos —mantener pulsado fija una palabra, y se extiende
// arrastrando NUESTROS tiradores— calculando el rango con caretRangeFromPoint.
// El resaltado y los tiradores se pintan en una capa del documento PADRE,
// encima del iframe, para no depender de cómo epub.js desplaza las columnas.
//
// La capa de dibujo, los tiradores y las utilidades de rango son COMUNES con la selección
// táctil del PDF y viven en ui/selection-engine.js. Aquí queda lo propio del EPUB: el gesto
// —que compite con el pase de página y con el toque en una imagen— y el paso a coordenadas
// de pantalla, que en el EPUB lleva la escala del viewport (ver ui/frame-rect.js).

import { rafThrottle } from './ui/raf.js';
import { frameTransform, toScreen, anchorRect } from './ui/frame-rect.js';
import * as Engine from './ui/selection-engine.js';

let callbacks = { onTap: () => {}, onImageTap: () => {}, onSelect: () => {}, onDismiss: () => {}, onSwipeMove: () => {}, onSwipeEnd: () => {} };
export function configure(c) { callbacks = { ...callbacks, ...c }; }

const LONGPRESS_MS = 380;   // pulsación larga que inicia la selección
const MOVE_CANCEL = 10;     // px de movimiento que cancela la pulsación (=scroll)
const SWIPE_START = 10;     // px horizontales que inician el arrastre de página

// Estado de la selección activa (una a la vez).
let active = null;  // { contents, doc, range, anchor }
// Desactiva la selección nativa dentro del contenido (solo táctil).
function injectStyles(doc) {
  if (doc.getElementById('ts-content-style')) return;
  const s = doc.createElement('style');
  s.id = 'ts-content-style';
  s.textContent = `html, body, p, div, span, li, a, blockquote, h1, h2, h3, h4, h5, h6 {
    -webkit-user-select: none !important; user-select: none !important; -webkit-touch-callout: none !important;
  }`;
  doc.head.appendChild(s);
}

// --- coordenadas: iframe ↔ pantalla -----------------------------------------
// Offset Y ESCALA: el viewport del lector se encoge cuando las barras están a la vista
// (ver ui/frame-rect.js). Sumar solo el offset dejaba el resaltado y los tiradores
// desplazados, cada vez más abajo en la página.

// --- caret bajo un punto (coords del iframe) --------------------------------
function caretAt(doc, x, y) {
  try {
    if (doc.caretRangeFromPoint) {
      const r = doc.caretRangeFromPoint(x, y);
      if (r) return { node: r.startContainer, offset: r.startOffset };
    }
    if (doc.caretPositionFromPoint) {
      const p = doc.caretPositionFromPoint(x, y);
      if (p) return { node: p.offsetNode, offset: p.offset };
    }
  } catch (e) { /* fuera de texto */ }
  return null;
}

const expandToWord = Engine.expandToWord;
const orderedRange = Engine.orderedRange;

// --- dibujo (capa del padre, coords de pantalla) ----------------------------
function draw() {
  if (!active || !active.range) return;
  Engine.draw(Engine.usableRects(active.range), frameTransform());
}

function hitHandle(x, y) {
  if (!active || !active.range) return null;
  return Engine.hitHandle(Engine.usableRects(active.range), frameTransform(), x, y);
}

function setActive(contents, range) {
  active = { contents, doc: contents.document, range, anchor: null };
}

function updateEndpoint(which, x, y) {
  const pos = caretAt(active.doc, x, y);
  if (!pos) return;
  const a = active.anchor;
  const r = orderedRange(active.doc, a.node, a.offset, pos.node, pos.offset);
  if (!r || r.collapsed) return;
  active.range = r;
  draw();
}

// Caja donde colocar la barra de acciones, en coordenadas de pantalla: la PRIMERA línea
// de la selección, no el bounding box de todas (ver anchorRect).
function screenRect(range) {
  const a = anchorRect(range);
  return a ? toScreen(a) : null;
}

function finalize() {
  if (!active || !active.range) return;
  const text = active.range.toString().trim();
  if (!text) { dismiss(); return; }
  let cfiRange = '';
  try { cfiRange = active.contents.cfiFromRange(active.range); } catch (e) {}
  callbacks.onSelect({ cfiRange, text, rect: screenRect(active.range) });
}

export function dismiss() {
  active = null;
  Engine.hideOverlay();
  callbacks.onDismiss();
}

export function hasSelection() { return !!(active && active.range); }

function tapZone(x) {
  const cont = document.getElementById('epub-container');
  const w = (cont && cont.clientWidth) || window.innerWidth || 1;
  const within = ((x % w) + w) % w;
  const f = within / w;
  // Bordes del 20%: tocar por el centro no debe pasar página (solo alternar barras).
  return f < 0.2 ? 'prev' : f > 0.8 ? 'next' : 'center';
}

// Reposiciona la capa si cambia el viewport mientras hay selección. Una por frame: el
// `resize` llega en ráfaga y cada draw() mide y repinta los tiradores.
window.addEventListener('resize', rafThrottle(() => { if (active) draw(); }));

export function attach(contents) {
  const doc = contents.document;
  injectStyles(doc);

  let downX = 0, downY = 0, downT = 0, moved = false;
  let lpTimer = null, lpStarted = false, dragging = null, swiping = false;
  const clearLP = () => { clearTimeout(lpTimer); lpTimer = null; };

  doc.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { clearLP(); moved = true; return; }
    const t = e.touches[0];
    downX = t.clientX; downY = t.clientY; downT = Date.now();
    moved = false; lpStarted = false; dragging = null; swiping = false;

    // ¿hay selección y el toque agarra un tirador? → arrastrar ese extremo
    if (active && active.range) {
      const hit = hitHandle(t.clientX, t.clientY);
      if (hit) {
        dragging = hit;
        const r = active.range;
        // el ancla es el extremo OPUESTO al que se arrastra
        active.anchor = hit === 'end'
          ? { node: r.startContainer, offset: r.startOffset }
          : { node: r.endContainer, offset: r.endOffset };
        e.preventDefault();
        return;
      }
    }

    // programar la pulsación larga que inicia una nueva selección
    lpTimer = setTimeout(() => {
      lpTimer = null;
      if (moved) return;
      const pos = caretAt(doc, downX, downY);
      const word = pos && expandToWord(doc, pos.node, pos.offset);
      if (!word) return;
      setActive(contents, word);
      // ancla = inicio de la palabra; el arrastre posterior mueve el final
      active.anchor = { node: word.startContainer, offset: word.startOffset };
      lpStarted = true;
      draw();
    }, LONGPRESS_MS);
  }, { passive: false });

  doc.addEventListener('touchmove', (e) => {
    const t = e.touches[0]; if (!t) return;
    const adx = Math.abs(t.clientX - downX), ady = Math.abs(t.clientY - downY);
    if (adx > MOVE_CANCEL || ady > MOVE_CANCEL) moved = true;

    if (dragging) { e.preventDefault(); updateEndpoint(dragging, t.clientX, t.clientY); return; }
    if (lpStarted) { e.preventDefault(); updateEndpoint('end', t.clientX, t.clientY); return; }
    if (lpTimer && moved) clearLP();   // se movió antes del long-press → es scroll

    // Arrastre de página (swipe): horizontal dominante y sin selección en curso.
    // La página sigue al dedo; el efecto de giro lo hace el consumidor (epub-reader).
    if (!(active && active.range) && (swiping || (adx > SWIPE_START && adx > ady))) {
      swiping = true;
      e.preventDefault();
      callbacks.onSwipeMove(t.clientX - downX);
    }
  }, { passive: false });

  doc.addEventListener('touchend', (e) => {
    clearLP();
    if (dragging || lpStarted) { dragging = null; lpStarted = false; finalize(); return; }

    const t = e.changedTouches[0];
    const dx = t ? t.clientX - downX : 0;
    const quick = !moved && Date.now() - downT < 500;
    if (active && active.range) { if (quick) dismiss(); return; }  // tocar fuera cierra

    // Fin del arrastre de página: el consumidor decide girar o volver (bounce)
    // según el umbral. El long-press ya separó antes los "mantener pulsado".
    if (swiping) { swiping = false; callbacks.onSwipeEnd(dx); return; }

    if (quick && t) {
      const zone = tapZone(t.clientX);
      // Toque central sobre una imagen → abrir zoom. En los bordes se pasa página
      // igualmente (para páginas que son una imagen a sangre completa).
      if (zone === 'center') {
        const el = doc.elementFromPoint(t.clientX, t.clientY);
        const img = el && el.closest && el.closest('img');
        if (img) { callbacks.onImageTap(img); return; }
      }
      callbacks.onTap(zone);
    }
  }, { passive: true });
}
