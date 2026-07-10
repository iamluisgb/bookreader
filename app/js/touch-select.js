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
// Toda la geometría de ENTRADA va en coordenadas del iframe (lo que devuelven
// los toques, caretRangeFromPoint y getClientRects). Solo al DIBUJAR sumamos el
// desplazamiento del iframe para pasar a coordenadas de pantalla.

let callbacks = { onTap: () => {}, onImageTap: () => {}, onSelect: () => {}, onDismiss: () => {}, onSwipeMove: () => {}, onSwipeEnd: () => {} };
export function configure(c) { callbacks = { ...callbacks, ...c }; }

const LONGPRESS_MS = 380;   // pulsación larga que inicia la selección
const MOVE_CANCEL = 10;     // px de movimiento que cancela la pulsación (=scroll)
const HANDLE_HIT = 26;      // radio de toque para agarrar un tirador (px)
const HANDLE_OFFSET = 14;   // separación del círculo del tirador respecto a la línea
const SWIPE_START = 10;     // px horizontales que inician el arrastre de página

// Estado de la selección activa (una a la vez).
let active = null;  // { contents, doc, range, anchor }
let overlay = null; // capa de dibujo en el documento padre

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'ts-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:150;display:none;';
  overlay.innerHTML = `
    <div class="ts-hilayer"></div>
    <div class="ts-handle ts-start"></div>
    <div class="ts-handle ts-end"></div>`;
  document.body.appendChild(overlay);
  if (!document.getElementById('ts-overlay-style')) {
    const s = document.createElement('style');
    s.id = 'ts-overlay-style';
    s.textContent = `
      #ts-overlay .ts-hi { position:absolute; background:rgba(100,181,246,0.40); border-radius:2px; }
      #ts-overlay .ts-handle { position:absolute; width:0; height:0; }
      #ts-overlay .ts-handle::before { content:''; position:absolute; left:-1px; width:2px; height:18px; background:#2563eb; }
      #ts-overlay .ts-handle::after  { content:''; position:absolute; left:-8px; width:16px; height:16px; border-radius:50%; background:#2563eb; box-shadow:0 1px 3px rgba(0,0,0,.3); }
      #ts-overlay .ts-start::before { top:-18px; }   #ts-overlay .ts-start::after { top:-32px; }
      #ts-overlay .ts-end::before   { top:0; }        #ts-overlay .ts-end::after   { top:16px; }`;
    document.head.appendChild(s);
  }
  return overlay;
}

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
function iframeOffset() {
  const f = document.querySelector('#epub-container iframe');
  const r = f ? f.getBoundingClientRect() : { left: 0, top: 0 };
  return { x: r.left, y: r.top };
}

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

// Char-class de limites de palabra con unicode intencionado para la seleccion.
// eslint-disable-next-line no-irregular-whitespace, no-useless-escape
const WORD_RE = /[^\s .,;:!?¡¿"'«»()\[\]{}—–\-]/;

function expandToWord(doc, node, offset) {
  if (!node || node.nodeType !== 3) return null;
  const t = node.textContent;
  let s = offset, e = offset;
  while (s > 0 && WORD_RE.test(t[s - 1])) s--;
  while (e < t.length && WORD_RE.test(t[e])) e++;
  if (s === e) {                       // cayó en espacio/puntuación → palabra siguiente
    while (e < t.length && !WORD_RE.test(t[e])) e++;
    s = e;
    while (e < t.length && WORD_RE.test(t[e])) e++;
  }
  if (s === e) return null;
  const r = doc.createRange();
  r.setStart(node, s); r.setEnd(node, e);
  return r;
}

// Rango ordenado entre un punto ancla (fijo) y el punto foco (móvil).
function orderedRange(doc, aNode, aOff, fNode, fOff) {
  const r = doc.createRange();
  try {
    r.setStart(aNode, aOff);
    if (r.comparePoint(fNode, fOff) >= 0) r.setEnd(fNode, fOff);
    else { r.setEnd(aNode, aOff); r.setStart(fNode, fOff); }
  } catch (e) { return null; }
  return r;
}

// --- dibujo (capa del padre, coords de pantalla) ----------------------------
function draw() {
  if (!active || !active.range) return;
  const o = ensureOverlay();
  o.style.display = 'block';
  const off = iframeOffset();
  const rects = active.range.getClientRects();
  // resaltado
  const hl = o.querySelector('.ts-hilayer');
  hl.innerHTML = '';
  for (const r of rects) {
    if (r.width < 0.5 || r.height < 0.5) continue;
    const d = document.createElement('div');
    d.className = 'ts-hi';
    d.style.left = (off.x + r.left) + 'px';
    d.style.top = (off.y + r.top) + 'px';
    d.style.width = r.width + 'px';
    d.style.height = r.height + 'px';
    hl.appendChild(d);
  }
  // tiradores en los extremos
  if (rects.length) {
    const first = rects[0], last = rects[rects.length - 1];
    const hs = o.querySelector('.ts-start'), he = o.querySelector('.ts-end');
    hs.style.left = (off.x + first.left) + 'px';
    hs.style.top = (off.y + first.top) + 'px';
    hs.style.height = first.height + 'px';
    he.style.left = (off.x + last.right) + 'px';
    he.style.top = (off.y + last.top) + 'px';
    he.style.height = last.height + 'px';
  }
}

// Posiciones (coords del iframe) de los círculos de los tiradores, para el
// hit-test del agarre.
function handlePoints() {
  const rects = active.range.getClientRects();
  if (!rects.length) return null;
  const first = rects[0], last = rects[rects.length - 1];
  return {
    start: { x: first.left, y: first.top - HANDLE_OFFSET },
    end:   { x: last.right, y: last.bottom + HANDLE_OFFSET },
  };
}

function hitHandle(x, y) {
  if (!active || !active.range) return null;
  const p = handlePoints();
  if (!p) return null;
  const ds = Math.hypot(x - p.start.x, y - p.start.y);
  const de = Math.hypot(x - p.end.x, y - p.end.y);
  if (ds <= HANDLE_HIT && ds <= de) return 'start';
  if (de <= HANDLE_HIT) return 'end';
  return null;
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

function screenRect(range) {
  const off = iframeOffset();
  const r = range.getBoundingClientRect();
  return { left: off.x + r.left, top: off.y + r.top, width: r.width, height: r.height };
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
  if (overlay) overlay.style.display = 'none';
  callbacks.onDismiss();
}

export function hasSelection() { return !!(active && active.range); }

function tapZone(x) {
  const cont = document.getElementById('epub-container');
  const w = (cont && cont.clientWidth) || window.innerWidth || 1;
  const within = ((x % w) + w) % w;
  const f = within / w;
  return f < 0.28 ? 'prev' : f > 0.72 ? 'next' : 'center';
}

// Reposiciona la capa si cambia el viewport mientras hay selección.
window.addEventListener('resize', () => { if (active) draw(); });

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
