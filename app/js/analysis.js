// analysis.js — la sección de Análisis: lo leído y lo estudiado (P25 F2, P44).
//
// Responde cuatro preguntas, en este orden: ¿cuánto he leído?, ¿cuánto y cómo he estudiado?,
// ¿qué me queda de cada libro? y ¿qué se me viene? Más el ajuste del algoritmo a tu memoria
// cuando hay historia para ello. Investigación y criterios: docs/INVESTIGACION_ANALISIS.md.
//
// Todo lo que enseña sale de datos que YA existen: el registro de lectura (`reading-log.js`),
// los subrayados (localStorage, con `timestamp`), las notas de la libreta, los intentos del
// repaso (store `attempts`, P42 F1) y el estado de cada tarjeta (`card.srs`). Aquí no se mide
// nada nuevo: se junta y se cuenta (las cuentas del estudio, en `ai/study-stats.js`).
//
// UNA SOLA CIFRA DE TIEMPO por actividad, y es la validada. La tentación es enseñar al lado
// el "tiempo con el libro abierto", que siempre es mayor y siempre es más halagador; puesto
// al lado, el usuario se queda con el grande y la sección deja de significar nada. Por eso el
// rato que el libro estuvo abierto sin leerse no aparece. Mismo criterio en el estudio: la
// retención real (lo que se recordó de lo que tocaba) y no la retrievabilidad media, que casi
// siempre es mayor.
//
// El desglose se ordena por TIEMPO y no por páginas: un libro técnico de 40 páginas puede
// haber costado más que una novela de 200, y lo que la pantalla responde es "en qué se te
// fue la semana".
//
// Lo que NO hace, a propósito (P31): compararte con otros, rankings, histogramas de
// dificultad, ni retención de un solo día. Cada bloque acaba en una acción (repasar este
// libro, arreglar sus tarjetas, pausar las nuevas), no en un dato suelto.
import * as ReadingLog from './reading-log.js';
import * as Store from './library/store.js';
import * as Storage from './storage.js';
import * as AiDB from './ai/db.js';
import * as Srs from './ai/srs.js';
import * as Stats from './ai/study-stats.js';
import * as FsrsParams from './ai/fsrs-params.js';
import { canonicalOf } from './sync/aliases.js';
import { icon } from './ui/icons.js';
import { escapeHtml } from './ui/escape.js';
import { t } from './i18n.js';
import { loadAgentCss } from './css-loader.js';

const DAY_MS = 86400000;
const RANGES = [
  { id: 'day', days: 1, label: () => t('Día') },
  { id: 'week', days: 7, label: () => t('Semana') },
  { id: 'month', days: 30, label: () => t('Mes') },
];
const BOOKS_CAP = 5;   // P31 punto 1: con biblioteca grande el desglose no acaba

let overlay = null;
let range = 'week';
let scope = null;          // id canónico del libro al que se filtra la pantalla (P31 punto 3)
let allBooks = false;      // «Ver todos» en el desglose
let optimizer = null;      // estado del ajuste del algoritmo: null | 'running' | resultado
let last = null;           // últimos datos pintados (para las acciones)

// ---- Datos -----------------------------------------------------------------

