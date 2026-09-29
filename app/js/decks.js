// decks.js — el gestor de mazos (WU3 de "gestor de mazos").
//
// Pantalla hermana de Análisis: misma concha (.appset), mismo arranque perezoso
// desde el rail de la biblioteca. Enseña TODOS los mazos agrupados por libro,
// los huérfanos («Mazos sin libro») en su propia sección con la reparación
// manual de la Fase 1 (asignar a un libro de la biblioteca o borrar), y el
// detalle de cada mazo: editar frente/dorso, suspender, quitar y crear
// tarjetas a mano (solo texto: P→R y cloze — las visuales siguen naciendo del
// generador, ver deck-manager.js).
//
// Toda escritura persiste con DB.updateDeck / DB.deleteDeck / DB.remapDecks;
// las mutaciones de tarjetas salen de los helpers PUROS de deck-manager.js y
// aquí solo se decide cuándo guardar. Cada valor interpolado pasa por
// escapeHtml — los nombres de mazos y libros los escribió un LLM o una persona.

import * as AiDB from './ai/db.js';
import * as Store from './library/store.js';
import * as DM from './ai/deck-manager.js';
import * as Study from './ai/study.js';
import { icon } from './ui/icons.js';
import { escapeHtml } from './ui/escape.js';
import { t } from './i18n.js';
import { loadAgentCss } from './css-loader.js';
import { confirmBox, formBox } from './ui/dialog.js';

const VISUAL_TYPES = ['occlusion', 'diagram', 'drawing'];

let overlay = null;
let mode = 'list';        // 'list' (grupos) | 'deck' (detalle de un mazo)
let deckId = null;        // mazo abierto en modo detalle
let currentDeck = null;   // referencia viva para los handlers del detalle

const body = () => overlay?.querySelector('.dk-body');

function isOpen() {
  return !!overlay && overlay.style.display !== 'none';
}

export async function open() {
  loadAgentCss().catch(e => console.warn('agent.css:', e));
  ensureOverlay().style.display = 'flex';
  await paint();
}

