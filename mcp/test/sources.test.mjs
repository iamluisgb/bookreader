// sources — las dos fuentes que cumplen la MISMA interfaz, y lo que cada proveedor hace con
// el layout. Aquí se prueba sin red y sin credenciales: memoria y carpeta de disco.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createBackupFileSource, indexBackup, BACKUP_FORMAT } from '../src/sources/backup-file.mjs';
import { createDriveSource, isSafeBookFile } from '../src/sources/drive.mjs';
import { createMemoryProvider } from '../src/providers/memory.mjs';
import { createFsProvider } from '../src/providers/fs.mjs';
import { SourceError } from '../src/errors.mjs';
import { BOOK_1, BOOK_2, HIGHLIGHTS, DEVICE_IDS, buildBackupFixture, buildLayoutFiles } from './helpers/dataset.mjs';
import { FIXTURES } from './helpers/mcp-client.mjs';

const BACKUP = resolve(FIXTURES, 'backup.json');
const LAYOUT = resolve(FIXTURES, 'layout');

function driveFromMemory(files = buildLayoutFiles(), opts = {}) {
  const provider = createMemoryProvider(files);
  return { provider, source: createDriveSource({ provider, cacheMs: 15000, now: () => 0, ...opts }) };
}

function countReads(provider) {
  const wrapped = {
    reads: 0,
    async list(prefix) {
      return provider.list(prefix);
    },
    async read(path) {
      wrapped.reads++;
      return provider.read(path);
    },
  };
  return wrapped;
}

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

test('drive: lee el manifest y los ficheros por libro, con los mismos números que el backup', async () => {
  const { source } = driveFromMemory();
  const books = await source.listBooks();
  assert.deepEqual(
    books.map((b) => [b.id, b.title, b.highlightCount, b.noteCount, b.bookmarkCount]),
    [
      [BOOK_1.id, BOOK_1.title, 3, 2, 1],
      [BOOK_2.id, null, 2, 0, 0],
    ],
  );
  assert.equal(source.hasReadingStats, true);
});

test('drive: los días de lectura vienen sin key ni deviceId', async () => {
  const { source } = driveFromMemory();
  const days = await source.readingDays();
  assert.equal(days.length, 4);
  for (const d of days) {
    assert.deepEqual(Object.keys(d).sort(), ['books', 'day', 'updatedAt']);
    assert.ok(!JSON.stringify(d).includes(DEVICE_IDS[0]));
    assert.ok(!JSON.stringify(d).includes(DEVICE_IDS[1]));
  }
});

test('drive: sin manifest no hay fuente, y se dice', async () => {
  const { source } = driveFromMemory({});
  await assert.rejects(() => source.ping(), /manifest\.json/);
});

test('drive: una ruta de libro que no es del layout no se lee (manifest manipulado)', async () => {
  const files = buildLayoutFiles();
  files['bookreader/manifest.json'].books[BOOK_1.id].file = '../../etc/passwd';
  const { source, provider } = driveFromMemory(files);
  const books = await source.listBooks();
  const b1 = books.find((b) => b.id === BOOK_1.id);
  assert.match(b1.error, /ruta de libro no permitida/);
  assert.equal(b1.highlightCount, 0);
  assert.deepEqual(
    provider.paths().filter((p) => p.includes('passwd')),
    [],
  );
  assert.equal(isSafeBookFile('books/x.json'), true);
  assert.equal(isSafeBookFile('../x.json'), false);
  assert.equal(isSafeBookFile('/etc/passwd'), false);
});

test('drive: un fichero de libro que falta no tumba el listado', async () => {
  const files = buildLayoutFiles();
  delete files['bookreader/books/' + BOOK_2.id + '.json'];
  const { source } = driveFromMemory(files);
  const books = await source.listBooks();
  assert.match(books.find((b) => b.id === BOOK_2.id).error, /falta bookreader\/books/);
  assert.equal((await source.getHighlights(BOOK_1.id)).length, 3);
});

test('drive: el título sale del manifest y, si no está, del meta del libro', async () => {
  const files = buildLayoutFiles();
  files['bookreader/manifest.json'].books[BOOK_1.id].title = null;
  const { source } = driveFromMemory(files);
  assert.equal((await source.bookInfo(BOOK_1.id)).title, BOOK_1.title);
  assert.deepEqual(await source.titles(), { [BOOK_1.id]: null, [BOOK_2.id]: null });
});

