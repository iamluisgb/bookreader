// El MCP remoto (src/mcp.js): tokens de agente creados desde la app, la clave cifrada con el
// token, y el protocolo. Con el Worker de verdad sobre SQLite y un R2 en memoria, y los datos
// cifrados con el módulo de la app, como los sube un dispositivo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { authenticateAgent } from '../src/mcp.js';
import { env as baseEnv, ORIGIN } from './harness.mjs';
import * as C from '../../../app/js/sync/sync-crypto.js';
import { createDriveSource } from '../../../mcp/src/sources/drive.mjs';
import { createMemoryProvider } from '../../../mcp/src/providers/memory.mjs';
import { BOOK_1, buildLayoutFiles } from '../../../mcp/test/helpers/dataset.mjs';

const LICENSE = 'BKRD-TEST-0001';
const env = () => baseEnv({ DATA_QUOTA_BYTES: String(10 * 1024 * 1024), MAX_BYTES: String(10 * 1024 * 1024) });

function call(e, method, path, { body, token, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = 'Bearer ' + token;
  if (body !== undefined && typeof body !== 'string' && !(body instanceof Uint8Array)) { body = JSON.stringify(body); }
  if (typeof body === 'string') h['Content-Type'] = 'application/json';
  if (body instanceof Uint8Array) h['Content-Length'] = String(body.length);
  return worker.fetch(new Request('https://sync.test' + path, { method, body, headers: h }), e);
}

// Un usuario con su biblioteca subida y cifrada, y su sesión del sync (la de la app).
async function seeded(e = env(), license = LICENSE) {
  const raw = C.generateKey();
  const k = await C.importKeys(raw);
  const { token } = await (await call(e, 'POST', '/v1/sync-token', { body: { license }, headers: { Origin: ORIGIN } })).json();
  for (const [path, content] of Object.entries(buildLayoutFiles())) {
    const pid = await C.pathId(k, path);
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    const body = new Uint8Array(await (await C.encrypt(k, pid, text)).arrayBuffer());
    const res = await call(e, 'PUT', '/v1/o/' + pid, { body, token, headers: { 'X-Name': await C.encryptName(k, path), 'X-Kind': 'data' } });
    assert.equal(res.status, 200);
  }
  return { e, raw, session: token };
}

const createToken = (s, extra = {}) => call(s.e, 'POST', '/v1/mcp-tokens', {
  token: s.session, body: { name: 'Hermes', key: C.b64url(s.raw), license: LICENSE, ...extra },
});

let rpcId = 0;
async function rpc(e, token, method, params, headers = {}) {
  const res = await call(e, 'POST', '/mcp', { token, body: { jsonrpc: '2.0', id: ++rpcId, method, params }, headers });
  return { status: res.status, headers: res.headers, body: res.status === 202 ? null : await res.json() };
}
const toolJson = (r) => JSON.parse(r.body.result.content[0].text);

test('un agente con su token lee lo mismo que el layout en claro', async () => {
  const s = await seeded();
  const created = await (await createToken(s)).json();
  assert.match(created.token, /^br-mcp-[A-Za-z0-9_-]{43}$/);

  const init = await rpc(s.e, created.token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.equal(init.body.result.serverInfo.name, 'bookreader');
  const tools = (await rpc(s.e, created.token, 'tools/list')).body.result.tools.map((t) => t.name);
  assert.ok(tools.includes('list_books') && tools.includes('reading_stats') && tools.includes('search_highlights'));

  const plano = createDriveSource({ provider: createMemoryProvider(buildLayoutFiles()), kind: 'bookreader', cacheMs: 0 });
  const books = toolJson(await rpc(s.e, created.token, 'tools/call', { name: 'list_books', arguments: {} }));
  assert.deepEqual(books.books, await plano.listBooks());
  const hl = toolJson(await rpc(s.e, created.token, 'tools/call', { name: 'get_highlights', arguments: { bookId: BOOK_1.id } }));
  assert.deepEqual(hl.highlights, await plano.getHighlights(BOOK_1.id));
  assert.ok(hl.highlights.length > 0);
});

test('en D1 no queda nada legible: ni el token, ni la licencia, ni la clave', async () => {
  const s = await seeded();
  const { token } = await (await createToken(s)).json();
  const row = s.e.DB._raw.prepare('SELECT * FROM mcp_tokens').get();
  const dump = JSON.stringify(row);
  for (const secret of [token, token.slice(7), LICENSE, C.b64url(s.raw)]) assert.ok(!dump.includes(secret), secret);
});

test('crear: hace falta la licencia de ESTA cuenta y la clave de ESTE sync; en solo lectura, no', async () => {
  const s = await seeded();
  assert.equal((await createToken(s, { license: 'BKRD-TEST-OTRA' })).status, 403);
  const ajena = await createToken(s, { key: C.b64url(C.generateKey()) });
  assert.deepEqual([ajena.status, (await ajena.json()).error], [403, 'wrong_key']);
  assert.equal((await createToken(s, { name: '' })).status, 400);
  s.e.DB._raw.prepare('UPDATE tokens SET read_only = 1').run();
  assert.equal((await createToken(s)).status, 403);
});

test('listar y revocar desde la app; revocado, el agente recibe 401 con WWW-Authenticate', async () => {
  const s = await seeded();
  const a = await (await createToken(s, { name: 'Hermes' })).json();
  const b = await (await createToken(s, { name: 'Mac', days: 30 })).json();
  const list = await (await call(s.e, 'GET', '/v1/mcp-tokens', { token: s.session })).json();
  assert.deepEqual(list.tokens.map((t) => t.name).sort(), ['Hermes', 'Mac']);
  assert.ok(list.tokens.every((t) => !('token' in t) && !('wrapped' in t)));
  assert.equal((await call(s.e, 'DELETE', '/v1/mcp-tokens/' + a.id, { token: s.session })).status, 200);
  const r = await rpc(s.e, a.token, 'tools/list');
  assert.equal(r.status, 401);
  assert.match(r.headers.get('WWW-Authenticate'), /^Bearer/);
  assert.equal((await rpc(s.e, b.token, 'tools/list')).status, 200);
});

test('empezar de cero borra los tokens de agentes (llevan la clave vieja)', async () => {
  const s = await seeded();
  const { token } = await (await createToken(s)).json();
  await call(s.e, 'DELETE', '/v1/all', { token: s.session });
  assert.equal((await rpc(s.e, token, 'tools/list')).status, 401);
});

test('la licencia se revalida: caducada, se lee durante la gracia y después 403', async () => {
  const s = await seeded();
  const { token } = await (await createToken(s)).json();
  const polar = { ...s.e, ALLOW_MOCK_LICENSES: '', POLAR_ORG_ID: 'org_1' };
  const revoked = async () => new Response(JSON.stringify({ status: 'revoked' }), { status: 200 });
  const day = 24 * 60 * 60 * 1000;
  const later = Date.now() + 2 * day;
  const ok = await authenticateAgent(polar, token, later, revoked);
  assert.ok(ok.user, 'dentro de la gracia sigue leyendo');
  assert.ok(s.e.DB._raw.prepare('SELECT lapsed_at FROM users').get().lapsed_at);
  const gone = await authenticateAgent(polar, token, later + 31 * day, revoked);
  assert.equal(gone.error, 'lapsed');
});

test('protocolo: notificaciones 202, método desconocido, lotes, GET 405 y Origin ajeno 403', async () => {
  const s = await seeded();
  const { token } = await (await createToken(s)).json();
  const note = await call(s.e, 'POST', '/mcp', { token, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  assert.equal(note.status, 202);
  const unknown = await rpc(s.e, token, 'resources/list');
  assert.equal(unknown.body.error.code, -32601);
  const batch = await call(s.e, 'POST', '/mcp', { token, body: [{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }] });
  const out = await batch.json();
  assert.deepEqual(out.map((m) => m.id), [1, 2]);
  assert.equal((await call(s.e, 'GET', '/mcp', { token })).status, 405);
  assert.equal((await rpc(s.e, token, 'ping', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await rpc(s.e, 'br-mcp-inventado', 'ping')).status, 401);
});

test('más llamadas por minuto de las que deja MCP_CALLS: error que lee el agente, sin tocar R2', async () => {
  let quedan = 2;
  const s = await seeded(baseEnv({ DATA_QUOTA_BYTES: String(10 * 1024 * 1024), MAX_BYTES: String(10 * 1024 * 1024),
    MCP_CALLS: { limit: async () => ({ success: quedan-- > 0 }) } }));
  const { token } = await (await createToken(s)).json();
  for (let i = 0; i < 2; i++) assert.ok(toolJson(await rpc(s.e, token, 'tools/call', { name: 'list_books', arguments: {} })).books);

  const gets = s.e.SYNC._ops.get;
  const r = await rpc(s.e, token, 'tools/call', { name: 'list_books', arguments: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.result.isError, true);
  assert.match(r.body.result.content[0].text, /Espera un minuto/);
  assert.equal(s.e.SYNC._ops.get, gets);
  // Lo que no gasta (initialize, tools/list) sigue contestando.
  assert.ok((await rpc(s.e, token, 'tools/list')).body.result.tools.length);
});

test('cada llamada deja en el log las tools y lo leído, sin argumentos ni rutas con ids', async () => {
  const s = await seeded();
  const { token } = await (await createToken(s)).json();
  const lineas = [];
  const log = console.log;
  console.log = (x) => lineas.push(String(x));
  try {
    await rpc(s.e, token, 'tools/call', { name: 'get_highlights', arguments: { bookId: BOOK_1.id } });
  } finally { console.log = log; }
  const [antes, despues] = lineas.map((l) => JSON.parse(l));
  assert.deepEqual(antes.tools, ['get_highlights']);
  assert.equal(despues.mcp, 'done');
  assert.ok(despues.bytes > 0 && despues.reads.length > 0);
  assert.ok(!lineas.join().includes(BOOK_1.id));
});
