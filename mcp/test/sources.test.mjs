// sources — la fuente de backup: qué indexa, qué ignora y cómo falla.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createBackupFileSource, indexBackup, BACKUP_FORMAT } from '../src/sources/backup-file.mjs';
import { SourceError } from '../src/errors.mjs';
import { BOOK_1, BOOK_2, HIGHLIGHTS, buildBackupFixture } from './helpers/dataset.mjs';
import { FIXTURES } from './helpers/mcp-client.mjs';

const BACKUP = resolve(FIXTURES, 'backup.json');

test('backup: indexa por libro y respeta los tombstones', async () => {
  const source = createBackupFileSource({ path: BACKUP });
  const books = await source.listBooks();
  assert.deepEqual(
    books.map((b) => [b.id, b.title, b.highlightCount, b.noteCount, b.bookmarkCount, b.convoCount]),
    [
      [BOOK_1.id, BOOK_1.title, 3, 2, 1, 1],
      // El subrayado borrado del libro 1 y la nota borrada no cuentan.
      [BOOK_2.id, null, 2, 0, 0, 0],
    ],
  );
  const highlights = await source.getHighlights(BOOK_1.id);
  assert.ok(!highlights.some((h) => h.deleted));
  assert.ok(!highlights.some((h) => /borrado/.test(h.text)));
});

test('backup: no hay registro de lectura, y eso NO es un error', async () => {
  const source = createBackupFileSource({ path: BACKUP });
  assert.equal(source.hasReadingStats, false);
  assert.deepEqual(await source.readingDays(), []);
});

test('backup: tolera las claves con prefijo (un volcado a mano desde las DevTools)', () => {
  const raw = buildBackupFixture();
  const prefixed = { ...raw, localStorage: {} };
  for (const [k, v] of Object.entries(raw.localStorage)) prefixed.localStorage['bookreader_' + k] = v;
  const books = indexBackup(prefixed);
  assert.equal(books.get(BOOK_1.id).highlights.length, HIGHLIGHTS[BOOK_1.id].length);
  assert.equal(books.get(BOOK_1.id).notes.length, 3); // los tombstones viven en el índice; los filtra la proyección
});

test('backup: un fichero que no es un backup se rechaza diciendo por qué', async () => {
  assert.throws(() => indexBackup({ format: 'otra-cosa' }), (e) => e instanceof SourceError && new RegExp(BACKUP_FORMAT).test(e.message));
  assert.throws(() => indexBackup(null), SourceError);
  const source = createBackupFileSource({ path: resolve(FIXTURES, 'no-existe.json') });
  await assert.rejects(() => source.listBooks(), /No puedo leer el backup/);
});

test('backup: un fichero que no es JSON no arranca', async () => {
  const source = createBackupFileSource({ path: 'cualquiera', readFile: async () => '{roto' });
  await assert.rejects(() => source.listBooks(), /no es JSON válido/);
});

test('backup: libro desconocido es un error con nombre, no un resultado vacío', async () => {
  const source = createBackupFileSource({ path: BACKUP });
  await assert.rejects(() => source.getHighlights('no-existe'), /Libro desconocido/);
  await assert.rejects(() => source.getNotes('no-existe'), /Libro desconocido/);
});

test('el fichero versionado del backup es el que genera el dataset (sin deriva silenciosa)', async () => {
  const onDisk = JSON.parse(await readFile(BACKUP, 'utf8'));
  assert.deepEqual(onDisk, buildBackupFixture());
});
