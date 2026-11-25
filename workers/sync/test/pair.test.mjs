// Añadir un dispositivo (docs/PROPUESTA_EMPAREJAR_DISPOSITIVOS.md): relevo `#pair2=` (F2),
// `key-owner` (F3) y «empezar de cero» con prueba de la clave.
//
//   npm run test:sync

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { purge } from '../src/index.js';
import { env, ORIGIN } from './harness.mjs';

const P1 = 'a'.repeat(43);
const P2 = 'b'.repeat(43);
const BLOB = 'Y2lmcmFkbw'.repeat(10);

function req(method, path, { body, headers = {}, token, origin = ORIGIN } = {}) {
  const h = { ...headers };
  if (origin) h.Origin = origin;
  if (token) h.Authorization = 'Bearer ' + token;
  if (body instanceof Uint8Array) h['Content-Length'] = String(body.length);
  else if (body !== undefined) { body = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  return new Request('https://sync.test' + path, { method, body, headers: h });
}
const call = (e, ...a) => worker.fetch(req(...a), e);
async function login(e, license = 'BKRD-TEST-0001') {
  return (await call(e, 'POST', '/v1/sync-token', { body: { license } })).json();
}
const put = (e, token, path) => call(e, 'PUT', '/v1/o/' + path, { body: new Uint8Array(3).fill(1), token });

// ---- F2 · relevo -------------------------------------------------------------------------

test('pair: crear, reclamar una sola vez y el origen ve quién lo usó', async () => {
  const e = env();
  const a = await login(e);
  const c = await call(e, 'POST', '/v1/pair', { token: a.token, body: { blob: BLOB } });
  assert.equal(c.status, 200);
  const { id, expiresAt } = await c.json();
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  assert.ok(expiresAt - Date.now() <= 10 * 60 * 1000 && expiresAt - Date.now() > 9 * 60 * 1000);

  let st = await (await call(e, 'GET', '/v1/pair/' + id, { token: a.token })).json();
  assert.equal(st.state, 'pending');

  // Sin token: el id es la credencial.
  const r = await call(e, 'POST', `/v1/pair/${id}/claim`, { body: { device: 'Chrome en Windows' } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).blob, BLOB);

  st = await (await call(e, 'GET', '/v1/pair/' + id, { token: a.token })).json();
  assert.equal(st.state, 'claimed');
  assert.equal(st.device, 'Chrome en Windows');

  // Segundo uso: 410, y el blob ya no está en D1.
  assert.equal((await call(e, 'POST', `/v1/pair/${id}/claim`, { body: {} })).status, 410);
  assert.equal(e.DB._raw.prepare('SELECT blob FROM pair_codes WHERE id = ?').get(id).blob, null);
});

test('pair: dos reclamaciones a la vez, solo una se lleva el blob', async () => {
  const e = env();
  const a = await login(e);
  const { id } = await (await call(e, 'POST', '/v1/pair', { token: a.token, body: { blob: BLOB } })).json();
  const rs = await Promise.all([1, 2, 3].map(() => call(e, 'POST', `/v1/pair/${id}/claim`, { body: { device: 'x' } })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 410, 410]);
});

test('pair: caduca a los 10 minutos y la purga tira el blob', async () => {
  const e = env();
  const a = await login(e);
  const { id } = await (await call(e, 'POST', '/v1/pair', { token: a.token, body: { blob: BLOB } })).json();
  // Se adelanta el reloj moviendo la caducidad al pasado.
  e.DB._raw.prepare('UPDATE pair_codes SET expires_at = ? WHERE id = ?').run(Date.now() - 1, id);
  assert.equal((await call(e, 'POST', `/v1/pair/${id}/claim`, { body: {} })).status, 410);
  assert.equal((await (await call(e, 'GET', '/v1/pair/' + id, { token: a.token })).json()).state, 'expired');
  await purge(e);
  assert.equal(e.DB._raw.prepare('SELECT blob FROM pair_codes WHERE id = ?').get(id).blob, null);
  const p = await purge(e, Date.now() + 2 * 86400000);
  assert.equal(p.pairCodes, 1);
});

test('pair: otro usuario no ve el estado ni lo cancela; el dueño lo cancela', async () => {
  const e = env();
  const a = await login(e, 'BKRD-USER-AAAA');
  const b = await login(e, 'BKRD-USER-BBBB');
  const { id } = await (await call(e, 'POST', '/v1/pair', { token: a.token, body: { blob: BLOB } })).json();
  assert.equal((await call(e, 'GET', '/v1/pair/' + id, { token: b.token })).status, 404);
  assert.equal((await call(e, 'GET', '/v1/pair/' + id)).status, 401);
  await call(e, 'DELETE', '/v1/pair/' + id, { token: b.token });
  assert.equal((await call(e, 'GET', '/v1/pair/' + id, { token: a.token })).status, 200);
  assert.equal((await call(e, 'DELETE', '/v1/pair/' + id, { token: a.token })).status, 200);
  assert.equal((await call(e, 'POST', `/v1/pair/${id}/claim`, { body: {} })).status, 410);
});

test('pair: reclamar exige el origen de la app; crear exige token de escritura y tiene tope', async () => {
  const e = env();
  const a = await login(e);
  const { id } = await (await call(e, 'POST', '/v1/pair', { token: a.token, body: { blob: BLOB } })).json();
  assert.equal((await call(e, 'POST', `/v1/pair/${id}/claim`, { body: {}, origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(e, 'POST', `/v1/pair/${id}/claim`, { body: {}, origin: null })).status, 403);
  assert.equal((await call(e, 'POST', '/v1/pair/no-es-un-id/claim', { body: {} })).status, 410);
  assert.equal((await call(e, 'POST', '/v1/pair', { body: { blob: BLOB } })).status, 401);
  assert.equal((await call(e, 'POST', '/v1/pair', { token: a.token, body: { blob: 'no vale!' } })).status, 400);
  assert.equal((await call(e, 'POST', '/v1/pair', { token: a.token, body: { blob: 'x'.repeat(5000) } })).status, 400);
  for (let i = 0; i < 4; i++) assert.equal((await call(e, 'POST', '/v1/pair', { token: a.token, body: { blob: BLOB } })).status, 200);
  const tope = await call(e, 'POST', '/v1/pair', { token: a.token, body: { blob: BLOB } });
  assert.equal(tope.status, 429);
  assert.equal((await tope.json()).error, 'too_many');
});

test('pair: el límite por IP de reclamar corta a quien prueba ids', async () => {
  let n = 0;
  const e = env({ PAIRING: { limit: async ({ key }) => ({ success: !key.startsWith('claim:') || ++n <= 2 }) } });
  const r = () => call(e, 'POST', '/v1/pair/' + 'z'.repeat(22) + '/claim', { body: {}, headers: { 'CF-Connecting-IP': '1.2.3.4' } });
  assert.equal((await r()).status, 410);
  assert.equal((await r()).status, 410);
  assert.equal((await r()).status, 429);
});

// ---- F3 · key-owner ------------------------------------------------------------------------

test('key-owner: dice si la ruta de una clave está en el espacio de OTRO usuario', async () => {
  const e = env();
  const a = await login(e, 'BKRD-USER-AAAA');
  const b = await login(e, 'BKRD-USER-BBBB');
  await put(e, a.token, P1);
  const ask = async (token, pid) => (await call(e, 'POST', '/v1/key-owner', { token, body: { pid } })).json();
  assert.deepEqual(await ask(b.token, P1), { elsewhere: true });
  assert.deepEqual(await ask(a.token, P1), { elsewhere: false });   // la suya no cuenta
  assert.deepEqual(await ask(b.token, P2), { elsewhere: false });
  assert.equal((await call(e, 'POST', '/v1/key-owner', { body: { pid: P1 } })).status, 401);
  assert.equal((await call(e, 'POST', '/v1/key-owner', { token: b.token, body: { pid: 'corto' } })).status, 400);
});

// ---- Empezar de cero con prueba de la clave ------------------------------------------------

test('DELETE /v1/all: sin prueba de la clave no borra; con ella, sí', async () => {
  const e = env();
  const a = await login(e);
  await put(e, a.token, P1);
  const sin = await call(e, 'DELETE', '/v1/all', { token: a.token });
  assert.equal(sin.status, 403);
  assert.equal((await sin.json()).error, 'key_proof_required');
  // Un pid que no es suyo tampoco prueba nada.
  assert.equal((await call(e, 'DELETE', '/v1/all', { token: a.token, body: { pid: P2 } })).status, 403);
  assert.equal((await call(e, 'GET', '/v1/o/' + P1, { token: a.token })).status, 200);
  const con = await call(e, 'DELETE', '/v1/all', { token: a.token, body: { pid: P1 } });
  assert.equal(con.status, 200);
  assert.equal((await con.json()).wiped, true);
  assert.equal((await call(e, 'GET', '/v1/o/' + P1, { token: a.token })).status, 404);
});

test('DELETE /v1/all: un sync vacío se borra sin prueba (no hay nada que proteger)', async () => {
  const e = env();
  const a = await login(e);
  assert.equal((await call(e, 'DELETE', '/v1/all', { token: a.token })).status, 200);
});

test('clave perdida: el borrado se apunta, un dispositivo con la clave lo cancela, y si no la purga lo hace', async () => {
  const e = env({ WIPE_DELAY_DAYS: '7' });
  const a = await login(e);
  await put(e, a.token, P1);
  const r = await call(e, 'DELETE', '/v1/all', { token: a.token, body: { schedule: true } });
  assert.equal(r.status, 202);
  const { wipeAt, wiped } = await r.json();
  assert.equal(wiped, false);
  assert.ok(wipeAt > Date.now() + 6 * 86400000);
  // Pedirlo otra vez no lo retrasa.
  assert.equal((await (await call(e, 'DELETE', '/v1/all', { token: a.token, body: { schedule: true } })).json()).wipeAt, wipeAt);
  const st = await (await call(e, 'GET', '/v1/status', { token: a.token })).json();
  assert.equal(st.wipeAt, wipeAt);
  // Antes de tiempo, la purga no toca nada.
  await purge(e);
  assert.equal((await call(e, 'GET', '/v1/o/' + P1, { token: a.token })).status, 200);

  // Cancelar exige la prueba.
  assert.equal((await call(e, 'POST', '/v1/all/cancel', { token: a.token, body: {} })).status, 403);
  assert.equal((await call(e, 'POST', '/v1/all/cancel', { token: a.token, body: { pid: P1 } })).status, 200);
  assert.equal((await (await call(e, 'GET', '/v1/status', { token: a.token })).json()).wipeAt, null);

  // Sin cancelar: llegado el día, la purga vacía el sync.
  await call(e, 'DELETE', '/v1/all', { token: a.token, body: { schedule: true } });
  const p = await purge(e, Date.now() + 8 * 86400000);
  assert.equal(p.wipes, 1);
  // El token de 24 h ya caducó a esa hora; se pide otro.
  const a2 = await login(e);
  assert.equal((await call(e, 'GET', '/v1/o/' + P1, { token: a2.token })).status, 404);
  assert.equal((await (await call(e, 'GET', '/v1/status', { token: a2.token })).json()).wipeAt, null);
});
