// cli --remote — el MCP remoto (Worker del sync) desde la terminal, como lo usa pi en Hermes.
// Contra el Worker de verdad sobre el arnés de sus tests, con un token creado como lo crea la app.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../workers/sync/src/index.js';
import { env as workerEnv, ORIGIN } from '../../workers/sync/test/harness.mjs';
import * as C from '../../app/js/sync/sync-crypto.js';
import { main } from '../cli.mjs';
import { BOOK_1, buildLayoutFiles } from './helpers/dataset.mjs';

const URL_ = 'https://sync.test';

async function setup() {
  const e = workerEnv({ DATA_QUOTA_BYTES: String(10 * 1024 * 1024), MAX_BYTES: String(10 * 1024 * 1024) });
  const fetchImpl = (url, init = {}) => worker.fetch(new Request(url, init), e);
  const raw = C.generateKey();
  const k = await C.importKeys(raw);
  const license = 'BKRD-TEST-CLI';
  const { token: session } = await (await fetchImpl(URL_ + '/v1/sync-token', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ license }),
  })).json();
  for (const [path, content] of Object.entries(buildLayoutFiles())) {
    const pid = await C.pathId(k, path);
    const body = new Uint8Array(await (await C.encrypt(k, pid, typeof content === 'string' ? content : JSON.stringify(content))).arrayBuffer());
    await fetchImpl(URL_ + '/v1/o/' + pid, {
      method: 'PUT', body,
      headers: { Authorization: 'Bearer ' + session, 'Content-Length': String(body.length), 'X-Name': await C.encryptName(k, path), 'X-Kind': 'data' },
    });
  }
  const { token } = await (await fetchImpl(URL_ + '/v1/mcp-tokens', {
    method: 'POST', headers: { Authorization: 'Bearer ' + session, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'pi en Hermes', key: C.b64url(raw), license }),
  })).json();
  return { fetchImpl, token };
}

function io(fetchImpl, env) {
  const out = { stdout: '', stderr: '' };
  return {
    out,
    io: {
      stdout: { write: (s) => { out.stdout += s; } },
      stderr: { write: (s) => { out.stderr += s; } },
      env: { BOOKREADER_MCP_URL: URL_ + '/mcp', ...env },
      fetchImpl,
    },
  };
}

test('--remote: lista las tools y ejecuta una, con el token del entorno', async () => {
  const { fetchImpl, token } = await setup();
  const a = io(fetchImpl, { BOOKREADER_MCP_TOKEN: token });
  assert.equal(await main(['--remote', 'tools'], a.io), 0);
  assert.match(a.out.stdout, /^list_books$/m);
  const b = io(fetchImpl, { BOOKREADER_MCP_TOKEN: token });
  assert.equal(await main(['--remote', 'get_highlights', JSON.stringify({ bookId: BOOK_1.id })], b.io), 0);
  assert.ok(JSON.parse(b.out.stdout).highlights.length > 0);
});

test('--remote: sin token, o con uno que no vale, lo dice y sale con 1', async () => {
  const { fetchImpl } = await setup();
  const a = io(fetchImpl, {});
  assert.equal(await main(['--remote', 'list_books'], a.io), 1);
  assert.match(a.out.stderr, /Agentes/);
  const b = io(fetchImpl, { BOOKREADER_MCP_TOKEN: 'br-mcp-' + 'x'.repeat(43) });
  assert.equal(await main(['--remote', 'list_books'], b.io), 1);
  assert.match(b.out.stderr, /revocado, caducado/);
});

test('--remote: un libro que no existe es un error de la tool (stderr, código 1)', async () => {
  const { fetchImpl, token } = await setup();
  const a = io(fetchImpl, { BOOKREADER_MCP_TOKEN: token });
  assert.equal(await main(['--remote', 'get_highlights', '{"bookId":"no-existe"}'], a.io), 1);
  assert.match(a.out.stderr, /Libro desconocido/);
});
