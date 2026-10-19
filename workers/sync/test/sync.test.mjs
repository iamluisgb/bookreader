// Tests del sync de BookReader (MON4 F1). D1 = SQLite de verdad (node:sqlite) con las MISMAS
// migraciones; R2 = un doble en memoria con la API que usa el Worker (y que falla si se lista).
// Lo que más importa: que el If-Match sea de verdad atómico, que nadie lea lo de otro, que las
// cuotas por usuario y los topes globales se cumplan, y que nunca se pase de lo gratis.
//
//   npm run test:sync

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker, { purge, usage, checkLicense } from '../src/index.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async run() { this.db.prepare(this.sql).run(...this.args); return { success: true }; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
}
export function nuevaDB() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).sort()) db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  return { prepare: (sql) => new Stmt(db, sql), _raw: db };
}
export function fakeR2() {
  const m = new Map();
  const uploads = new Map();
  const ops = { put: 0, get: 0, list: 0, parts: 0 };
  const r2 = {
    _m: m, _ops: ops, _uploads: uploads, onPut: null,
    async put(key, body) {
      ops.put++;
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      if (r2.onPut) { const f = r2.onPut; r2.onPut = null; await f(key); }
      m.set(key, bytes);
      return { key, size: bytes.length };
    },
    async get(key) { ops.get++; const b = m.get(key); return b ? { body: new Blob([b]).stream(), size: b.length } : null; },
    async delete(keys) { for (const k of [].concat(keys)) m.delete(k); },
    async list() { ops.list++; throw new Error('listar R2 es clase A: no se usa'); },
    async createMultipartUpload(key) {
      const uploadId = 'up' + (uploads.size + 1) + Math.random().toString(36).slice(2, 6);
      uploads.set(uploadId, { key, parts: new Map() });
      return r2.resumeMultipartUpload(key, uploadId);
    },
    resumeMultipartUpload(key, uploadId) {
      return {
        key, uploadId,
        async uploadPart(n, body) {
          const u = uploads.get(uploadId);
          if (!u) throw new Error('upload desconocido');
          ops.parts++;
          u.parts.set(n, new Uint8Array(await new Response(body).arrayBuffer()));
          return { partNumber: n, etag: 'p' + n };
        },
        async complete(parts) {
          const u = uploads.get(uploadId);
          if (!u) throw new Error('upload desconocido');
          const chunks = parts.map((p) => u.parts.get(p.partNumber));
          const total = chunks.reduce((a, c) => a + c.length, 0);
          const out = new Uint8Array(total);
          let o = 0;
          for (const c of chunks) { out.set(c, o); o += c.length; }
          m.set(key, out);
          uploads.delete(uploadId);
          return { key, size: total };
        },
        async abort() { uploads.delete(uploadId); },
      };
    },
  };
  return r2;
}
export const ORIGIN = 'https://bookreader.raiatech.com';
export const env = (extra = {}) => ({
  SYNC: fakeR2(), DB: nuevaDB(), ALLOWED_ORIGINS: ORIGIN, ALLOW_MOCK_LICENSES: '1',
  USAGE_TOKEN: 'secreto', DATA_QUOTA_BYTES: '1000', FILE_QUOTA_BYTES: '5000', FILES_ENABLED: '1',
  MAX_BYTES: '4000', ...extra,
});
const P1 = 'a'.repeat(43);
const P2 = 'b'.repeat(43);

function req(method, path, { body, headers = {}, token } = {}) {
  const h = { Origin: ORIGIN, ...headers };
  if (token) h.Authorization = 'Bearer ' + token;
  if (body !== undefined && typeof body !== 'string') h['Content-Length'] = String(body.length);
  if (typeof body === 'string') h['Content-Type'] = 'application/json';
  return new Request('https://sync.test' + path, { method, body, headers: h });
}
async function login(e, license = 'BKRD-TEST-0001') {
  const r = await worker.fetch(req('POST', '/v1/sync-token', { body: JSON.stringify({ license }) }), e);
  return { status: r.status, ...(await r.json()) };
}
const bytes = (n, v = 7) => new Uint8Array(n).fill(v);
const put = (e, token, path, n, headers = {}) => worker.fetch(req('PUT', '/v1/o/' + path, { body: bytes(n, n % 250), token, headers }), e);
const get = (e, token, path) => worker.fetch(req('GET', '/v1/o/' + path, { token }), e);

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// ---- Identidad -------------------------------------------------------------------------

