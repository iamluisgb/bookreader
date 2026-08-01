// IA6 v2 · Selección de REGIÓN sobre la página del PDF: el usuario arrastra un marco sobre
// una figura, una ecuación o una tabla y esa zona —no la página entera— es lo que se adjunta
// al turno de visión.
//
// Por qué un módulo aparte y no dentro de pdf-reader.js: esto es una capa de INTERACCIÓN
// efímera (se monta, captura un rect, se desmonta). El lector no debe saber que existe, y
// así se puede reutilizar tal cual el día que haya que rasterizar un EPUB.
//
// Las coordenadas que devuelve son FRACCIONALES sobre la página (0..1), el mismo sistema que
// los subrayados de PDF: sobreviven al zoom y al reflow, y valen para recapturar más tarde.
import { t } from './i18n.js';

let overlay = null;
let onDone = null;

export function isActive() { return !!overlay; }

// Arranca el modo selección. `onPick({page, rect})` recibe la zona elegida; `onCancel` se
// llama si el usuario sale con ESC, con el botón o con un clic sin arrastre.
//
// `onWholePage` es opcional y, si viene, añade un botón "Toda la página" a la barra de ayuda.
// Existe porque adjuntar la página entera y recortar una zona son la MISMA intención con dos
// alcances ("enséñale esto al agente"), y el sitio donde eliges alcance es mirando la página,
// no en el composer antes de haberla mirado. Es el patrón de la captura de pantalla del
// sistema: un punto de entrada, el modo se decide dentro. El módulo sigue sin saber quién lo
// usa: si no le pasas el callback, el botón no se pinta.
export function start({ onPick, onCancel, onWholePage } = {}) {
  cancel();
  const container = document.getElementById('pdf-container');
  if (!container) return false;

  onDone = { onPick, onCancel, onWholePage };
  overlay = document.createElement('div');
  overlay.className = 'region-overlay';
  overlay.innerHTML = `
    <div class="region-hint">
      <span>${t('Arrastra para marcar la zona')}</span>
      ${onWholePage ? `<button type="button" class="region-whole">${t('Toda la página')}</button>` : ''}
      <button type="button" class="region-cancel">${t('Cancelar')}</button>
    </div>
    <div class="region-box" hidden></div>`;
  // Fijo sobre el hueco del lector, NO dentro del contenedor que scrollea: así el marco se
  // dibuja en coordenadas de pantalla y no hay que compensar el scroll — que es de donde
  // salen los marcos desplazados en cuanto la página es más alta que la ventana.
  document.body.appendChild(overlay);
  placeOverlay(container);
  document.body.classList.add('region-selecting');

  const box = overlay.querySelector('.region-box');
  overlay.querySelector('.region-cancel').addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    finish(null);
  });
  // `pointerdown` y no `click`, igual que Cancelar: el overlay captura el puntero al bajar,
  // así que un `click` sobre los botones de la barra no llegaría a dispararse.
  overlay.querySelector('.region-whole')?.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    const cb = onDone?.onWholePage;
    cancel();
    cb?.();
  });
  document.addEventListener('keydown', onKey, true);

  let startPt = null;
  let wrapper = null;

  const pointFor = (e) => {
    const wr = wrapper.getBoundingClientRect();
    // Se recorta al área de la página: arrastrar fuera del papel no debe producir un rect
    // con coordenadas negativas o mayores que 1 (el recorte del canvas las rechazaría).
    return {
      x: Math.min(1, Math.max(0, (e.clientX - wr.left) / wr.width)),
      y: Math.min(1, Math.max(0, (e.clientY - wr.top) / wr.height)),
    };
  };

  overlay.addEventListener('pointerdown', (e) => {
    // La página bajo el dedo, no "la actual": en modo scroll hay varias a la vista y el
    // usuario puede marcar una zona de la de arriba mientras el lector cree estar en otra.
    wrapper = pageWrapperAt(e.clientX, e.clientY);
    if (!wrapper) return;
    e.preventDefault();
    overlay.setPointerCapture(e.pointerId);
    startPt = pointFor(e);
    drawBox(box, wrapper, startPt, startPt);
  });

  overlay.addEventListener('pointermove', (e) => {
    if (!startPt) return;
    drawBox(box, wrapper, startPt, pointFor(e));
  });

  const end = (e) => {
    if (!startPt) return;
    const a = startPt, b = pointFor(e);
    startPt = null;
    try { overlay.releasePointerCapture(e.pointerId); } catch { /* ya liberado */ }
    const rect = normalize(a, b);
    const page = parseInt(wrapper.dataset.page, 10);
    // Un toque sin arrastre no es una zona: se trata como cancelar, no como un recorte
    // minúsculo que luego el modelo no sabría leer.
    if (rect.w < 0.02 || rect.h < 0.02) { finish(null); return; }
    finish({ page, rect });
  };
  overlay.addEventListener('pointerup', end);
  overlay.addEventListener('pointercancel', () => finish(null));
  return true;
}

export function cancel() {
  document.removeEventListener('keydown', onKey, true);
  if (overlay) { overlay.remove(); overlay = null; }
  document.body.classList.remove('region-selecting');
  onDone = null;
}

function onKey(e) {
  if (e.key === 'Escape') { e.stopPropagation(); finish(null); }
}

function finish(picked) {
  const cbs = onDone;
  cancel();
  if (!cbs) return;
  if (picked) cbs.onPick?.(picked);
  else cbs.onCancel?.();
}

// El wrapper de página que hay bajo un punto de pantalla.
function pageWrapperAt(clientX, clientY) {
  for (const el of document.querySelectorAll('#pdf-container .pdf-page[data-page]')) {
    const r = el.getBoundingClientRect();
    if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return el;
  }
  return null;
}

// Rect normalizado (0..1) a partir de dos esquinas en cualquier orden.
export function normalize(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

function placeOverlay(container) {
  const cr = container.getBoundingClientRect();
  overlay.style.left = cr.left + 'px';
  overlay.style.top = cr.top + 'px';
  overlay.style.width = cr.width + 'px';
  overlay.style.height = cr.height + 'px';
}

// El marco, en coordenadas del overlay (que está fijo): esquina de la página en pantalla
// más la fracción arrastrada.
function drawBox(box, wrapper, a, b) {
  const or = overlay.getBoundingClientRect();
  const wr = wrapper.getBoundingClientRect();
  const r = normalize(a, b);
  box.hidden = false;
  box.style.left = (wr.left - or.left + r.x * wr.width) + 'px';
  box.style.top = (wr.top - or.top + r.y * wr.height) + 'px';
  box.style.width = (r.w * wr.width) + 'px';
  box.style.height = (r.h * wr.height) + 'px';
}
