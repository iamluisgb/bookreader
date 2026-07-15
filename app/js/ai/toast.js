// ai/toast.js — Aviso breve no intrusivo (abajo, auto-dismiss) con una acción opcional.
// Pieza de plataforma reutilizable; el primer uso es "resumen/mapa listo · Ver".
import { t } from '../i18n.js';
import { icon } from '../ui/icons.js';

let host = null;
function ensureHost() {
  if (host && document.body.contains(host)) return host;
  host = document.createElement('div');
  host.className = 'ai-toast-host';
  document.body.appendChild(host);
  return host;
}

export function toast({ message, actionLabel, onAction, kind = 'info', timeout = 7000 }) {
  const h = ensureHost();
  const el = document.createElement('div');
  el.className = `ai-toast ai-toast--${kind}`;
  el.setAttribute('role', 'status');
  el.innerHTML =
    `<span class="ai-toast-msg"></span>` +
    (actionLabel ? `<button class="ai-toast-action"></button>` : '') +
    `<button class="ai-toast-close" aria-label="${t('Cerrar')}">${icon('xmark', { size: 14 })}</button>`;
  el.querySelector('.ai-toast-msg').textContent = message;
  if (actionLabel) el.querySelector('.ai-toast-action').textContent = actionLabel;
  h.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));

  let timer;
  const dismiss = () => { clearTimeout(timer); el.classList.remove('show'); setTimeout(() => el.remove(), 200); };
  el.querySelector('.ai-toast-close').addEventListener('click', dismiss);
  if (actionLabel) el.querySelector('.ai-toast-action').addEventListener('click', () => { dismiss(); onAction?.(); });
  if (timeout) timer = setTimeout(dismiss, timeout);
  return dismiss;
}
