// analysis.js — la sección de Análisis: lo leído y lo estudiado (P25 F2, P44, P45).
//
// Responde cuatro preguntas, en este orden: ¿cuánto he leído?, ¿cuánto y cómo he estudiado?,
// ¿qué me queda de cada libro? y ¿qué se me viene? Más el ajuste del algoritmo a tu memoria
// cuando hay historia para ello. Investigación y criterios: docs/INVESTIGACION_ANALISIS.md.
//
// P45 · PERIODOS DE CALENDARIO, navegables: día, semana (lunes a domingo), mes, año y «todo»,
// con flechas para ir a los anteriores. Y un ÁMBITO: la biblioteca, una estantería o un libro.
// Con un libro, «todo» es su historia de principio a fin (curva de avance y resumen).
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
// La única comparación es CONTIGO MISMO y con el periodo anterior («+25 min que la semana
// pasada a estas alturas»): un periodo en curso se compara con el mismo tramo del anterior, no
// con el anterior entero. Nada de compararte con otros, rankings, histogramas de dificultad
// ni retención de un solo día. Cada bloque acaba en una acción (repasar, arreglar tarjetas,
// pausar las nuevas), no en un dato suelto.
import * as ReadingLog from './reading-log.js';
import * as Store from './library/store.js';
import * as Shelves from './library/shelves.js';
import * as Storage from './storage.js';
import * as AiDB from './ai/db.js';
import * as Srs from './ai/srs.js';
import * as Stats from './ai/study-stats.js';
import * as FsrsParams from './ai/fsrs-params.js';
import { canonicalOf } from './sync/aliases.js';
import { icon } from './ui/icons.js';
import { escapeHtml } from './ui/escape.js';
import { t, getLang } from './i18n.js';
import { loadAgentCss } from './css-loader.js';

const DAY_MS = 86400000;
const RANGES = [
  { id: 'day', label: () => t('Día') },
  { id: 'week', label: () => t('Semana') },
  { id: 'month', label: () => t('Mes') },
  { id: 'year', label: () => t('Año') },
  { id: 'all', label: () => t('Todo') },
];
const BOOKS_CAP = 5;   // P31 punto 1: con biblioteca grande el desglose no acaba

let overlay = null;
let range = 'week';
let offset = 0;            // 0 = el periodo actual; -1 el anterior…
let scope = null;          // null | { type: 'book' | 'shelf', id }
let picking = false;       // selector de ámbito abierto
let allBooks = false;      // «Ver todos» en el desglose
let optimizer = null;      // estado del ajuste del algoritmo: null | 'running' | resultado
let last = null;           // últimos datos pintados (para las acciones)

// ---- Periodos --------------------------------------------------------------

const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const fmtDate = (d, o) => d.toLocaleDateString(getLang(), o);

// Inicio y fin [from, to) de un periodo de calendario, en hora local. `first` = primer día con
// datos (solo para «todo»). Semanas de lunes a domingo. Puro: lo usan los tests.
export function period(kind, off = 0, now = Date.now(), first = null) {
  const today = startOfDay(now);
  let from, to;
  if (kind === 'day') { from = addDays(today, off); to = addDays(from, 1); }
  else if (kind === 'week') {
    const monday = addDays(today, -((today.getDay() + 6) % 7));
    from = addDays(monday, off * 7); to = addDays(from, 7);
  } else if (kind === 'month') {
    from = new Date(today.getFullYear(), today.getMonth() + off, 1);
    to = new Date(today.getFullYear(), today.getMonth() + off + 1, 1);
  } else if (kind === 'year') {
    from = new Date(today.getFullYear() + off, 0, 1);
    to = new Date(today.getFullYear() + off + 1, 0, 1);
  } else {
    from = first ? startOfDay(first) : today;
    to = addDays(today, 1);
  }
  const tomorrow = addDays(today, 1);
  const current = to > today && from <= today;
  const end = to < tomorrow ? to : tomorrow;      // hasta hoy: el futuro no cuenta
  const days = [];
  for (let d = new Date(from); d < end; d = addDays(d, 1)) days.push(ReadingLog.dayKey(d.getTime()));
  return { kind, offset: off, from: from.getTime(), to: to.getTime(), end: end.getTime(), current, days };
}