test('token: la licencia de prueba da un token de escritura; sin Polar configurado, 503', async () => {
  const e = env();
  const s = await login(e);
  assert.equal(s.status, 200);
  assert.match(s.token, /^br-sync-/);
  assert.equal(s.readOnly, false);
  assert.equal(s.files, true);
  const sinMock = env({ ALLOW_MOCK_LICENSES: '' });
  assert.equal((await login(sinMock)).status, 503);
  assert.equal((await login(sinMock)).error, 'not_configured');
});

test('token: un Pro sin suscripción no entra; una key revocada sin datos tampoco', async () => {
  const e = env();
  assert.deepEqual([(await login(e, 'BKRD-TEST-NOSUB')).status, (await login(e, 'BKRD-TEST-NOSUB')).error], [403, 'not_subscribed']);
  assert.deepEqual([(await login(e, 'BKRD-TEST-REVOKED')).status, (await login(e, 'BKRD-TEST-REVOKED')).error], [403, 'lapsed']);
});

test('token: se valida contra Polar en el servidor (estado, benefit y caducidad)', async () => {
  const calls = [];
  const polar = (lk, status = 200) => async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(lk), { status });
  };
  const e = { POLAR_ORG_ID: 'org_1', SYNC_BENEFIT_IDS: 'ben_sync' };
  assert.equal(await checkLicense(e, 'K', polar({ status: 'granted', benefit_id: 'ben_sync' })), 'granted');
  assert.deepEqual(calls[0], { url: 'https://api.polar.sh/v1/customer-portal/license-keys/validate', body: { key: 'K', organization_id: 'org_1' } });
  assert.equal(await checkLicense(e, 'K', polar({ status: 'granted', benefit_id: 'ben_pro' })), 'not_subscribed');
  assert.equal(await checkLicense(e, 'K', polar({ status: 'revoked', benefit_id: 'ben_sync' })), 'lapsed');
  assert.equal(await checkLicense(e, 'K', polar({ status: 'granted', benefit_id: 'ben_sync', expires_at: '2020-01-01T00:00:00Z' })), 'lapsed');
  assert.equal(await checkLicense(e, 'K', polar({}, 404)), 'invalid');
  await assert.rejects(checkLicense(e, 'K', polar({}, 500)), /polar_500/);
  // Las keys de prueba NO valen en producción (sin ALLOW_MOCK_LICENSES).
  assert.equal(await checkLicense(e, 'BKRD-TEST-0001', polar({}, 404)), 'invalid');
});

test('sin token, o con uno inventado o caducado: 401', async () => {
  const e = env({ TOKEN_HOURS: '0' });
  const { token } = await login(e);
  assert.equal((await get(e, token, P1)).status, 401);   // caducó al instante
  assert.equal((await get(e, 'br-sync-inventado', P1)).status, 401);
  assert.equal((await worker.fetch(req('GET', '/v1/list'), e)).status, 401);
});

// ---- Objetos ---------------------------------------------------------------------------

test('escribir y leer: los mismos bytes, el nombre cifrado y un etag; el listado sale de D1', async () => {
  const e = env();
  const { token } = await login(e);
  const w = await put(e, token, P1, 5, { 'X-Name': 'nombre-cifrado' });
  assert.equal(w.status, 200);
  const { etag } = await w.json();
  assert.match(etag, /^[A-Za-z0-9_-]{22}$/);
  const r = await get(e, token, P1);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('ETag'), etag);
  assert.equal(r.headers.get('X-Name'), 'nombre-cifrado');
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), bytes(5, 5));
  const l = await (await worker.fetch(req('GET', '/v1/list', { token }), e)).json();
  assert.deepEqual(l.items.map((i) => [i.path, i.name, i.etag, i.size]), [[P1, 'nombre-cifrado', etag, 5]]);
  const meta = await (await worker.fetch(req('GET', '/v1/meta/' + P1, { token }), e)).json();
  assert.equal(meta.etag, etag);
  assert.equal(e.SYNC._ops.list, 0);
  assert.equal((await get(e, token, P2)).status, 404);
});

test('lo de un usuario no lo ve otro', async () => {
  const e = env();
  const a = await login(e, 'BKRD-USER-AAAA');
  const b = await login(e, 'BKRD-USER-BBBB');
  await put(e, a.token, P1, 5);
  assert.equal((await get(e, b.token, P1)).status, 404);
  const l = await (await worker.fetch(req('GET', '/v1/list', { token: b.token }), e)).json();
  assert.deepEqual(l.items, []);
});

