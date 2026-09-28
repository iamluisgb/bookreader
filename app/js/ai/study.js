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
import { shareStreak } from '../share-card.js';
import * as Shelves from '../library/shelves.js';
import { icon } from '../ui/icons.js';
import { escapeHtml } from '../ui/escape.js';
import { confirmBox } from '../ui/dialog.js';
import { ensurePro } from '../ui/paywall.js';
import * as LLM from './llm.js';
import { bookLook } from '../ui/book-accent.js';
import { toast } from './toast.js';
import { segmentBook } from './segment.js';
import { segmentPdf } from './segment-pdf.js';
import { loadEpubJs, loadPdfJs } from '../vendor-loader.js';

// Racha de estudio (F3): {count, lastDay}, global de la app (no por libro).
const STREAK_KEY = 'study_streak';
// Tope de tarjetas NUEVAS por sesión (P24 F1). Configurable en Ajustes → Aplicación;
// 0 = sin tope.
const NEW_LIMIT_KEY = 'study_new_limit';
export const DEFAULT_NEW_LIMIT = 20;
const UNDO_DEPTH = 30;

// Meta diaria elegible (retención T3): el usuario elige cuántas tarjetas quiere por día.
// Lección Duolingo: quien ELIGE la meta, la cumple (ownership), y el copy de compromiso
// solo funciona si hay una promesa propia que cumplir. El anillo cuenta el repaso de TODO
// el día (study_log): cerrar la sesión y volver no reinicia el progreso.
const GOAL_KEY = 'study_goal';
export const DEFAULT_GOAL = 20;
const GOAL_STEP = 5;
const GOAL_C = +(2 * Math.PI * 15).toFixed(2);   // circunferencia del anillo del header

// Hitos de racha celebrables (T4): el primer «jaja, llevo una semana» es el que engancha.
const MILESTONES = [7, 30, 100, 365];

export function dailyGoal() {
  const v = Storage.get(GOAL_KEY, DEFAULT_GOAL);
  return Number.isFinite(v) && v >= 5 ? Math.min(200, Math.round(v)) : DEFAULT_GOAL;
}

export function setDailyGoal(n) {
  const v = Math.min(200, Math.max(5, Math.round(Number(n) || DEFAULT_GOAL)));
  Storage.set(GOAL_KEY, v);
  return v;
}

export function newLimit() {
  const v = Storage.get(NEW_LIMIT_KEY, DEFAULT_NEW_LIMIT);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_NEW_LIMIT;
}

let overlay = null;
let onCloseCb = null;
let onNavigateCb = null;
let queue = [];          // [{deck, idx}] pendientes de la sesión (los "otra vez" se re-encolan)
let held = [];           // nuevas que el tope dejó fuera (se pueden pedir al terminar)
let undoStack = [];      // [{queue, done, deck, idx, srs, streak}] para deshacer la última nota
let done = 0;            // tarjetas superadas en la sesión (no cuenta los "otra vez")
let editing = false;     // la tarjeta actual está abierta en el editor inline
let flipped = false;
let minimized = false;   // sesión viva pero oculta (se fue a ver la fuente en el libro)
let chip = null;         // chip "Volver al repaso" mientras está minimizada
const anchorsCache = new Map();   // bookId → Map(aN → {cfi, href, page, chapter})
const passageCache = new Map();   // bookId → Map(aN → texto del pasaje) — se suelta al cerrar
const segInFlight = new Map();    // bookId → Promise<boolean> segmentación en curso (dedupe)

// ---- Cola diaria (para el chip de la estantería) -----------------------------