// El periodo con el que comparar: el anterior, recortado al mismo tramo si el actual va a
// medias (miércoles contra lunes–miércoles de la semana pasada). Sin comparación en «hoy»
// (el día va a medias y el registro no guarda horas) ni en «todo».
function previousOf(p, now) {
  if (p.kind === 'all' || (p.kind === 'day' && p.current)) return null;
  const prev = period(p.kind, p.offset - 1, now);
  if (!p.current) return prev;
  const span = Math.round((p.end - p.from) / DAY_MS);
  const end = addDays(new Date(prev.from), span).getTime();
  return { ...prev, end: Math.min(end, prev.to), days: prev.days.slice(0, span) };
}

function periodLabel(p) {
  const from = new Date(p.from);
  const yearOf = (d) => (d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {});
  if (p.kind === 'day') {
    if (p.offset === 0) return t('Hoy');
    if (p.offset === -1) return t('Ayer');
    return fmtDate(from, { weekday: 'long', day: 'numeric', month: 'short', ...yearOf(from) });
  }
  if (p.kind === 'week') {
    if (p.offset === 0) return t('Esta semana');
    if (p.offset === -1) return t('La semana pasada');
    const sun = addDays(from, 6);
    return t('{a} – {b}', { a: fmtDate(from, { day: 'numeric', month: 'short' }), b: fmtDate(sun, { day: 'numeric', month: 'short', ...yearOf(sun) }) });
  }
  if (p.kind === 'month') {
    const m = fmtDate(from, { month: 'long', ...yearOf(from) });
    return m.charAt(0).toUpperCase() + m.slice(1);
  }
  if (p.kind === 'year') return String(from.getFullYear());
  return t('Desde el {d}', { d: fmtDate(from, { day: 'numeric', month: 'short', year: 'numeric' }) });
}

function deltaLabel(p) {
  const cur = p.current;
  return {
    day: t('que el día anterior'),
    week: cur ? t('que la semana pasada a estas alturas') : t('que la semana anterior'),
    month: cur ? t('que el mes pasado a estas alturas') : t('que el mes anterior'),
    year: cur ? t('que el año pasado a estas alturas') : t('que el año anterior'),
  }[p.kind];
}

// Columnas de la gráfica: un día por columna en semana y mes; en el año, una por mes; en
// «todo», días si caben (≤ 62), meses si no y años con más de tres. Cada columna sabe a qué
// periodo lleva al tocarla (`go`).
function buckets(p, now) {
  if (p.kind === 'day') return [];
  const mk = (from, to, label, title, go) => ({ from, to, label, title, go });
  const out = [];
  const spanDays = Math.round((p.to - p.from) / DAY_MS);
  const today = startOfDay(now);
  const byDay = p.kind === 'week' || p.kind === 'month' || (p.kind === 'all' && spanDays <= 62);
  if (byDay) {
    const every = p.kind === 'week' ? 1 : p.kind === 'month' ? 5 : Math.ceil(spanDays / 8);
    let i = 0;
    for (let d = new Date(p.from); d < new Date(p.to); d = addDays(d, 1), i++) {
      const label = p.kind === 'week' ? fmtDate(d, { weekday: 'narrow' })
        : (i % every === 0 ? (p.kind === 'all' ? fmtDate(d, { day: 'numeric', month: 'short' }) : String(d.getDate())) : '');
      const dayOff = Math.round((startOfDay(d) - today) / DAY_MS);
      out.push(mk(d.getTime(), addDays(d, 1).getTime(), label, fmtDate(d, { weekday: 'short', day: 'numeric', month: 'short' }),
        { range: 'day', offset: dayOff }));
    }
    return out;
  }
  const years = (new Date(p.to).getFullYear() - new Date(p.from).getFullYear());
  if (p.kind === 'all' && years > 3) {
    for (let y = new Date(p.from).getFullYear(); y <= today.getFullYear(); y++) {
      out.push(mk(new Date(y, 0, 1).getTime(), new Date(y + 1, 0, 1).getTime(), String(y), String(y),
        { range: 'year', offset: y - today.getFullYear() }));
    }
    return out;
  }
  const start = new Date(new Date(p.from).getFullYear(), new Date(p.from).getMonth(), 1);
  for (let d = start; d < new Date(p.to); d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const off = (d.getFullYear() - today.getFullYear()) * 12 + d.getMonth() - today.getMonth();
    const label = p.kind === 'year' ? fmtDate(d, { month: 'narrow' })
      : (d.getMonth() === 0 || d.getTime() === start.getTime() ? fmtDate(d, { month: 'short', year: '2-digit' }) : fmtDate(d, { month: 'narrow' }));
    out.push(mk(d.getTime(), next.getTime(), label, fmtDate(d, { month: 'long', year: 'numeric' }), { range: 'month', offset: off }));
  }
  return out;
}

