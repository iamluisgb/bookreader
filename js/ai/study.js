// P10 · Modo Estudiar — sesión de repaso con repetición espaciada sobre los mazos de
// flashcards que ya viven en IndexedDB (store `decks`). Overlay a pantalla completa
// (misma familia visual que el modal de flashcards); ver decisiones en BACKLOG · P10.
//
// Dos puertas, misma UI: un mazo concreto (desde el modal de flashcards) o la cola
// del día con lo vencido de TODOS los mazos (chip en la estantería).
//
// El estado de scheduling (`card.srs`) se persiste TRAS CADA tarjeta, no al final:
// cerrar a media sesión no pierde nada.
import * as DB from './db.js';
import * as Srs from './srs.js';
import { icon } from '../ui/icons.js';
import { escapeHtml } from '../ui/escape.js';

let overlay = null;
let onCloseCb = null;
let queue = [];          // [{deck, idx}] pendientes de la sesión (los "otra vez" se re-encolan)
let done = 0;            // tarjetas superadas en la sesión (no cuenta los "otra vez")
let flipped = false;

// ---- Cola diaria (para el chip de la estantería) -----------------------------

// Vencidas hoy en todos los mazos: total y mazos implicados.
export async function dueToday(now = Date.now()) {
  const decks = await DB.getAllDecks();
  let cards = 0, withDue = [];
  for (const d of decks) {
    const n = Srs.dueCount(d.cards, now);
    if (n) { cards += n; withDue.push(d); }
  }
  return { cards, decks: withDue };
}

// Abre la sesión global del día (todo lo vencido, de todos los mazos).
export async function openToday({ onClose } = {}) {
  const { decks } = await dueToday();
  open({ decks, title: 'Repaso de hoy', onClose });
}

// ---- Sesión -------------------------------------------------------------------

