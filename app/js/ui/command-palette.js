// command-palette.js — Paleta de comandos (⌘K / Ctrl+K), idea de Matter y de cmdk.
// Una caja de búsqueda sobre todo lo que se puede hacer: acciones del lector y de la app,
// los capítulos del libro abierto y los libros de la biblioteca. Escribir filtra; ↑/↓ mueve;
// Intro ejecuta; Escape cierra.
//
// Este módulo no sabe nada de la app: recibe `source()`, que devuelve la lista de comandos
// del momento —{ group, label, keywords?, hint?, run }—, y la vuelve a pedir en cada
// apertura, así los comandos dependen de si hay un libro abierto, de su formato y de su
// índice sin que nadie tenga que avisar.
//
// La búsqueda es por subsecuencia sin acentos ni mayúsculas («oscu» → «Tema oscuro»,
// «tmo» también), puntuando más el comienzo de palabra y las letras seguidas. Sin
// dependencias: cmdk es React y aquí no hay framework.

import { escapeHtml } from './escape.js';
import { icon } from './icons.js';
import { t } from '../i18n.js';

const MAX_RESULTS = 60;

let source = () => [];
let overlay = null;
let input = null;
let list = null;
let items = [];       // comandos de esta apertura
let shown = [];       // los que pasan el filtro, en orden
let active = 0;
let prevFocus = null;

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
export function shortcutLabel() { return isMac ? '⌘K' : 'Ctrl+K'; }

export function init(getCommands) {
  source = getCommands || source;
  document.addEventListener('keydown', onGlobalKey, true);
  // El iframe del EPUB no deja subir sus teclas: epub-reader.js las reenvía como evento.
  window.addEventListener('reader:palette', () => toggle());
}

// ¿Esta pulsación abre la paleta? ⌘K en Mac, Ctrl+K en el resto (las dos valen en ambos:
// un teclado externo en un iPad o un Mac con Ctrl no deberían quedarse sin ella).
export function isPaletteKey(e) {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K');
}

function onGlobalKey(e) {
  if (!isPaletteKey(e)) return;
  // Con un diálogo de confirmación abierto, no se apila otra capa encima.
  if (!isOpen() && document.querySelector('.dlg-overlay')) return;
  e.preventDefault();
  e.stopPropagation();
  toggle();
}

export function isOpen() { return !!overlay && !overlay.hidden; }

export function toggle() { if (isOpen()) close(); else open(); }

function build() {
  overlay = document.createElement('div');
  overlay.className = 'cmdk-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="cmdk" role="dialog" aria-modal="true" aria-label="${escapeHtml(t('Paleta de comandos'))}">
      <div class="cmdk-input-row">
        ${icon('search', { size: 'lg' })}
        <input class="cmdk-input" type="text" role="combobox" aria-expanded="true" aria-controls="cmdk-list"
          aria-autocomplete="list" autocomplete="off" spellcheck="false"
          placeholder="${escapeHtml(t('Escribe un comando, un capítulo o un libro…'))}">
      </div>
      <ul class="cmdk-list" id="cmdk-list" role="listbox"></ul>
      <div class="cmdk-foot" aria-hidden="true">
        <span><kbd>↑</kbd> <kbd>↓</kbd> ${escapeHtml(t('moverse'))}</span>
        <span><kbd>↵</kbd> ${escapeHtml(t('ejecutar'))}</span>
        <span><kbd>Esc</kbd> ${escapeHtml(t('cerrar'))}</span>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  input = overlay.querySelector('.cmdk-input');
  list = overlay.querySelector('.cmdk-list');

  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  input.addEventListener('input', () => { active = 0; render(); });
  input.addEventListener('keydown', onKey);
  list.addEventListener('mousemove', (e) => {
    const li = e.target.closest('.cmdk-item');
    if (!li) return;
    const i = Number(li.dataset.i);
    if (i !== active) { active = i; paintActive(false); }
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('.cmdk-item');
    if (li) run(Number(li.dataset.i));
  });
}

// `source()` puede devolver una promesa (los libros salen de IndexedDB): la hoja se abre y
// toma el foco al momento, y la lista se pinta en cuanto llega. Una segunda apertura antes
// de que llegue la primera descarta la vieja (`openSeq`).
let openSeq = 0;
export async function open() {
  if (!overlay) build();
  const seq = ++openSeq;
  prevFocus = document.activeElement;
  input.value = '';
  active = 0;
  items = [];
  list.innerHTML = '';
  overlay.hidden = false;
  document.body.classList.add('cmdk-open');
  input.focus();
  let got = [];
  try { got = (await source()) || []; }
  catch (e) { console.warn('paleta: no se pudieron listar los comandos', e); }
  if (seq !== openSeq || !isOpen()) return;
  items = got.filter((c) => c && c.label && typeof c.run === 'function');
  render();
}