test('IF-MATCH: un etag viejo da 412 sin tocar R2; el bueno escribe', async () => {
  const e = env();
  const { token } = await login(e);
  const e1 = (await (await put(e, token, P1, 3)).json()).etag;
  const e2 = (await (await put(e, token, P1, 4, { 'If-Match': e1 })).json()).etag;
  const puts = e.SYNC._ops.put;
  const r = await put(e, token, P1, 5, { 'If-Match': e1 });
  assert.equal(r.status, 412);
  assert.equal((await r.json()).etag, e2);
  assert.equal(e.SYNC._ops.put, puts);
  assert.equal((await get(e, token, P1)).headers.get('ETag'), e2);
});

test('IF-MATCH ATÓMICO: si otro escribe mientras subo, pierdo con 412 y mi copia se borra', async () => {
  const e = env();
  const { token } = await login(e);
  const e1 = (await (await put(e, token, P1, 3)).json()).etag;
  // Mientras R2 recibe mi subida, otro dispositivo escribe la misma ruta con el mismo If-Match.
  let otro;
  e.SYNC.onPut = async () => { otro = await put(e, token, P1, 9, { 'If-Match': e1 }); };
  const r = await put(e, token, P1, 4, { 'If-Match': e1 });
  assert.equal(otro.status, 200);
  assert.equal(r.status, 412);
  const ganador = (await otro.json()).etag;
  assert.equal((await get(e, token, P1)).headers.get('ETag'), ganador);
  // En R2 queda solo la clave del ganador: ni la mía ni la anterior (sin versiones).
  assert.equal(e.SYNC._m.size, 1);
  const n = e.DB._raw.prepare('SELECT COUNT(*) AS n FROM blobs').get().n;
  assert.equal(n, 1);
});

test('sin X-Keep-Versions, sobrescribir borra la clave anterior; con él, quedan las N últimas', async () => {
  const e = env({ MAX_VERSIONS: '3', DATA_QUOTA_BYTES: '100000' });
  const { token } = await login(e);
  for (let i = 1; i <= 3; i++) await put(e, token, P1, i);
  assert.equal(e.SYNC._m.size, 1);
  for (let i = 1; i <= 6; i++) await put(e, token, P2, 10 + i, { 'X-Keep-Versions': '1' });
  const v = await (await worker.fetch(req('GET', '/v1/versions/' + P2, { token }), e)).json();
  assert.deepEqual(v.versions.map((x) => x.size), [15, 14, 13]);
  const old = await worker.fetch(req('GET', `/v1/versions/${P2}/${v.versions[2].id}`, { token }), e);
  assert.deepEqual(new Uint8Array(await old.arrayBuffer()), bytes(13, 13));
  assert.equal(e.SYNC._m.size, 1 + 1 + 3);
});

test('borrar: idempotente, y se lleva las versiones', async () => {
  const e = env({ DATA_QUOTA_BYTES: '100000' });
  const { token } = await login(e);
  await put(e, token, P1, 3, { 'X-Keep-Versions': '1' });
  await put(e, token, P1, 4, { 'X-Keep-Versions': '1' });
  assert.equal((await worker.fetch(req('DELETE', '/v1/o/' + P1, { token }), e)).status, 200);
  assert.equal((await worker.fetch(req('DELETE', '/v1/o/' + P1, { token }), e)).status, 200);
  assert.equal(e.SYNC._m.size, 0);
  assert.equal((await get(e, token, P1)).status, 404);
});

test('rutas: solo hashes opacos; nada de barras ni nombres en claro', async () => {
  const e = env();
  const { token } = await login(e);
  assert.equal((await put(e, token, 'books%2Fabc.json', 3)).status, 404);
  assert.equal((await put(e, token, 'corto', 3)).status, 404);
  const largo = await put(e, token, P1, 3, { 'X-Name': 'x'.repeat(3000) });
  assert.equal(largo.status, 400);
});

// ---- Cuotas y topes --------------------------------------------------------------------

