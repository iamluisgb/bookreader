// P10 · Modo Estudiar — sesión de repaso con repetición espaciada sobre los mazos de
// flashcards que ya viven en IndexedDB (store `decks`). Overlay a pantalla completa
// (misma familia visual que el modal de flashcards); ver decisiones en BACKLOG · P10.
//
// Dos puertas, misma UI: un mazo concreto (desde el modal de flashcards) o la cola
// del día con lo vencido de TODOS los mazos (chip en la estantería).
//
// El estado de scheduling (`card.srs`) se persiste TRAS CADA tarjeta, no al final:
// cerrar a media sesión no pierde nada.
import { t } from '../i18n.js';
import * as DB from './db.js';
import * as Srs from './srs.js';
import * as Storage from '../storage.js';
import * as Store from '../library/store.js';
import { icon } from '../ui/icons.js';
import { escapeHtml } from '../ui/escape.js';
import { ensurePro } from '../ui/paywall.js';

// Racha de estudio (F3): {count, lastDay}, global de la app (no por libro).
const STREAK_KEY = 'study_streak';

let overlay = null;
let onCloseCb = null;
let onNavigateCb = null;
let queue = [];          // [{deck, idx}] pendientes de la sesión (los "otra vez" se re-encolan)
let done = 0;            // tarjetas superadas en la sesión (no cuenta los "otra vez")
let flipped = false;
const anchorsCache = new Map();   // bookId → Map(aN → {cfi, href, page, chapter})

// ---- Cola diaria (para el chip de la estantería) -----------------------------

// P12 · Mazos de un ÁMBITO de repaso: todo | un libro | una estantería. Sin ámbito
// (o 'all') son todos los mazos; el filtro por libro/estantería permite repasar solo
// lo de un contexto en vez del revoltijo global.
async function decksForScope(scope) {
  const decks = await DB.getAllDecks();
  if (!scope || scope.type === 'all') return decks;
  if (scope.type === 'book') return decks.filter(d => d.bookId === scope.bookId);
  if (scope.type === 'shelf') {
    const books = await Store.getAllBooks();
    const inShelf = new Set(books.filter(b => (b.shelfIds || []).includes(scope.shelfId)).map(b => b.id));
    return decks.filter(d => inShelf.has(d.bookId));
  }
  return decks;
}

// Vencidas hoy en el ámbito dado (por defecto, todo): total y mazos implicados.
export async function dueToday(scope, now = Date.now()) {
  const decks = await decksForScope(scope);
  let cards = 0, withDue = [];
  for (const d of decks) {
    const n = Srs.dueCount(d.cards, now);
    if (n) { cards += n; withDue.push(d); }
  }
  return { cards, decks: withDue };
}

// Abre la sesión del día para un ámbito (por defecto, todo lo vencido).
// Gate Pro (MON2): el repaso espaciado (quizzes) es Pro. `open()` directo no se gatea:
// se llega desde el modal de flashcards, que ya pasó su propio gate.
export async function openToday({ scope, title, onClose } = {}) {
  if (!(await ensurePro('study'))) return;
  const { decks } = await dueToday(scope);
  open({ decks, title: title || t('Repaso de hoy'), onClose });
}

// Ámbitos de repaso con tarjetas vencidas hoy (para el selector, árbol estilo Anki): total
// global + cada ESTANTERÍA (categoría padre, con la SUMA de sus libros) y, anidados dentro,
// sus LIBROS; más los libros SUELTOS (sin estantería) aparte. Se repasa a cualquier nivel.
export async function studyScopes(now = Date.now()) {
  const [decks, books, shelves] = await Promise.all([
    DB.getAllDecks(), Store.getAllBooks(), Store.getShelves(),
  ]);
  const dueByBook = new Map();
  let total = 0;
  for (const d of decks) {
    const n = Srs.dueCount(d.cards, now);
    if (n) { dueByBook.set(d.bookId, (dueByBook.get(d.bookId) || 0) + n); total += n; }
  }
  const byCardsThenTitle = (a, b) => b.cards - a.cards || a.title.localeCompare(b.title);
  const dueBooks = books
    .filter(b => dueByBook.get(b.id))
    .map(b => ({ id: b.id, title: b.title || t('Sin título'), cards: dueByBook.get(b.id), shelfIds: b.shelfIds || [] }));

  const placed = new Set();
  const shelfScopes = [];
  for (const sh of shelves) {
    const members = dueBooks.filter(b => b.shelfIds.includes(sh.id)).sort(byCardsThenTitle);
    if (!members.length) continue;
    members.forEach(b => placed.add(b.id));
    shelfScopes.push({
      id: sh.id, name: sh.name,
      cards: members.reduce((s, b) => s + b.cards, 0),
      books: members.map(({ id, title, cards }) => ({ id, title, cards })),
    });
  }
  // Un libro sin estantería (o cuyas estanterías ya no existen) cuenta en el total pero
  // no quedó bajo ninguna categoría → va como "suelto".
  const looseBooks = dueBooks.filter(b => !placed.has(b.id)).sort(byCardsThenTitle)
    .map(({ id, title, cards }) => ({ id, title, cards }));

  return { total, shelves: shelfScopes, looseBooks };
}

