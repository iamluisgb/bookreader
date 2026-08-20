// selection-engine.js — Las piezas comunes de la selección de texto propia en táctil.
//
// La app reimplementa la selección táctil en dos sitios, y por el mismo motivo en los dos:
// las asas NATIVAS del navegador no se dejan gobernar. En el EPUB porque epub.js maqueta en
// columnas y las asas se rompen (bug conocido #904); en el PDF porque la capa de texto son
// spans en absoluto cuyo orden en el DOM no es el de la página, así que al arrastrar el asa
// por un hueco el navegador ancla donde le parece y la selección se dispara. Y en ninguno de
// los dos casos se puede corregir desde fuera: el arrastre de un asa nativa NO emite eventos
// táctiles a la página.
//
// Lo que vive aquí es lo que comparten: la capa de dibujo, los tiradores, el hit-test del
// agarre y las utilidades de rango. Lo que NO vive aquí es el gesto: cada consumidor tiene el
// suyo (el EPUB compite con el pase de página y el toque en una imagen; el PDF no), y meterlo
// todo en un tronco común habría salido más enrevesado que las dos versiones por separado.
//
// COORDENADAS. Toda la geometría de entrada —toques, caretRangeFromPoint, getClientRects—
// va en coordenadas del documento donde vive el texto. Al dibujar se pasa a pantalla con la
// `transform` que da el consumidor: en el EPUB el iframe lleva una escala (ver frame-rect),
// y en el PDF no hay ninguna, `IDENTIDAD`.

export const HANDLE_HIT = 26;   // radio de toque para agarrar un tirador (px de pantalla)
// Centro del círculo de cada tirador respecto a su línea, en px de pantalla. Sale de las
// reglas CSS de más abajo (::after a -32/+16 con 16 px de diámetro): el agarre se comprueba
// EXACTAMENTE donde está pintado el círculo, no en una posición paralela.
const HANDLE_CY_START = -24;
const HANDLE_CY_END = 24;

export const IDENTIDAD = { x: 0, y: 0, sx: 1, sy: 1 };

let overlay = null;

export function ensureOverlay() {
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

export function hideOverlay() {
  if (overlay) overlay.style.display = 'none';
}

// Rects de un rango sin los degenerados. `getClientRects()` mete rects de ancho o alto cero
// en los saltos de línea y de columna; tomar uno de esos como extremo pone el tirador donde
// no hay texto.
export function usableRects(range) {
  const out = [];
  for (const r of range.getClientRects()) {
    if (r.width >= 0.5 && r.height >= 0.5) out.push(r);
  }
  return out;
}

function aPantalla(rect, tr) {
  return {
    left: tr.x + rect.left * tr.sx,
    top: tr.y + rect.top * tr.sy,
    width: rect.width * tr.sx,
    height: rect.height * tr.sy,
  };
}

// `rects` son los rectángulos de la selección en coordenadas del documento del texto. Se
// pasan ya calculados —y no el rango— porque en el PDF una selección de varias líneas NO es
// un rango del DOM: el orden de los spans en el DOM no es el de la página, así que se
// construye recorriendo las líneas en orden VISUAL (ver pdf-touch-select.js).
export function draw(rects, tr) {
  const o = ensureOverlay();
  o.style.display = 'block';

  const hl = o.querySelector('.ts-hilayer');
  hl.innerHTML = '';
  for (const r of rects) {
    const s = aPantalla(r, tr);
    const d = document.createElement('div');
    d.className = 'ts-hi';
    d.style.left = s.left + 'px';
    d.style.top = s.top + 'px';
    d.style.width = s.width + 'px';
    d.style.height = s.height + 'px';
    hl.appendChild(d);
  }

  if (rects.length) {
    const first = rects[0], last = rects[rects.length - 1];
    const fs = aPantalla(first, tr);
    const ls = aPantalla({ left: last.right, top: last.top, width: 0, height: last.height }, tr);
    const hs = o.querySelector('.ts-start'), he = o.querySelector('.ts-end');
    hs.style.left = fs.left + 'px'; hs.style.top = fs.top + 'px'; hs.style.height = fs.height + 'px';
    he.style.left = ls.left + 'px'; he.style.top = ls.top + 'px'; he.style.height = ls.height + 'px';
  }
}

// Centros de los círculos de los tiradores, en coordenadas de PANTALLA.
export function handlePoints(rects, tr) {
  if (!rects.length) return null;
  const first = rects[0], last = rects[rects.length - 1];
  const fs = aPantalla(first, tr);
  const ls = aPantalla({ left: last.right, top: last.top, width: 0, height: last.height }, tr);
  return {
    start: { x: fs.left, y: fs.top + HANDLE_CY_START },
    end:   { x: ls.left, y: ls.top + HANDLE_CY_END },
  };
}

// (x, y) llegan en coordenadas del documento del texto —es donde ocurre el toque—; se pasan
// a pantalla para compararlas con los círculos dibujados.
export function hitHandle(rects, tr, x, y) {
  const p = handlePoints(rects, tr);
  if (!p) return null;
  const sx = tr.x + x * tr.sx, sy = tr.y + y * tr.sy;
  const ds = Math.hypot(sx - p.start.x, sy - p.start.y);
  const de = Math.hypot(sx - p.end.x, sy - p.end.y);
  if (ds <= HANDLE_HIT && ds <= de) return 'start';
  if (de <= HANDLE_HIT) return 'end';
  return null;
}

// Char-class de limites de palabra con unicode intencionado para la seleccion.
// eslint-disable-next-line no-useless-escape
const WORD_RE = /[^\s .,;:!?¡¿"'«»()\[\]{}—–\-]/;

export function expandToWord(doc, node, offset) {
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
export function orderedRange(doc, aNode, aOff, fNode, fOff) {
  const r = doc.createRange();
  try {
    r.setStart(aNode, aOff);
    if (r.comparePoint(fNode, fOff) >= 0) r.setEnd(fNode, fOff);
    else { r.setEnd(aNode, aOff); r.setStart(fNode, fOff); }
  } catch (e) { return null; }
  return r;
}