test('CUOTA DE DATOS por usuario: lo que no cabe da 507 quota y no toca R2; las versiones cuentan', async () => {
  const e = env({ DATA_QUOTA_BYTES: '10' });
  const { token } = await login(e);
  assert.equal((await put(e, token, P1, 6, { 'X-Keep-Versions': '1' })).status, 200);
  const r = await put(e, token, P1, 5, { 'X-Keep-Versions': '1' });   // 6 + 5 > 10
  assert.equal(r.status, 507);
  assert.equal((await r.json()).error, 'quota');
  assert.equal(e.SYNC._m.size, 1);
  // Otro usuario tiene su propia cuota.
  const b = await login(e, 'BKRD-USER-BBBB');
  assert.equal((await put(e, b.token, P1, 6)).status, 200);
});

test('FICHEROS: apagados por defecto (opción B); con la cuota llena, los datos siguen', async () => {
  const off = env({ FILES_ENABLED: '0' });
  const s = await login(off);
  assert.equal(s.files, false);
  const r = await put(off, s.token, P1, 3, { 'X-Kind': 'file' });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'files_disabled');

  const e = env({ FILE_QUOTA_BYTES: '10' });
  const { token } = await login(e);
  assert.equal((await put(e, token, P1, 8, { 'X-Kind': 'file' })).status, 200);
  const lleno = await put(e, token, P2, 8, { 'X-Kind': 'file' });
  assert.equal(lleno.status, 507);
  assert.equal((await lleno.json()).error, 'quota');
  assert.equal((await put(e, token, 'c'.repeat(43), 8)).status, 200);   // un dato sí entra
  const st = await (await worker.fetch(req('GET', '/v1/status', { token }), e)).json();
  assert.deepEqual(st.used, { data: 8, versions: 0, files: 8 });
  assert.deepEqual(st.quota, { data: 1000, files: 10 });
});

test('TOPE GLOBAL de almacenamiento: 507 capacity aunque el usuario tenga cuota', async () => {
  const e = env({ CAP_STORAGE_BYTES: '10' });
  const a = await login(e, 'BKRD-USER-AAAA');
  const b = await login(e, 'BKRD-USER-BBBB');
  assert.equal((await put(e, a.token, P1, 6)).status, 200);
  const r = await put(e, b.token, P1, 6);
  assert.equal(r.status, 507);
  assert.equal((await r.json()).error, 'capacity');
  assert.equal((await usage(e)).refused, 1);
});

test('TOPES DE OPERACIONES del mes: escrituras (A) y lecturas (B)', async () => {
  const e = env({ CAP_CLASS_A: '2', CAP_CLASS_B: '1' });
  const { token } = await login(e);
  assert.equal((await put(e, token, P1, 1)).status, 200);
  assert.equal((await put(e, token, P1, 2)).status, 200);
  assert.equal((await put(e, token, P1, 3)).status, 507);
  assert.equal((await get(e, token, P1)).status, 200);
  assert.equal((await get(e, token, P1)).status, 503);
  // Lo que no existe no gasta lectura.
  assert.equal((await get(e, token, P2)).status, 404);
});

test('cuerpo: sin longitud 411; por encima de MAX_BYTES 413', async () => {
  const e = env();
  const { token } = await login(e);
  assert.equal((await put(e, token, P1, 4001)).status, 413);
  const sin = await worker.fetch(new Request('https://sync.test/v1/o/' + P1, {
    method: 'PUT', headers: { Origin: ORIGIN, Authorization: 'Bearer ' + token },
  }), e);
  assert.equal(sin.status, 411);
});

test('límite de escrituras por usuario y minuto', async () => {
  const vistos = [];
  const e = env({ WRITES: { limit: async ({ key }) => { vistos.push(key); return { success: false }; } } });
  const { token } = await login(e);
  assert.equal((await put(e, token, P1, 3)).status, 429);
  assert.match(vistos[0], /^[0-9a-f]{64}$/);   // por usuario (hash), no por IP
  assert.equal(e.SYNC._ops.put, 0);
});

// ---- Suscripción caducada --------------------------------------------------------------

