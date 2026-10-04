// Tests del almacén de enlaces compartidos (P24 F4). D1 = SQLite de verdad (node:sqlite) con
// las MISMAS migraciones; R2 = un doble en memoria con la API que usa el Worker.
// Lo que más importa aquí: que NUNCA se pase de lo gratis (topes al 80 %).
//
//   npm run test:share

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker, { purge, usage, spend } from '../src/index.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async run() { this.db.prepare(this.sql).run(...this.args); return { success: true }; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
}
function nuevaDB() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).sort()) db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  return { prepare: (sql) => new Stmt(db, sql), _raw: db };
}
function fakeR2() {
  const m = new Map();
  const ops = { put: 0, get: 0, list: 0 };
  return {
    _m: m, _ops: ops,
    async put(key, body) { ops.put++; m.set(key, new Uint8Array(await new Response(body).arrayBuffer())); },
    async get(key) { ops.get++; const b = m.get(key); return b ? { body: new Blob([b]).stream(), size: b.length } : null; },
    async delete(keys) { for (const k of [].concat(keys)) m.delete(k); },
    async list() { ops.list++; throw new Error('listar R2 es clase A: no se usa'); },
  };
}
const env = (extra = {}) => ({
  SHARES: fakeR2(), DB: nuevaDB(), ALLOWED_ORIGINS: 'https://bookreader.raiatech.com',
  MAX_BYTES: '1000', TTL_DAYS: '7', USAGE_TOKEN: 'secreto', ...extra,
});
const ORIGIN = { Origin: 'https://bookreader.raiatech.com' };
const req = (method, path, { body, headers = {} } = {}) => new Request('https://share.test' + path, {
  method, body, headers: { ...ORIGIN, ...(body ? { 'Content-Length': String(body.length) } : {}), ...headers },
});
const subir = async (e, n = 3) => worker.fetch(req('POST', '/v1/share', { body: new Uint8Array(n).fill(7) }), e);

test('subir y bajar: los mismos bytes, id opaco, caducidad, y se cuenta cada operación', async () => {
  const e = env();
  const up = await subir(e, 4);
  assert.equal(up.status, 201);
  const { id, expiresAt, deleteToken } = await up.json();
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  assert.ok(deleteToken && deleteToken !== id);
  assert.ok(expiresAt > Date.now() + 6 * 86400000);
  const down = await worker.fetch(req('GET', '/v1/share/' + id), e);
  assert.equal(down.status, 200);
  assert.deepEqual(new Uint8Array(await down.arrayBuffer()), new Uint8Array(4).fill(7));
  const u = await usage(e);
  assert.equal(u.classA.ops, 1);
  assert.equal(u.classB.ops, 1);
  assert.equal(u.storage.bytes, 4);
  assert.equal(u.links, 1);
});

test('subir: sin origen permitido, sin longitud o por encima del tope por fichero, no', async () => {
  const e = env();
  const otro = await worker.fetch(new Request('https://share.test/v1/share', { method: 'POST', body: 'x', headers: { Origin: 'https://evil.test', 'Content-Length': '1' } }), e);
  assert.equal(otro.status, 403);
  assert.equal((await subir(e, 1001)).status, 413);
  assert.equal(e.SHARES._m.size, 0);
});

test('TOPE DE ALMACENAMIENTO: lo que no cabe no se sube, y no se toca R2', async () => {
  const e = env({ CAP_STORAGE_BYTES: '10' });
  assert.equal((await subir(e, 6)).status, 201);
  const r = await subir(e, 5);                    // 6 + 5 > 10
  assert.equal(r.status, 507);
  assert.equal((await r.json()).error, 'capacity');
  assert.equal(e.SHARES._ops.put, 1);             // el rechazado ni llegó a R2
  assert.equal((await subir(e, 4)).status, 201);  // 6 + 4 = 10: cabe justo
  assert.equal((await usage(e)).refused, 1);
});

test('lo caducado cuenta hasta que la purga lo borra (R2 lo cobra igual)', async () => {
  const e = env({ CAP_STORAGE_BYTES: '10' });
  const { id } = await (await subir(e, 8)).json();
  e.DB._raw.prepare('UPDATE shares SET expires_at = ? WHERE id = ?').run(Date.now() - 1, id);
  assert.equal((await subir(e, 5)).status, 507);
  assert.equal(await purge(e), 1);
  assert.equal(e.SHARES._m.size, 0);
  assert.equal((await subir(e, 5)).status, 201);
  assert.equal(e.SHARES._ops.list, 0);            // la purga no lista R2 (clase A)
});

