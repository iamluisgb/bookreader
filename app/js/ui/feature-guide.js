// feature-guide.js — Guía rápida "¿qué puedo hacer aquí?" (P30 · F4) y fuente
// compartida del inventario de features (P30 · F5).
//
// En la app el usuario está leyendo → descubrimiento contextual (hints.js). En la
// guía y en la landing el visitante está EVALUANDO → un listado sí funciona. Este
// módulo es la única fuente del inventario in-app; la landing lleva la misma lista
// con el mismo criterio (sección "what's in the box", HTML estático porque no hay
// build). REGLA F5: una feature entra aquí y también en la landing (index.html y
// es/index.html) o en ninguna. Los landings por nicho (P16) luego seleccionan de
// esta lista; no reescriben.
//
// La taxonomía es por MOMENTO de uso, no por módulo interno — el mismo criterio de
// la landing. Sin datos del usuario: solo cadenas propias, traducidas con t().

import { t } from '../i18n.js';
import { icon } from './icons.js';
import { track } from './usage-log.js';
import { helpUrl, helpAttrs } from './help-link.js';

// Cada grupo acaba con «Más en la ayuda →» hacia la página que desarrolla ese
// momento de uso. Paths SIN prefijo de lengua: helpUrl() los resuelve. Los
// valida scripts/build-help.mjs contra los sitemaps: un renombre de página
// rompe el build, no la ayuda.
const GROUPS = [
  {
    id: 'reading',
    help: 'guias/read-a-book/',
    title: () => t('Mientras lees'),
    items: [
      'Modo inmersivo, a páginas o scroll continuo',
      'Búsqueda en el libro, marcadores, subrayados y notas',
      'Temas, tonos de papel, brillo y luz cálida (Ajustes de lectura)',
      'Tipografía: fuente, tamaño, columnas e interlineado',
      'Tiempo de lectura restante, por capítulo y por libro',
    ],
  },
  {
    id: 'selection',
    help: 'guias/ask-the-book/',
    title: () => t('Con un texto seleccionado'),
    items: [
      'Preguntar al agente sobre el fragmento, o empezar a escribir',
      'Explícame · Por qué importa · Qué significa aquí · Dónde más lo trata · La objeción más fuerte · Con números',
      'Subrayar de un toque (con el último color) y añadir una nota',
      'Zona: recortar una figura o ecuación y enviársela al agente (PDF)',
      'Copiar y compartir (tarjeta-cita)',
    ],
  },
  {
    id: 'agent',
    help: 'guias/set-up-ai-key/',
    title: () => t('Con el agente'),
    items: [
      'Objetivo de lectura y plantillas de libreta por conversación',
      'Resumen citado, mapa mental, flashcards y Modo Estudiar',
      'Repaso al terminar cada capítulo y modo Feynman',
      'Preparar el libro para preguntarle sin conexión',
      'Sync entre dispositivos con tu propio Google Drive (Ajustes generales)',
    ],
  },
];

let overlay = null;

function render() {
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'feature-guide';
  overlay.className = 'fguide';
  overlay.style.display = 'none';
  overlay.innerHTML = `
    <div class="fguide-card" role="dialog" aria-modal="true" aria-label="${t('¿Qué puedes hacer aquí?')}">
      <button class="fguide-close" title="${t('Cerrar')}" aria-label="${t('Cerrar')}">${icon('xmark', { size: 'md' })}</button>
      <h2 class="fguide-h2">${t('¿Qué puedes hacer aquí?')}</h2>
      <div class="fguide-body"></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.fguide-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay && overlay.style.display !== 'none') close();
  });
  return overlay;
}

function fill() {
  const body = overlay.querySelector('.fguide-body');
  body.innerHTML = GROUPS.map((g) => `
    <section class="fguide-group">
      <h3>${g.title()}</h3>
      <ul>${g.items.map((item) => `<li>${t(item)}</li>`).join('')}</ul>
      <a class="fguide-more" href="${helpUrl(g.help)}" ${helpAttrs} data-help-group="${g.id}">${t('Más en la ayuda')} ${icon('arrow-up-right', { size: 'sm' })}</a>
    </section>`).join('');
  body.querySelectorAll('.fguide-more').forEach((a) =>
    a.addEventListener('click', () => track('guide:help', a.dataset.helpGroup)));
}

export function open() {
  const el = render();
  fill();
  el.style.display = '';
  track('guide:open');
}

export function close() {
  if (overlay) overlay.style.display = 'none';
}

export function isOpen() {
  return !!(overlay && overlay.style.display !== 'none');
}

export function toggle() {
  if (isOpen()) close(); else open();
}
