// Panel lateral (índice, buscar, marcadores, subrayados): UNA sola vía para abrirlo y
// cerrarlo, y su estado accesible siempre al día (auditoría de la cabecera, Q4/Q5).
//
// Antes se abría desde cuatro sitios con lógica distinta: el botón marcaba el capítulo
// actual y avisaba al agente (atenuación), pero la lupa y «Más» hacían `classList.add`
// a mano y se saltaban las dos cosas; y el botón decía siempre «Abrir sidebar», también
// con el panel abierto, sin `aria-expanded`.
//
// - setSidebar(open, tab?): abre/cierra y, si se pide, cambia de pestaña.
// - Un MutationObserver vigila la clase `open`, así que el estado accesible y el evento
//   `sidebar:change` ({ open }) se mantienen aunque otro módulo cierre el panel con
//   `classList.remove('open')` (navegar desde un subrayado, un marcador, la búsqueda…).
import { t } from '../i18n.js';

const el = () => document.getElementById('sidebar');

export function isSidebarOpen() {
  return !!el()?.classList.contains('open');
}

export function setSidebar(open, tab = null) {
  const sb = el();
  if (!sb) return;
  if (tab) document.querySelector(`[data-tab="${tab}"]`)?.click();
  sb.classList.toggle('open', open);
}

export function toggleSidebar(tab = null) {
  setSidebar(!isSidebarOpen(), tab);
}

function syncToggle(open) {
  const btn = document.getElementById('sidebar-toggle');
  if (!btn) return;
  const label = open ? t('Ocultar índice y notas') : t('Índice y notas');
  btn.setAttribute('aria-expanded', String(open));
  btn.setAttribute('aria-label', label);
  btn.dataset.tip = label;
}

export function initSidebarState() {
  const sb = el();
  if (!sb) return;
  let last = isSidebarOpen();
  syncToggle(last);
  new MutationObserver(() => {
    const open = isSidebarOpen();
    if (open === last) return;
    last = open;
    syncToggle(open);
    window.dispatchEvent(new CustomEvent('sidebar:change', { detail: { open } }));
  }).observe(sb, { attributes: true, attributeFilter: ['class'] });
}
