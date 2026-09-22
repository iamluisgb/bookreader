// hints.js — Motor de hints de descubrimiento (P30 · F1/F2).
//
// La app es deliberadamente minimalista y muchas features viven detrás de
// contextos (barra de selección, panel del agente, ajustes). Este módulo muestra
// UN hint en el momento natural en que la feature se vuelve relevante — nunca un
// tour, nunca dos a la vez, nunca dos veces.
//
// Reglas:
//  - `maybeShow(id, html)`: si el hint ya se vio, no pasa nada. Si hay otro activo,
//    se encola y sale al descartar el anterior. Máximo UNO en pantalla.
//  - Marcar visto ocurre al DESCARTAR (botón, auto-caducidad) — no al mostrarse:
//    una recarga accidental no roba el hint.
//  - El HTML del hint es SIEMPRE nuestro (cadenas propias con <b>), nunca datos
//    del usuario: por eso va como html y no como texto.
//  - i18n por t() (clave = cadena española); el texto se traduce en el disparador.
//  - Cada show/dismiss queda en el registro local de uso (usage-log.js).

import { t } from '../i18n.js';
import { icon } from './icons.js';
import { track } from './usage-log.js';

const SEEN_KEY = 'bookreader_hints_seen';
const MAX_SEEN = 60;         // rotación: la lista de vistos no crece eternamente
const AUTO_DISMISS_MS = 20000;

let seen = loadSeen();
let root = null;
let current = null;          // { id, timer }
let queue = [];              // hints que llegaron mientras había uno activo

function loadSeen() {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}

function persistSeen() {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen.slice(-MAX_SEEN))); }
  catch (e) { /* storage bloqueado: los hints se repetirán, nunca romperán nada */ }
}

export function isSeen(id) { return seen.indexOf(id) !== -1; }

function markSeen(id) {
  if (seen.indexOf(id) === -1) { seen.push(id); persistSeen(); }
}

// Ofrece un hint. `html` ya traducido (el disparador usa t()); contenido propio,
// puede llevar <b>. No lanza nada visible si el usuario ya lo vio.
export function maybeShow(id, html) {
  if (isSeen(id) || !html) return;
  if (current) {
    if (!queue.some((q) => q.id === id)) queue.push({ id, html });
    return;
  }
  show(id, html);
}

function ensureRoot() {
  if (root) return root;
  root = document.createElement('div');
  root.className = 'hint-pop';
  root.setAttribute('role', 'status');
  root.innerHTML = `
    <span class="hint-pop-ico">${icon('sparkles', { size: 15 })}</span>
    <span class="hint-pop-text"></span>
    <button class="hint-pop-close" aria-label="${t('Entendido')}" title="${t('Entendido')}">${icon('xmark', { size: 13 })}</button>`;
  root.querySelector('.hint-pop-close').addEventListener('click', dismiss);
  document.body.appendChild(root);
  return root;
}

function show(id, html) {
  const el = ensureRoot();
  el.querySelector('.hint-pop-text').innerHTML = html;
  el.dataset.hint = id;
  el.classList.add('show');
  current = { id };
  current.timer = setTimeout(dismiss, AUTO_DISMISS_MS);
  track('hint:show', id);
}

function dismiss() {
  if (!current) return;
  clearTimeout(current.timer);
  markSeen(current.id);
  track('hint:dismiss', current.id);
  hide();
  const next = queue.shift();
  if (next) setTimeout(() => { if (!current) show(next.id, next.html); }, 400);
}

function hide() {
  if (root) root.classList.remove('show');
  current = null;
}
