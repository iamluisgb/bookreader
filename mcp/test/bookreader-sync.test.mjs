// bookreader-sync — la fuente `bookreader` (MON4): el MISMO layout que Drive, leído del Worker
// del sync de BookReader y descifrado en local.
//
// Sin red y sin imitaciones del protocolo: el Worker es el de verdad (workers/sync/src), sobre
// el arnés de sus propios tests (SQLite + R2 en memoria), y lo que se sube va cifrado con el
// módulo de la app, igual que lo sube un dispositivo. Lo que se comprueba es la paridad: el MCP
// tiene que devolver exactamente lo mismo que con el layout en claro.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker from '../../workers/sync/src/index.js';
import { env as workerEnv } from '../../workers/sync/test/harness.mjs';
import * as C from '../../app/js/sync/sync-crypto.js';
import { createSource } from '../src/sources/index.mjs';
import { createDriveSource } from '../src/sources/drive.mjs';
import { createMemoryProvider } from '../src/providers/memory.mjs';
import { parsePairLink, readPairFile } from '../src/providers/bookreader-sync.mjs';
import { BOOK_1, buildLayoutFiles } from './helpers/dataset.mjs';

const URL_ = 'https://sync.test';
const LICENSE = 'BKRD-TEST-MCP';

// Un servidor y lo que un dispositivo subió a él, cifrado con `raw`.
async function seeded(files = buildLayoutFiles()) {
  const e = workerEnv({ DATA_QUOTA_BYTES: String(10 * 1024 * 1024), MAX_BYTES: String(10 * 1024 * 1024) });
  const fetchImpl = (url, init = {}) => worker.fetch(new Request(url, init), e);
  const raw = C.generateKey();
  const k = await C.importKeys(raw);
  const t = await (await fetchImpl(URL_ + '/v1/sync-token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ license: LICENSE }),
  })).json();
  for (const [path, content] of Object.entries(files)) {
    const pid = await C.pathId(k, path);
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    const body = new Uint8Array(await (await C.encrypt(k, pid, text)).arrayBuffer());
    const res = await fetchImpl(URL_ + '/v1/o/' + pid, {
      method: 'PUT', body,
      headers: { Authorization: 'Bearer ' + t.token, 'Content-Length': String(body.length), 'X-Name': await C.encryptName(k, path), 'X-Kind': 'data' },
    });
    assert.equal(res.status, 200, 'subida de ' + path);
  }
  return { e, fetchImpl, raw };
}

const source = (fetchImpl, raw, license = LICENSE) =>
  createSource({ source: 'bookreader', base: 'bookreader/', cacheMs: 0 }, { fetchImpl, workerUrl: URL_, pair: { raw, license } });

test('lee del sync de BookReader lo mismo que del layout en claro', async () => {
  const { fetchImpl, raw } = await seeded();
  const br = await source(fetchImpl, raw);
  const plano = createDriveSource({ provider: createMemoryProvider(buildLayoutFiles()), cacheMs: 0 });
  assert.equal(br.kind, 'bookreader');
  assert.deepEqual(await br.ping(), { kind: 'bookreader', detail: 'bookreader/' });
  assert.deepEqual(await br.listBooks(), await plano.listBooks());
  assert.deepEqual(await br.getHighlights(BOOK_1.id), await plano.getHighlights(BOOK_1.id));
  assert.deepEqual(await br.getNotes(BOOK_1.id), await plano.getNotes(BOOK_1.id));
  assert.deepEqual(await br.readingDays(), await plano.readingDays());
  assert.ok((await br.getHighlights(BOOK_1.id)).length > 0);
});

test('con la clave de otro sync no lee nada, y lo dice al arrancar', async () => {
  const { fetchImpl } = await seeded();
  const ajena = await source(fetchImpl, C.generateKey());
  await assert.rejects(() => ajena.ping(), /manifest/);
});

test('una licencia sin sync se explica, no es un error críptico', async () => {
  const { fetchImpl, raw } = await seeded();
  const s = await source(fetchImpl, raw, 'BKRD-TEST-NOSUB');
  await assert.rejects(() => s.ping(), /no incluye el sync de BookReader/);
});

test('el enlace de emparejamiento: entero o solo el valor; roto, se dice cómo conseguirlo', async () => {
  const raw = C.generateKey();
  const valor = C.b64url(raw) + '.' + C.b64url(new TextEncoder().encode(LICENSE));
  for (const txt of ['https://bookreader.raiatech.com/app/#pair=' + valor + '\n', valor]) {
    const p = parsePairLink(txt);
    assert.deepEqual([...p.raw], [...raw]);
    assert.equal(p.license, LICENSE);
  }
  assert.throws(() => parsePairLink('https://bookreader.raiatech.com/app/'), /Enlace para otro dispositivo/);
});

test('el fichero del enlace tiene que ser privado (modo 600)', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'br-pair-'));
  const f = join(dir, 'sync-pair');
  const valor = C.b64url(C.generateKey()) + '.' + C.b64url(new TextEncoder().encode(LICENSE));
  await writeFile(f, '#pair=' + valor);
  await chmod(f, 0o644);
  await assert.rejects(() => readPairFile(f, readFile), /chmod 600/);
  await chmod(f, 0o600);
  assert.equal((await readPairFile(f, readFile)).license, LICENSE);
});
