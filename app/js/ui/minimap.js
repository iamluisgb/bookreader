// minimap.js — Minimapa del libro en el borde derecho del lector (idea de Matter, su
// «Annotations Minimap»): una marca por subrayado, con su color, a la altura que ocupa en
// el libro ENTERO; los capítulos de primer nivel como rayas finas; y dónde se está leyendo.
// Pasar el ratón por una marca enseña el texto del subrayado (o el título del capítulo) y
// hacer clic salta allí.
//
// Por qué del libro entero y no del capítulo: en EPUB paginado el capítulo no se ve de una
// vez, así que un mapa del capítulo no orienta. El libro entero sí: dice dónde se concentró
// lo subrayado y deja volver a ello sin abrir la barra lateral.
//
// Solo con ratón (`hover: hover` y `pointer: fine`, en CSS): en táctil el borde de la
// pantalla es del gesto de pasar página, y la lista de subrayados ya vive en la barra
// lateral. Por la misma razón el carril es `aria-hidden` y sus marcas no entran en el
// orden de tabulación: es un atajo de ratón sobre información que ya es accesible allí.
//
// Este módulo solo pinta: las fracciones (0..1) las calcula app.js, que sabe qué lector
// está activo. Cada marca: { f, kind: 'hl'|'ch', label, sub?, color?, go() }.

import { escapeHtml } from './escape.js';

let rail = null;
let tip = null;
let here = null;
let marks = [];

function ensure() {
  if (rail) return rail;
  const vp = document.getElementById('reader-viewport');
  if (!vp) return null;
  rail = document.createElement('div');
  rail.id = 'reader-minimap';
  rail.className = 'minimap';
  rail.setAttribute('aria-hidden', 'true');
  rail.hidden = true;
  vp.appendChild(rail);

  tip = document.createElement('div');
  tip.className = 'minimap-tip';
  tip.hidden = true;
  vp.appendChild(tip);

  rail.addEventListener('pointerover', (e) => {
    const el = e.target.closest('.minimap-mark');
    if (el) showTip(el); else hideTip();
  });
  rail.addEventListener('pointerleave', hideTip);
  rail.addEventListener('click', (e) => {
    const el = e.target.closest('.minimap-mark');
    const m = el && marks[Number(el.dataset.i)];
    if (!m) return;
    e.preventDefault();
    hideTip();
    try { m.go(); } catch (err) { console.warn('minimapa: salto fallido', err); }
  });
  return rail;
}

function showTip(el) {
  const m = marks[Number(el.dataset.i)];
  if (!m || !tip) return;
  const text = m.label.length > 220 ? m.label.slice(0, 217).trimEnd() + '…' : m.label;
  tip.className = 'minimap-tip minimap-tip--' + m.kind;
  tip.innerHTML = `<span class="minimap-tip-text">${escapeHtml(text)}</span>`
    + (m.sub ? `<span class="minimap-tip-sub">${escapeHtml(m.sub)}</span>` : '');
  tip.hidden = false;
  // A la altura de la marca, sin salirse por arriba ni por abajo del lector.
  const vp = rail.parentElement.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const h = tip.offsetHeight;
  const y = Math.min(Math.max(r.top + r.height / 2 - vp.top - h / 2, 8), vp.height - h - 8);
  tip.style.top = y + 'px';
}

function hideTip() { if (tip) tip.hidden = true; }

// Pinta las marcas. Los capítulos van primero en el DOM para que, si coinciden en altura
// con un subrayado, el subrayado quede encima y sea el que recibe el ratón.
export function setMarks(list) {
  const el = ensure();
  if (!el) return;
  marks = (list || []).filter((m) => Number.isFinite(m.f))
    .map((m) => ({ ...m, f: Math.min(1, Math.max(0, m.f)) }))
    .sort((a, b) => (a.kind === b.kind ? a.f - b.f : a.kind === 'ch' ? -1 : 1));
  hideTip();
  el.innerHTML = marks.map((m, i) => {
    const style = `top:${(m.f * 100).toFixed(3)}%` + (m.color ? `;--mm-color:${escapeHtml(m.color)}` : '');
    return `<div class="minimap-mark minimap-mark--${m.kind}" data-i="${i}" style="${style}"></div>`;
  }).join('');
  here = document.createElement('div');
  here.className = 'minimap-here';
  el.appendChild(here);
  el.hidden = marks.length === 0;
}

// Dónde se está leyendo (0..1). Sin marcas no hay carril, y tampoco esto.
export function setPosition(f) {
  if (!here || !Number.isFinite(f)) return;
  here.style.top = (Math.min(1, Math.max(0, f)) * 100).toFixed(3) + '%';
}

export function clear() {
  marks = [];
  hideTip();
  if (rail) { rail.innerHTML = ''; rail.hidden = true; here = null; }
}
