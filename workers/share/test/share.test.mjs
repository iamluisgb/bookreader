// Tests del almacén de enlaces compartidos (P24 F4). R2 se sustituye por un doble en
// memoria con la parte de la API que usa el Worker (put/get/head/delete/list).
//
//   node --test workers/share/test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { purge } from '../src/index.js';

function fakeR2() {
  const m = new Map();
  return {
    _m: m,
    async put(key, body, opts = {}) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      m.set(key, { bytes, customMetadata: opts.customMetadata || {} });
    },
    async get(key) {
      const o = m.get(key); if (!o) return null;
      return { body: new Blob([o.bytes]).stream(), size: o.bytes.length, customMetadata: o.customMetadata };
    },
    async head(key) { const o = m.get(key); return o ? { customMetadata: o.customMetadata } : null; },
    async delete(keys) { for (const k of [].concat(keys)) m.delete(k); },
    async list({ prefix }) {
      return { objects: [...m].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, customMetadata: o.customMetadata })), truncated: false };
    },
  };
}
const env = (extra = {}) => ({ SHARES: fakeR2(), ALLOWED_ORIGINS: 'https://bookreader.raiatech.com', MAX_BYTES: '1000', TTL_DAYS: '7', ...extra });
const ORIGIN = { Origin: 'https://bookreader.raiatech.com' };
const req = (method, path, { body, headers = {} } = {}) => new Request('https://share.test' + path, {
  method, body, headers: { ...ORIGIN, ...(body ? { 'Content-Length': String(body.length) } : {}), ...headers },
});

test('subir y bajar: los mismos bytes, con id opaco y caducidad', async () => {
  const e = env();
  const bytes = new Uint8Array([1, 2, 3, 250]);
  const up = await worker.fetch(req('POST', '/v1/share', { body: bytes }), e);
  assert.equal(up.status, 201);
  const { id, expiresAt, deleteToken } = await up.json();
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  assert.ok(deleteToken && deleteToken !== id);
  assert.ok(expiresAt > Date.now() + 6 * 86400000);
  assert.equal(up.headers.get('Access-Control-Allow-Origin'), 'https://bookreader.raiatech.com');
  // El hash del token, nunca el token.
  const meta = e.SHARES._m.get('d/' + id).customMetadata;
  assert.notEqual(meta.del, deleteToken);

  const down = await worker.fetch(req('GET', '/v1/share/' + id), e);
  assert.equal(down.status, 200);
  assert.deepEqual(new Uint8Array(await down.arrayBuffer()), bytes);
});

test('subir: sin origen permitido, sin longitud o por encima del tope, no', async () => {
  const e = env();
  const otro = await worker.fetch(new Request('https://share.test/v1/share', { method: 'POST', body: 'x', headers: { Origin: 'https://evil.test', 'Content-Length': '1' } }), e);
  assert.equal(otro.status, 403);
  const grande = await worker.fetch(req('POST', '/v1/share', { body: new Uint8Array(1001) }), e);
  assert.equal(grande.status, 413);
  assert.equal((await grande.json()).max, 1000);
  assert.equal(e.SHARES._m.size, 0);
});

test('límite de subidas por IP', async () => {
  const e = env({ UPLOADS: { limit: async () => ({ success: false }) } });
  const r = await worker.fetch(req('POST', '/v1/share', { body: new Uint8Array(3) }), e);
  assert.equal(r.status, 429);
});

test('caducado: 410 y se borra; inexistente o id raro: 404', async () => {
  const e = env();
  const { id } = await (await worker.fetch(req('POST', '/v1/share', { body: new Uint8Array(3) }), e)).json();
  e.SHARES._m.get('d/' + id).customMetadata.expiresAt = String(Date.now() - 1);
  assert.equal((await worker.fetch(req('GET', '/v1/share/' + id), e)).status, 410);
  assert.equal(e.SHARES._m.size, 0);
  assert.equal((await worker.fetch(req('GET', '/v1/share/' + 'A'.repeat(22)), e)).status, 404);
  assert.equal((await worker.fetch(req('GET', '/v1/share/../../x'), e)).status, 404);
});

test('revocar: solo con el token de quien lo subió', async () => {
  const e = env();
  const { id, deleteToken } = await (await worker.fetch(req('POST', '/v1/share', { body: new Uint8Array(3) }), e)).json();
  assert.equal((await worker.fetch(req('DELETE', '/v1/share/' + id, { headers: { 'X-Delete-Token': 'otro' } }), e)).status, 403);
  assert.equal((await worker.fetch(req('DELETE', '/v1/share/' + id, { headers: { 'X-Delete-Token': deleteToken } }), e)).status, 200);
  assert.equal((await worker.fetch(req('GET', '/v1/share/' + id), e)).status, 404);
});

test('purga diaria: borra solo lo caducado', async () => {
  const e = env();
  const a = (await (await worker.fetch(req('POST', '/v1/share', { body: new Uint8Array(3) }), e)).json()).id;
  const b = (await (await worker.fetch(req('POST', '/v1/share', { body: new Uint8Array(3) }), e)).json()).id;
  e.SHARES._m.get('d/' + a).customMetadata.expiresAt = String(Date.now() - 1);
  assert.equal(await purge(e), 1);
  assert.deepEqual([...e.SHARES._m.keys()], ['d/' + b]);
});

test('CORS: preflight con los métodos y la cabecera del token', async () => {
  const r = await worker.fetch(req('OPTIONS', '/v1/share'), env());
  assert.equal(r.status, 204);
  assert.match(r.headers.get('Access-Control-Allow-Methods'), /DELETE/);
  assert.match(r.headers.get('Access-Control-Allow-Headers'), /X-Delete-Token/);
});
