// parity — la misma biblioteca descrita de las dos formas (backup y layout de Drive) tiene que
// dar EXACTAMENTE el mismo resultado en las cuatro tools comunes. Es la comprobación de que
// «misma superficie de tools» en F2 es de verdad y no un parecido razonable.
//
// Diferencias admitidas: `source` (cada uno dice de dónde lee) y, en `reading_stats`, nada
// porque solo la fuente de Drive la tiene.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { connect, FIXTURES } from './helpers/mcp-client.mjs';
import { BOOK_1 } from './helpers/dataset.mjs';

const BACKUP = ['--backup', resolve(FIXTURES, 'backup.json')];
const DIR = ['--dir', resolve(FIXTURES, 'layout')];

const COMMON = [
  ['list_books', {}],
  ['get_highlights', { bookId: BOOK_1.id }],
  ['get_notes', { bookId: BOOK_1.id }],
  ['search_highlights', { query: 'memoria' }],
  ['search_highlights', { query: 'cobertura', limit: 1 }],
];

function sinFuente(payload) {
  const { source: _fuente, ...rest } = payload;
  return rest;
}

test('las dos fuentes devuelven lo mismo en las tools comunes', async () => {
  const fromBackup = await connect(BACKUP);
  const fromDrive = await connect(DIR);
  try {
    for (const [name, args] of COMMON) {
      const a = await fromBackup.call(name, args);
      const b = await fromDrive.call(name, args);
      assert.equal(a.isError, false, name + ' no debería fallar en el backup');
      assert.equal(b.isError, false, name + ' no debería fallar en Drive');
      assert.equal(a.json.source, 'backup-file');
      assert.equal(b.json.source, 'drive');
      assert.deepEqual(sinFuente(b.json), sinFuente(a.json), name + ' difiere entre fuentes');
    }
  } finally {
    await fromBackup.close();
    await fromDrive.close();
  }
});

test('los errores también coinciden en las dos fuentes', async () => {
  const fromBackup = await connect(BACKUP);
  const fromDrive = await connect(DIR);
  try {
    const a = await fromBackup.call('get_notes', { bookId: 'no-existe' });
    const b = await fromDrive.call('get_notes', { bookId: 'no-existe' });
    assert.equal(a.isError, true);
    assert.equal(b.isError, true);
    assert.equal(a.text, b.text);
  } finally {
    await fromBackup.close();
    await fromDrive.close();
  }
});
