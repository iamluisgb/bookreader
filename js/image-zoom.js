// image-zoom.js — Lightbox con zoom para imágenes del libro (útil en libros
// técnicos: diagramas, tablas como imagen, etc.). Tocar una figura la abre a pantalla
// completa; se amplía con pinch (táctil), rueda (escritorio) o doble toque/clic, y se
// desplaza arrastrando cuando está ampliada. Se cierra con la ✕, Escape o tocando el
// fondo. La imagen del iframe de lectura es same-origin (el lector le inyecta estilos),
// así que reutilizamos su `src` (normalmente un blob:) directamente aquí.
import { icon } from './ui/icons.js';

let overlay = null, imgEl = null;
let scale = 1, tx = 0, ty = 0, openedAt = 0;
const MIN = 1, MAX = 6, ZOOM_STEP = 2.5;

const pointers = new Map();
let startDist = 0, startScale = 1, lastMid = null, panStart = null;
let lastTap = 0, movedSincePress = false, downPos = null, lastTouchUp = 0;

function apply() { imgEl.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`; }
function reset() { scale = 1; tx = 0; ty = 0; apply(); }
function clamp(s) { return Math.min(MAX, Math.max(MIN, s)); }
function isOpen() { return overlay && overlay.style.display !== 'none'; }

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function openImageZoom(srcOrImg) {
  const src = typeof srcOrImg === 'string' ? srcOrImg : (srcOrImg && (srcOrImg.currentSrc || srcOrImg.src));
  if (!src) return;
  ensureOverlay();
  imgEl.src = src;
  reset();
  overlay.style.display = 'flex';
  openedAt = Date.now();   // ignora el "click fantasma" del toque que abre (ver más abajo)
}

function close() {
  if (!overlay) return;
  overlay.style.display = 'none';
  imgEl.removeAttribute('src');
  pointers.clear();
}

function ensureOverlay() {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.id = 'img-zoom';
  overlay.className = 'img-zoom';
  overlay.style.display = 'none';
  overlay.innerHTML = `
    <button class="img-zoom-close" aria-label="Cerrar">${icon('xmark', { size: 22 })}</button>
    <img class="img-zoom-img" alt="Imagen del libro" draggable="false">`;
  document.body.appendChild(overlay);
  imgEl = overlay.querySelector('.img-zoom-img');

  overlay.querySelector('.img-zoom-close').addEventListener('click', (e) => { e.stopPropagation(); close(); });
  // Fondo → cerrar. En móvil, al abrir desde un TOQUE, el navegador sintetiza un
  // "click fantasma" ~300 ms después; como la imagen aún no ha cargado (sin tamaño),
  // ese click cae en el fondo y cerraría el visor recién abierto. Lo ignoramos.
  overlay.addEventListener('click', (e) => {
    if (Date.now() - openedAt < 450) return;
    if (e.target === overlay) close();
  });
  overlay.addEventListener('dblclick', (e) => {                                        // ratón → alternar zoom
    if (e.target.closest('.img-zoom-close')) return;
    if (Date.now() - lastTouchUp < 600) return;   // dblclick fantasma de un doble-TOQUE: ya lo gestionó onUp
    e.preventDefault();
    if (scale > 1) reset(); else { scale = ZOOM_STEP; apply(); }
  });
  overlay.addEventListener('pointerdown', onDown);
  overlay.addEventListener('pointermove', onMove);
  overlay.addEventListener('pointerup', onUp);
  overlay.addEventListener('pointercancel', onUp);
  overlay.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close(); });
}

function onDown(e) {
  if (e.target.closest('.img-zoom-close')) return;     // el botón cerrar no participa en gestos
  // Ni preventDefault ni setPointerCapture: ambos suprimen los click/dblclick del ratón
  // (zoom con doble clic). El overlay ocupa toda la pantalla, así que los pointermove no
  // se escapan; y `touch-action: none` (CSS) ya evita el scroll/zoom nativo en táctil.
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  movedSincePress = false;
  downPos = { x: e.clientX, y: e.clientY };
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    startDist = dist(a, b); startScale = scale; lastMid = mid(a, b);
  } else {
    panStart = { x: e.clientX, y: e.clientY, tx, ty };
  }
}

function onMove(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (downPos && Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 8) movedSincePress = true;

  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const m = mid(a, b);
    if (startDist > 0) scale = clamp(startScale * (dist(a, b) / startDist));
    if (lastMid) { tx += m.x - lastMid.x; ty += m.y - lastMid.y; }   // desplazar con el gesto
    lastMid = m;
    apply();
  } else if (pointers.size === 1 && scale > 1 && panStart) {
    tx = panStart.tx + (e.clientX - panStart.x);
    ty = panStart.ty + (e.clientY - panStart.y);
    apply();
  }
}

function onUp(e) {
  if (e.target.closest('.img-zoom-close')) return;
  pointers.delete(e.pointerId);
  lastMid = null;
  if (pointers.size === 1) {
    const p = [...pointers.values()][0];
    panStart = { x: p.x, y: p.y, tx, ty };
  }
  if (e.pointerType === 'touch') lastTouchUp = Date.now();   // marca para ignorar el dblclick fantasma
  // Doble TOQUE (táctil) → alternar zoom. En ratón lo hace el evento 'dblclick'.
  if (pointers.size === 0 && e.pointerType === 'touch' && !movedSincePress) {
    const now = Date.now();
    if (now - lastTap < 300) {
      lastTap = 0;
      if (scale > 1) reset(); else { scale = ZOOM_STEP; apply(); }
    } else {
      lastTap = now;
    }
  }
}

function onWheel(e) {
  e.preventDefault();
  scale = clamp(scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
  if (scale === 1) { tx = 0; ty = 0; }
  apply();
}
