// IA10 F2 · El almacén de pasajes del índice de la biblioteca en el Worker: bloques sellados por
// separado (sync-crypto.js · sealBlocks) que el MCP lee con lecturas por RANGO de R2 y abre uno a
// uno (src/mcp.js · r2Provider.readBlocks). El servidor no puede cambiarlos de sitio.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { r2Provider } from '../src/mcp.js';
import { env as baseEnv, ORIGIN } from './harness.mjs';
import * as C from '../../../app/js/sync/sync-crypto.js';

const LICENSE = 'BKRD-TEST-0001';
const PATH = 'bookreader/index/s/libro.bin';

function call(e, method, path, { body, token, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = 'Bearer ' + token;
  if (body !== undefined && !(body instanceof Uint8Array)) { body = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  if (body instanceof Uint8Array) h['Content-Length'] = String(body.length);
  return worker.fetch(new Request('https://sync.test' + path, { method, body, headers: h }), e);
}

async function seeded() {
  const e = baseEnv({ DATA_QUOTA_BYTES: String(10 * 1024 * 1024), MAX_BYTES: String(10 * 1024 * 1024) });
  const raw = C.generateKey();
  const k = await C.importKeys(raw);
  const session = (await (await call(e, 'POST', '/v1/sync-token', { body: { license: LICENSE }, headers: { Origin: ORIGIN } })).json()).token;
  const enc = new TextEncoder();
  const blocks = Array.from({ length: 6 }, (_, i) => enc.encode(`${i * 10}\tbloque ${i}: ${'x'.repeat(3000 + i)}\n`));
  const put = async (path, body) => {
    const pid = await C.pathId(k, path);
    assert.equal((await call(e, 'PUT', '/v1/o/' + pid, { body, token: session, headers: { 'X-Name': await C.encryptName(k, path), 'X-Kind': 'data' } })).status, 200);
  };
  const { body, offsets } = await C.sealBlocks(k, await C.pathId(k, PATH), blocks);
  await put(PATH, body);
  const user = e.DB._raw.prepare('SELECT id FROM users').get().id;
  return { e, k, raw, user, offsets, put };
}

const spec = (offsets, i) => ({ i, count: offsets.length - 1, offset: offsets[i], length: offsets[i + 1] - offsets[i] });

test('lee solo los bloques pedidos, con una lectura por rango cada uno', async () => {
  const s = await seeded();
  const p = r2Provider(s.e, s.user, s.raw);
  const before = s.e.SYNC._ops.get;
  const out = await p.readBlocks(PATH, [spec(s.offsets, 1), spec(s.offsets, 4)]);
  assert.equal(s.e.SYNC._ops.get - before, 2);
  assert.match(out[0], /^10\tbloque 1: x{3001}\n$/);
  assert.match(out[1], /^40\tbloque 4: x{3004}\n$/);
  assert.equal(await p.readBlocks('bookreader/index/s/otro.bin', [spec(s.offsets, 0)]), null);
});

test('un bloque en otra posición, de otro fichero o sin su final no se abre', async () => {
  const s = await seeded();
  const p = r2Provider(s.e, s.user, s.raw);
  // Pedir los bytes del bloque 2 diciendo que es el 3: los datos asociados no casan.
  await assert.rejects(p.readBlocks(PATH, [{ ...spec(s.offsets, 2), i: 3 }]));
  // Con otro total (como si se hubieran quitado bloques del final).
  await assert.rejects(p.readBlocks(PATH, [{ ...spec(s.offsets, 2), count: 3 }]));
  // El mismo contenido sellado para otra ruta.
  const other = 'bookreader/index/s/copia.bin';
  const { body } = await C.sealBlocks(s.k, await C.pathId(s.k, PATH), [new TextEncoder().encode('0\tajeno\n')]);
  await s.put(other, body);
  await assert.rejects(p.readBlocks(other, [{ i: 0, count: 1, offset: 0, length: body.length }]));
});