export function close() {
  if (overlay) overlay.style.display = 'none';
}

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'decks';
  overlay.className = 'appset';
  overlay.style.display = 'none';
  overlay.innerHTML = `
    <div class="appset-card dk-card" role="dialog" aria-modal="true" aria-label="${t('Mazos')}">
      <button class="appset-close" title="${t('Cerrar')}" aria-label="${t('Cerrar')}">${icon('xmark')}</button>
      <h2 class="appset-h2">${icon('cards', { size: 20 })} ${t('Mazos')}</h2>
      <div class="dk-body"></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.appset-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) close();
  });
  overlay.addEventListener('click', onListClick);
  return overlay;
}

// ---- Pintado ---------------------------------------------------------------

async function paint() {
  const b = body();
  if (!b || !isOpen()) return;
  const [decks, books] = await Promise.all([
    AiDB.getAllDecks().catch(() => []),
    Store.getAllBooks().catch(() => []),
  ]);
  if (!isOpen()) return;
  if (mode === 'deck' && deckId != null) {
    const deck = (decks || []).find(d => String(d.id) === String(deckId));
    if (deck) {
      currentDeck = deck;
      b.innerHTML = renderDetail(deck);
      wireDetail(b);
      return;
    }
    mode = 'list';   // el mazo se borró debajo: vuelto a la lista
    deckId = null;
  }
  b.innerHTML = renderList(decks || [], books || []);
}

function typeLabel(deck) {
  const types = new Set(AiDB.cardsOf(deck).map(c => (VISUAL_TYPES.includes(c?.type) ? 'visual' : c?.type || 'basic')));
  const key = types.size === 1 ? [...types][0] : 'mixed';
  return { basic: t('Básica'), cloze: t('Cloze'), visual: t('Visual'), mixed: t('Mixto') }[key] || key;
}

function deckName(deck) {
  return deck.name || t('Mazo sin nombre');
}

// ---- Vista 1: resumen + grupos por libro + huérfanos -----------------------

function renderList(decks, books) {
  const sums = new Map(decks.map(d => [d.id, DM.deckSummary(d)]));
  const totalCards = decks.reduce((n, d) => n + sums.get(d.id).total, 0);
  const totalDue = decks.reduce((n, d) => n + sums.get(d.id).due, 0);

  const { groups, orphans } = DM.groupDecks(decks, books);

  const bookSections = groups.map(g => `
    <div class="dk-book">
      <div class="dk-book-h">${escapeHtml(g.title || t('Libro sin título'))}</div>
      ${g.decks.map(d => deckRow(d, sums.get(d.id))).join('')}
    </div>`).join('');

  // Reparación manual (Fase 1): los mazos cuyo libro ya no está en la
  // biblioteca. «Asignar a…» mueve TODOS los mazos de ese libro ausente —
  // el confirm del picker lo dice con el número exacto.
  const orphanSection = orphans.length ? `
    <div class="dk-book dk-orphans">
      <div class="dk-book-h">${t('Mazos sin libro')}</div>
      ${orphans.map(o => {
        const deck = decks.find(d => String(d.id) === String(o.deckId));
        return deck ? deckRow(deck, sums.get(deck.id), assignBtn(o.bookId)) : '';
      }).join('')}
    </div>` : '';

  return `
    <div class="dk-hero">
      ${heroTile(t('Mazos'), decks.length)}
      ${heroTile(t('Tarjetas'), totalCards)}
      ${heroTile(t('Vencidas hoy'), totalDue)}
    </div>
    ${decks.length
      ? bookSections + orphanSection
      : `<p class="dk-empty">${t('Todavía no hay mazos. Se crean al generar tarjetas desde un libro.')}</p>`}
  `;
}

function heroTile(label, n) {
  return `<div class="dk-tile"><div class="dk-tile-l">${escapeHtml(label)}</div>
    <div class="dk-tile-v">${escapeHtml(n)}</div></div>`;
}

function deckRow(deck, sum, extraAction = '') {
  // Singular aparte: «1 vencida» vs «3 vencidas».
  const dueBadge = sum.due
    ? `<span class="dk-badge">${sum.due === 1 ? t('1 vencida') : t('{n} vencidas', { n: sum.due })}</span>` : '';
  return `<div class="dk-row" data-deck="${escapeHtml(deck.id)}">
    <div class="dk-row-main">
      <div class="dk-row-name">${escapeHtml(deckName(deck))}</div>
      <div class="dk-row-meta">
        <span class="dk-chip">${escapeHtml(typeLabel(deck))}</span>
        <span>${t('{n} tarjetas', { n: sum.total })}</span>
        ${dueBadge}
      </div>
    </div>
    <div class="dk-actions">
      <button class="icon-btn" data-act="dk-study" title="${t('Estudiar')}" aria-label="${t('Estudiar')}">${icon('cards', { size: 16 })}</button>
      <button class="icon-btn" data-act="dk-open" title="${t('Abrir')}" aria-label="${t('Abrir')}">${icon('pencil', { size: 16 })}</button>
      ${extraAction}
      <button class="icon-btn" data-act="dk-del" title="${t('Borrar mazo')}" aria-label="${t('Borrar mazo')}">${icon('trash', { size: 16 })}</button>
    </div>
  </div>`;
}

function assignBtn(bookId) {
  return `<button class="icon-btn" data-act="dk-assign" data-book="${escapeHtml(bookId)}"
    title="${t('Asignar a…')}" aria-label="${t('Asignar a…')}">${icon('books', { size: 16 })}</button>`;
}

// ---- Vista 2: detalle del mazo ----------------------------------------------

function renderDetail(deck) {
  const sum = DM.deckSummary(deck);
  const headMeta = [
    t('{n} tarjetas', { n: sum.total }),
    t('{n} vencidas', { n: sum.due }),
    sum.suspendidas ? t('{n} suspendidas', { n: sum.suspendidas }) : '',
  ].filter(Boolean).join(' · ');
  return `
    <button class="ai-ob-back" data-act="dk-back">${icon('chevron-left', { size: 16 })}<span>${t('Volver')}</span></button>
    <div class="dk-head">
      <h3 class="dk-head-name">${escapeHtml(deckName(deck))}</h3>
      <span class="dk-chip">${escapeHtml(typeLabel(deck))}</span>
      <span class="dk-head-meta">${escapeHtml(headMeta)}</span>
    </div>
    <div class="fc-list">
      ${deck.cards.map((c, i) => (c && !c.deleted ? cardRow(c, i) : '')).join('')}
    </div>
    ${addFormHtml()}`;
}

// Misma fila que el modal de flashcards (renderReview): frente/dorso editables
// en el sitio, suspender/reactivar y quitar.
function cardRow(c, i) {
  return `<div class="fc-item${c.suspended ? ' is-suspended' : ''}" data-i="${i}">
    <div class="fc-item-fields">
      <div class="fc-front" contenteditable="true" spellcheck="false">${escapeHtml(c.front)}</div>
      <div class="fc-back" contenteditable="true" spellcheck="false" data-ph="${t('Respuesta (opcional)')}">${escapeHtml(c.back)}</div>
    </div>
    <button class="icon-btn fc-susp" data-act="dk-susp" title="${c.suspended ? t('Reactivar: vuelve al repaso') : t('Suspender: no volver a mostrarla')}"
      aria-label="${c.suspended ? t('Reactivar: vuelve al repaso') : t('Suspender: no volver a mostrarla')}">${icon(c.suspended ? 'undo' : 'eye-off', { size: 15 })}</button>
    <button class="icon-btn fc-del" data-act="dk-del-card" title="${t('Quitar tarjeta')}" aria-label="${t('Quitar tarjeta')}">${icon('xmark', { size: 15 })}</button>
  </div>`;
}

function addFormHtml() {
  return `<div class="dk-add">
    <div class="dk-add-h">${t('Agregar tarjeta')}</div>
    <div class="dk-add-row">
      <select class="dk-input dk-add-type" aria-label="${t('Tipo')}">
        <option value="basic">${t('Pregunta → Respuesta')}</option>
        <option value="cloze">${t('Cloze')}</option>
      </select>
      <input class="dk-input dk-add-front" type="text" placeholder="${t('Frente')}" aria-label="${t('Frente')}">
      <input class="dk-input dk-add-back" type="text" placeholder="${t('Respuesta (opcional)')}" aria-label="${t('Respuesta (opcional)')}">
      <button class="primary-btn dk-add-btn" data-act="dk-add">${icon('plus', { size: 14 })} ${t('Agregar')}</button>
    </div>
    <div class="dk-error" data-role="add-error" style="display:none"></div>
  </div>`;
}

const ADD_ERRORS = {
  'empty-front': () => t('Escribe la pregunta'),
  'bad-type': () => t('Tipo no válido'),
  'cloze-without-hole': () => t('Un cloze necesita un hueco {{c1::…}}'),
  'duplicate': () => t('Ya existe una tarjeta con esa pregunta'),
};

// ---- Acciones ---------------------------------------------------------------

// Un solo listener delegado para la vista de lista (el detalle lleva el suyo,
// wireDetail, porque necesita el DOM del formulario).
async function onListClick(e) {
  const act = e.target.closest('[data-act]');
  if (!act) return;
  const a = act.dataset.act;
  if (a === 'dk-open') {
    mode = 'deck';
    deckId = act.closest('.dk-row')?.dataset.deck;
    await paint();
    return;
  }
  if (a === 'dk-study') {
    const id = act.closest('.dk-row')?.dataset.deck;
    // Mazo re-leído de IndexedDB: el cache puede traer tarjetas viejas.
    const deck = (await AiDB.getAllDecks()).find(d => String(d.id) === String(id));
    if (deck) Study.open({ decks: [deck], title: deck.name || t('Estudiar'), onClose: () => paint() });
    return;
  }
  if (a === 'dk-del') { await deleteDeckFlow(act.closest('.dk-row')?.dataset.deck); return; }
  if (a === 'dk-assign') { await assignFlow(act.dataset.book); return; }
}

async function deleteDeckFlow(id) {
  if (id == null) return;
  if (!(await confirmBox('¿Borrar este mazo de flashcards?', { title: 'Borrar mazo', okText: 'Borrar', danger: true }))) return;
  await AiDB.deleteDeck(id);
  if (mode === 'deck' && String(deckId) === String(id)) { mode = 'list'; deckId = null; }
  await paint();
}

// Reparación manual de huérfanos: el remapeo mueve TODOS los mazos del libro
// ausente (remapDecks opera por bookId), y el picker lo dice con el número.
async function assignFlow(fromId) {
  if (fromId == null) return;
  const books = await Store.getAllBooks().catch(() => []);
  if (!books.length) return;
  const decks = await AiDB.getAllDecks().catch(() => []);
  const n = decks.filter(d => d.bookId === fromId).length;
  const options = {};
  for (const b of books) options[b.id] = b.title || t('Libro sin título');
  const res = await formBox({
    title: 'Asignar a…',
    message: n === 1
      ? t('Se moverá {n} mazo del libro ausente al libro elegido.', { n })
      : t('Se moverán los {n} mazos del libro ausente al libro elegido.', { n }),
    fields: [{ name: 'book', label: 'Libro', type: 'select', options }],
    okText: 'Asignar',
  });
  if (!res?.book) return;
  await AiDB.remapDecks(fromId, res.book);
  await paint();
}

function wireDetail(b) {
  b.addEventListener('click', onDetailClick);
  // La edición es en el sitio: al salir del campo se persiste (mismo patrón
  // que el modal de flashcards). Sin re-render aquí: robaría el foco.
  b.querySelector('.fc-list').addEventListener('focusout', () => syncCardsFromDom(b));
}

async function onDetailClick(e) {
  const act = e.target.closest('[data-act]');
  if (!act || !currentDeck) return;
  const a = act.dataset.act;
  if (a === 'dk-back') { mode = 'list'; deckId = null; await paint(); return; }
  if (a === 'dk-susp') {
    syncCardsFromDom(body());
    const i = parseInt(act.closest('.fc-item').dataset.i, 10);
    const next = DM.toggleSuspendCard(currentDeck, i);
    currentDeck = next;
    await AiDB.updateDeck(currentDeck.id, { cards: next.cards });
    await paint();
    return;
  }
  if (a === 'dk-del-card') {
    syncCardsFromDom(body());
    const i = parseInt(act.closest('.fc-item').dataset.i, 10);
    const next = DM.removeCard(currentDeck, i);
    currentDeck = next;
    await AiDB.updateDeck(currentDeck.id, { cards: next.cards });
    await paint();
    return;
  }
  if (a === 'dk-add') await submitAdd(body());
}

// Vuelca las ediciones pendientes del DOM (frente/dorso) al mazo y persiste.
// Los data-i de las filas son índices de deck.cards (las tombstone se saltan
// al pintar, no al indexar), así que casan siempre con los helpers puros.
function syncCardsFromDom(b) {
  if (!currentDeck) return;
  let next = currentDeck;
  for (const r of b.querySelectorAll('.fc-item')) {
    const i = parseInt(r.dataset.i, 10);
    next = DM.updateCardText(next, i, {
      front: r.querySelector('.fc-front').innerText.trim(),
      back: r.querySelector('.fc-back').innerText.trim(),
    });
  }
  currentDeck = next;
  AiDB.updateDeck(currentDeck.id, { cards: next.cards });
}

async function submitAdd(b) {
  const typeEl = b.querySelector('.dk-add-type');
  const frontEl = b.querySelector('.dk-add-front');
  const backEl = b.querySelector('.dk-add-back');
  const errEl = b.querySelector('[data-role="add-error"]');
  const input = { type: typeEl.value, front: frontEl.value, back: backEl.value };
  const v = DM.validateCardInput(input, { existingFronts: AiDB.cardsOf(currentDeck).map(c => c.front) });
  if (!v.ok) {
    errEl.textContent = ADD_ERRORS[v.reason] ? ADD_ERRORS[v.reason]() : v.reason;
    errEl.style.display = '';
    return;
  }
  const next = DM.addCard(currentDeck, DM.makeCard(input));
  await AiDB.updateDeck(currentDeck.id, { cards: next.cards });
  frontEl.value = '';
  backEl.value = '';
  errEl.style.display = 'none';
  await paint();
}