// Todo lo del rango, en una sola pasada. `now` inyectable para los tests. `bookId` filtra
// todo al libro (lectura, estudio y carga); sin él, la biblioteca entera.
export async function collect(days, now = Date.now(), bookId = null) {
  // Inicio del PRIMER día del rango (medianoche local), no "hace 7×24 h": los
  // subrayados y las notas se cuentan por día natural, igual que la lectura.
  const first = ReadingLog.dayKey(now - (days - 1) * DAY_MS).split('-').map(Number);
  const from = new Date(first[0], first[1] - 1, first[2]).getTime();
  const to = now + 1;
  FsrsParams.applyStored();

  const [read, books, notes, decksRaw, attemptsRaw] = await Promise.all([
    ReadingLog.summary(days, now),
    Store.getAllBooks().catch(() => []),
    AiDB.getAll('notes').catch(() => []),
    AiDB.getAllDecks().catch(() => []),
    AiDB.getAll('attempts').catch(() => []),
  ]);

  // Todo por id CANÓNICO: la biblioteca migra identidades (fichero → hash → canónico) y los
  // mazos, intentos y días de lectura pueden venir bajo un alias viejo del mismo libro.
  const cid = (id) => (id ? canonicalOf(id) : id);
  const scopeId = bookId ? cid(bookId) : null;
  const inScope = (id) => !scopeId || cid(id) === scopeId;
  const meta = new Map();
  for (const b of books) meta.set(cid(b.id), b);
  const decks = (decksRaw || []).filter(d => d && !d.deleted && inScope(d.bookId));
  const attempts = (attemptsRaw || []).filter(a => a && inScope(a.bookId));
  const ranged = Stats.inRange(attempts, from, to);

  // ---- Lectura
  const readBooks = new Map();
  for (const [id, v] of Object.entries(read.books)) {
    if (!inScope(id)) continue;
    const k = cid(id);
    const cur = readBooks.get(k) || { ms: 0, words: 0, units: 0, byDay: {} };
    cur.ms += v.ms; cur.words += v.words; cur.units += v.units;
    for (const [day, x] of Object.entries(v.byDay || {})) {
      const d = cur.byDay[day] || (cur.byDay[day] = { ms: 0, units: 0 });
      d.ms += x.ms; d.units += x.units;
    }
    readBooks.set(k, cur);
  }
  let ms = 0, words = 0, units = 0;
  const byDay = {};
  for (const v of readBooks.values()) {
    ms += v.ms; words += v.words; units += v.units;
    for (const [day, x] of Object.entries(v.byDay)) {
      const d = byDay[day] || (byDay[day] = { ms: 0, units: 0 });
      d.ms += x.ms; d.units += x.units;
    }
  }
  // Serie diaria COMPLETA, con los días a cero incluidos: una semana con dos días de
  // lectura son cinco huecos, y verlos es parte de la respuesta.
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = ReadingLog.dayKey(now - i * DAY_MS);
    series.push({ day, ms: byDay[day]?.ms || 0, units: byDay[day]?.units || 0 });
  }

  // ---- Estudio
  // El contador por día de `study_log` (este dispositivo) solo rellena los días de antes de
  // que existiera el registro de intentos, y solo en la vista global: no sabe de libros.
  const legacy = scopeId ? {} : Storage.get('study_log', {}) || {};
  const perDay = Stats.reviewsByDay(attempts, legacy);
  const studySeries = [];
  for (let i = days - 1; i >= 0; i--) {
    const ts = now - i * DAY_MS;
    studySeries.push({ day: ReadingLog.dayKey(ts), n: perDay[Srs.dayOf(ts)] || 0 });
  }
  const hasCards = decks.some(d => (d.cards || []).some(c => c && !c.deleted));
  const study = {
    has: hasCards || attempts.length > 0,
    reviews: studySeries.reduce((n, s) => n + s.n, 0),
    activeDays: studySeries.filter(s => s.n > 0).length,
    ms: Stats.studyTime(ranged),
    retention: Stats.trueRetention(ranged),
    practice: Stats.practiceSplit(ranged),
    calibration: Stats.calibration(ranged),
    series: studySeries,
  };

  // ---- Por libro: lo leído en el rango + lo estudiado en el rango, con su memoria de hoy
  const decksBy = new Map();
  for (const d of decks) {
    const k = cid(d.bookId);
    if (!k) continue;
    if (!decksBy.has(k)) decksBy.set(k, []);
    decksBy.get(k).push(d);
  }
  const reviewsBy = new Map();
  for (const a of ranged) {
    const k = cid(a.bookId);
    if (k) reviewsBy.set(k, (reviewsBy.get(k) || 0) + 1);
  }
  const ids = new Set([...readBooks.keys(), ...reviewsBy.keys()]);
  if (scopeId) ids.add(scopeId);
  const rows = [...ids].map((id) => {
    const r = readBooks.get(id);
    const bookDecks = decksBy.get(id);
    return {
      id,
      title: meta.get(id)?.title || t('Libro sin título'),
      author: meta.get(id)?.author || '',
      cover: meta.get(id)?.cover || '',
      ms: r?.ms || 0, words: r?.words || 0, units: r?.units || 0,
      reviews: reviewsBy.get(id) || 0,
      memory: bookDecks ? Stats.bookMemory(bookDecks, now) : null,
    };
  }).filter(b => b.ms || b.reviews || b.id === scopeId)
    .sort((a, b) => b.ms - a.ms || b.reviews - a.reviews);

  // ---- Lo que viene
  const work = Stats.workload(decks, now);
  const pace = scopeId ? null : Stats.typicalPace(Stats.reviewsByDay(attemptsRaw, legacy), now);

  return {
    days,
    scope: scopeId,
    ms, words, units,
    activeDays: series.filter(d => d.ms > 0).length,
    books: rows,
    series,
    highlights: countHighlights(from, scopeId),
    notes: (notes || []).filter(n => !n.deleted && (n.ts || 0) >= from && inScope(n.bookId)).length,
    streak: scopeId ? 0 : Srs.currentStreak(Storage.get('study_streak'), now),
    study,
    work: { ...work, pace, overloaded: Stats.overloaded(work, pace) },
    fsrs: {
      reviews: FsrsParams.trainableReviews(FsrsParams.histories(attemptsRaw)),
      stored: FsrsParams.stored(),
    },
    attempts: attemptsRaw,
    decks: decksRaw,
  };
}