// P12 · Mazos de un ÁMBITO de repaso: todo | un libro | una estantería. Sin ámbito
// (o 'all') son todos los mazos; el filtro por libro/estantería permite repasar solo
// lo de un contexto en vez del revoltijo global.
async function decksForScope(scope) {
  const decks = await DB.getAllDecks();
  if (!scope || scope.type === 'all') return decks;
  if (scope.type === 'book') return decks.filter(d => d.bookId === scope.bookId);
  if (scope.type === 'shelf') {
    const [books, shelves] = await Promise.all([Store.getAllBooks(), Store.getShelves()]);
    const shelf = shelves.find(s => s.id === scope.shelfId);
    // Vía Shelves.booksIn, no leyendo `shelfIds`: así una estantería INTELIGENTE
    // (que no guarda miembros, los calcula) vale como ámbito de repaso igual que
    // una manual, sin caso especial aquí.
    const inShelf = new Set(Shelves.booksIn(books, shelf).map(b => b.id));
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
  const dueById = new Map(dueBooks.map(b => [b.id, b]));

  const placed = new Set();
  const shelfScopes = [];
  for (const sh of shelves) {
    // Pertenencia calculada sobre los libros COMPLETOS (una regla mira `status`,
    // `addedAt`…, no solo `shelfIds`) y luego proyectada a los que tienen
    // vencidas hoy, que es lo único que el selector enseña.
    const members = Shelves.booksIn(books, sh, now)
      .map(b => dueById.get(b.id)).filter(Boolean).sort(byCardsThenTitle);
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

// ---- Orden de la sesión (P24 F1) ------------------------------------------------

// Barajado Fisher-Yates in situ. `rng` inyectable para poder testear el orden.
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Aleja las tarjetas HERMANAS (las que salen del mismo pasaje `src`): si la siguiente
// comparte origen con la anterior, se intercambia por la primera de más adelante que no
// lo comparta. Dos cloze de la misma frase seguidos se cantan la respuesta el uno al otro.
function spreadSiblings(q) {
  for (let i = 1; i < q.length; i++) {
    if (!q[i].src || q[i].src !== q[i - 1].src) continue;
    const j = q.findIndex((e, k) => k > i && e.src !== q[i].src);
    if (j > i) [q[i], q[j]] = [q[j], q[i]];
  }
  return q;
}

// Cola de una sesión a partir de los mazos. PURA (mazos → entradas) para poder testearla.
// Tres reglas, todas para que exista una segunda sesión:
//  - TOPE de nuevas: la cola diaria suma lo vencido de TODOS los mazos, así que generar
//    tres mazos de 30 pone 90 tarjetas el primer día. Las que no entran se devuelven en
//    `held` (al terminar se pueden pedir), no se pierden.
//  - BARAJADO: en orden de mazo se repasa siempre el mismo capítulo primero, y el orden
//    acaba siendo una pista más (te sabes la siguiente por dónde va la sesión).
//  - HERMANAS separadas (spreadSiblings).
export function buildQueue(decks, { now = Date.now(), newLimit: limit = 0, rng = Math.random } = {}) {
  const news = [], revs = [];
  for (const deck of decks || []) {
    (deck.cards || []).forEach((c, idx) => {
      if (!c || !c.front || !Srs.isDue(c, now)) return;
      (c.srs && c.srs.reps > 0 ? revs : news).push({ deck, idx, src: c.src || '' });
    });
  }
  shuffle(news, rng);
  // El tope solo recorta NUEVAS: lo ya empezado vence hoy porque el scheduler lo decidió,
  // y aplazarlo es justo lo que rompe la programación.
  const heldNew = limit > 0 ? news.splice(limit) : [];
  return { queue: spreadSiblings(shuffle(revs.concat(news), rng)), held: heldNew };
}

// ---- Sesión -------------------------------------------------------------------
// ST2 (2026-09-28): la sesión pasa a ser una pantalla de concentración con la tarjeta como
// objeto (gira en 3D, el montón de detrás es el progreso), el color del libro de cada
// tarjeta, dos botones por defecto con el tiempo en palabras, deslizar en móvil, responder
// por escrito para que el agente corrija, «reescribir con el agente» y un cierre con datos.

// Modo de notas: 'simple' (Otra vez / Bien) por defecto; 'full' con las cuatro. Elegir entre
// «Difícil» y «Bien» en cada tarjeta cansa, y FSRS funciona bien con dos notas.
const GRADING_KEY = 'study_grading';
export function gradingMode() { return Storage.get(GRADING_KEY, 'simple') === 'full' ? 'full' : 'simple'; }

// Registro diario de repasos {día: nº} para el calendario de la racha (últimos 120 días).
const LOG_KEY = 'study_log';
function bumpLog(delta = 1, now = Date.now()) {
  const log = Storage.get(LOG_KEY, {}) || {};
  const day = Srs.dayOf(now);
  log[day] = Math.max(0, (log[day] || 0) + delta);
  const keys = Object.keys(log).map(Number).sort((a, b) => a - b);
  while (keys.length > 120) delete log[keys.shift()];
  Storage.set(LOG_KEY, log);
}
// Racha vigente (para la tarjeta «Hoy» de la biblioteca).
export function currentStreak(now = Date.now()) { return Srs.currentStreak(Storage.get(STREAK_KEY), now); }

export function reviewsToday(now = Date.now()) {
  return (Storage.get(LOG_KEY, {}) || {})[Srs.dayOf(now)] || 0;
}

let startedAt = 0;       // para el tiempo de la sesión
let streakAtStart = 0;   // racha al abrir la sesión: el hito se celebra una vez, no cada día
let graded = 0;          // notas puestas (incluye los «otra vez»)
let firstTry = 0;        // tarjetas acertadas a la primera
let failedOnce = new Set();
let animating = false;
let sessionBooks = new Set();
let recallText = '';     // lo que el usuario escribió como respuesta (recuerdo activo)
let suggested = null;    // nota sugerida por el agente al corregir

// `decks`: mazos a repasar (solo entran sus tarjetas vencidas).
// `onNavigate`: se llama al saltar a la fuente ("ver en el libro") para que quien abrió
// la sesión cierre lo suyo (p. ej. el modal de flashcards) antes de mostrar el libro.
export function open({ decks, title = t('Estudiar'), onClose, onNavigate } = {}) {
  close();
  onCloseCb = onClose || null;
  onNavigateCb = onNavigate || null;
  const built = buildQueue(decks, { now: Date.now(), newLimit: newLimit() });
  queue = built.queue;
  held = built.held;
  undoStack = [];
  done = 0;
  graded = 0;
  firstTry = 0;
  failedOnce = new Set();
  sessionBooks = new Set((decks || []).map(d => d.bookId).filter(Boolean));
  startedAt = Date.now();
  streakAtStart = Srs.currentStreak(Storage.get(STREAK_KEY));
  flipped = false;
  editing = false;
  animating = false;

  overlay = document.createElement('div');
  overlay.id = 'ai-study';
  overlay.className = 'ai-onboarding study-screen';
  overlay.innerHTML = `
    <div class="ai-ob-card study-card" role="dialog" aria-modal="true" aria-label="${t('Modo Estudiar')}">
      <div class="study-progress" aria-hidden="true"><span></span></div>
      <div class="study-head">
        <span class="study-title">${escapeHtml(title)}</span>
        <span class="study-streakchip" aria-live="polite"></span>
        <button class="study-goal" title="${t('Meta diaria')}" aria-label="${t('Meta diaria')}">
          <svg viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15" class="study-goal-track"/><circle cx="18" cy="18" r="15" class="study-goal-fill"/></svg>
          <span class="study-goal-n" aria-live="polite"></span>
        </button>
        <span class="study-left" aria-live="polite"></span>
        <div class="study-tools"></div>
        <button class="ai-ob-close" title="${t('Cerrar')}" aria-label="${t('Cerrar')}">${icon('xmark', { size: 18 })}</button>
      </div>
      <div class="study-body"></div>
      <div class="study-foot"></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.ai-ob-close').addEventListener('click', close);
  overlay.querySelector('.study-goal').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleGoalPop();
  });
  document.addEventListener('keydown', onKey);
  renderCard();
}

export function isOpen() { return !!overlay && !minimized; }

// F2 · Saltar al libro MINIMIZA la sesión, no la mata (la navegación es SPA): se oculta el
// overlay y un chip permite volver con la cola intacta.
function minimize() {
  if (!overlay || minimized) return;
  minimized = true;
  overlay.hidden = true;
  document.removeEventListener('keydown', onKey);
  renderChip();
}

function restore() {
  if (!overlay || !minimized) return;
  minimized = false;
  overlay.hidden = false;
  document.addEventListener('keydown', onKey);
  removeChip();
}

function renderChip() {
  removeChip();
  chip = document.createElement('div');
  chip.className = 'ai-taskchip is-study';
  chip.innerHTML = `<span class="ai-taskchip-dot" aria-hidden="true">${icon('cards', { size: 13 })}</span>
    <span class="ai-taskchip-label"></span>
    <button class="ai-taskchip-x" title="${t('Terminar repaso')}" aria-label="${t('Terminar repaso')}">${icon('xmark', { size: 14 })}</button>`;
  chip.querySelector('.ai-taskchip-label').textContent =
    t('Volver al repaso · {n} pendiente{s}', { n: queue.length, s: queue.length === 1 ? '' : 's' });
  chip.querySelector('.ai-taskchip-x').onclick = (e) => { e.stopPropagation(); close(); };
  chip.onclick = restore;
  document.body.appendChild(chip);
}

function removeChip() {
  if (chip) { chip.remove(); chip = null; }
}

function close() {
  document.removeEventListener('keydown', onKey);
  if (overlay) { overlay.remove(); overlay = null; }
  minimized = false;
  removeChip();
  queue = [];
  held = [];
  undoStack = [];
  editing = false;
  passageCache.clear();        // el texto anotado de un libro son MB: no sobrevive a la sesión
  syncBadge();
  if (onCloseCb) { const cb = onCloseCb; onCloseCb = null; cb(); }
}

function typingInRecall(e) {
  return e.target && e.target.closest && e.target.closest('.study-recall-input');
}

function onKey(e) {
  if (!overlay) return;
  // Editando: el teclado es del editor (Escape cancela la edición, no la sesión).
  if (editing) { if (e.key === 'Escape') { e.preventDefault(); renderCard(); } return; }
  // Escribiendo la respuesta: Intro (sin mayúsculas) comprueba; el resto es texto.
  if (typingInRecall(e)) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); flip(); }
    if (e.key === 'Escape') { e.preventDefault(); e.target.blur(); }
    return;
  }
  if (e.key === 'Escape') { close(); return; }
  if ((e.key === 'z' || e.key === 'Z') && undoStack.length) { e.preventDefault(); undo(); return; }
  const current = queue[0];
  if (!current || animating) return;
  if (!flipped && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); flip(); return; }
  if (flipped) {
    // Las cuatro teclas valen siempre; en modo simple el 2 también es «bien».
    const map = gradingMode() === 'full'
      ? { 1: 'again', 2: 'hard', 3: 'good', 4: 'easy' }
      : { 1: 'again', 2: 'good', 3: 'good', 4: 'easy' };
    if (map[e.key]) { e.preventDefault(); gradeCurrent(map[e.key]); }
  }
}

// ---- Render de la tarjeta -------------------------------------------------------

// Cloze {{cN::respuesta(::pista)}} → hueco en el frente; revelado resaltado al voltear.
const CLOZE_RE = /\{\{c\d+::((?:(?!::|\}\}).)*)(?:::((?:(?!\}\}).)*))?\}\}/g;

// Nota: el replace corre sobre el texto YA escapado, así que los grupos capturados llegan
// escapados — insertarlos tal cual es seguro.
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

// Cabecera de acciones: deshacer (visible) y un menú «⋯» con editar, reescribir con el
// agente, suspender y borrar. Antes eran tres iconos grises sin texto (el ojo tachado de
// «suspender» no se entendía).
function renderTools() {
  const host = overlay?.querySelector('.study-tools');
  if (!host) return;
  const hasCard = !editing && !!queue.length;
  const item = (act, ico, label) =>
    `<button class="study-menu-item" data-act="${act}" role="menuitem">${icon(ico, { size: 15 })}<span>${label}</span></button>`;
  host.innerHTML =
    (undoStack.length ? `<button class="icon-btn study-tool" data-act="undo" title="${t('Deshacer la última nota')} (Z)" aria-label="${t('Deshacer la última nota')}">${icon('undo', { size: 16 })}</button>` : '') +
    (hasCard ? `<button class="icon-btn study-tool study-more" aria-haspopup="menu" aria-expanded="false" title="${t('Más acciones')}" aria-label="${t('Más acciones')}">${icon('ellipsis', { size: 18 })}</button>
      <div class="study-menu" role="menu" hidden>
        ${item('edit', 'pencil', t('Editar la tarjeta'))}
        ${LLM.hasKey() ? item('rewrite', 'sparkles', t('Reescribir con el agente')) : ''}
        ${item('suspend', 'eye-off', t('Suspender: no volver a mostrarla'))}
        ${item('delete', 'trash', t('Borrar la tarjeta'))}
      </div>` : '');
  host.onclick = (e) => {
    const more = e.target.closest('.study-more');
    const menu = host.querySelector('.study-menu');
    if (more && menu) {
      menu.hidden = !menu.hidden;
      more.setAttribute('aria-expanded', String(!menu.hidden));
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (menu) menu.hidden = true;
    if (b.dataset.act === 'undo') undo();
    if (b.dataset.act === 'edit') renderEditor();
    if (b.dataset.act === 'rewrite') rewriteCurrent();
    if (b.dataset.act === 'suspend') suspendCurrent();
    if (b.dataset.act === 'delete') deleteCurrent();
  };
}

function setProgress() {
  const bar = overlay?.querySelector('.study-progress span');
  if (!bar) return;
  const total = done + queue.length;
  bar.style.width = total ? `${Math.round((done / total) * 100)}%` : '100%';
}

// Cabecera de la tarjeta: portada en miniatura + libro · capítulo, en el color del libro.
function metaHtml(deck, card) {
  const where = [deck.name || deck.scope || t('Mazo'), card.chapter].filter(Boolean).join(' · ');
  return `<div class="study-meta"><span class="study-meta-cover" aria-hidden="true"></span><span class="study-deckname">${escapeHtml(where)}</span></div>`;
}

// El color y la portada llegan en asíncrono (se leen de la biblioteca): la tarjeta se pinta ya
// y se tiñe al llegar, si sigue siendo la misma.
function paintLook(deck) {
  const stage = overlay?.querySelector('.study-stage');
  if (!stage || !deck.bookId) return;
  bookLook(deck.bookId).then(({ accent, cover }) => {
    if (!overlay || overlay.querySelector('.study-stage') !== stage) return;
    stage.style.setProperty('--book', accent);
    overlay.querySelector('.study-card').style.setProperty('--book', accent);
    stage.querySelectorAll('.study-meta-cover').forEach((el) => {
      if (cover) { el.style.backgroundImage = `url("${cover}")`; el.classList.add('has-cover'); }
    });
  });
}

// La racha se ve en los primeros 3 segundos de sesión (lección de retención de Duolingo:
// la gente que abandona nunca llega a la pantalla final, así que la racha solo al cerrar no
// motiva a nadie). «En riesgo» = la racha sigue viva pero HOY todavía no repasaste: mejor
// avisar ahora que lamentar mañana.
function refreshHead() {
  const el = overlay?.querySelector('.study-streakchip');
  if (!el) return;
  const streak = Srs.currentStreak(Storage.get(STREAK_KEY));
  el.textContent = `🔥 ${streak}`;
  el.setAttribute('aria-label', t('Racha de {n} día{s}', { n: streak, s: streak === 1 ? '' : 's' }));
  el.classList.toggle('is-zero', !streak);
  el.classList.toggle('is-risky', streak > 0 && !reviewsToday());
  // Anillo de meta: repaso de hoy / meta elegida. Se llena aunque la sesión se cierre:
  // es la promesa del día, no de la sesión.
  const goalEl = overlay?.querySelector('.study-goal');
  if (goalEl) {
    const today = reviewsToday();
    const goal = dailyGoal();
    const fill = goalEl.querySelector('.study-goal-fill');
    fill.style.strokeDasharray = String(GOAL_C);
    fill.style.strokeDashoffset = (GOAL_C * (1 - Math.min(1, today / goal))).toFixed(1);
    goalEl.querySelector('.study-goal-n').textContent = `${today}/${goal}`;
    goalEl.classList.toggle('is-done', today >= goal);
  }
}

// Popover para cambiar la meta (±5, 5–200). Nada de pantallas de ajustes: la meta se
// ajusta donde se ve. El click fuera la cierra.
function toggleGoalPop() {
  overlay?.querySelector('.study-goal-pop')?.remove();
  const btn = overlay?.querySelector('.study-goal');
  if (!btn) return;
  const pop = document.createElement('div');
  pop.className = 'study-goal-pop';
  const paint = () => {
    pop.innerHTML = `
      <button class="study-goal-less" aria-label="${t('Menos')}">−</button>
      <span class="study-goal-v"><b>${dailyGoal()}</b> ${t('al día')}</span>
      <button class="study-goal-more" aria-label="${t('Más')}">+</button>`;
    pop.querySelector('.study-goal-less').onclick = () => { setDailyGoal(dailyGoal() - GOAL_STEP); paint(); refreshHead(); };
    pop.querySelector('.study-goal-more').onclick = () => { setDailyGoal(dailyGoal() + GOAL_STEP); paint(); refreshHead(); };
  };
  paint();
  btn.appendChild(pop);
  setTimeout(() => {
    const off = (ev) => {
      if (!pop.isConnected || ev.target.closest?.('.study-goal')) return;
      pop.remove();
      document.removeEventListener('click', off);
    };
    document.addEventListener('click', off);
  });
}

function renderCard() {
  const b = overlay?.querySelector('.study-body');
  const f = overlay?.querySelector('.study-foot');
  const left = overlay?.querySelector('.study-left');
  if (!b || !f) return;
  editing = false;
  animating = false;
  recallText = '';
  suggested = null;
  setProgress();
  refreshHead();

  if (!queue.length) { renderDone(b, f, left); renderTools(); return; }
  left.textContent = t('{n} pendiente{s}', { n: queue.length, s: queue.length === 1 ? '' : 's' });

  const { deck, idx } = queue[0];
  const card = deck.cards[idx];
  flipped = false;
  const behind = Math.min(queue.length - 1, 3);
  b.innerHTML = `
    <div class="study-stage">
      <div class="study-stack" aria-hidden="true">${'<span></span>'.repeat(behind)}</div>
      <div class="study-card3d" tabindex="-1">
        <div class="study-face study-face--front">
          ${metaHtml(deck, card)}
          ${leechHtml(card)}
          <div class="study-q">${frontHtml(card)}</div>
          <p class="study-tap">${t('Toca la tarjeta para girarla')}</p>
        </div>
        <div class="study-face study-face--back">
          ${metaHtml(deck, card)}
          <div class="study-qmini">${card.type === 'cloze' ? '' : escapeHtml(card.front)}</div>
          <div class="study-a" hidden></div>
          <div class="study-feedback" hidden></div>
        </div>
      </div>
    </div>
    ${LLM.hasKey() ? `<div class="study-recall">
      <textarea class="study-recall-input" rows="1" placeholder="${t('Escribe tu respuesta y el agente la corrige (opcional)')}" aria-label="${t('Tu respuesta')}"></textarea>
    </div>` : ''}`;
  f.innerHTML = `<button class="primary-btn study-flip">${t('Mostrar respuesta')} <kbd>${t('espacio')}</kbd></button>`;
  f.querySelector('.study-flip').addEventListener('click', flip);
  b.querySelector('.study-card3d').addEventListener('click', (e) => {
    if (!flipped && !e.target.closest('button, a, textarea')) flip();
  });
  const input = b.querySelector('.study-recall-input');
  if (input) {
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 140) + 'px';
      f.querySelector('.study-flip').firstChild.textContent = input.value.trim() ? `${t('Comprobar')} ` : `${t('Mostrar respuesta')} `;
    });
  }
  wireSwipe(b.querySelector('.study-card3d'));
  paintLook(deck);
  renderTools();
}

// Aviso de leech: no suspende sola; propone el arreglo, que casi siempre es reformularla.
function leechHtml(card) {
  if (!Srs.isLeech(card)) return '';
  return `<div class="study-leech">${icon('warning', { size: 14 })}
    <span>${t('La has fallado {n} veces. Suele ser señal de que la tarjeta está mal formulada, no de que el tema sea difícil: edítala o suspéndela.', { n: card.srs.lapses })}</span>
    ${LLM.hasKey() ? `<button class="study-leech-fix" data-act="rewrite">${icon('sparkles', { size: 13 })} ${t('Reescribir con el agente')}</button>` : ''}
  </div>`;
}

// ---- Editar / reescribir / suspender / borrar la tarjeta actual ------------------

// Editor inline: los mismos dos campos de la vista de revisión, sin salir del repaso. En
// cloze se edita el TEXTO CRUDO (con {{c1::…}}). `draft` prellena (p. ej. con lo que propone
// el agente) sin guardar: el usuario confirma.
function renderEditor(draft = null) {
  if (!queue.length) return;
  const b = overlay?.querySelector('.study-body');
  const f = overlay?.querySelector('.study-foot');
  if (!b || !f) return;
  editing = true;
  const { deck, idx } = queue[0];
  const card = deck.cards[idx];
  const front = draft ? draft.front : card.front;
  const back = draft ? draft.back : (card.back || '');
  b.innerHTML = `
    <div class="study-stage study-stage--edit">
      ${draft ? `<p class="study-draft-note">${icon('sparkles', { size: 14 })} ${t('Propuesta del agente a partir del pasaje. Revísala y guarda.')}</p>` : ''}
      <div class="study-edit">
        <label class="fc-label">${card.type === 'cloze' ? t('Frase con huecos') : t('Pregunta')}</label>
        <div class="fc-front study-edit-f" contenteditable="true" spellcheck="false">${escapeHtml(front)}</div>
        <label class="fc-label">${card.type === 'cloze' ? t('Extra (opcional)') : t('Respuesta')}</label>
        <div class="fc-back study-edit-b" contenteditable="true" spellcheck="false">${escapeHtml(back)}</div>
      </div>
    </div>`;
  f.innerHTML = `
    <div class="study-editbar">
      <button class="ai-ob-back study-edit-cancel">${t('Cancelar')}</button>
      <button class="primary-btn study-edit-save">${t('Guardar')}</button>
    </div>`;
  f.querySelector('.study-edit-cancel').addEventListener('click', renderCard);
  f.querySelector('.study-edit-save').addEventListener('click', () => {
    const nf = b.querySelector('.study-edit-f').innerText.trim();
    if (!nf) return;                                   // sin frente no hay tarjeta
    patchCurrent({ front: nf, back: b.querySelector('.study-edit-b').innerText.trim() });
    renderCard();
  });
  b.querySelector('.study-edit-f').focus();
  renderTools();
}

// Reescribir con el agente: las tarjetas las escribe un LLM y la que se falla una y otra vez
// suele estar mal formulada. El agente la reformula a partir de su pasaje y la propuesta se
// abre en el editor para confirmarla.
async function rewriteCurrent() {
  if (!queue.length || !LLM.hasKey()) return;
  const { deck, idx } = queue[0];
  const card = deck.cards[idx];
  const b = overlay?.querySelector('.study-body');
  if (b) b.insertAdjacentHTML('afterbegin', `<p class="study-working">${icon('sparkles', { size: 14 })} ${t('Reescribiendo la tarjeta…')}</p>`);
  const passage = await passageOf(deck, card);
  try {
    const raw = await LLM.chatStream({
      messages: [
        { role: 'system', content:
`Eres un experto en tarjetas de memoria. Reescribe esta tarjeta para que sea CLARA y ATÓMICA: una sola pregunta, sin ambigüedad, con una respuesta corta que esté en el pasaje. Mantén el idioma de la tarjeta.
${card.type === 'cloze' ? 'Es una tarjeta de HUECOS: "front" debe ser una frase con UN hueco en formato {{c1::respuesta}} y "back" puede ir vacío.' : '"front" es la pregunta y "back" la respuesta.'}
Devuelve SOLO un JSON: {"front": "...", "back": "..."}` },
        { role: 'user', content: `TARJETA ACTUAL\nfront: ${card.front}\nback: ${card.back || ''}\n\nPASAJE DEL LIBRO\n${passage || '(no disponible)'}` },
      ],
      maxTokens: 500,
    });
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : null;
    const front = j && String(j.front || '').trim();
    if (!front || (card.type === 'cloze' && !/\{\{c\d+::/.test(front))) throw new Error('bad');
    renderEditor({ front, back: String(j.back || '').trim() });
  } catch {
    overlay?.querySelector('.study-working')?.remove();
    toastError(t('El agente no pudo reescribirla. Puedes editarla a mano.'));
  }
}

function toastError(msg) {
  const b = overlay?.querySelector('.study-body');
  if (!b) return;
  b.querySelector('.study-working')?.remove();
  b.insertAdjacentHTML('afterbegin', `<p class="study-working is-error">${escapeHtml(msg)}</p>`);
}

// Escribe un parche en la tarjeta actual y lo persiste (array COMPLETO, tombstones
// incluidos: updateDeck lee lo ausente como borrado).
function patchCurrent(patch) {
  const { deck, idx } = queue[0];
  deck.cards[idx] = { ...deck.cards[idx], ...patch };
  if (deck.id) DB.updateDeck(deck.id, { cards: deck.cards });
}

// Saca de la cola TODAS las entradas de una tarjeta (la actual puede estar re-encolada).
function dropFromQueue(deck, idx) {
  queue = queue.filter(e => !(e.deck === deck && e.idx === idx));
  held = held.filter(e => !(e.deck === deck && e.idx === idx));
}

function suspendCurrent() {
  if (!queue.length) return;
  const { deck, idx } = queue[0];
  patchCurrent({ suspended: true });
  dropFromQueue(deck, idx);
  renderCard();
}

async function deleteCurrent() {
  if (!queue.length) return;
  const { deck, idx } = queue[0];
  if (!(await confirmBox('Se borrará esta tarjeta del mazo. No afecta al resto del repaso.',
    { title: 'Borrar tarjeta', okText: 'Borrar', danger: true }))) return;
  if (!queue.length || queue[0].deck !== deck || queue[0].idx !== idx) return;   // cambió mientras confirmaba
  // Tombstone EN SU SITIO: los índices de la cola apuntan a posiciones.
  patchCurrent({ front: '', back: '', deleted: true, deletedAt: Date.now() });
  dropFromQueue(deck, idx);
  renderCard();
}

// ---- Deshacer la última nota (P24 F2) -------------------------------------------

function pushUndo(entry) {
  undoStack.push(entry);
  if (undoStack.length > UNDO_DEPTH) undoStack.shift();
}

function undo() {
  const u = undoStack.pop();
  if (!u) return;
  const card = { ...u.deck.cards[u.idx] };
  if (u.srs) card.srs = u.srs; else delete card.srs;      // volvía a ser NUEVA
  u.deck.cards[u.idx] = card;
  if (u.deck.id) DB.updateDeck(u.deck.id, { cards: u.deck.cards });
  if (u.streak) Storage.set(STREAK_KEY, u.streak); else Storage.remove(STREAK_KEY);
  bumpLog(-1);
  queue = u.queue;
  done = u.done;
  graded = u.graded ?? graded;
  firstTry = u.firstTry ?? firstTry;
  renderCard();
}

// ---- Voltear, corregir y notas --------------------------------------------------

async function passageOf(deck, card) {
  if (card.quote) return card.quote;
  if (!card.src || !deck.bookId) return '';
  try { return (await passagesFor(deck.bookId)).get(card.src) || ''; } catch { return ''; }
}

function flip() {
  if (!overlay || flipped || !queue.length || animating) return;
  flipped = true;
  const { deck, idx } = queue[0];
  const card = deck.cards[idx];
  const a = overlay.querySelector('.study-a');
  a.innerHTML = backHtml(card);
  a.hidden = card.type !== 'cloze' && !card.back;
  const input = overlay.querySelector('.study-recall-input');
  recallText = input ? input.value.trim() : '';
  overlay.querySelector('.study-recall')?.remove();
  overlay.querySelector('.study-card3d')?.classList.add('is-flipped');
  overlay.querySelector('.study-card')?.classList.add('is-flipped');

  // El pasaje que respalda la tarjeta, como recorte de página plegable.
  if ((card.src && deck.bookId) || card.quote) showPassage(deck, card);
  if (recallText) checkRecall(deck, card, recallText);
  renderGrades(card);
}

function renderGrades(card) {
  const f = overlay?.querySelector('.study-foot');
  if (!f) return;
  const prev = Srs.previewIntervals(card.srs);
  const full = gradingMode() === 'full';
  const keys = full ? { again: 1, hard: 2, good: 3, easy: 4 } : { again: 1, good: 2 };
  const btn = (r, lbl, cls) => `
    <button class="study-grade ${cls}${suggested === r ? ' is-suggested' : ''}" data-rate="${r}">
      <span class="study-grade-lbl">${lbl}</span><small>${Srs.intervalLabel(prev[r])}</small><kbd>${keys[r]}</kbd>
    </button>`;
  f.innerHTML = `
    ${card.src ? `<button class="study-src">${icon('book', { size: 15 })} ${t('Ver en el libro')}</button>` : ''}
    <div class="study-grades${full ? '' : ' is-simple'}">
      ${btn('again', t('Otra vez'), 'is-again')}${full ? btn('hard', t('Difícil'), 'is-hard') : ''}
      ${btn('good', t('Bien'), 'is-good')}${full ? btn('easy', t('Fácil'), 'is-easy') : ''}
    </div>
    <p class="study-swipe-hint">${t('Desliza: ← otra vez · bien →')}</p>`;
  f.querySelector('.study-grades').addEventListener('click', (e) => {
    const g = e.target.closest('[data-rate]');
    if (g) gradeCurrent(g.dataset.rate);
  });
  const { deck } = queue[0];
  f.querySelector('.study-src')?.addEventListener('click', (e) => goToSource(deck, card, e.currentTarget));
}

// Recuerdo activo: el agente compara lo que escribiste con la respuesta y el pasaje, te dice
// qué acertaste y qué falta, y sugiere la nota (resaltada; la decisión sigue siendo tuya).
async function checkRecall(deck, card, answer) {
  const box = overlay?.querySelector('.study-feedback');
  if (!box) return;
  box.hidden = false;
  box.innerHTML = `<p class="study-feedback-wait">${icon('sparkles', { size: 14 })} ${t('El agente está corrigiendo tu respuesta…')}</p>`;
  const expected = card.type === 'cloze'
    ? String(card.front).replace(CLOZE_RE, (_, ans) => ans) + (card.back ? `\n${card.back}` : '')
    : `${card.front}\n${card.back || ''}`;
  const passage = await passageOf(deck, card);
  try {
    const raw = await LLM.chatStream({
      messages: [
        { role: 'system', content:
`Eres un profesor que corrige de forma breve, justa y amable. Compara la RESPUESTA DEL ALUMNO con la RESPUESTA CORRECTA (y el pasaje del libro, si lo hay). No penalices la redacción, solo el contenido.
Devuelve SOLO un JSON: {"veredicto": "bien" | "a medias" | "mal", "comentario": "una o dos frases, en el idioma del alumno: qué acertó y qué le falta"}` },
        { role: 'user', content: `TARJETA Y RESPUESTA CORRECTA\n${expected}\n\nPASAJE\n${passage || '(no disponible)'}\n\nRESPUESTA DEL ALUMNO\n${answer}` },
      ],
      maxTokens: 300,
    });
    if (!overlay || queue[0]?.deck.cards[queue[0].idx] !== card) return;   // ya se pasó de tarjeta
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : {};
    const v = String(j.veredicto || '').toLowerCase();
    const verdict = v.startsWith('bien') ? 'good' : v.includes('medias') ? 'partial' : 'wrong';
    const full = gradingMode() === 'full';
    suggested = verdict === 'good' ? 'good' : verdict === 'partial' ? (full ? 'hard' : 'again') : 'again';
    const label = { good: t('Bien'), partial: t('A medias'), wrong: t('Aún no') }[verdict];
    box.className = `study-feedback is-${verdict}`;
    box.innerHTML = `
      <div class="study-feedback-head"><span class="study-feedback-tag">${label}</span><span class="study-feedback-you">${t('Tu respuesta')}: «${escapeHtml(answer)}»</span></div>
      <p>${escapeHtml(String(j.comentario || ''))}</p>`;
    renderGrades(card);
  } catch {
    box.innerHTML = `<p class="study-feedback-wait">${t('No se pudo corregir ahora. Compárala tú con la respuesta.')}</p>`;
  }
}

async function showPassage(deck, card) {
  let text = await passageOf(deck, card);
  // Libro llegada por sync sin segmentación local: generarla y reintentar una vez.
  if (!text && card.src && deck.bookId && await ensureSegmented(deck.bookId)) {
    text = await passageOf(deck, card);
  }
  if (!text || !overlay || !flipped) return;
  if (queue[0]?.deck.cards[queue[0].idx] !== card) return;   // ya se pasó de tarjeta
  const a = overlay.querySelector('.study-a');
  if (!a || a.querySelector('.study-passage')) return;
  const chapter = card.chapter ? `<span class="study-passage-ch">${escapeHtml(card.chapter)}</span>` : '';
  // Recorte de página: papel, serif y la tarjeta citándolo. Plegado: se abre con un toque.
  a.insertAdjacentHTML('beforeend',
    `<details class="study-passage-wrap"><summary>${icon('book', { size: 14 })} ${t('Ver el pasaje del libro')}</summary>
      <blockquote class="study-passage">${chapter}${escapeHtml(text)}</blockquote></details>`);
  a.hidden = false;
}

// Deslizar la tarjeta ya girada: izquierda = otra vez, derecha = bien. Con umbral y vuelta a su
// sitio si no se llega (un toque o un arrastre corto no califica por error).
function wireSwipe(el) {
  if (!el) return;
  let x0 = null, dx = 0;
  el.addEventListener('pointerdown', (e) => {
    if (!flipped || animating || e.target.closest('button, a, details, textarea')) return;
    x0 = e.clientX; dx = 0;
    el.setPointerCapture?.(e.pointerId);
    el.classList.add('is-dragging');
  });
  el.addEventListener('pointermove', (e) => {
    if (x0 === null) return;
    dx = e.clientX - x0;
    // Número sin unidad: el CSS lo convierte (calc(--drag * 1px) / * 1deg).
    el.style.setProperty('--drag', String(Math.round(dx)));
    el.dataset.lean = dx > 40 ? 'good' : dx < -40 ? 'again' : '';
  });
  const end = () => {
    if (x0 === null) return;
    x0 = null;
    el.classList.remove('is-dragging');
    el.style.removeProperty('--drag');
    const lean = Math.abs(dx) > 90 ? (dx > 0 ? 'good' : 'again') : '';
    el.dataset.lean = '';
    if (lean) gradeCurrent(lean);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

function gradeCurrent(rating) {
  if (!queue.length || editing || animating) return;
  // Foto de la sesión ANTES de tocar nada: es lo que restaura "deshacer".
  pushUndo({
    queue: queue.slice(), done, graded, firstTry, deck: queue[0].deck, idx: queue[0].idx,
    srs: queue[0].deck.cards[queue[0].idx].srs, streak: Storage.get(STREAK_KEY),
  });
  const entry = queue.shift();
  const { deck, idx } = entry;
  const key = `${deck.id}:${idx}`;
  deck.cards[idx] = { ...deck.cards[idx], srs: Srs.grade(deck.cards[idx].srs, rating) };
  // Se persiste TRAS CADA tarjeta y con el array COMPLETO (tombstones incluidos).
  if (deck.id) DB.updateDeck(deck.id, { cards: deck.cards });
  Storage.set(STREAK_KEY, Srs.bumpStreak(Storage.get(STREAK_KEY)));   // repaso de hoy → racha
  bumpLog(1);
  graded++;
  if (rating === 'again') { queue.push(entry); failedOnce.add(key); }
  else { done++; if (!failedOnce.has(key)) firstTry++; }

  // La tarjeta sale hacia el lado de la nota (izquierda = otra vez). La siguiente entra YA:
  // lo que se va es una copia fija encima, así la sesión nunca espera a la animación.
  const el = overlay?.querySelector('.study-card3d');
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (el && !reduce) {
    const r = el.getBoundingClientRect();
    const ghost = el.cloneNode(true);
    ghost.classList.add('study-ghost');
    ghost.removeAttribute('tabindex');
    ghost.setAttribute('aria-hidden', 'true');
    Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    ghost.style.setProperty('--book', overlay.querySelector('.study-card')?.style.getPropertyValue('--book') || '');
    // Fuera del overlay (en un envoltorio con la misma clase de estilos): la copia no debe
    // duplicar la tarjeta en el DOM de la sesión mientras se va.
    const wrap = document.createElement('div');
    wrap.className = 'study-screen study-ghost-wrap';
    wrap.appendChild(ghost);
    document.body.appendChild(wrap);
    requestAnimationFrame(() => ghost.classList.add(rating === 'again' ? 'out-left' : 'out-right'));
    setTimeout(() => wrap.remove(), 320);
  }
  renderCard();
}

// ---- Final de sesión --------------------------------------------------------------

function fmtTime(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? t('{n} s', { n: s }) : t('{m} min {s} s', { m: Math.floor(s / 60), s: s % 60 });
}

// Calendario de la racha: las últimas 5 semanas, un cuadro por día (más oscuro = más repasos).
function heatmapHtml(now = Date.now()) {
  const log = Storage.get(LOG_KEY, {}) || {};
  const today = Srs.dayOf(now);
  const cells = [];
  for (let d = today - 34; d <= today; d++) {
    const n = log[d] || 0;
    const lvl = n === 0 ? 0 : n < 10 ? 1 : n < 25 ? 2 : 3;
    cells.push(`<span class="study-heat-cell lvl-${lvl}${d === today ? ' is-today' : ''}" title="${n}"></span>`);
  }
  return `<div class="study-heat" aria-label="${t('Repasos de las últimas 5 semanas')}">${cells.join('')}</div>`;
}

// Previsión: cuántas tarjetas vencen cada uno de los próximos 7 días (de todos los mazos).
async function forecastHtml(now = Date.now()) {
  const decks = await DB.getAllDecks().catch(() => []);
  const today = Srs.dayOf(now);
  const days = Array(7).fill(0);
  for (const d of decks) for (const c of d.cards || []) {
    if (!c || c.deleted || c.suspended || !c.srs) continue;
    const k = c.srs.due - today;
    if (k >= 1 && k <= 7) days[k - 1]++;
  }
  const max = Math.max(1, ...days);
  const names = [t('mañana')].concat([2, 3, 4, 5, 6, 7].map((k) => {
    const dt = new Date(now + k * 86400000);
    return dt.toLocaleDateString(undefined, { weekday: 'short' }).replace('.', '');
  }));
  return `<div class="study-forecast" aria-label="${t('Tarjetas de los próximos 7 días')}">
    ${days.map((n, i) => `<div class="study-fc-col"><span class="study-fc-n">${n || ''}</span><span class="study-fc-bar" style="height:${Math.round((n / max) * 100)}%"></span><span class="study-fc-day">${escapeHtml(names[i])}</span></div>`).join('')}
  </div>`;
}

function renderDone(b, f, left) {
  if (left) left.textContent = '';
  const streak = Srs.currentStreak(Storage.get(STREAK_KEY));
  // Hito (T4): solo si esta sesión lo CRUZÓ (no se re-celebra 7 días seguidos). El hito
  // convertirse en hábito compartido es lo que tracciona el bucle: se puede compartir.
  const milestone = MILESTONES.find(m => streak >= m && streakAtStart < m) || 0;
  const acc = done ? Math.round((firstTry / done) * 100) : 0;
  b.innerHTML = `
    <div class="study-end">
      <div class="study-end-icon${done ? ' is-done' : ''}">
        <svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="28" class="study-ring-track"/><circle cx="32" cy="32" r="28" class="study-ring-fill"/></svg>
        ${icon('check', { size: 30 })}
      </div>
      <h2>${done ? t('¡Repaso completado!') : t('Nada que repasar')}</h2>
      <p>${done
        ? t('Has repasado <b>{n}</b> tarjeta{s}. La repetición espaciada hará el resto.', { n: done, s: done === 1 ? '' : 's' })
        : t('No hay tarjetas vencidas ahora mismo. Vuelve mañana.')}</p>
      ${done ? `<div class="study-stats">
        <div><b>${acc}%</b><span>${t('a la primera')}</span></div>
        <div><b>${fmtTime(Date.now() - startedAt)}</b><span>${t('de sesión')}</span></div>
        <div><b>${streak}</b><span>${t('días de racha')}</span></div>
      </div>` : ''}
      ${done && streak ? `<div class="study-streak">${t('🔥 Racha de <b>{n}</b> día{s} estudiando', { n: streak, s: streak === 1 ? '' : 's' })}</div>` : ''}
      ${milestone ? `<div class="study-milestone" role="status">
        <span class="study-milestone-flame" aria-hidden="true">🔥</span>
        <div class="study-milestone-txt"><h3>${t('¡{n} días de racha!', { n: milestone })}</h3>
          <p>${t('La constancia ya es un hábito. Presúmelo.')}</p></div>
        <button class="study-share">${icon('share', { size: 15 })} ${t('Compartir')}</button>
      </div>` : ''}
      <div class="study-end-charts">
        <div><h3>${t('Tu racha')}</h3>${heatmapHtml()}</div>
        <div><h3>${t('Próximos días')}</h3><div class="study-forecast-slot"></div></div>
      </div>
      ${held.length ? `<p class="study-held">${t('Quedan <b>{n}</b> tarjeta{s} nueva{s} fuera del tope de hoy.', { n: held.length, s: held.length === 1 ? '' : 's' })}</p>` : ''}
    </div>`;
  forecastHtml().then((html) => {
    const slot = b.querySelector('.study-forecast-slot');
    if (slot) slot.innerHTML = html;
  });
  const oneBook = sessionBooks.size === 1 ? [...sessionBooks][0] : null;
  b.querySelector('.study-share')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const book = oneBook ? await Store.getBook(oneBook).catch(() => null) : null;
      await shareStreak({ streak: milestone, bookTitle: book?.title, cover: book?.cover });
    } finally { btn.disabled = false; }
  });
  // El tope de nuevas es una recomendación, no una cárcel: quien quiera seguir, sigue.
  f.innerHTML = `<div class="study-end-actions">
    ${held.length ? `<button class="primary-btn study-more-new">${t('Seguir con {n} nueva{s}', { n: held.length, s: held.length === 1 ? '' : 's' })}</button>` : ''}
    ${done && oneBook ? `<button class="ai-ob-back study-read">${icon('book', { size: 15 })} ${t('Seguir leyendo')}</button>` : ''}
    <button class="${held.length ? 'ai-ob-back' : 'primary-btn'} study-flip">${t('Cerrar')}</button>
  </div>`;
  f.querySelector('.study-flip').addEventListener('click', close);
  f.querySelector('.study-read')?.addEventListener('click', () => {
    const id = oneBook;
    close();
    const p = new URLSearchParams();
    p.set('book', id);
    location.hash = p.toString();
  });
  f.querySelector('.study-more-new')?.addEventListener('click', () => {
    queue = held;                                  // ya venían barajadas de buildQueue
    held = [];
    renderCard();
  });
}

// ---- Número en el icono de la app (PWA instalada) --------------------------------
// «N tarjetas pendientes» en el propio icono: el recordatorio que no necesita notificaciones.
export async function syncBadge() {
  try {
    if (!('setAppBadge' in navigator)) return;
    const { cards } = await dueToday();
    if (cards) await navigator.setAppBadge(cards); else await navigator.clearAppBadge();
  } catch { /* sin permiso o sin soporte: el badge es un extra */ }
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

// F3 · Texto del pasaje que respalda la tarjeta, para enseñarlo SIN salir del repaso.
// La mayoría de los "ver en el libro" son "quiero releer esa frase", no "quiero abandonar
// la sesión"; con el pasaje delante, el salto pasa a ser la excepción.
//
// La fuente es el libro segmentado (`bookText`), no Retrieval: la cola diaria cruza libros
// y ninguno tiene por qué estar abierto ni indexado. Se cachea el mapa entero por libro
// —una pasada por el texto anotado— y se suelta al cerrar la sesión, que si no serían
// varios MB retenidos por libro repasado.
async function passagesFor(bookId) {
  if (!passageCache.has(bookId)) {
    const rec = await DB.get('bookText', bookId);
    const map = new Map();
    for (const line of (rec?.annotatedText || '').split('\n')) {
      const m = /^\[\[(a\d+)\]\]\s*(.*)$/.exec(line);
      if (m) map.set(m[1], m[2]);
    }
    passageCache.set(bookId, map);
  }
  return passageCache.get(bookId);
}

// Segmenta el libro en este dispositivo si aún no lo está. El sync mueve mazos entre
// dispositivos pero NO el libro segmentado (bookText/anchors): una tarjeta llegada por sync
// tiene `src` pero aquí no hay anclas — ni pasaje (F3) ni salto a la fuente (F2). La
// segmentación es local y barata (parsea el EPUB/PDF sin IA) y el resultado persiste, así
// que se regenera a demanda la primera vez que hace falta y queda para siempre.
async function ensureSegmented(bookId, onStatus) {
  if (!bookId) return false;
  if (await DB.loadSegmented(bookId)) {
    anchorsCache.delete(bookId); passageCache.delete(bookId);
    return true;
  }
  if (segInFlight.has(bookId)) return segInFlight.get(bookId);
  const job = (async () => {
    try {
      const record = await Store.getBook(bookId);
      if (!record || !Store.hasFile(record)) return false;
      onStatus?.(t('Preparando el libro…'));
      const buf = record.file instanceof ArrayBuffer ? record.file.slice(0) : await record.file.arrayBuffer();
      let seg;
      if (record.format === 'pdf') {
        const pdfjs = await loadPdfJs();
        const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
        try { seg = await segmentPdf(doc, onStatus); } finally { doc.destroy(); }
      } else {
        const ePub = await loadEpubJs();
        const book = ePub(buf);
        try { seg = await segmentBook(book, onStatus); } finally { book.destroy?.(); }
      }
      await DB.saveSegmented(bookId, record.title, seg);
      anchorsCache.delete(bookId); passageCache.delete(bookId);
      return true;
    } catch { return false; }
  })();
  segInFlight.set(bookId, job);
  try { return await job; } finally { segInFlight.delete(bookId); }
}

// Salta a la página/CFI de origen de la tarjeta vía el deep-link del router
// (`#book=<id>&loc=<cfi|página>`): el mismo camino abre el libro si no está abierto
// (la cola global cruza libros) o solo reposiciona si ya lo está. El id del mazo y el
// de la biblioteca son el mismo hash del archivo.
// NUNCA silencioso: si falta el dato de origen lo genera (ensureSegmented); si aun así
// no hay ancla exacta abre el libro sin posición; si el fichero no está aquí avisa.
async function goToSource(deck, card, btn) {
  if (!deck.bookId) { toast({ message: t('Esta tarjeta no tiene libro de origen') }); return; }
  if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }
  try {
    let a = (await anchorsFor(deck.bookId)).get(card.src);
    if (!a && await ensureSegmented(deck.bookId)) a = (await anchorsFor(deck.bookId)).get(card.src);
    const loc = a ? (a.cfi ?? a.href ?? a.page) : null;
    if (loc == null) {
      const record = await Store.getBook(deck.bookId);
      if (!record || !Store.hasFile(record)) {
        toast({ message: t('El fichero de este libro no está en este dispositivo') });
        return;
      }
      // Sin ancla exacta (p. ej. PDF escaneado): mejor el libro entero que nada.
      minimize();
      if (onNavigateCb) onNavigateCb();
      location.hash = new URLSearchParams({ book: deck.bookId }).toString();
      toast({ message: t('No encontré la posición exacta; te abrí el libro') });
      return;
    }
    const p = new URLSearchParams();
    p.set('book', deck.bookId);
    p.set('loc', String(loc));
    // MINIMIZA, no cierra: al volver, la cola sigue donde estaba (F2). `onNavigate` sí se
    // llama —quien abrió la sesión debe apartar lo suyo (el modal de flashcards) para dejar
    // ver el libro—, pero se conserva por si se vuelve a saltar desde la misma sesión.
    minimize();
    if (onNavigateCb) onNavigateCb();
    location.hash = p.toString();             // dispara hashchange → el router abre/reposiciona
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('is-busy'); }
  }
}