test('TOPE DE ESCRITURAS (clase A) del mes', async () => {
  const e = env({ CAP_CLASS_A: '2' });
  assert.equal((await subir(e)).status, 201);
  assert.equal((await subir(e)).status, 201);
  assert.equal((await subir(e)).status, 507);
  assert.equal(e.SHARES._ops.put, 2);
  // La reserva del rechazado se deshizo: no ocupa almacenamiento.
  assert.equal((await usage(e)).storage.bytes, 6);
});

test('TOPE DE LECTURAS (clase B) del mes, y un mes nuevo empieza de cero', async () => {
  const e = env({ CAP_CLASS_B: '1' });
  const { id } = await (await subir(e)).json();
  assert.equal((await worker.fetch(req('GET', '/v1/share/' + id), e)).status, 200);
  const r = await worker.fetch(req('GET', '/v1/share/' + id), e);
  assert.equal(r.status, 503);
  assert.equal(e.SHARES._ops.get, 1);
  const nextMonth = Date.now() + 40 * 86400000;
  assert.equal(await spend(e, 'b', nextMonth), true);
});

test('lo que no existe o caducó se contesta sin gastar una lectura de R2', async () => {
  const e = env();
  const { id } = await (await subir(e)).json();
  e.DB._raw.prepare('UPDATE shares SET expires_at = ? WHERE id = ?').run(Date.now() - 1, id);
  assert.equal((await worker.fetch(req('GET', '/v1/share/' + id), e)).status, 410);
  assert.equal((await worker.fetch(req('GET', '/v1/share/' + 'A'.repeat(22)), e)).status, 404);
  assert.equal((await worker.fetch(req('GET', '/v1/share/../../x'), e)).status, 404);
  assert.equal(e.SHARES._ops.get, 0);
  assert.equal((await usage(e)).classB.ops, 0);
});

test('límite de subidas por IP', async () => {
  const e = env({ UPLOADS: { limit: async () => ({ success: false }) } });
  assert.equal((await subir(e)).status, 429);
});

test('revocar: solo con el token de quien lo subió, y libera el sitio', async () => {
  const e = env();
  const { id, deleteToken } = await (await subir(e)).json();
  assert.equal((await worker.fetch(req('DELETE', '/v1/share/' + id, { headers: { 'X-Delete-Token': 'otro' } }), e)).status, 403);
  assert.equal((await worker.fetch(req('DELETE', '/v1/share/' + id, { headers: { 'X-Delete-Token': deleteToken } }), e)).status, 200);
  assert.equal((await worker.fetch(req('GET', '/v1/share/' + id), e)).status, 404);
  assert.equal((await usage(e)).storage.bytes, 0);
});

test('/v1/usage: solo con el token, y en % de lo gratis', async () => {
  const e = env();
  await subir(e);
  assert.equal((await worker.fetch(new Request('https://share.test/v1/usage'), e)).status, 403);
  const r = await worker.fetch(new Request('https://share.test/v1/usage', { headers: { Authorization: 'Bearer secreto' } }), e);
  assert.equal(r.status, 200);
  const u = await r.json();
  assert.equal(u.classA.ops, 1);
  assert.equal(u.classA.cap, 800000);
  assert.equal(u.storage.cap, 8 * 1024 ** 3);
});

test('D1 caído: 503, nunca R2 a ciegas', async () => {
  const e = env();
  e.DB = { prepare() { throw new Error('D1 sin cuota'); } };
  assert.equal((await subir(e)).status, 503);
  assert.equal(e.SHARES._ops.put, 0);
});

test('CORS: preflight con los métodos y la cabecera del token', async () => {
  const r = await worker.fetch(req('OPTIONS', '/v1/share'), env());
  assert.equal(r.status, 204);
  assert.match(r.headers.get('Access-Control-Allow-Methods'), /DELETE/);
  assert.match(r.headers.get('Access-Control-Allow-Headers'), /X-Delete-Token/);
});