test('CADUCA LA SUSCRIPCIÓN: solo lectura durante GRACE_DAYS, después 403 y la purga lo borra', async () => {
  const e = env({ ALLOW_MOCK_LICENSES: '', POLAR_ORG_ID: 'org_1' });
  let estado = 'granted';
  globalThis.fetch = async () => new Response(JSON.stringify({ status: estado, benefit_id: 'b' }));
  const { token } = await login(e, 'KEY-REAL');
  await put(e, token, P1, 5);

  estado = 'revoked';
  const ro = await login(e, 'KEY-REAL');
  assert.equal(ro.status, 200);
  assert.equal(ro.readOnly, true);
  assert.ok(ro.purgeAt > Date.now() + 29 * 86400000);
  assert.equal((await get(e, ro.token, P1)).status, 200);              // leer y exportar, sí
  const w = await put(e, ro.token, P1, 6);
  assert.equal(w.status, 403);
  assert.equal((await w.json()).error, 'read_only');
  assert.equal((await worker.fetch(req('DELETE', '/v1/o/' + P1, { token: ro.token }), e)).status, 403);

  // Pasados los días de gracia, ni token ni datos.
  e.DB._raw.prepare('UPDATE users SET lapsed_at = ?').run(Date.now() - 31 * 86400000);
  assert.equal((await login(e, 'KEY-REAL')).status, 403);
  const p = await purge(e);
  assert.equal(p.users, 1);
  assert.equal(e.SYNC._m.size, 0);
  assert.equal(e.DB._raw.prepare('SELECT COUNT(*) AS n FROM objects').get().n, 0);

  // Renovar dentro de plazo devuelve la escritura.
  estado = 'granted';
  const back = await login(e, 'KEY-REAL');
  assert.equal(back.readOnly, false);
});

// ---- Mantenimiento ---------------------------------------------------------------------

test('purga: tokens caducados, versiones viejas y subidas que nunca terminaron', async () => {
  const e = env({ DATA_QUOTA_BYTES: '100000' });
  const { token } = await login(e);
  await put(e, token, P1, 3, { 'X-Keep-Versions': '1' });
  await put(e, token, P1, 4, { 'X-Keep-Versions': '1' });
  e.DB._raw.prepare(`INSERT INTO blobs (key, user, path, size, kind, state, created_at) VALUES ('u/x/y/z', 'x', 'y', 9, 'file', 'pending', 0)`).run();
  const later = Date.now() + 31 * 86400000;
  const p = await purge(e, later);
  assert.deepEqual(p, { tokens: 1, users: 0, versions: 1, pending: 1 });
  assert.equal(e.SYNC._m.size, 1);   // queda la versión actual
});

test('empezar de cero: /v1/all borra todo lo del usuario y nada de otros', async () => {
  const e = env();
  const a = await login(e, 'BKRD-USER-AAAA');
  const b = await login(e, 'BKRD-USER-BBBB');
  await put(e, a.token, P1, 3);
  await put(e, b.token, P1, 3);
  assert.equal((await worker.fetch(req('DELETE', '/v1/all', { token: a.token }), e)).status, 200);
  assert.equal((await get(e, a.token, P1)).status, 404);
  assert.equal((await get(e, b.token, P1)).status, 200);
});

test('/v1/usage: solo con el token, y en % de lo gratis', async () => {
  const e = env();
  const { token } = await login(e);
  await put(e, token, P1, 5);
  assert.equal((await worker.fetch(new Request('https://sync.test/v1/usage'), e)).status, 403);
  const u = await (await worker.fetch(new Request('https://sync.test/v1/usage', { headers: { Authorization: 'Bearer secreto' } }), e)).json();
  assert.equal(u.users.active, 1);
  assert.equal(u.storage.bytes, 5);
  assert.equal(u.classA.ops, 1);
});

test('D1 caído: 503, nunca R2 a ciegas', async () => {
  const e = env();
  const { token } = await login(e);
  e.DB = { prepare() { throw new Error('D1 down'); } };
  assert.equal((await put(e, token, P1, 3)).status, 503);
  assert.equal(e.SYNC._ops.put, 0);
});

test('CORS: preflight con las cabeceras del protocolo, y ETag/X-Name visibles para el JS', async () => {
  const e = env();
  const r = await worker.fetch(new Request('https://sync.test/v1/o/' + P1, { method: 'OPTIONS', headers: { Origin: ORIGIN } }), e);
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  for (const h of ['Authorization', 'If-Match', 'X-Name', 'X-Kind', 'X-Keep-Versions']) {
    assert.ok(r.headers.get('Access-Control-Allow-Headers').includes(h), h);
  }
  assert.match(r.headers.get('Access-Control-Expose-Headers'), /ETag.*X-Name/);
  const otro = await worker.fetch(new Request('https://sync.test/v1/sync-token', { method: 'POST', body: '{}', headers: { Origin: 'https://evil.test' } }), e);
  assert.equal(otro.status, 403);
});