test('drive: la caché evita releer y caduca con el TTL', async () => {
  const inner = createMemoryProvider(buildLayoutFiles());
  const provider = countReads(inner);
  let now = 1000;
  const source = createDriveSource({ provider, cacheMs: 5000, now: () => now });

  await source.listBooks();
  const cold = provider.reads;
  assert.equal(cold, 3, 'manifest + un fichero por libro');
  await source.listBooks();
  assert.equal(provider.reads, cold, 'segunda llamada dentro del TTL: cero lecturas');

  now += 6000;
  await source.listBooks();
  assert.equal(provider.reads, cold + 3, 'pasado el TTL se vuelve a leer');
});

test('drive: titles() cuesta una sola lectura (el manifest ya tiene los títulos)', async () => {
  const provider = countReads(createMemoryProvider(buildLayoutFiles()));
  const source = createDriveSource({ provider, cacheMs: 0 });
  await source.titles();
  assert.equal(provider.reads, 1);
});

test('drive: cacheMs=0 desactiva la caché (fuente siempre viva)', async () => {
  const inner = createMemoryProvider(buildLayoutFiles());
  const provider = countReads(inner);
  const source = createDriveSource({ provider, cacheMs: 0 });
  await source.listBooks();
  await source.listBooks();
  assert.equal(provider.reads, 6);
});

test('drive: una escritura remota se ve al caducar la caché', async () => {
  const files = buildLayoutFiles();
  const inner = createMemoryProvider(files);
  let now = 1000;
  const source = createDriveSource({ provider: inner, cacheMs: 100, now: () => now });
  assert.equal((await source.listBooks()).find((b) => b.id === BOOK_1.id).highlightCount, 3);

  const path = 'bookreader/books/' + BOOK_1.id + '.json';
  const updated = structuredClone(files[path]);
  updated.local['highlights_' + BOOK_1.id].push({
    uid: 'nuevo',
    text: 'Un subrayado que llegó del móvil.',
    updatedAt: 999,
  });
  await inner.write(path, updated);
  now += 200;
  assert.equal((await source.listBooks()).find((b) => b.id === BOOK_1.id).highlightCount, 4);
});

test('fs: lee el layout de una carpeta y no se sale de ella', async () => {
  const provider = createFsProvider({ root: LAYOUT });
  const listed = await provider.list('bookreader/');
  assert.deepEqual(
    listed.map((f) => f.path),
    ['bookreader/books/' + BOOK_1.id + '.json', 'bookreader/books/' + BOOK_2.id + '.json', 'bookreader/manifest.json', 'bookreader/settings.json'],
  );
  assert.ok((await provider.read('bookreader/manifest.json')).content.includes('schemaVersion'));
  assert.equal(await provider.read('bookreader/no-existe.json'), null);
  await assert.rejects(() => provider.read('../backup.json'), /fuera de la carpeta/);
  await assert.rejects(() => provider.read('/etc/hostname'), /fuera de la carpeta/);
});

test('fs: un enlace simbólico dentro de la carpeta no saca al MCP de ella', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'bookreader-mcp-'));
  try {
    const root = join(tmp, 'layout');
    await mkdir(join(root, 'bookreader'), { recursive: true });
    await writeFile(join(root, 'bookreader', 'manifest.json'), '{"schemaVersion":1}');
    await writeFile(join(tmp, 'secreto.txt'), 'ai_key=sk-no-debe-salir');
    await symlink(join(tmp, 'secreto.txt'), join(root, 'bookreader', 'fuga.json'));
    await symlink(join(root, 'bookreader', 'manifest.json'), join(root, 'bookreader', 'alias.json'));

    const provider = createFsProvider({ root });
    await assert.rejects(() => provider.read('bookreader/fuga.json'), /enlace simbólico/);
    // un enlace que se queda dentro sigue funcionando, y list() no los enumera
    assert.ok((await provider.read('bookreader/alias.json')).content.includes('schemaVersion'));
    assert.deepEqual(
      (await provider.list('bookreader/')).map((f) => f.path),
      ['bookreader/manifest.json'],
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('fs: la fuente funciona igual sobre disco que en memoria', async () => {
  const provider = createFsProvider({ root: LAYOUT });
  const source = createDriveSource({ provider, cacheMs: 0 });
  const books = await source.listBooks();
  assert.equal(books.length, 2);
  assert.equal((await source.getHighlights(BOOK_1.id)).length, 3);
  assert.equal((await source.getNotes(BOOK_1.id)).length, 2);
  assert.equal((await source.readingDays()).length, 4);
});

test('el fichero versionado del backup es el que genera el dataset (sin deriva silenciosa)', async () => {
  const onDisk = JSON.parse(await readFile(BACKUP, 'utf8'));
  assert.deepEqual(onDisk, buildBackupFixture());
});