// ---- Datos -----------------------------------------------------------------

// Todo lo del periodo, en una sola pasada. `now` inyectable para los tests. `sc` (ámbito)
// filtra todo —lectura, estudio y carga— a un libro o a los libros de una estantería.
export async function collect({ range: kind = 'week', offset: off = 0 } = {}, now = Date.now(), sc = null) {
  FsrsParams.applyStored();
  const [records, books, shelves, notes, decksRaw, attemptsRaw] = await Promise.all([
    ReadingLog.getRecords().catch(() => []),
    Store.getAllBooks().catch(() => []),
    Store.getShelves().catch(() => []),
    AiDB.getAll('notes').catch(() => []),
    AiDB.getAllDecks().catch(() => []),
    AiDB.getAll('attempts').catch(() => []),
  ]);

  // Todo por id CANÓNICO: la biblioteca migra identidades (fichero → hash → canónico) y los
  // mazos, intentos y días de lectura pueden venir bajo un alias viejo del mismo libro.
  const cid = (id) => (id ? canonicalOf(id) : id);
  const meta = new Map();
  for (const b of books) meta.set(cid(b.id), b);
  let members = null;
  let scopeInfo = null;
  if (sc?.type === 'book') {
    members = new Set([cid(sc.id)]);
    scopeInfo = { ...sc, id: cid(sc.id), title: meta.get(cid(sc.id))?.title || t('Libro sin título') };
  } else if (sc?.type === 'shelf') {
    const shelf = shelves.find(s => s.id === sc.id);
    members = new Set(shelf ? Shelves.booksIn(books, shelf, now).map(b => cid(b.id)) : []);
    scopeInfo = { ...sc, title: shelf?.name || t('Estantería') };
  }
  const inScope = (id) => !members || members.has(cid(id));
  const legacyLog = members ? {} : Storage.get('study_log', {}) || {};

  // Primer día con datos, para «todo» y para no navegar hacia atrás al vacío.
  let first = null;
  const firstByBook = new Map();
  for (const rec of records) {
    for (const id of Object.keys(rec.books || {})) {
      const k = cid(id);
      if (!firstByBook.has(k) || rec.day < firstByBook.get(k)) firstByBook.set(k, rec.day);
      if (inScope(id) && (!first || rec.day < first)) first = rec.day;
    }
  }
  let firstTs = first ? new Date(`${first}T00:00:00`).getTime() : null;
  for (const a of attemptsRaw) if (a && inScope(a.bookId) && (!firstTs || a.ts < firstTs)) firstTs = a.ts;
  if (!members) {
    for (const k of Object.keys(legacyLog)) {
      const ts = Number(k) * DAY_MS + new Date(Number(k) * DAY_MS).getTimezoneOffset() * 60000;
      if (!firstTs || ts < firstTs) firstTs = ts;
    }
  }

  const p = period(kind, off, now, firstTs);
  const prevP = previousOf(p, now);
  const decks = (decksRaw || []).filter(d => d && !d.deleted && inScope(d.bookId));
  const attempts = (attemptsRaw || []).filter(a => a && inScope(a.bookId));
  const ranged = Stats.inRange(attempts, p.from, p.end);

  // ---- Lectura
  const readIn = (from, to) => {
    const out = new Map();
    for (const rec of records) {
      if (rec.day < from || rec.day > to) continue;
      for (const [id, v] of Object.entries(rec.books || {})) {
        if (!inScope(id)) continue;
        const k = cid(id);
        const cur = out.get(k) || { ms: 0, words: 0, units: 0, byDay: {} };
        const n = ReadingLog.unitCount(v);
        cur.ms += v.ms || 0; cur.words += v.words || 0; cur.units += n;
        const d = cur.byDay[rec.day] || (cur.byDay[rec.day] = { ms: 0, units: 0 });
        d.ms += v.ms || 0; d.units += n;
        out.set(k, cur);
      }
    }
    return out;
  };
  const sum = (m, f) => [...m.values()].reduce((n, v) => n + v[f], 0);
  const readBooks = readIn(p.days[0] || '9999', p.days[p.days.length - 1] || '0000');
  const byDay = {};
  for (const v of readBooks.values()) {
    for (const [day, x] of Object.entries(v.byDay)) {
      const d = byDay[day] || (byDay[day] = { ms: 0, units: 0 });
      d.ms += x.ms; d.units += x.units;
    }
  }
  const ms = sum(readBooks, 'ms');
  const series = p.days.map(day => ({ day, ms: byDay[day]?.ms || 0, units: byDay[day]?.units || 0 }));
  const prevRead = prevP && prevP.days.length ? readIn(prevP.days[0], prevP.days[prevP.days.length - 1]) : null;

  // ---- Estudio
  // El contador por día de `study_log` (este dispositivo) solo rellena los días de antes de
  // que existiera el registro de intentos, y solo en la vista global: no sabe de libros.
  const perDay = Stats.reviewsByDay(attempts, legacyLog);
  const studySeries = p.days.map((day) => ({ day, n: perDay[Srs.dayOf(new Date(`${day}T12:00:00`).getTime())] || 0 }));
  const hasCards = decks.some(d => (d.cards || []).some(c => c && !c.deleted));
  const study = {
    has: hasCards || attempts.length > 0,
    reviews: studySeries.reduce((n, s) => n + s.n, 0),
    activeDays: studySeries.filter(s => s.n > 0).length,
    ms: Stats.studyTime(ranged),
    prevMs: prevP ? Stats.studyTime(Stats.inRange(attempts, prevP.from, prevP.end)) : null,
    retention: Stats.trueRetention(ranged),
    practice: Stats.practiceSplit(ranged),
    calibration: Stats.calibration(ranged),
    series: studySeries,
  };

  // ---- Columnas
  const cols = buckets(p, now).map((b) => {
    let read = 0, n = 0;
    for (let d = new Date(b.from); d.getTime() < b.to; d = addDays(d, 1)) {
      const key = ReadingLog.dayKey(d.getTime());
      read += byDay[key]?.ms || 0;
      n += perDay[Srs.dayOf(d.getTime() + DAY_MS / 2)] || 0;
    }
    return { ...b, read, n, future: b.from > now };
  });

  // ---- Por libro: lo leído en el periodo + lo estudiado en él, con su memoria de hoy
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
  if (sc?.type === 'book') ids.add(scopeInfo.id);
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
  }).filter(b => b.ms || b.reviews || b.id === scopeInfo?.id)
    .sort((a, b) => b.ms - a.ms || b.reviews - a.reviews);

  // ---- Libros empezados (primer día de lectura del libro en el periodo) y terminados
  // (`finishedAt`, que se guarda desde P45: lo terminado antes no tiene fecha).
  const startKey = p.days[0] || '9999', endKey = p.days[p.days.length - 1] || '0000';
  const started = [...firstByBook.entries()].filter(([id, day]) => inScope(id) && day >= startKey && day <= endKey).length;
  const finished = books.filter(b => inScope(b.id) && b.finishedAt && b.finishedAt >= p.from && b.finishedAt < p.end).length;

  // ---- Historia de un libro (ámbito libro + «todo»)
  let history = null;
  if (sc?.type === 'book' && kind === 'all') {
    const id = scopeInfo.id;
    const days = series.filter(s => s.ms > 0);
    let acc = 0;
    const curve = series.map(s => ({ day: s.day, v: (acc += s.units) }));
    const b = meta.get(id);
    const startDay = firstByBook.get(id) || null;
    const words = readBooks.get(id)?.words || 0;
    history = {
      start: startDay,
      readDays: days.length,
      weeks: startDay ? Math.max(1, Math.ceil(p.days.length / 7)) : 0,
      wpm: ms ? Math.round(words / (ms / 60000)) : 0,
      finishedAt: b?.status === 'finished' ? b.finishedAt || null : null,
      progress: b?.progress || 0,
      curve,
    };
  }

  // ---- Lo que viene (solo si el periodo llega a hoy)
  const work = Stats.workload(decks, now);
  const pace = members ? null : Stats.typicalPace(Stats.reviewsByDay(attemptsRaw, legacyLog), now);

  return {
    period: p,
    label: periodLabel(p),
    canPrev: kind !== 'all' && !!firstTs && p.from > startOfDay(firstTs).getTime(),
    canNext: kind !== 'all' && !p.current,
    // Sin comparación si el periodo anterior es de antes del primer dato: «+108 h que el año
    // pasado» cuando el año pasado no había registro es falso, no una mejora.
    delta: prevP && firstTs && prevP.end > firstTs ? { label: deltaLabel(p), readMs: prevRead ? sum(prevRead, 'ms') : 0 } : null,
    days: p.days.length,
    scope: scopeInfo,
    ms, words: sum(readBooks, 'words'), units: sum(readBooks, 'units'),
    activeDays: series.filter(d => d.ms > 0).length,
    books: rows,
    series,
    cols,
    started, finished,
    history,
    highlights: countHighlights(p.from, p.end, inScope),
    notes: (notes || []).filter(n => !n.deleted && (n.ts || 0) >= p.from && (n.ts || 0) < p.end && inScope(n.bookId)).length,
    streak: p.current && !members ? Srs.currentStreak(Storage.get('study_streak'), now) : 0,
    study,
    work: { ...work, pace, overloaded: Stats.overloaded(work, pace) },
    fsrs: {
      reviews: FsrsParams.trainableReviews(FsrsParams.histories(attemptsRaw)),
      stored: FsrsParams.stored(),
    },
    pick: {
      shelves: shelves.filter(s => !s.deleted).map(s => ({ id: s.id, name: s.name })),
      books: [...firstByBook.keys(), ...new Set((decksRaw || []).filter(d => d && !d.deleted).map(d => cid(d.bookId)))]
        .filter((id, i, arr) => id && arr.indexOf(id) === i && meta.has(id))
        .map(id => ({ id, title: meta.get(id).title || t('Libro sin título') }))
        .sort((a, b) => a.title.localeCompare(b.title, getLang())),
    },
    attempts: attemptsRaw,
    decks: decksRaw,
  };
}

