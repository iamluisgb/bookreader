// stats.mjs — `reading_stats`: agregados del registro de lectura que viaja en el layout.
//
// El registro son filas por DÍA y DISPOSITIVO (`${día}|${deviceId}`, P25 F3). Fusionarlas es
// unir, y leerlas es SUMAR: el mismo martes leído en el PC y en la tableta son dos filas con
// su propio `ms`/`words`/`units`. Aquí se suman y se tira el identificador del dispositivo
// (redact.mjs · sanitizeReadingDay): un desglose «por dispositivo» sería publicar el deviceId,
// que es justo lo que P28 prohíbe.
//
// Las cuentas son las mismas que hace la app (app/js/reading-log.js · summary): ms y palabras
// de tramos a ritmo plausible, y `units` (localizaciones de EPUB o páginas de PDF, ya contadas
// por el dispositivo que las leyó — la lista de unidades no viaja).

import { ToolError } from './errors.mjs';

/** Rangos aceptados, en el orden en que se documentan. */
export const RANGES = ['today', '7d', '30d', '90d', '365d', 'all'];
export const GROUP_BY = ['day', 'week', 'month'];
const RANGE_RE = /^(\d{1,4})d$/;

/** Día LOCAL en `YYYY-MM-DD` (igual que reading-log.js · dayKey: leer a las 23:50 es ese día). */
export function dayKey(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function shiftDays(day, delta) {
  const d = new Date(day + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  return dayKey(d);
}

/**
 * `range` → ventana de días. Acepta `today`, `Nd` (1..9999) y `all`.
 *
 * @param {string} [range]
 * @param {Date} [now]
 */
export function parseRange(range = '7d', now = new Date()) {
  const label = String(range || '7d').trim().toLowerCase();
  const to = dayKey(now);
  if (label === 'all') return { label, from: null, to, days: null };
  if (label === 'today') return { label, from: to, to, days: 1 };
  const m = RANGE_RE.exec(label);
  if (m) {
    const n = Number(m[1]);
    if (n < 1) throw new ToolError('Rango inválido: ' + label + '. Usa ' + RANGES.join(', ') + '.');
    return { label, from: n === 1 ? to : shiftDays(to, -(n - 1)), to, days: n };
  }
  throw new ToolError('Rango desconocido: «' + range + '». Usa ' + RANGES.join(', ') + '.');
}

/** Semana ISO (`2026-W39`) y mes (`2026-09`) como claves de agrupación, deterministas. */
export function bucketOf(day, groupBy) {
  if (groupBy === 'month') return day.slice(0, 7);
  if (groupBy === 'week') return isoWeek(day);
  return day;
}

function isoWeek(day) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3); // jueves de esta semana
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((d - firstThursday) / (7 * 86400000));
  return d.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

/**
 * Suma el registro de lectura en la ventana pedida.
 *
 * @param {Array<{ day: string, books: Record<string, { ms: number, words: number, units: number }> }>} days
 * @param {{ range?: string, bookId?: string|null, groupBy?: string, now?: Date,
 *           titleOf?: (bookId: string) => string|null }} [opts]
 */
export function aggregateReading(days, opts = {}) {
  const { bookId = null, groupBy = 'day', now = new Date(), titleOf = () => null } = opts;
  if (!GROUP_BY.includes(groupBy)) {
    throw new ToolError('Agrupación desconocida: «' + groupBy + '». Usa ' + GROUP_BY.join(', ') + '.');
  }
  const window = parseRange(opts.range, now);

  const totals = { ms: 0, words: 0, units: 0 };
  const byDay = new Map();
  const byBook = new Map();
  const readDays = new Set();

  for (const rec of Array.isArray(days) ? days : []) {
    if (!rec || typeof rec.day !== 'string') continue;
    if (window.from && rec.day < window.from) continue;
    if (rec.day > window.to) continue;
    for (const [id, v] of Object.entries(rec.books || {})) {
      if (bookId && id !== bookId) continue;
      const ms = Number(v && v.ms) || 0;
      const words = Number(v && v.words) || 0;
      const units = Number(v && v.units) || 0;
      if (!ms && !words && !units) continue;

      totals.ms += ms;
      totals.words += words;
      totals.units += units;
      readDays.add(rec.day);

      const key = bucketOf(rec.day, groupBy);
      const b = byDay.get(key) || { bucket: key, ms: 0, words: 0, units: 0 };
      b.ms += ms;
      b.words += words;
      b.units += units;
      byDay.set(key, b);

      const bk = byBook.get(id) || { bookId: id, title: titleOf(id), ms: 0, words: 0, units: 0 };
      bk.ms += ms;
      bk.words += words;
      bk.units += units;
      byBook.set(id, bk);
    }
  }

  return {
    range: { ...window, groupBy },
    totals: { ...totals, minutes: Math.round(totals.ms / 60000) },
    daysRead: readDays.size,
    byDay: [...byDay.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0)),
    byBook: [...byBook.values()].sort((a, b) => b.words - a.words || (a.bookId < b.bookId ? -1 : 1)),
  };
}