// `decks`: mazos a repasar (solo entran sus tarjetas vencidas, en orden de mazo).
export function open({ decks, title = 'Estudiar', onClose } = {}) {
  close();
  onCloseCb = onClose || null;
  const now = Date.now();
  queue = [];
  done = 0;
  flipped = false;
  for (const deck of decks || []) {
    (deck.cards || []).forEach((c, idx) => { if (c.front && Srs.isDue(c, now)) queue.push({ deck, idx }); });
  }

  overlay = document.createElement('div');
  overlay.id = 'ai-study';
  overlay.className = 'ai-onboarding';
  overlay.innerHTML = `
    <div class="ai-ob-card study-card" role="dialog" aria-modal="true" aria-label="Modo Estudiar">
      <div class="study-head">
        <span class="study-title">${escapeHtml(title)}</span>
        <span class="study-left" aria-live="polite"></span>
        <button class="ai-ob-close" title="Cerrar" aria-label="Cerrar">${icon('xmark', { size: 18 })}</button>
      </div>
      <div class="study-body"></div>
      <div class="study-foot"></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.ai-ob-close').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  renderCard();
}

export function isOpen() { return !!overlay; }

function close() {
  document.removeEventListener('keydown', onKey);
  if (overlay) { overlay.remove(); overlay = null; }
  queue = [];
  if (onCloseCb) { const cb = onCloseCb; onCloseCb = null; cb(); }
}

function onKey(e) {
  if (!overlay) return;
  if (e.key === 'Escape') { close(); return; }
  const current = queue[0];
  if (!current) return;
  if (!flipped && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); flip(); return; }
  if (flipped) {
    const map = { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' };
    if (map[e.key]) { e.preventDefault(); gradeCurrent(map[e.key]); }
  }
}

// ---- Render de la tarjeta -------------------------------------------------------

// Cloze {{cN::respuesta(::pista)}} → hueco “[…]” (o “[pista]”) en el frente; revelado
// resaltado al voltear. Las tarjetas básicas muestran pregunta → respuesta.
const CLOZE_RE = /\{\{c\d+::((?:(?!::|\}\}).)*)(?:::((?:(?!\}\}).)*))?\}\}/g;

// Nota: el replace corre sobre el texto YA escapado, así que los grupos capturados
// (respuesta/pista) llegan escapados — insertarlos tal cual es seguro; re-escaparlos
// duplicaría entidades (&amp;amp;).
function frontHtml(card) {
  if (card.type === 'cloze') {
    return escapeHtml(card.front).replace(CLOZE_RE, (_, _ans, hint) =>
      `<span class="study-cloze">[${hint || '…'}]</span>`);
  }
  return escapeHtml(card.front);
}

function backHtml(card) {
  if (card.type === 'cloze') {
    const revealed = escapeHtml(card.front).replace(CLOZE_RE, (_, ans) =>
      `<span class="study-cloze is-revealed">${ans}</span>`);
    return revealed + (card.back ? `<div class="study-extra">${escapeHtml(card.back)}</div>` : '');
  }
  return escapeHtml(card.back || '');
}

function renderCard() {
  const b = overlay?.querySelector('.study-body');
  const f = overlay?.querySelector('.study-foot');
  const left = overlay?.querySelector('.study-left');
  if (!b || !f) return;

  if (!queue.length) { renderDone(b, f, left); return; }
  left.textContent = `${queue.length} pendiente${queue.length === 1 ? '' : 's'}`;

  const { deck, idx } = queue[0];
  const card = deck.cards[idx];
  flipped = false;
  b.innerHTML = `
    <div class="study-deckname">${escapeHtml(deck.name || deck.scope || 'Mazo')}</div>
    <div class="study-q">${frontHtml(card)}</div>
    <div class="study-a" hidden></div>`;
  f.innerHTML = `<button class="primary-btn study-flip">Mostrar respuesta <kbd>espacio</kbd></button>`;
  f.querySelector('.study-flip').addEventListener('click', flip);
}

function flip() {
  if (!overlay || flipped || !queue.length) return;
  flipped = true;
  const { deck, idx } = queue[0];
  const card = deck.cards[idx];
  const a = overlay.querySelector('.study-a');
  a.innerHTML = backHtml(card);
  a.hidden = card.type !== 'cloze' && !card.back;
  if (card.type === 'cloze') overlay.querySelector('.study-q').hidden = true;   // el revelado la sustituye

  const prev = Srs.previewIntervals(card.srs);
  const btn = (r, lbl, cls) => `
    <button class="study-grade ${cls}" data-rate="${r}">
      <span>${lbl}</span><small>${Srs.intervalLabel(prev[r])}</small>
    </button>`;
  const f = overlay.querySelector('.study-foot');
  f.innerHTML = `
    <div class="study-grades">
      ${btn('again', 'Otra vez', 'is-again')}${btn('hard', 'Difícil', 'is-hard')}
      ${btn('good', 'Bien', 'is-good')}${btn('easy', 'Fácil', 'is-easy')}
    </div>`;
  f.querySelector('.study-grades').addEventListener('click', (e) => {
    const g = e.target.closest('[data-rate]');
    if (g) gradeCurrent(g.dataset.rate);
  });
}

function gradeCurrent(rating) {
  if (!queue.length) return;
  const entry = queue.shift();
  const { deck, idx } = entry;
  deck.cards[idx] = { ...deck.cards[idx], srs: Srs.grade(deck.cards[idx].srs, rating) };
  if (deck.id) DB.updateDeck(deck.id, { cards: deck.cards });   // persistir TRAS CADA tarjeta
  if (rating === 'again') queue.push(entry);                    // se repite al final de la sesión
  else done++;
  renderCard();
}

function renderDone(b, f, left) {
  if (left) left.textContent = '';
  b.innerHTML = `
    <div class="study-end">
      <div class="study-end-icon">${icon('check', { size: 40 })}</div>
      <h2>${done ? '¡Repaso completado!' : 'Nada que repasar'}</h2>
      <p>${done
        ? `Has repasado <b>${done}</b> tarjeta${done === 1 ? '' : 's'}. La repetición espaciada hará el resto.`
        : 'No hay tarjetas vencidas ahora mismo. Vuelve mañana.'}</p>
    </div>`;
  f.innerHTML = `<button class="primary-btn study-flip">Cerrar</button>`;
  f.querySelector('.study-flip').addEventListener('click', close);
}
