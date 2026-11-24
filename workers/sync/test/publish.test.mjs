// Publicar el perfil público desde la app (src/publish.js): solo quien está en PUBLISH_PROFILES,
// la foto se guarda y se avisa a GitHub, y la Action baja la foto e informa con su propio token.
//
//   npm run test:sync

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { env, ORIGIN } from './harness.mjs';

const PULL = 'pull-secret-123';
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function req(method, path, { body, token, headers = {} } = {}) {
  const h = { Origin: ORIGIN, ...headers };
  if (token) h.Authorization = 'Bearer ' + token;
  if (typeof body === 'string') { h['Content-Type'] = 'application/json'; h['Content-Length'] = String(body.length); }
  return new Request('https://sync.test' + path, { method, body, headers: h });
}
async function login(e, license = 'BKRD-TEST-0001') {
  const r = await worker.fetch(req('POST', '/v1/sync-token', { body: JSON.stringify({ license }) }), e);
  const { token } = await r.json();
  const user = e.DB._raw.prepare('SELECT user FROM tokens ORDER BY rowid DESC LIMIT 1').get().user;
  return { token, user };
}
const snap = (handle = 'luis', extra = {}) => JSON.stringify({
  format: 'bookreader-perfil', version: 2, handle, exportedAt: '2026-11-24T10:00:00Z',
  shelves: [{ id: 'tecnico', name: 'Técnico', books: ['abc'] }],
  books: [{ id: 'abc', bookId: 'abc'.padEnd(64, '0'), title: 'Un libro', coverData: 'data:image/webp;base64,AAAA' }],
  ...extra,
});
// Un GitHub de mentira que apunta los avisos.
function fakeGitHub(status = 204) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response(null, { status });
  };
  return calls;
}
async function setup(over = {}) {
  const e = env({ PUBLISH_REPO: 'iamluisgb/bookreader', GITHUB_DISPATCH_TOKEN: 'gh-xyz', PUBLISH_PULL_TOKEN: PULL, ...over });
  const me = await login(e);
  e.PUBLISH_PROFILES = JSON.stringify({ [me.user]: 'luis' });
  return { e, me };
}

test('publicar: quien no está en PUBLISH_PROFILES no publica (403), ni sin token (401)', async () => {
  const { e } = await setup();
  const otro = await login(e, 'BKRD-TEST-0002');
  fakeGitHub();
  const r = await worker.fetch(req('POST', '/v1/profile/publish', { body: snap(), token: otro.token }), e);
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'not_allowed');
  assert.equal((await worker.fetch(req('POST', '/v1/profile/publish', { body: snap() }), e)).status, 401);
  // Sin PUBLISH_PROFILES (o mal formado) no publica nadie.
  e.PUBLISH_PROFILES = 'no es json';
  const yo = await login(e);
  assert.equal((await worker.fetch(req('POST', '/v1/profile/publish', { body: snap(), token: yo.token }), e)).status, 403);
});

test('publicar: guarda la foto, avisa a GitHub y deja el estado en cola', async () => {
  const { e, me } = await setup();
  const calls = fakeGitHub();
  const r = await worker.fetch(req('POST', '/v1/profile/publish', { body: snap(), token: me.token }), e);
  assert.equal(r.status, 202);
  const st = await r.json();
  assert.equal(st.state, 'queued');
  assert.match(st.id, /^[0-9a-f-]{36}$/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/iamluisgb/bookreader/dispatches');
  assert.equal(calls[0].headers.Authorization, 'Bearer gh-xyz');
  assert.deepEqual(calls[0].body, { event_type: 'publicar-perfil', client_payload: { handle: 'luis', id: st.id } });
  assert.equal(new TextDecoder().decode(e.SYNC._m.get('publish/luis.json')), snap());
  // El estado se lee con el mismo token.
  const g = await worker.fetch(req('GET', '/v1/profile/publish', { token: me.token }), e);
  assert.deepEqual(await g.json(), st);
});

test('publicar: una foto de otro handle, mal formada o enorme se rechaza sin avisar a GitHub', async () => {
  const { e, me } = await setup();
  const calls = fakeGitHub();
  const post = (body) => worker.fetch(req('POST', '/v1/profile/publish', { body, token: me.token }), e);
  assert.equal((await post(snap('otro'))).status, 400);
  assert.equal((await post(snap('luis', { shelves: [] }))).status, 400);
  assert.equal((await post('{')).status, 400);
  const big = snap('luis', { pad: 'x'.repeat(12 * 1024 * 1024) });
  assert.equal((await post(big)).status, 413);
  assert.equal(calls.length, 0);
  assert.equal(e.SYNC._m.has('publish/luis.json'), false);
});

test('publicar: si GitHub no acepta el aviso, el estado queda en fallo (502)', async () => {
  const { e, me } = await setup();
  fakeGitHub(401);
  const r = await worker.fetch(req('POST', '/v1/profile/publish', { body: snap(), token: me.token }), e);
  assert.equal(r.status, 502);
  assert.equal((await r.json()).reason, 'dispatch');
});

test('Action: baja la foto e informa solo con PUBLISH_PULL_TOKEN, y solo de la publicación en curso', async () => {
  const { e, me } = await setup();
  fakeGitHub();
  const { id } = await (await worker.fetch(req('POST', '/v1/profile/publish', { body: snap(), token: me.token }), e)).json();
  globalThis.fetch = realFetch;

  // Sin el token de la Action (o con el de sync) no se baja nada.
  assert.equal((await worker.fetch(req('GET', '/v1/profile/snapshot/luis'), e)).status, 403);
  assert.equal((await worker.fetch(req('GET', '/v1/profile/snapshot/luis', { token: me.token }), e)).status, 403);
  const s = await worker.fetch(req('GET', '/v1/profile/snapshot/luis', { token: PULL }), e);
  assert.equal(s.status, 200);
  assert.equal(await s.text(), snap());
  assert.equal((await worker.fetch(req('GET', '/v1/profile/snapshot/nadie', { token: PULL }), e)).status, 404);

  const report = (body) => worker.fetch(req('POST', '/v1/profile/status/luis', { body: JSON.stringify(body), token: PULL }), e);
  assert.equal((await report({ id: 'vieja', state: 'done' })).status, 409);
  assert.equal((await report({ id, state: 'cocinando' })).status, 400);
  assert.equal((await report({ id, state: 'done', sha: 'f'.repeat(40), run: 'https://github.com/x/runs/1' })).status, 200);
  const st = await (await worker.fetch(req('GET', '/v1/profile/publish', { token: me.token }), e)).json();
  assert.equal(st.state, 'done');
  assert.equal(st.id, id);
  assert.equal(st.sha, 'f'.repeat(40));
});
