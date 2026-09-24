// redact.mjs — la lista de lo vetado, y los dos caminos por los que podría escaparse: una
// clave con nombre conocido y un identificador escondido DENTRO de un valor (el `key` del
// registro de lectura es `<día>|<deviceId>`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scrub,
  findForbidden,
  sanitizeReadingDay,
  NEVER_EXPOSED_KEYS,
  DROPPED_READING_FIELDS,
} from '../src/redact.mjs';

test('la lista cubre los tres que P28 prohíbe, en las dos grafías del device_id', () => {
  for (const key of ['ai_key', 'drive_refresh_token', 'device_id', 'deviceId']) {
    assert.ok(NEVER_EXPOSED_KEYS.includes(key), 'falta ' + key);
  }
  // Y de más: estado de sync local y la licencia (ninguna tool la necesita).
  assert.ok(NEVER_EXPOSED_KEYS.includes('sync_state'));
  assert.ok(NEVER_EXPOSED_KEYS.includes('sync_schema_migrated'));
  assert.ok(NEVER_EXPOSED_KEYS.includes('license'));
});

test('scrub borra lo vetado a cualquier profundidad sin tocar lo demás', () => {
  const input = {
    ai_key: 'sk-secreta',
    format: 'bookreader-backup',
    ai: { notes: [{ content: 'una nota', device_id: 'dev-1' }] },
    deep: [{ nested: { drive_refresh_token: '1//refresh', license: { key: 'PRO-1' } } }],
  };
  const out = scrub(input);
  assert.deepEqual(findForbidden(out), []);
  assert.equal(out.format, 'bookreader-backup');
  assert.equal(out.ai.notes[0].content, 'una nota');
  // No muta la entrada: las fuentes reutilizan lo que leen.
  assert.equal(input.ai_key, 'sk-secreta');
});

test('findForbidden detecta la clave, no solo la borra', () => {
  const hits = findForbidden({ a: { ai_key: 'x' }, b: [{ device_id: 'y' }] });
  assert.deepEqual(hits.sort(), ['$.a.ai_key', '$.b[0].device_id']);
});

test('findForbidden encuentra el deviceId metido dentro de un valor', () => {
  const hits = findForbidden({ reading_days: [{ key: '2026-09-21|dev0a1b2c' }] }, { needles: ['dev0a1b2c'] });
  assert.equal(hits.length, 1);
  assert.match(hits[0], /\$\.reading_days\[0\]\.key/);
});

test('sanitizeReadingDay tira key y deviceId y conserva las cuentas', () => {
  const rec = {
    key: '2026-09-21|dev0a1b2c',
    day: '2026-09-21',
    deviceId: 'dev0a1b2c',
    updatedAt: 123,
    books: { b1: { ms: 600000, words: 1800, units: 9 }, raro: null },
  };
  const out = sanitizeReadingDay(rec);
  assert.deepEqual(Object.keys(out).sort(), ['books', 'day', 'updatedAt']);
  assert.deepEqual(out.books, { b1: { ms: 600000, words: 1800, units: 9 } });
  assert.deepEqual(DROPPED_READING_FIELDS.sort(), ['deviceId', 'key']);
});

test('sanitizeReadingDay tolera basura sin lanzar', () => {
  assert.equal(sanitizeReadingDay(null), null);
  assert.equal(sanitizeReadingDay({}), null);
  assert.equal(sanitizeReadingDay({ day: '2026-09-21' }).books.b1, undefined);
});
