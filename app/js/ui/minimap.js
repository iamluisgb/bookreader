// minimap.js — Subrayados y capítulos sobre la barra de progreso del pie (idea de Matter,
// su «Annotations Minimap»). Cada subrayado es una muesca de su color a la altura del libro
// en que está; cada capítulo de primer nivel, una muesca fina gris.
//
// Primero fue un carril vertical en el borde derecho; se pasó al pie porque la barra verde
// YA es el mapa del libro entero (dos mapas del mismo libro sobraban), es más ancha (las
// marcas se amontonan menos) y existe también en táctil, donde el borde de la pantalla es
// del gesto de pasar página.
//
// Este módulo pinta y responde «¿qué marca hay cerca de aquí?» (`nearest`). La interacción
// —burbuja al pasar o arrastrar, salto al soltar— es la de la barra (initProgressScrub en
// app.js), que la consulta: cerca de una marca, la burbuja enseña el subrayado y soltar
// salta a él exacto en vez de a la fracción. Las fracciones (0..1) las calcula app.js, que
// sabe qué lector está activo. Cada marca: { f, kind: 'hl'|'ch', label, sub?, color?, go() }.
//
// La capa es `aria-hidden`: la barra ya es un slider accesible y la lista de subrayados vive
// en la barra lateral; esto es un atajo visual sobre esa misma información.

import { escapeHtml } from './escape.js';

let layer = null;
let marks = [];

function ensure() {
  if (layer && layer.isConnected) return layer;
  const host = document.getElementById('progress-container');
  if (!host) return null;
  layer = document.createElement('div');
  layer.id = 'progress-marks';
  layer.className = 'progress-marks';
  layer.setAttribute('aria-hidden', 'true');
  host.appendChild(layer);
  return layer;
}

// Pinta las marcas. Los capítulos van primero en el DOM para que un subrayado que caiga en
// el mismo sitio quede encima.
export function setMarks(list) {
  const el = ensure();
  if (!el) return;
  marks = (list || []).filter((m) => Number.isFinite(m.f))
    .map((m) => ({ ...m, f: Math.min(1, Math.max(0, m.f)) }))
    .sort((a, b) => (a.kind === b.kind ? a.f - b.f : a.kind === 'ch' ? -1 : 1));
  el.innerHTML = marks.map((m) => {
    const style = `left:${(m.f * 100).toFixed(3)}%` + (m.color ? `;--mm-color:${escapeHtml(m.color)}` : '');
    return `<span class="progress-mark progress-mark--${m.kind}" style="${style}"></span>`;
  }).join('');
}

// La marca más cercana a la fracción `f` dentro de `radiusPx` píxeles de la barra, o null.
// Un subrayado gana a un capítulo aunque esté algo más lejos: es lo que se busca al apuntar.
export function nearest(f, radiusPx) {
  if (!marks.length || !layer) return null;
  const w = layer.getBoundingClientRect().width;
  if (!w) return null;
  let best = null, bestD = Infinity;
  for (const m of marks) {
    const d = Math.abs(m.f - f) * w - (m.kind === 'hl' ? radiusPx / 2 : 0);
    if (Math.abs(m.f - f) * w <= radiusPx && d < bestD) { best = m; bestD = d; }
  }
  return best;
}

export function clear() {
  marks = [];
  if (layer) layer.innerHTML = '';
}
