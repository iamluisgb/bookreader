// pdf-text-select.js — Selección de texto con ratón en el PDF, acotada por geometría.
//
// La capa de texto de pdf.js son `<span>` posicionados en absoluto, y su orden en el DOM es
// el del flujo de contenido del PDF, que no tiene por qué parecerse a lo que se ve. Cuando
// el puntero cae en un hueco —el margen, el aire entre dos bloques, más allá del final de
// una línea— el navegador resuelve el cursor por PROXIMIDAD EN EL DOM, no por proximidad en
// la página, y aterriza donde le parece.
//
// Medido sobre un PDF de prueba, queriendo seleccionar un párrafo de 223 caracteres:
//   · arrancando 120 px a la izquierda de la primera línea → 684 (ancla en la cabecera de
//     la página, arrastrando todo lo que hay en medio);
//   · arrancando 12 px por encima → 228 (se cuela la línea anterior);
//   · soltando 120 px a la derecha del final → 592;
//   · soltando 40 px por debajo → 301.
//
// El mecanismo `.endOfContent` del visor de pdf.js no arregla esto: ataca el desbordamiento
// hacia abajo al arrastrar fuera de la página, no el anclaje. Medido: sin efecto en los
// cuatro casos.
//
// Así que la selección con ratón se lleva aquí, como ya se hacía en táctil para el EPUB
// (touch-select.js): en cada extremo se busca el span MÁS CERCANO EN LA PÁGINA, se mete el
// punto dentro de su rectángulo y ahí sí se pide el cursor al navegador, que sobre texto
// acierta. El doble y el triple clic se dejan al navegador, que ya seleccionan palabra y
// párrafo bien. En táctil no se toca nada: ahí la selección la hace el sistema.
import * as RegionSelect from './region-select.js';

// Peso del eje vertical al buscar el span más cercano. La LÍNEA manda: entre un span de la
// línea de al lado y otro lejos en la misma línea, se quiere el de la misma línea.
const PESO_VERTICAL = 1000;

let arrastre = null;   // { pagina } mientras el botón está pulsado

function paginaEn(x, y) {
  const el = document.elementFromPoint(x, y);
  const directa = el && el.closest ? el.closest('#pdf-container .pdf-page') : null;
  if (directa) return directa;
  // Fuera de la caja de la página —el fondo gris de alrededor, o al arrastrar más allá del
  // borde— vale la página más cercana. Sin este repliegue, arrancar el arrastre en el fondo
  // dejaba el anclaje en manos del navegador, que es justo lo que se quiere evitar.
  let mejor = null, mejorD = Infinity;
  for (const p of document.querySelectorAll('#pdf-container .pdf-page')) {
    const r = p.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const d = Math.hypot(dx, dy);
    if (d < mejorD) { mejorD = d; mejor = p; }
  }
  return mejor;
}

function cursorNativo(x, y) {
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (r) return { node: r.startContainer, offset: r.startOffset };
  }
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (p) return { node: p.offsetNode, offset: p.offset };
  }
  return null;
}

function spanMasCercano(pagina, x, y) {
  let mejor = null, mejorD = Infinity;
  for (const s of pagina.querySelectorAll('.textLayer span')) {
    const r = s.getBoundingClientRect();
    if (r.width < 0.5 || r.height < 0.5) continue;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const d = dy * PESO_VERTICAL + dx;
    if (d < mejorD) { mejorD = d; mejor = r; }
  }
  return mejor;
}

// El punto, pegado a la mancha de texto de una página concreta.
function cursorAcotadoA(pagina, x, y) {
  const r = spanMasCercano(pagina, x, y);
  if (!r) return null;
  // Medio píxel hacia dentro: justo en el borde el navegador puede resolver al vecino.
  return cursorNativo(
    Math.min(Math.max(x, r.left + 0.5), r.right - 0.5),
    Math.min(Math.max(y, r.top + 0.5), r.bottom - 0.5),
  );
}

// Cursor para un punto de pantalla, acotado a la mancha de texto de la página. Es LA regla
// del módulo —los dos extremos del arrastre pasan por aquí— y por eso se exporta: los tests
// la ejercitan sobre un layout sintético con un hueco grande, que es el caso que un PDF de
// prueba corriente (párrafos seguidos) no sabe expresar.
export function cursorEnPunto(x, y, paginaPorDefecto) {
  const el = document.elementFromPoint(x, y);
  // Ya está sobre texto: el navegador acierta y no hay nada que corregir.
  if (el && el.closest && el.closest('#pdf-container .textLayer span')) return cursorNativo(x, y);

  const pagina = paginaEn(x, y) || paginaPorDefecto;
  if (!pagina) return null;
  return cursorAcotadoA(pagina, x, y);
}

// Igual, pero clavado a UNA página. Lo usa el arrastre táctil: un subrayado de PDF se guarda
// contra una sola página, así que la selección no puede saltar a la siguiente. Sin esto, al
// arrastrar hasta el borde inferior el punto caía ya en la página de abajo, el span resuelto
// no estaba en el tramo y la selección dejaba de crecer justo cuando el lector empezaba a
// desplazarse solo.
export function cursorEnPagina(x, y, pagina) {
  if (!pagina) return null;
  const el = document.elementFromPoint(x, y);
  const span = el && el.closest ? el.closest('#pdf-container .textLayer span') : null;
  if (span && pagina.contains(span)) return cursorNativo(x, y);
  return cursorAcotadoA(pagina, x, y);
}

function alBajar(e) {
  if (e.button !== 0) return;
  if (e.detail >= 2) return;                 // doble/triple clic: los hace bien el navegador
  if (RegionSelect.isActive && RegionSelect.isActive()) return;
  const pagina = paginaEn(e.clientX, e.clientY);
  if (!pagina) return;
  const pos = cursorEnPunto(e.clientX, e.clientY, pagina);
  if (!pos) return;

  // Que el navegador no ponga SU ancla: es justo la que se equivoca.
  e.preventDefault();
  const sel = window.getSelection();
  sel.removeAllRanges();
  const r = document.createRange();
  r.setStart(pos.node, pos.offset);
  r.collapse(true);
  sel.addRange(r);
  arrastre = { pagina };

  window.addEventListener('mousemove', alMover, true);
  window.addEventListener('mouseup', alSoltar, true);
}

function alMover(e) {
  if (!arrastre) return;
  const pos = cursorEnPunto(e.clientX, e.clientY, arrastre.pagina);
  if (!pos) return;
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  try { sel.extend(pos.node, pos.offset); } catch (err) { /* nodo de otra página */ }
}

function alSoltar() {
  arrastre = null;
  window.removeEventListener('mousemove', alMover, true);
  window.removeEventListener('mouseup', alSoltar, true);
}

export function install(container) {
  if (!container || container.dataset.textSelWired) return;
  container.dataset.textSelWired = '1';
  container.addEventListener('mousedown', alBajar);
}