// Los subrayados viven en localStorage, una clave por libro (`highlights_<bookId>`), así
// que se cuentan barriendo el prefijo. Los tombstones no cuentan: un subrayado borrado no
// es trabajo hecho esta semana.
function countHighlights(from, scopeId = null) {
  let n = 0;
  const all = Storage.getAll('highlights_');
  for (const [key, list] of Object.entries(all)) {
    if (!Array.isArray(list)) continue;
    if (scopeId && canonicalOf(key.replace(/^highlights_/, '')) !== scopeId) continue;
    for (const h of list) if (h && !h.deleted && (h.timestamp || 0) >= from) n++;
  }
  return n;
}

// ---- Formato ---------------------------------------------------------------

export function humanTime(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return t('{n} min', { n: min });
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? t('{h} h {m} min', { h, m }) : t('{h} h', { h });
}

const pct = (x) => `${Math.round(x * 100)}%`;

function dayLabel(day, days) {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  // En una semana caben las iniciales del día; en un mes, solo el número, y aun así
  // uno de cada cinco (ver renderColumns).
  return days <= 7
    ? date.toLocaleDateString(undefined, { weekday: 'narrow' })
    : String(d);
}

// ---- Pintado ---------------------------------------------------------------

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'analysis';
  overlay.className = 'appset';
  overlay.style.display = 'none';
  overlay.innerHTML = `
    <div class="appset-card anal-card" role="dialog" aria-modal="true" aria-label="${t('Análisis')}">
      <button class="appset-close" title="${t('Cerrar')}" aria-label="${t('Cerrar')}">${icon('xmark')}</button>
      <h2 class="appset-h2">${icon('chart', { size: 'lg' })} ${t('Análisis')}</h2>
      <div class="anal-body"></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.appset-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.style.display !== 'none') close();
  });
  overlay.addEventListener('click', onClick);
  // La fila de un libro es un botón para el teclado también.
  overlay.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-book]')) { e.preventDefault(); onClick(e); }
  });
  return overlay;
}

export async function open({ bookId = null } = {}) {
  loadAgentCss().catch(e => console.warn('agent.css:', e));
  scope = bookId ? canonicalOf(bookId) : null;
  allBooks = false;
  optimizer = null;
  ensureOverlay().style.display = 'flex';
  await paint();
}

export function close() {
  if (overlay) overlay.style.display = 'none';
}

export function isOpen() {
  return !!overlay && overlay.style.display !== 'none';
}

async function paint() {
  const body = overlay.querySelector('.anal-body');
  const days = RANGES.find(r => r.id === range).days;
  if (!last) body.innerHTML = `<p class="anal-loading">${t('Contando…')}</p>`;
  const data = await collect(days, Date.now(), scope);
  if (!isOpen()) return;
  last = data;
  const nothing = !data.ms && !data.study.has && !data.scope;
  body.innerHTML = renderTabs() + (nothing ? renderEmpty() : renderData(data));
}

async function onClick(e) {
  const el = e.target.closest('[data-range], [data-act], [data-book]');
  if (!el || !overlay.contains(el)) return;
  if (el.dataset.range) { range = el.dataset.range; paint(); return; }
  const act = el.dataset.act;
  if (!act && el.dataset.book) { scope = el.dataset.book; allBooks = false; paint(); return; }
  if (act === 'all-books') { scope = null; paint(); return; }
  if (act === 'more-books') { allBooks = true; paint(); return; }
  if (act === 'study-book') {
    const book = last?.books.find(b => b.id === scope);
    close();
    const Study = await import('./ai/study.js');
    Study.openToday({ scope: { type: 'book', bookId: scope }, title: book?.title || t('Libro sin título') });
    return;
  }
  if (act === 'fix-cards') {
    const deck = JSON.parse(el.dataset.deck || 'null');
    close();
    const Decks = await import('./decks.js');
    Decks.openDeck(deck.deckId, { focus: deck.idx });
    return;
  }
  if (act === 'pause-new' || act === 'resume-new') {
    const Study = await import('./ai/study.js');
    if (act === 'pause-new') Study.pauseNewToday(); else Study.resumeNewToday();
    paint();
    return;
  }
  if (act === 'fsrs-run') {
    optimizer = 'running';
    paint();
    optimizer = await FsrsParams.optimize(last.attempts, last.decks);
    if (isOpen()) paint();
    return;
  }
  if (act === 'fsrs-accept') { FsrsParams.accept(optimizer); optimizer = null; paint(); return; }
  if (act === 'fsrs-discard') { optimizer = null; paint(); return; }
  if (act === 'fsrs-reset') { FsrsParams.reset(); optimizer = null; paint(); }
}

function renderTabs() {
  return `<div class="anal-tabs" role="tablist">
    ${RANGES.map(r => `<button class="anal-tab${r.id === range ? ' active' : ''}"
      role="tab" aria-selected="${r.id === range}" data-range="${r.id}">${r.label()}</button>`).join('')}
  </div>`;
}

// Sin un minuto validado no se pinta un cero con gráfica al lado: se explica qué se cuenta.
// Es la primera vez que alguien ve la sección y la pregunta que trae es justo esa.
function renderEmpty() {
  return `<div class="anal-empty">
    ${icon('chart', { size: 'display' })}
    <p class="anal-empty-h">${t('Todavía no hay lectura que contar en este periodo')}</p>
    <p class="anal-empty-p">${t('Solo cuenta lo que se leyó a ritmo humano: pasar páginas buscando algo, o dejar el libro abierto, no suma.')}</p>
  </div>`;
}

function renderData(d) {
  return `
    ${d.scope ? renderScope(d) : ''}
    ${d.ms ? renderReading(d) : renderEmpty()}
    ${d.study.has ? renderStudy(d) : ''}
    ${renderBooks(d)}
    ${d.study.has ? renderWork(d) : ''}
    ${d.study.has && !d.scope ? renderFsrs(d) : ''}
    <p class="anal-note">${t('Solo cuenta lo que se leyó a ritmo humano: pasar páginas buscando algo, o dejar el libro abierto, no suma.')}</p>
  `;
}

// Filtro por libro: la pantalla entera mira a ese libro, con salida clara al total.
function renderScope(d) {
  const b = d.books.find(x => x.id === d.scope);
  const due = b?.memory?.due || 0;
  return `<div class="anal-scope">
    <button class="ai-ob-back anal-scope-back" data-act="all-books">${icon('chevron-left', { size: 'md' })}<span>${t('Todos los libros')}</span></button>
    <div class="anal-scope-t">${escapeHtml(b?.title || t('Libro sin título'))}</div>
    ${due ? `<button class="btn btn--primary primary-btn anal-scope-study" data-act="study-book">${icon('cards', { size: 'sm' })} ${t('Repasar este libro ({n})', { n: due })}</button>` : ''}
  </div>`;
}

function renderReading(d) {
  return `
    <section class="anal-sec">
      ${d.study.has ? `<h3 class="anal-sec-h">${t('Lectura')}</h3>` : ''}
      <div class="anal-hero">
        <div class="anal-hero-n">${escapeHtml(humanTime(d.ms))}</div>
        <div class="anal-hero-l">${d.days === 1 ? t('leyendo hoy') : t('leyendo · {n} de {total} días', { n: d.activeDays, total: d.days })}</div>
      </div>
      <div class="anal-tiles">
        ${tile(t('Páginas'), String(d.units))}
        ${tile(t('Subrayados'), String(d.highlights))}
        ${tile(t('Notas'), String(d.notes))}
      </div>
      ${renderColumns(d.series.map(s => ({ day: s.day, v: s.ms })), humanTime, t('Tiempo leído por día'), d.days)}
    </section>`;
}

// ¿Cuánto y cómo he estudiado? Tiempo y repasos, la retención real con su valla de N, lo
// practicado frente a lo solo girado y, si hay datos, la calibración.
function renderStudy(d) {
  const s = d.study;
  if (!s.reviews) {
    return `<section class="anal-sec anal-study">
      <h3 class="anal-sec-h">${t('Estudio')}</h3>
      <p class="anal-muted">${t('Sin repasos en este periodo.')}</p>
    </section>`;
  }
  return `<section class="anal-sec anal-study">
    <h3 class="anal-sec-h">${t('Estudio')}</h3>
    <div class="anal-hero anal-hero--sm">
      <div class="anal-hero-n">${escapeHtml(humanTime(s.ms))}</div>
      <div class="anal-hero-l">${d.days === 1 ? t('repasando hoy') : t('repasando · {n} de {total} días', { n: s.activeDays, total: d.days })}</div>
    </div>
    <div class="anal-tiles">
      ${tile(t('Repasos'), String(s.reviews))}
      ${d.streak ? tile(t('Racha'), t('{n} d', { n: d.streak })) : ''}
      ${tile(t('Practicado'), String(s.practice.practiced), t('Escribiendo la respuesta o con un ejercicio'))}
      ${tile(t('Solo girar'), String(s.practice.revealed), t('Girando la tarjeta y poniéndose nota'))}
    </div>
    ${renderRetention(s.retention)}
    ${renderCalibration(s.calibration)}
    ${renderColumns(s.series.map(x => ({ day: x.day, v: x.n })), (n) => t('{n} repasos', { n }), t('Repasos por día'), d.days)}
  </section>`;
}

function renderRetention(r) {
  const n = r.all.n;
  const head = `<div class="anal-ret-h">${t('Retención real')}</div>`;
  if (n < Stats.MIN_RETENTION_N) {
    return `<div class="anal-ret anal-ret--pending">${head}
      <p class="anal-muted">${t('Hacen falta {n} repasos de tarjetas ya aprendidas para medirla; llevas {k} en este periodo.', { n: Stats.MIN_RETENTION_N, k: n })}</p>
    </div>`;
  }
  const rate = r.all.rate;
  const note = rate < Stats.TARGET_RETENTION - 0.05
    ? t('Por debajo de lo que programa el algoritmo: suele ser señal de tarjetas mal formuladas o de demasiadas nuevas.')
    : rate > Stats.TARGET_RETENTION + 0.05
      ? t('Por encima del objetivo: repasas algo más de lo necesario.')
      : t('En línea con lo que programa el algoritmo.');
  const part = (label, b) => (b.n ? `<span>${escapeHtml(label)} <b>${pct(b.rate)}</b> <span class="anal-faint">(${b.n})</span></span>` : '');
  return `<div class="anal-ret">${head}
    <div class="anal-ret-row">
      <span class="anal-ret-n">${pct(rate)}</span>
      <span class="anal-ret-goal">${t('objetivo {p}', { p: pct(Stats.TARGET_RETENTION) })}</span>
    </div>
    <div class="anal-ret-split">${part(t('Jóvenes'), r.young)}${part(t('Maduras'), r.mature)}</div>
    <p class="anal-muted">${escapeHtml(note)}</p>
  </div>`;
}

// Calibración (F5): solo con intentos escritos juzgados suficientes. Es la única cifra que
// compara tu juicio con uno externo, y por eso dice algo que ninguna otra dice.
function renderCalibration(c) {
  if (c.n < Stats.MIN_CALIBRATION_N) return '';
  const gap = c.self - c.agent;
  const note = gap > 0.1
    ? t('Te das por bueno más de lo que el agente acepta: escribir la respuesta antes de girar ayuda a medirlo.')
    : t('Tu nota y la del agente coinciden: te calibras bien.');
  return `<div class="anal-calib">
    <div class="anal-ret-h">${t('¿Te calibras bien?')}</div>
    <p>${t('En tus respuestas escritas te pones «bien» en el <b>{a}</b>; el agente las da por buenas en el <b>{b}</b>.', { a: pct(c.self), b: pct(c.agent) })} <span class="anal-faint">(${c.n})</span></p>
    <p class="anal-muted">${escapeHtml(note)}</p>
  </div>`;
}

// `sub`: matiz pequeño junto a la cifra (p. ej. las nuevas al lado de las vencidas, que el
// botón «Repasar» cuenta juntas y la baldosa separa).
function tile(label, value, title = '', sub = '') {
  return `<div class="anal-tile"${title ? ` title="${escapeHtml(title)}"` : ''}><div class="anal-tile-l">${escapeHtml(label)}</div>
    <div class="anal-tile-v">${escapeHtml(value)}${sub ? ` <span class="anal-tile-sub">${escapeHtml(sub)}</span>` : ''}</div></div>`;
}

// Columnas por día, una sola serie (por eso no hay leyenda: el título ya dice qué es). La
// altura es proporcional al MÁXIMO del periodo, no a un tope fijo: lo que se compara aquí
// son los días entre sí. Solo lleva etiqueta el día más alto — un número sobre cada
// columna es ruido que nadie lee, y el resto lo da el tooltip. En el rango DIARIO no hay
// gráfica: una sola columna no compara nada, y la cifra del héroe ya es la respuesta.
function renderColumns(series, fmt, title, days) {
  if (days === 1) return '';
  const max = Math.max(...series.map(s => s.v));
  if (!max) return '';
  const every = days <= 7 ? 1 : 5;
  const top1 = series.findIndex(s => s.v === max);   // en un empate, solo el primero lleva cifra
  const cols = series.map((s, i) => {
    // Un día sin actividad se queda VACÍO: un muñón de 2px al pie dice "poco" donde la
    // verdad es "nada", y los huecos son parte de lo que se viene a mirar.
    const h = s.v ? Math.max(4, Math.round((s.v / max) * 100)) : 0;
    const label = (i % every === 0 || i === series.length - 1) ? dayLabel(s.day, days) : '';
    const top = i === top1 ? `<span class="anal-col-top">${escapeHtml(fmt(s.v))}</span>` : '';
    return `<div class="anal-col" title="${escapeHtml(s.day)} · ${escapeHtml(fmt(s.v))}"
        tabindex="0" aria-label="${escapeHtml(s.day)}: ${escapeHtml(fmt(s.v))}">
      ${top}
      <div class="anal-col-track">${h ? `<div class="anal-col-fill" style="height:${h}%"></div>` : ''}</div>
      <span class="anal-col-x">${escapeHtml(label)}</span>
    </div>`;
  }).join('');
  return `<div class="anal-chart" role="img" aria-label="${escapeHtml(title)}">
    <div class="anal-chart-h">${escapeHtml(title)}</div>
    <div class="anal-cols">${cols}</div>
  </div>`;
}

// ¿Qué me queda de cada libro? Lo leído y lo repasado en el rango, y lo que se recuerda HOY
// de sus tarjetas. Tocar la fila filtra la pantalla a ese libro.
function renderBooks(d) {
  if (!d.books.length || d.scope) return d.scope ? renderBookMemory(d) : '';
  const shown = allBooks ? d.books : d.books.slice(0, BOOKS_CAP);
  const rows = shown.map((b) => {
    const sub = [b.units ? t('{n} pág.', { n: b.units }) : '', b.reviews ? t('{n} repasos', { n: b.reviews }) : '']
      .filter(Boolean).join(' · ');
    return `
    <div class="anal-book" data-book="${escapeHtml(b.id)}" role="button" tabindex="0"
        aria-label="${escapeHtml(t('Ver el análisis de {t}', { t: b.title }))}">
      ${b.cover
        ? `<img class="anal-book-cover" src="${escapeHtml(b.cover)}" alt="">`
        : `<span class="anal-book-cover anal-book-cover--none">${icon('book', { size: 'sm' })}</span>`}
      <div class="anal-book-txt">
        <div class="anal-book-t">${escapeHtml(b.title)}</div>
        <div class="anal-book-s">${escapeHtml(sub)}</div>
        ${memoryLine(b.memory)}
      </div>
      <div class="anal-book-ms">${b.ms ? escapeHtml(humanTime(b.ms)) : ''}</div>
    </div>`;
  }).join('');
  const more = !allBooks && d.books.length > BOOKS_CAP
    ? `<button class="btn btn--secondary anal-more" data-act="more-books">${t('Ver todos ({n})', { n: d.books.length })}</button>`
    : '';
  return `<section class="anal-books"><div class="anal-chart-h">${t('Por libro')}</div>${rows}${more}</section>`;
}

// Recuerdo estimado de hoy: «recuerdas ~k de n tarjetas», con barra. Es la cifra que solo un
// lector con tarjetas puede dar, y la misma que enseña la biblioteca.
function memoryLine(m, big = false) {
  if (!m || !m.total) return '';
  const share = Math.round(m.share * 100);
  const problems = m.problems
    ? `<button class="anal-fix" data-act="fix-cards" data-deck="${escapeHtml(JSON.stringify(m.problemDeck))}">${t('{n} difíciles · Revisar', { n: m.problems })}</button>`
    : '';
  return `<div class="anal-mem${big ? ' anal-mem--big' : ''}">
    <span class="anal-mem-bar" aria-hidden="true"><span class="anal-mem-fill" style="width:${share}%"></span></span>
    <span class="anal-mem-l">${t('Recuerdas ~{k} de {n} tarjetas', { k: Math.round(m.known), n: m.total })}</span>
    ${problems}
  </div>`;
}

function renderBookMemory(d) {
  const b = d.books.find(x => x.id === d.scope);
  if (!b?.memory?.total) return '';
  return `<section class="anal-sec">
    <h3 class="anal-sec-h">${t('Lo que te queda')}</h3>
    ${memoryLine(b.memory, true)}
    <p class="anal-muted">${t('Estimación de hoy con la curva de olvido de cada tarjeta. Las que aún no has estudiado cuentan como no sabidas.')}</p>
  </section>`;
}

// ¿Qué se me viene? Vencidas hoy, los próximos 7 días y la carga media. Si lo que viene no
// cabe en el ritmo habitual, se avisa con UNA acción: pausar las nuevas de hoy.
function renderWork(d) {
  const w = d.work;
  if (!w.dueNow && !w.days.some(Boolean) && !w.load) return '';
  const max = Math.max(1, ...w.days);
  const now = Date.now();
  const names = [t('mañana')].concat([2, 3, 4, 5, 6, 7].map((k) =>
    new Date(now + k * DAY_MS).toLocaleDateString(undefined, { weekday: 'short' }).replace('.', '')));
  const cols = w.days.map((n, i) => `<div class="anal-fc-col" title="${escapeHtml(names[i])}: ${n}">
      <span class="anal-fc-n">${n || ''}</span>
      <span class="anal-fc-track"><span class="anal-fc-bar" style="height:${Math.round((n / max) * 100)}%"></span></span>
      <span class="anal-fc-day">${escapeHtml(names[i])}</span></div>`).join('');
  let warn = '';
  if (!d.scope) {
    // Import diferido de study.js sería asíncrono; la pausa es una clave de un día, se lee aquí.
    const paused = Storage.get('study_new_pause', null) === Srs.dayOf(now);
    if (paused) {
      warn = `<div class="anal-warn anal-warn--ok">${t('Nuevas en pausa hoy: el repaso se queda con lo que ya estabas aprendiendo.')}
        <button class="btn btn--secondary" data-act="resume-new">${t('Reanudar')}</button></div>`;
    } else if (w.overloaded) {
      warn = `<div class="anal-warn">${t('Lo que viene supera tu ritmo habitual (~{n} al día). Si no te da tiempo, pausar las nuevas de hoy evita que se acumule.', { n: Math.round(w.pace) })}
        <button class="btn btn--secondary" data-act="pause-new">${t('Pausar nuevas hoy')}</button></div>`;
    }
  }
  return `<section class="anal-sec anal-work">
    <h3 class="anal-sec-h">${t('Lo que viene')}</h3>
    <div class="anal-tiles">
      ${tile(t('Para hoy'), String(w.dueNow), '', w.fresh ? t('+ {n} nuevas', { n: w.fresh }) : '')}
      ${tile(t('Carga media'), t('~{n} al día', { n: Math.round(w.load) }), t('Repasos al día que añaden, de media, las tarjetas en rotación'))}
    </div>
    <div class="anal-chart-h anal-fc-h">${t('Próximos 7 días')}</div>
    <div class="anal-fc">${cols}</div>
    ${warn}
  </section>`;
}

// Tu memoria, tu algoritmo (F4). Solo cuando hay historia suficiente se ofrece el ajuste, y
// nunca se aplica solo: se enseña qué cambia y se elige.
function renderFsrs(d) {
  const f = d.fsrs;
  const head = `<h3 class="anal-sec-h">${t('Ajustado a tu memoria')}</h3>`;
  let body;
  if (optimizer === 'running') {
    body = `<p class="anal-muted" role="status">${t('Calculando con tu historial… (se queda en este dispositivo)')}</p>`;
  } else if (optimizer && optimizer.ok && optimizer.better) {
    const gain = Math.round((1 - optimizer.lossPersonal / optimizer.lossDefault) * 100);
    body = `<p>${t('Con tus parámetros, el algoritmo predice tu memoria un <b>{p}%</b> mejor.', { p: gain })}</p>
      <p class="anal-muted">${t('Próximos 30 días: ~{a} repasos con los de serie, ~{b} con los tuyos.', { a: optimizer.projDefault, b: optimizer.projPersonal })}</p>
      <div class="anal-actions">
        <button class="btn btn--primary primary-btn" data-act="fsrs-accept">${t('Usar los míos')}</button>
        <button class="btn btn--secondary" data-act="fsrs-discard">${t('Seguir con los de serie')}</button>
      </div>`;
  } else if (optimizer && optimizer.ok) {
    body = `<p class="anal-muted">${t('Con tu historial de momento no se mejora a los de serie. Se queda como está; prueba otra vez dentro de unas semanas.')}</p>`;
  } else if (optimizer && optimizer.reason === 'error') {
    body = `<p class="anal-muted">${t('No se pudo calcular: {e}', { e: optimizer.error || '' })}</p>`;
  } else if (f.stored) {
    const when = new Date(f.stored.ts).toLocaleDateString();
    body = `<p>${t('El repaso usa tus parámetros, calculados el {d} con {n} repasos.', { d: when, n: f.stored.reviews })}</p>
      <div class="anal-actions">
        ${f.reviews >= FsrsParams.MIN_REVIEWS ? `<button class="btn btn--secondary" data-act="fsrs-run">${t('Recalcular')}</button>` : ''}
        <button class="btn btn--secondary" data-act="fsrs-reset">${t('Volver a los de serie')}</button>
      </div>`;
  } else if (f.reviews < FsrsParams.MIN_REVIEWS) {
    body = `<p class="anal-muted">${t('Con {min} repasos de tarjetas empezadas aquí, el algoritmo se podrá ajustar a tu memoria. Llevas {n}.', { min: FsrsParams.MIN_REVIEWS, n: f.reviews })}</p>
      <span class="anal-mem-bar anal-fsrs-bar" aria-hidden="true"><span class="anal-mem-fill" style="width:${Math.round(Math.min(1, f.reviews / FsrsParams.MIN_REVIEWS) * 100)}%"></span></span>`;
  } else {
    body = `<p>${t('Ya hay historial para ajustar el algoritmo a cómo olvidas tú. Se calcula en este dispositivo y te enseña qué cambia antes de aplicarlo.')}</p>
      <div class="anal-actions"><button class="btn btn--primary primary-btn" data-act="fsrs-run">${t('Ajustar a mi memoria')}</button></div>`;
  }
  return `<section class="anal-sec anal-fsrs">${head}${body}</section>`;
}
