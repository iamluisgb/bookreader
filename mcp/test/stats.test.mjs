// stats.mjs — el registro de lectura son filas por día y dispositivo: aquí se suman, se
// ventanean y se agrupan sin que el identificador del dispositivo asome.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange, aggregateReading, bucketOf, dayKey } from '../src/stats.mjs';
import { ToolError } from '../src/errors.mjs';
import { READING_DAYS, BOOK_1, BOOK_2 } from './helpers/dataset.mjs';
import { sanitizeReadingDay } from '../src/redact.mjs';

const NOW = new Date('2026-09-23T12:00:00');
const days = READING_DAYS.map(sanitizeReadingDay);

test('parseRange: today, Nd y all', () => {
  assert.deepEqual(parseRange('today', NOW), { label: 'today', from: '2026-09-23', to: '2026-09-23', days: 1 });
  assert.deepEqual(parseRange('7d', NOW), { label: '7d', from: '2026-09-17', to: '2026-09-23', days: 7 });
  assert.deepEqual(parseRange('1d', NOW), { label: '1d', from: '2026-09-23', to: '2026-09-23', days: 1 });
  assert.deepEqual(parseRange('all', NOW), { label: 'all', from: null, to: '2026-09-23', days: null });
  // Por defecto, una semana.
  assert.equal(parseRange(undefined, NOW).label, '7d');
});

test('parseRange: un rango que no existe se explica, no se ignora', () => {
  assert.throws(() => parseRange('13m', NOW), ToolError);
  assert.throws(() => parseRange('marzo', NOW), /Rango desconocido/);
  assert.throws(() => parseRange('0d', NOW), /Rango inválido/);
});

test('dayKey es día LOCAL: leer a las 23:50 pertenece a ese día', () => {
  assert.equal(dayKey(new Date(2026, 8, 23, 23, 50)), '2026-09-23');
  assert.equal(dayKey(new Date(2026, 8, 23, 0, 5)), '2026-09-23');
});

test('all suma los dispositivos y las dos fuentes de tiempo', () => {
  const out = aggregateReading(days, { range: 'all', now: NOW, titleOf: (id) => (id === BOOK_1.id ? BOOK_1.title : null) });
  // 1200+1800+600+900 s = 4500 s de lectura; el martes 22 lleva 300 s del segundo libro.
  assert.deepEqual(out.totals, { ms: 4800000, words: 14400, units: 72, minutes: 80 });
  assert.equal(out.daysRead, 3);
  assert.deepEqual(
    out.byDay.map((d) => d.bucket),
    ['2026-09-20', '2026-09-21', '2026-09-22'],
  );
  // El mismo día en dos dispositivos es UN día y DOS filas sumadas.
  assert.deepEqual(out.byDay[1], { bucket: '2026-09-21', ms: 2400000, words: 7200, units: 36 });
  assert.deepEqual(
    out.byBook.map((b) => [b.bookId, b.words, b.title]),
    [
      [BOOK_1.id, 13500, BOOK_1.title],
      [BOOK_2.id, 900, null],
    ],
  );
});

test('la ventana recorta por día, incluidos los bordes', () => {
  const out = aggregateReading(days, { range: '2d', now: NOW });
  assert.deepEqual(out.range, { label: '2d', from: '2026-09-22', to: '2026-09-23', days: 2, groupBy: 'day' });
  assert.equal(out.totals.ms, 1200000);
  assert.equal(out.daysRead, 1);
});

test('un día futuro no entra: el registro no inventa lectura', () => {
  const out = aggregateReading(days, { range: 'all', now: new Date('2026-09-20T08:00:00') });
  assert.equal(out.totals.ms, 1200000);
  assert.equal(out.daysRead, 1);
});

test('bookId como escope del registro', () => {
  const out = aggregateReading(days, { range: 'all', now: NOW, bookId: BOOK_2.id });
  assert.deepEqual(out.totals, { ms: 300000, words: 900, units: 5, minutes: 5 });
  assert.equal(out.byBook.length, 1);
  assert.deepEqual(out.byDay.map((d) => d.bucket), ['2026-09-22']);
});

test('agrupación por semana ISO y por mes', () => {
  const biweekly = aggregateReading(days, { range: 'all', now: NOW, groupBy: 'week' });
  assert.deepEqual(
    biweekly.byDay.map((d) => d.bucket),
    ['2026-W38', '2026-W39'],
  );
  const monthly = aggregateReading(days, { range: 'all', now: NOW, groupBy: 'month' });
  assert.deepEqual(monthly.byDay, [{ bucket: '2026-09', ms: 4800000, words: 14400, units: 72 }]);
  assert.throws(() => aggregateReading(days, { groupBy: 'trimestre' }), /Agrupación desconocida/);
});

test('bucketOf: la semana ISO no se cae en el cambio de año', () => {
  // 2027-01-01 (viernes) pertenece a la semana 53 de 2026.
  assert.equal(bucketOf('2027-01-01', 'week'), '2026-W53');
  assert.equal(bucketOf('2026-12-28', 'week'), '2026-W53');
  assert.equal(bucketOf('2026-01-01', 'week'), '2026-W01');
});

test('sin registros no se inventa un cero raro: totales a cero y listas vacías', () => {
  const out = aggregateReading([], { range: '7d', now: NOW });
  assert.deepEqual(out.totals, { ms: 0, words: 0, units: 0, minutes: 0 });
  assert.deepEqual(out.byDay, []);
  assert.deepEqual(out.byBook, []);
  assert.equal(out.daysRead, 0);
});

test('un registro con basura no contamina las cuentas', () => {
  const out = aggregateReading(
    [null, { day: 'no-es-día' }, { day: '2026-09-22', books: { b1: { ms: 'x', units: null } } }],
    { range: 'all', now: NOW },
  );
  assert.deepEqual(out.totals, { ms: 0, words: 0, units: 0, minutes: 0 });
});