// Los subrayados viven en localStorage, una clave por libro (`highlights_<bookId>`), así
// que se cuentan barriendo el prefijo. Los tombstones no cuentan: un subrayado borrado no
// es trabajo hecho en el periodo.
function countHighlights(from, to, inScope) {
  let n = 0;
  const all = Storage.getAll('highlights_');
  for (const [key, list] of Object.entries(all)) {
    if (!Array.isArray(list) || !inScope(key.replace(/^highlights_/, ''))) continue;
    for (const h of list) if (h && !h.deleted && (h.timestamp || 0) >= from && (h.timestamp || 0) < to) n++;
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

// «+25 min que la semana pasada a estas alturas». Solo si alguno de los dos tiene algo.
function deltaLine(cur, prev, label) {
  if (prev == null || !label || (!cur && !prev)) return '';
  const diff = cur - prev;
  const txt = Math.abs(diff) < 60000
    ? t('Igual {que}', { que: label })
    : `${diff > 0 ? '+' : '−'}${humanTime(Math.abs(diff))} ${label}`;
  return `<div class="anal-delta${diff >= 60000 ? ' is-up' : ''}">${escapeHtml(txt)}</div>`;
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
    if (e.key === 'Escape' && overlay.style.display !== 'none') {
      if (picking) { picking = false; paint(); } else close();
    }
  });
  overlay.addEventListener('click', onClick);
  // La fila de un libro y las columnas con destino son botones para el teclado también.
  overlay.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-book], [data-go]')) { e.preventDefault(); onClick(e); }
  });
  return overlay;
}

