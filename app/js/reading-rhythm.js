// reading-rhythm.js — cuánto se leyó de cada libro, día a día (la gráfica apilada de Análisis).
//
// Desde la auditoría de Análisis (25-nov) la gráfica sigue el periodo de arriba: Análisis pasa
// `from`/`to` (los días del periodo) y agrupa las capas en sus columnas de calendario. `range`
// (30d/90d/all) y el suavizado quedan para quien quiera una tendencia móvil (y para los tests).
//
// Sale del MISMO registro que el resto del Análisis y que `reading_stats` del MCP
// (`reading-log.js`: filas por día y dispositivo con `ms`/`words` de tramos a ritmo plausible).
// Aquí no se mide nada nuevo: se suman las filas por libro y día, se suaviza y se agrupa.
//
// Decisiones, en el orden en que se aplican:
//   - Unidad: MINUTOS por defecto, que es lo medido. Las «páginas» son una ESTIMACIÓN
//     (palabras / WORDS_PER_PAGE) y la pantalla lo dice: un PDF escaneado y un EPUB no tienen
//     la misma página, así que la única página comparable entre libros es la inventada.
//   - Suavizado: media móvil de SMOOTH_DAYS días naturales hacia atrás, dividiendo siempre por
//     siete (un día sin leer es un cero, no un hueco). Usa los días de ANTES del rango para
//     que la curva no arranque desde cero el primer día de la ventana.
//   - Capas: los libros con más lectura en el rango, cada uno con su color; el resto va junto
//     en «Otros». Un bookId sin ficha en la biblioteca (libro borrado, o de otro dispositivo
//     que aún no ha llegado) va SIEMPRE a «Otros»: no hay título que poner y un «null» o un
//     hash en la leyenda es peor que agruparlo.
//   - Hasta MAX_LAYERS capas en total. Si los libros con título caben, todos llevan color; si
//     no, los MAX_LAYERS-1 primeros y «Otros» con el resto.
//
// Puro (sin DOM ni IndexedDB): recibe los registros de `ReadingLog.getRecords()`.
import { dayKey } from './reading-log.js';

export const WORDS_PER_PAGE = 300;
export const SMOOTH_DAYS = 7;
export const MAX_LAYERS = 5;
export const RANGES = ['30d', '90d', 'all'];
export const UNITS = ['min', 'pages'];
export const OTHER = '__other__';

function shift(day, n) {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return dayKey(d.getTime());
}

/** Días naturales de `from` a `to`, ambos incluidos ('YYYY-MM-DD'). */
export function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = shift(d, 1)) out.push(d);
  return out;
}

/** Media móvil hacia atrás de `n` días: el punto i promedia i-n+1..i (los que falten, cero). */
export function trailingMean(values, n = SMOOTH_DAYS, before = []) {
  const all = [...before, ...values];
  const off = before.length;
  const out = [];
  let acc = 0;
  for (let i = 0; i < all.length; i++) {
    acc += all[i];
    if (i >= n) acc -= all[i - n];
    if (i >= off) out.push(acc / n);
  }
  return out;
}

/**
 * @param {Array<{ day: string, books: Record<string, { ms?: number, words?: number }> }>} records
 * @param {{ range?: string, unit?: string, now?: number, from?: string, to?: string,
 *           cid?: (id: string) => string, inScope?: (id: string) => boolean,
 *           titleOf?: (id: string) => string|null }} [opts]
 */
export function rhythm(records, opts = {}) {
  const {
    range = '30d', unit = 'min', now = Date.now(),
    cid = (id) => id, inScope = () => true, titleOf = () => null,
  } = opts;
  const value = unit === 'pages' ? (v) => v.words / WORDS_PER_PAGE : (v) => v.ms / 60000;
  // `to` explícito: el último día del periodo mirado (nunca después de hoy).
  const today = dayKey(now);
  const to = opts.to && opts.to < today ? opts.to : today;

  // Libro → día → { ms, words }, sumando dispositivos y alias del mismo libro.
  const perBook = new Map();
  let first = null;
  for (const rec of Array.isArray(records) ? records : []) {
    if (!rec || typeof rec.day !== 'string' || rec.day > to) continue;
    for (const [rawId, v] of Object.entries(rec.books || {})) {
      if (!inScope(rawId)) continue;
      const ms = Number(v && v.ms) || 0;
      const words = Number(v && v.words) || 0;
      if (!ms && !words) continue;
      const id = cid(rawId);
      if (!perBook.has(id)) perBook.set(id, new Map());
      const days = perBook.get(id);
      const d = days.get(rec.day) || { ms: 0, words: 0 };
      d.ms += ms; d.words += words;
      days.set(rec.day, d);
      if (!first || rec.day < first) first = rec.day;
    }
  }

  const span = range === '90d' ? 90 : range === 'all' ? null : 30;
  const from = opts.from ? (opts.from > to ? to : opts.from)
    : span ? shift(to, -(span - 1)) : (first && first < to ? first : to);
  const days = daysBetween(from, to);
  const lead = daysBetween(shift(from, -(SMOOTH_DAYS - 1)), shift(from, -1));

  // Totales por libro en el rango, y orden por la unidad que se está mirando.
  const books = [];
  for (const [id, byDay] of perBook) {
    let total = 0, ms = 0, words = 0;
    for (const day of days) {
      const v = byDay.get(day);
      if (!v) continue;
      total += value(v); ms += v.ms; words += v.words;
    }
    if (total <= 0) continue;
    const title = titleOf(id);
    books.push({ id, title: title && String(title).trim() ? String(title) : null, total, ms, words, byDay });
  }
  books.sort((a, b) => b.total - a.total || (a.id < b.id ? -1 : 1));

  const named = books.filter(b => b.title);
  const rest = books.filter(b => !b.title);
  const fits = named.length <= MAX_LAYERS && !rest.length;
  const top = fits ? named : named.slice(0, MAX_LAYERS - 1);
  const others = fits ? [] : [...named.slice(MAX_LAYERS - 1), ...rest];

  const seriesOf = (list) => {
    const at = (day) => list.reduce((n, b) => { const v = b.byDay.get(day); return n + (v ? value(v) : 0); }, 0);
    const raw = days.map(at);
    return { raw, smooth: trailingMean(raw, SMOOTH_DAYS, lead.map(at)) };
  };

  // De abajo arriba: el libro más leído pegado al eje, «Otros» encima de todo.
  const layers = top.map((b, i) => ({
    id: b.id, title: b.title, color: i + 1, other: false, count: 1,
    total: b.total, ...seriesOf([b]),
  }));
  if (others.length) {
    layers.push({
      id: OTHER, title: null, color: 'other', other: true, count: others.length,
      members: others.map(b => b.id),
      total: others.reduce((n, b) => n + b.total, 0), ...seriesOf(others),
    });
  }

  const daily = days.map((_, i) => layers.reduce((n, l) => n + l.raw[i], 0));
  const stacked = days.map((_, i) => layers.reduce((n, l) => n + l.smooth[i], 0));
  return {
    range, unit, from, to, days,
    layers,
    daily,
    total: books.reduce((n, b) => n + b.total, 0),
    ms: books.reduce((n, b) => n + b.ms, 0),
    words: books.reduce((n, b) => n + b.words, 0),
    daysRead: daily.filter(v => v > 0).length,
    max: Math.max(0, ...daily, ...stacked),
  };
}

/** Tope «redondo» del eje, el primero por encima de `max` (pasos finos: con 1-2-5 un día de
 * 115 min dejaba el eje en 200 y la gráfica en la mitad de abajo). */
export function niceMax(max) {
  if (!(max > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}