export function close({ restoreFocus = true } = {}) {
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  document.body.classList.remove('cmdk-open');
  if (restoreFocus && prevFocus && prevFocus.isConnected) { try { prevFocus.focus(); } catch (e) { /* ya no enfocable */ } }
  prevFocus = null;
}

function onKey(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); run(active); }
  else if (e.key === 'Escape') { e.preventDefault(); close(); }
  else if (e.key === 'Tab') { e.preventDefault(); move(e.shiftKey ? -1 : 1); }   // el foco no sale de la paleta
}

function move(d) {
  if (!shown.length) return;
  active = (active + d + shown.length) % shown.length;
  paintActive(true);
}

async function run(i) {
  const cmd = shown[i];
  if (!cmd) return;
  // Se cierra ANTES de ejecutar y sin devolver el foco: la acción suele abrir otra cosa
  // (un panel, un diálogo, el selector de ficheros) que quiere el foco para sí.
  close({ restoreFocus: false });
  try { await cmd.run(); } catch (e) { console.warn('paleta: el comando falló', cmd.label, e); }
}

// ---------- Búsqueda ----------

export function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Puntúa `text` contra `q` (ya plegados). -1 = no casa. Subsecuencia: cada letra de la
// consulta tiene que aparecer en orden. Suma por letra, con extra si va seguida de la
// anterior o empieza palabra; una coincidencia literal del texto entero va por delante.
export function score(q, text) {
  if (!q) return 0;
  const lit = text.indexOf(q);
  if (lit >= 0) return 1000 - lit + (lit === 0 || /\W/.test(text[lit - 1]) ? 200 : 0);
  let s = 0, from = 0, prev = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    const at = text.indexOf(ch, from);
    if (at < 0) return -1;
    s += 1 + (at === prev + 1 ? 5 : 0) + (at === 0 || /\W/.test(text[at - 1]) ? 3 : 0);
    prev = at; from = at + 1;
  }
  return s;
}

function filter(q) {
  const fq = fold(q).trim();
  if (!fq) return items.filter((c) => !c.searchOnly).slice(0, MAX_RESULTS);
  return items
    .map((c, i) => {
      const label = fold(c.label);
      const best = Math.max(score(fq, label), c.keywords ? score(fq, fold(c.keywords)) - 50 : -1);
      return { c, i, s: best };
    })
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, MAX_RESULTS)
    .map((x) => x.c);
}

// ---------- Pintado ----------

function render() {
  const q = input.value;
  shown = filter(q);
  if (!shown.length) {
    list.innerHTML = `<li class="cmdk-empty" role="presentation">${escapeHtml(t('Nada coincide con «{q}»', { q: q.trim() }))}</li>`;
    input.removeAttribute('aria-activedescendant');
    return;
  }
  // Sin consulta, agrupado por sección y en el orden de la fuente; con consulta, por
  // relevancia y con la sección a la derecha (agrupar mezclaría el orden que importa).
  const grouped = !q.trim();
  let html = '', lastGroup = null;
  shown.forEach((c, i) => {
    if (grouped && c.group !== lastGroup) {
      html += `<li class="cmdk-group" role="presentation">${escapeHtml(c.group || '')}</li>`;
      lastGroup = c.group;
    }
    const hint = c.hint ? `<kbd>${escapeHtml(c.hint)}</kbd>` : (!grouped && c.group ? escapeHtml(c.group) : '');
    html += `<li class="cmdk-item" id="cmdk-i${i}" role="option" data-i="${i}" aria-selected="false">
      <span class="cmdk-item-label">${escapeHtml(c.label)}</span>
      ${hint ? `<span class="cmdk-item-hint">${hint}</span>` : ''}</li>`;
  });
  list.innerHTML = html;
  if (active >= shown.length) active = 0;
  paintActive(true);
}

function paintActive(scroll) {
  for (const li of list.querySelectorAll('.cmdk-item[aria-selected="true"]')) li.setAttribute('aria-selected', 'false');
  const li = list.querySelector(`#cmdk-i${active}`);
  if (!li) return;
  li.setAttribute('aria-selected', 'true');
  input.setAttribute('aria-activedescendant', li.id);
  if (scroll) li.scrollIntoView({ block: 'nearest' });
}