// ---- Sesión -------------------------------------------------------------------

// `decks`: mazos a repasar (solo entran sus tarjetas vencidas, en orden de mazo).
// `onNavigate`: se llama al saltar a la fuente ("ver en el libro") para que quien abrió
// la sesión cierre lo suyo (p. ej. el modal de flashcards) antes de mostrar el libro.
export function open({ decks, title = 'Estudiar', onClose, onNavigate } = {}) {
  close();
  onCloseCb = onClose || null;
  onNavigateCb = onNavigate || null;
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
        <button class="ai-ob-close" title="${t('Cerrar')}" aria-label="${t('Cerrar')}">${icon('xmark', { size: 18 })}</button>
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
    ${card.src ? `<button class="study-src">${icon('book', { size: 15 })} ${t('Ver en el libro')}</button>` : ''}
    <div class="study-grades">
      ${btn('again', t('Otra vez'), 'is-again')}${btn('hard', t('Difícil'), 'is-hard')}
      ${btn('good', t('Bien'), 'is-good')}${btn('easy', t('Fácil'), 'is-easy')}
    </div>`;
  f.querySelector('.study-grades').addEventListener('click', (e) => {
    const g = e.target.closest('[data-rate]');
    if (g) gradeCurrent(g.dataset.rate);
  });
  f.querySelector('.study-src')?.addEventListener('click', () => goToSource(deck, card));
}

// ---- Fuente citada (P10 F2): "ver en el libro" ----------------------------------

// Anclas [[aN]] del libro (store `anchors` de la BD del agente), cacheadas por sesión.
async function anchorsFor(bookId) {
  if (!anchorsCache.has(bookId)) {
    const rec = await DB.get('anchors', bookId);
    anchorsCache.set(bookId, new Map(rec?.entries || []));
  }
  return anchorsCache.get(bookId);
}

// Salta a la página/CFI de origen de la tarjeta vía el deep-link del router
// (`#book=<id>&loc=<cfi|página>`): el mismo camino abre el libro si no está abierto
// (la cola global cruza libros) o solo reposiciona si ya lo está. El id del mazo y el
// de la biblioteca son el mismo hash del archivo.
async function goToSource(deck, card) {
  const a = (await anchorsFor(deck.bookId)).get(card.src);
  const loc = a ? (a.cfi ?? a.href ?? a.page) : null;
  if (loc == null || !deck.bookId) return;
  const p = new URLSearchParams();
  p.set('book', deck.bookId);
  p.set('loc', String(loc));
  const cb = onNavigateCb;
  onNavigateCb = null;
  close();                                  // el progreso ya está persistido tarjeta a tarjeta
  if (cb) cb();
  location.hash = p.toString();             // dispara hashchange → el router abre/reposiciona
}

function gradeCurrent(rating) {
  if (!queue.length) return;
  const entry = queue.shift();
  const { deck, idx } = entry;
  deck.cards[idx] = { ...deck.cards[idx], srs: Srs.grade(deck.cards[idx].srs, rating) };
  if (deck.id) DB.updateDeck(deck.id, { cards: deck.cards });   // persistir TRAS CADA tarjeta
  Storage.set(STREAK_KEY, Srs.bumpStreak(Storage.get(STREAK_KEY)));   // repaso de hoy → racha
  if (rating === 'again') queue.push(entry);                    // se repite al final de la sesión
  else done++;
  renderCard();
}

function renderDone(b, f, left) {
  if (left) left.textContent = '';
  const streak = Srs.currentStreak(Storage.get(STREAK_KEY));
  b.innerHTML = `
    <div class="study-end">
      <div class="study-end-icon">${icon('check', { size: 40 })}</div>
      <h2>${done ? t('¡Repaso completado!') : t('Nada que repasar')}</h2>
      <p>${done
        ? t('Has repasado <b>{n}</b> tarjeta{s}. La repetición espaciada hará el resto.', { n: done, s: done === 1 ? '' : 's' })
        : t('No hay tarjetas vencidas ahora mismo. Vuelve mañana.')}</p>
      ${done && streak ? `<div class="study-streak">${t('🔥 Racha de <b>{n}</b> día{s} estudiando', { n: streak, s: streak === 1 ? '' : 's' })}</div>` : ''}
    </div>`;
  f.innerHTML = `<button class="primary-btn study-flip">${t('Cerrar')}</button>`;
  f.querySelector('.study-flip').addEventListener('click', close);
}
