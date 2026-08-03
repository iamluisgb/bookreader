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
import * as Shelves from '../library/shelves.js';
import { icon } from '../ui/icons.js';
import { escapeHtml } from '../ui/escape.js';
import { confirmBox } from '../ui/dialog.js';
import { ensurePro } from '../ui/paywall.js';

// Racha de estudio (F3): {count, lastDay}, global de la app (no por libro).
const STREAK_KEY = 'study_streak';
// Tope de tarjetas NUEVAS por sesión (P24 F1). Configurable en Ajustes → Aplicación;
// 0 = sin tope.
const NEW_LIMIT_KEY = 'study_new_limit';
export const DEFAULT_NEW_LIMIT = 20;
const UNDO_DEPTH = 30;

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

// `decks`: mazos a repasar (solo entran sus tarjetas vencidas, en orden de mazo).
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
  flipped = false;
  editing = false;

  overlay = document.createElement('div');
  overlay.id = 'ai-study';
  overlay.className = 'ai-onboarding';
  overlay.innerHTML = `
    <div class="ai-ob-card study-card" role="dialog" aria-modal="true" aria-label="${t('Modo Estudiar')}">
      <div class="study-head">
        <span class="study-title">${escapeHtml(title)}</span>
        <span class="study-left" aria-live="polite"></span>
        <div class="study-tools"></div>
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

export function isOpen() { return !!overlay && !minimized; }

// F2 · Saltar al libro MINIMIZA la sesión, no la mata. El scheduling ya se persistía tras
// cada tarjeta, pero la sesión no: `close()` vacía la cola, el contador y los "otra vez"
// re-encolados, así que releer una frase obligaba a reiniciar el repaso entero.
//
// La navegación es SPA (hashchange, sin recarga), así que basta con ocultar el overlay y
// dejar el estado en memoria. Un chip de vuelta lo hace visible.
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
  if (onCloseCb) { const cb = onCloseCb; onCloseCb = null; cb(); }
}

function onKey(e) {
  if (!overlay) return;
  // Editando: el teclado es del editor (Escape cancela la edición, no la sesión).
  if (editing) { if (e.key === 'Escape') { e.preventDefault(); renderCard(); } return; }
  if (e.key === 'Escape') { close(); return; }
  if ((e.key === 'z' || e.key === 'Z') && undoStack.length) { e.preventDefault(); undo(); return; }
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

// Barra de acciones sobre la tarjeta ACTUAL (P24 F3) + deshacer (F2). Vive en la cabecera
// porque debe estar disponible con la tarjeta boca abajo: una tarjeta mala se reconoce
// muchas veces desde el frente, y hasta ahora la única salida era cerrar la sesión, abrir
// el Studio, el mazo y la vista de revisión.
function renderTools() {
  const host = overlay?.querySelector('.study-tools');
  if (!host) return;
  const hasCard = !editing && !!queue.length;
  const btn = (act, ico, label) =>
    `<button class="icon-btn study-tool" data-act="${act}" title="${label}" aria-label="${label}">${icon(ico, { size: 15 })}</button>`;
  host.innerHTML =
    (undoStack.length ? btn('undo', 'undo', t('Deshacer la última nota')) : '') +
    (hasCard ? btn('edit', 'pencil', t('Editar la tarjeta')) : '') +
    (hasCard ? btn('suspend', 'eye-off', t('Suspender: no volver a mostrarla')) : '') +
    (hasCard ? btn('delete', 'trash', t('Borrar la tarjeta')) : '');
  host.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'undo') undo();
    if (b.dataset.act === 'edit') renderEditor();
    if (b.dataset.act === 'suspend') suspendCurrent();
    if (b.dataset.act === 'delete') deleteCurrent();
  };
}

function renderCard() {
  const b = overlay?.querySelector('.study-body');
  const f = overlay?.querySelector('.study-foot');
  const left = overlay?.querySelector('.study-left');
  if (!b || !f) return;
  editing = false;

  if (!queue.length) { renderDone(b, f, left); renderTools(); return; }
  left.textContent = t('{n} pendiente{s}', { n: queue.length, s: queue.length === 1 ? '' : 's' });

  const { deck, idx } = queue[0];
  const card = deck.cards[idx];
  flipped = false;
  b.innerHTML = `
    <div class="study-deckname">${escapeHtml(deck.name || deck.scope || t('Mazo'))}</div>
    ${leechHtml(card)}
    <div class="study-q">${frontHtml(card)}</div>
    <div class="study-a" hidden></div>`;
  f.innerHTML = `<button class="primary-btn study-flip">${t('Mostrar respuesta')} <kbd>${t('espacio')}</kbd></button>`;
  f.querySelector('.study-flip').addEventListener('click', flip);
  renderTools();
}

// Aviso de leech: no suspende sola: propone el arreglo que casi siempre es el bueno.
function leechHtml(card) {
  if (!Srs.isLeech(card)) return '';
  return `<div class="study-leech">${icon('warning', { size: 14 })}
    <span>${t('La has fallado {n} veces. Suele ser señal de que la tarjeta está mal formulada, no de que el tema sea difícil: edítala o suspéndela.', { n: card.srs.lapses })}</span>
  </div>`;
}

// ---- Editar / suspender / borrar la tarjeta actual (P24 F3) ---------------------

// Editor inline: los mismos dos campos de la vista de revisión, pero sin salir del repaso.
// En cloze se edita el TEXTO CRUDO (con {{c1::…}}), que es justo lo que hay que corregir.
function renderEditor() {
  if (!queue.length) return;
  const b = overlay?.querySelector('.study-body');
  const f = overlay?.querySelector('.study-foot');
  if (!b || !f) return;
  editing = true;
  const { deck, idx } = queue[0];
  const card = deck.cards[idx];
  b.innerHTML = `
    <div class="study-deckname">${escapeHtml(deck.name || deck.scope || t('Mazo'))}</div>
    <div class="study-edit">
      <label class="fc-label">${card.type === 'cloze' ? t('Frase con huecos') : t('Pregunta')}</label>
      <div class="fc-front study-edit-f" contenteditable="true" spellcheck="false">${escapeHtml(card.front)}</div>
      <label class="fc-label">${card.type === 'cloze' ? t('Extra (opcional)') : t('Respuesta')}</label>
      <div class="fc-back study-edit-b" contenteditable="true" spellcheck="false">${escapeHtml(card.back || '')}</div>
    </div>`;
  f.innerHTML = `
    <div class="study-editbar">
      <button class="ai-ob-back study-edit-cancel">${t('Cancelar')}</button>
      <button class="primary-btn study-edit-save">${t('Guardar')}</button>
    </div>`;
  f.querySelector('.study-edit-cancel').addEventListener('click', renderCard);
  f.querySelector('.study-edit-save').addEventListener('click', () => {
    const front = b.querySelector('.study-edit-f').innerText.trim();
    if (!front) return;                                   // sin frente no hay tarjeta
    patchCurrent({ front, back: b.querySelector('.study-edit-b').innerText.trim() });
    renderCard();
  });
  b.querySelector('.study-edit-f').focus();
  renderTools();
}

// Escribe un parche en la tarjeta actual y lo persiste (array COMPLETO, tombstones
// incluidos: updateDeck lee lo ausente como borrado).
function patchCurrent(patch) {
  const { deck, idx } = queue[0];
  deck.cards[idx] = { ...deck.cards[idx], ...patch };
  if (deck.id) DB.updateDeck(deck.id, { cards: deck.cards });
}

// Saca de la cola TODAS las entradas de una tarjeta (la actual puede estar re-encolada
// por un "otra vez" anterior).
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
  // Tombstone EN SU SITIO (no se quita del array): los índices de la cola apuntan a
  // posiciones, y compactar el array las desalinearía a media sesión.
  patchCurrent({ front: '', back: '', deleted: true, deletedAt: Date.now() });
  dropFromQueue(deck, idx);
  renderCard();
}

// ---- Deshacer la última nota (P24 F2) -------------------------------------------

// La nota se persiste al instante y las teclas 1-4 están pegadas: pulsar "fácil" en la que
// no era condena esa tarjeta a no volver en meses, y hasta ahora no había vuelta atrás.
// Se guarda la cola ENTERA (no solo la tarjeta) porque "otra vez" la re-encola: restaurar
// solo el estado SRS dejaría la sesión con una repetición fantasma.
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
  queue = u.queue;
  done = u.done;
  renderCard();
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

  // El pasaje que respalda la tarjeta, debajo de la respuesta. Se pide en asíncrono para
  // no retrasar el volteo (la BD puede tardar unos ms); si al llegar ya se ha pasado de
  // tarjeta, no se pinta.
  if (card.src && deck.bookId) showPassage(deck.bookId, card);

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

async function showPassage(bookId, card) {
  let text = '';
  try {
    text = (await passagesFor(bookId)).get(card.src) || '';
  } catch { /* IDB no disponible: sin pasaje, el botón "ver en el libro" sigue ahí */ }
  if (!text || !overlay || !flipped) return;
  if (queue[0]?.deck.cards[queue[0].idx] !== card) return;   // ya se pasó de tarjeta
  const a = overlay.querySelector('.study-a');
  if (!a || a.querySelector('.study-passage')) return;
  const chapter = card.chapter ? `<span class="study-passage-ch">${escapeHtml(card.chapter)}</span>` : '';
  a.insertAdjacentHTML('beforeend',
    `<blockquote class="study-passage">${chapter}${escapeHtml(text)}</blockquote>`);
  a.hidden = false;
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
  // MINIMIZA, no cierra: al volver, la cola sigue donde estaba (F2). `onNavigate` sí se
  // llama —quien abrió la sesión debe apartar lo suyo (el modal de flashcards) para dejar
  // ver el libro—, pero se conserva por si se vuelve a saltar desde la misma sesión.
  minimize();
  if (onNavigateCb) onNavigateCb();
  location.hash = p.toString();             // dispara hashchange → el router abre/reposiciona
}

function gradeCurrent(rating) {
  if (!queue.length || editing) return;
  // Foto de la sesión ANTES de tocar nada: es lo que restaura "deshacer".
  pushUndo({
    queue: queue.slice(), done, deck: queue[0].deck, idx: queue[0].idx,
    srs: queue[0].deck.cards[queue[0].idx].srs, streak: Storage.get(STREAK_KEY),
  });
  const entry = queue.shift();
  const { deck, idx } = entry;
  deck.cards[idx] = { ...deck.cards[idx], srs: Srs.grade(deck.cards[idx].srs, rating) };
  // Se persiste TRAS CADA tarjeta (cerrar a media sesión no pierde nada) y se pasa el
  // array COMPLETO —tombstones incluidos— porque updateDeck interpreta lo ausente como
  // tarjeta borrada. El sello por tarjeta lo pone él.
  if (deck.id) DB.updateDeck(deck.id, { cards: deck.cards });
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
      ${held.length ? `<p class="study-held">${t('Quedan <b>{n}</b> tarjeta{s} nueva{s} fuera del tope de hoy.', { n: held.length, s: held.length === 1 ? '' : 's' })}</p>` : ''}
    </div>`;
  // El tope de nuevas es una recomendación, no una cárcel: quien quiera seguir, sigue.
  f.innerHTML = (held.length
    ? `<button class="primary-btn study-more">${t('Seguir con {n} nueva{s}', { n: held.length, s: held.length === 1 ? '' : 's' })}</button>`
    : '') + `<button class="${held.length ? 'ai-ob-back' : 'primary-btn'} study-flip">${t('Cerrar')}</button>`;
  f.querySelector('.study-flip').addEventListener('click', close);
  f.querySelector('.study-more')?.addEventListener('click', () => {
    queue = held;                                  // ya venían barajadas de buildQueue
    held = [];
    renderCard();
  });
}