// `bookId` / `shelfId`: abrir ya filtrado. Con un libro se abre su historia entera.
export async function open({ bookId = null, shelfId = null } = {}) {
  loadAgentCss().catch(e => console.warn('agent.css:', e));
  scope = bookId ? { type: 'book', id: bookId } : shelfId ? { type: 'shelf', id: shelfId } : null;
  if (bookId) { range = 'all'; offset = 0; }
  else offset = 0;
  allBooks = false;
  picking = false;
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
  if (!last) body.innerHTML = `<p class="anal-loading">${t('Contando…')}</p>`;
  const data = await collect({ range, offset }, Date.now(), scope);
  if (!isOpen()) return;
  last = data;
  const nothing = !data.ms && !data.study.has && !data.scope;
  body.innerHTML = renderHead(data) + (nothing ? renderEmpty() : renderData(data));
}

function setScope(next) {
  const wasBook = scope?.type === 'book';
  scope = next;
  allBooks = false;
  picking = false;
  // Un libro se mira entero por defecto (su historia); al salir de él, vuelta a la semana.
  if (next?.type === 'book') { range = 'all'; offset = 0; }
  else if (wasBook && range === 'all') { range = 'week'; offset = 0; }
  paint();
}

async function onClick(e) {
  const el = e.target.closest('[data-range], [data-act], [data-book], [data-go], [data-pick]');
  // Tocar fuera del selector de ámbito lo cierra (y la acción tocada sigue su curso).
  if (picking && !e.target.closest('.anal-pick-menu, [data-act="pick"]')) {
    picking = false;
    if (!el || !overlay.contains(el)) { paint(); return; }
  }
  if (!el || !overlay.contains(el)) return;
  if (el.dataset.range) { range = el.dataset.range; offset = 0; paint(); return; }
  if (el.dataset.go) { const g = JSON.parse(el.dataset.go); range = g.range; offset = g.offset; paint(); return; }
  if (el.dataset.pick) {
    const [type, ...rest] = el.dataset.pick.split(':');
    setScope(type === 'all' ? null : { type, id: rest.join(':') });
    return;
  }
  const act = el.dataset.act;
  if (!act && el.dataset.book) { setScope({ type: 'book', id: el.dataset.book }); return; }
  if (act === 'prev') { offset--; paint(); return; }
  if (act === 'next') { offset = Math.min(0, offset + 1); paint(); return; }
  if (act === 'now') { offset = 0; paint(); return; }
  if (act === 'pick') { picking = !picking; paint(); return; }
  if (act === 'all-books') { setScope(null); return; }
  if (act === 'more-books') { allBooks = true; paint(); return; }
  if (act === 'study-scope') {
    const sc = last?.scope;
    close();
    const Study = await import('./ai/study.js');
    Study.openToday({ scope: sc.type === 'book' ? { type: 'book', bookId: sc.id } : { type: 'shelf', shelfId: sc.id }, title: sc.title });
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

// Cabecera: ámbito (biblioteca, estantería o libro), rango y el periodo con sus flechas.
function renderHead(d) {
  const sc = d.scope;
  const scopeLabel = sc ? sc.title : t('Toda la biblioteca');
  const menu = picking ? `<div class="anal-pick-menu" role="listbox" aria-label="${t('Qué analizar')}">
      <button class="anal-pick-item${!sc ? ' is-on' : ''}" data-pick="all" role="option">${icon('library', { size: 'sm' })} ${t('Toda la biblioteca')}</button>
      ${d.pick.shelves.length ? `<div class="anal-pick-h">${t('Estanterías')}</div>` : ''}
      ${d.pick.shelves.map(s => `<button class="anal-pick-item${sc?.type === 'shelf' && sc.id === s.id ? ' is-on' : ''}" data-pick="shelf:${escapeHtml(s.id)}" role="option">${escapeHtml(s.name)}</button>`).join('')}
      ${d.pick.books.length ? `<div class="anal-pick-h">${t('Libros')}</div>` : ''}
      ${d.pick.books.map(b => `<button class="anal-pick-item${sc?.type === 'book' && sc.id === b.id ? ' is-on' : ''}" data-pick="book:${escapeHtml(b.id)}" role="option">${icon('book', { size: 'sm' })} ${escapeHtml(b.title)}</button>`).join('')}
    </div>` : '';
  const due = sc ? studyDue(d) : 0;
  const tabs = RANGES.map(r => {
    const label = r.label();
    return `<button class="anal-tab${r.id === range ? ' active' : ''}" role="tab" aria-selected="${r.id === range}" data-range="${r.id}">${label}</button>`;
  }).join('');
  const nav = d.period.kind === 'all' ? `<div class="anal-nav"><span class="anal-nav-l">${escapeHtml(d.label)}</span></div>` : `<div class="anal-nav">
      <button class="icon-btn anal-nav-btn" data-act="prev" ${d.canPrev ? '' : 'disabled'} title="${t('Periodo anterior')}" aria-label="${t('Periodo anterior')}">${icon('chevron-left', { size: 'md' })}</button>
      ${d.period.current ? `<span class="anal-nav-l">${escapeHtml(d.label)}</span>`
        : `<button class="anal-nav-l anal-nav-now" data-act="now" title="${t('Volver a ahora')}">${escapeHtml(d.label)}</button>`}
      <button class="icon-btn anal-nav-btn" data-act="next" ${d.canNext ? '' : 'disabled'} title="${t('Periodo siguiente')}" aria-label="${t('Periodo siguiente')}">${icon('chevron-right', { size: 'md' })}</button>
    </div>`;
  return `<div class="anal-head">
      <div class="anal-scope">
        <button class="anal-scope-pick${sc ? ' is-set' : ''}" data-act="pick" aria-expanded="${picking}">
          ${sc?.type === 'shelf' ? '' : icon(sc?.type === 'book' ? 'book' : 'library', { size: 'sm' })}
          <span class="anal-scope-t">${escapeHtml(scopeLabel)}</span>${icon('chevron-down', { size: 'sm' })}
        </button>
        ${sc ? `<button class="anal-scope-x" data-act="all-books" title="${t('Toda la biblioteca')}" aria-label="${t('Toda la biblioteca')}">${icon('xmark', { size: 'sm' })}</button>` : ''}
        ${due ? `<button class="btn btn--primary primary-btn anal-scope-study" data-act="study-scope">${icon('cards', { size: 'sm' })} ${sc.type === 'book' ? t('Repasar este libro ({n})', { n: due }) : t('Repasar esta estantería ({n})', { n: due })}</button>` : ''}
        ${menu}
      </div>
      <div class="anal-tabs" role="tablist">${tabs}</div>
      ${nav}
    </div>`;
}

// Vencidas del ámbito (las nuevas cuentan: es lo que abrirá «Repasar»).
function studyDue(d) {
  return d.work.dueNow + d.work.fresh;
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
  const showAhead = d.period.current;
  return `
    ${d.ms ? renderReading(d) : renderEmpty()}
    ${d.study.has ? renderStudy(d) : ''}
    ${renderBooks(d)}
    ${d.study.has && showAhead ? renderWork(d) : ''}
    ${d.study.has && !d.scope && showAhead ? renderFsrs(d) : ''}
    <p class="anal-note">${t('Solo cuenta lo que se leyó a ritmo humano: pasar páginas buscando algo, o dejar el libro abierto, no suma.')}</p>
  `;
}

function readingSub(d) {
  if (d.period.kind === 'day') return d.period.current ? t('leyendo hoy') : t('leyendo');
  return t('leyendo · {n} de {total} días', { n: d.activeDays, total: d.days });
}

function renderReading(d) {
  const long = d.period.kind === 'year' || d.period.kind === 'all';
  return `
    <section class="anal-sec">
      ${d.study.has ? `<h3 class="anal-sec-h">${t('Lectura')}</h3>` : ''}
      <div class="anal-hero">
        <div class="anal-hero-n">${escapeHtml(humanTime(d.ms))}</div>
        <div class="anal-hero-l">${readingSub(d)}</div>
        ${long && d.scope?.type !== 'book' ? `<div class="anal-books-line" title="${escapeHtml(t('Terminados: cuenta desde octubre de 2026, antes no se guardaba la fecha'))}">${escapeHtml(booksLine(d.started, d.finished))}</div>` : ''}
        ${d.delta ? deltaLine(d.ms, d.delta.readMs, d.delta.label) : ''}
      </div>
      ${d.history ? renderHistory(d) : ''}
      <div class="anal-tiles">
        ${tile(t('Páginas'), String(d.units))}
        ${tile(t('Subrayados'), String(d.highlights))}
        ${tile(t('Notas'), String(d.notes))}
      </div>
      ${renderColumns(d.cols, 'read', humanTime, t('Tiempo leído'), d)}
    </section>`;
}

function booksLine(a, b) {
  return `${a === 1 ? t('1 libro empezado') : t('{n} libros empezados', { n: a })} · ${b === 1 ? t('1 terminado') : t('{n} terminados', { n: b })}`;
}

// La historia de un libro: cuándo empezó, cuántos días y a qué ritmo, y la curva de avance
// (páginas acumuladas). Se ven los parones y los acelerones.
function renderHistory(d) {
  const h = d.history;
  if (!h.start) return '';
  const start = new Date(`${h.start}T12:00:00`);
  // El inicio ya lo dice la cabecera («Desde el…») y los días leídos, la línea del héroe: aquí
  // solo lo que no está en pantalla.
  const bits = [
    t('a lo largo de {w} semanas', { w: h.weeks }),
    h.wpm ? t('{n} palabras/min', { n: h.wpm }) : '',
    h.finishedAt ? t('terminado en {n} días', { n: Math.max(1, Math.round((startOfDay(h.finishedAt) - startOfDay(start)) / DAY_MS) + 1) })
      : h.progress ? t('vas por el {p}%', { p: Math.round(h.progress) }) : '',
  ].filter(Boolean);
  const pts = h.curve;
  const max = pts.length ? pts[pts.length - 1].v : 0;
  let svg = '';
  if (pts.length > 1 && max > 0) {
    const W = 300, H = 80;
    const xy = pts.map((q, i) => `${((i / (pts.length - 1)) * W).toFixed(1)},${(H - (q.v / max) * H).toFixed(1)}`);
    svg = `<div class="anal-curve" role="img" aria-label="${escapeHtml(t('Avance: {n} páginas en total', { n: max }))}">
      <div class="anal-chart-h">${t('Avance')} <span class="anal-faint">· ${t('{n} pág.', { n: max })}</span></div>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <polygon class="anal-curve-area" points="0,${H} ${xy.join(' ')} ${W},${H}"/>
        <polyline class="anal-curve-line" points="${xy.join(' ')}"/>
      </svg>
      <div class="anal-curve-x"><span>${escapeHtml(fmtDate(new Date(`${pts[0].day}T12:00:00`), { day: 'numeric', month: 'short' }))}</span><span>${escapeHtml(fmtDate(new Date(`${pts[pts.length - 1].day}T12:00:00`), { day: 'numeric', month: 'short' }))}</span></div>
    </div>`;
  }
  return `<p class="anal-history">${bits.map(escapeHtml).join(' · ')}</p>${svg}`;
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
  const sub = d.period.kind === 'day'
    ? (d.period.current ? t('repasando hoy') : t('repasando'))
    : t('repasando · {n} de {total} días', { n: s.activeDays, total: d.days });
  return `<section class="anal-sec anal-study">
    <h3 class="anal-sec-h">${t('Estudio')}</h3>
    <div class="anal-hero anal-hero--sm">
      <div class="anal-hero-n">${escapeHtml(humanTime(s.ms))}</div>
      <div class="anal-hero-l">${sub}</div>
      ${d.delta ? deltaLine(s.ms, s.prevMs, d.delta.label) : ''}
    </div>
    <div class="anal-tiles">
      ${tile(t('Repasos'), String(s.reviews))}
      ${d.streak ? tile(t('Racha'), t('{n} d', { n: d.streak })) : ''}
      ${tile(t('Practicado'), String(s.practice.practiced), t('Escribiendo la respuesta o con un ejercicio'))}
      ${tile(t('Solo girar'), String(s.practice.revealed), t('Girando la tarjeta y poniéndose nota'))}
    </div>
    ${renderRetention(s.retention)}
    ${renderCalibration(s.calibration)}
    ${renderColumns(d.cols, 'n', (n) => t('{n} repasos', { n }), t('Repasos'), d)}
  </section>`;
}

// Columnas, una sola serie (por eso no hay leyenda: el título ya dice qué es). La altura es
// proporcional al MÁXIMO del periodo, no a un tope fijo: lo que se compara aquí son las
// columnas entre sí. Solo lleva cifra la más alta — un número sobre cada columna es ruido
// que nadie lee, y el resto lo da el tooltip. Sin gráfica en el rango DIARIO: una columna no
// compara nada. Tocar una columna lleva a ese día o ese mes.
function renderColumns(cols, key, fmt, title, d) {
  if (!cols.length) return '';
  const max = Math.max(...cols.map(c => c[key]));
  if (!max) return '';
  const top1 = cols.findIndex(c => c[key] === max);   // en un empate, solo el primero lleva cifra
  const html = cols.map((c, i) => {
    // Un día sin actividad se queda VACÍO: un muñón de 2px al pie dice "poco" donde la
    // verdad es "nada", y los huecos son parte de lo que se viene a mirar.
    const v = c[key];
    const h = v ? Math.max(4, Math.round((v / max) * 100)) : 0;
    const top = i === top1 ? `<span class="anal-col-top">${escapeHtml(fmt(v))}</span>` : '';
    const go = c.future ? '' : ` data-go='${escapeHtml(JSON.stringify(c.go))}' role="button"`;
    return `<div class="anal-col${c.future ? ' is-future' : ''}" title="${escapeHtml(c.title)} · ${escapeHtml(fmt(v))}"
        tabindex="0" aria-label="${escapeHtml(c.title)}: ${escapeHtml(fmt(v))}"${go}>
      ${top}
      <div class="anal-col-track">${h ? `<div class="anal-col-fill" style="height:${h}%"></div>` : ''}</div>
      <span class="anal-col-x">${escapeHtml(c.label)}</span>
    </div>`;
  }).join('');
  const per = { week: t('por día'), month: t('por día'), year: t('por mes') }[d.period.kind]
    || (cols.length && cols[0].go.range === 'day' ? t('por día') : cols[0]?.go.range === 'month' ? t('por mes') : t('por año'));
  const full = `${title} ${per}`;
  return `<div class="anal-chart" role="img" aria-label="${escapeHtml(full)}">
    <div class="anal-chart-h">${escapeHtml(full)}</div>
    <div class="anal-cols">${html}</div>
  </div>`;
}

// ¿Qué me queda de cada libro? Lo leído y lo repasado en el periodo, y lo que se recuerda HOY
// de sus tarjetas. Tocar la fila filtra la pantalla a ese libro.
function renderBooks(d) {
  if (d.scope?.type === 'book') return renderBookMemory(d);
  if (!d.books.length) return '';
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
  const b = d.books.find(x => x.id === d.scope.id);
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
