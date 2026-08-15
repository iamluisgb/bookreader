// MON1 F4 · El gateway sirve a dos apps (bookreader y arete). Lo que se fija aquí es
// la procedencia: cada token nace con su producto, solo puede usar los alias de ese
// producto, y el consumo queda desglosado.
//
// D1 se sustituye por SQLite de verdad (node:sqlite) con las MISMAS migraciones que
// producción: un doble a mano tendría que fingir RETURNING, ON CONFLICT y date('now'),
// que es justo la parte donde vive la atomicidad que importa.
//
//   node --test workers/gateway/test/

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker, { aliasesFor, ROUTING, PRODUCTS } from '../src/index.js';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// Adaptador mínimo de la API de D1 (prepare/bind/first/run) sobre node:sqlite.
class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async run() { this.db.prepare(this.sql).run(...this.args); return { success: true }; }
}

function nuevaDB() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  return { prepare: (sql) => new Stmt(db, sql), _raw: db };
}

let env, upstream;

beforeEach(() => {
  env = {
    DB: nuevaDB(),
    NAN_API_KEY: 'k',
    NAN_BASE_URL: 'https://proveedor.test/v1',
    ALLOWED_ORIGINS: 'https://bookreader.raiatech.com,https://arete.raiatech.com',
    DEMO_QUOTA: '3',
    MAX_DAILY_TOKENS: '10',
    MAX_DAILY_CALLS: '50',
  };
  upstream = [];
  globalThis.fetch = async (url, init) => {
    upstream.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 5 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
});

const call = (path, init = {}) =>
  worker.fetch(new Request('https://gw.test' + path, init), env, { waitUntil: (p) => p });

const pedirDemo = async (product) => {
  const res = await call('/demo-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7' },
    ...(product ? { body: JSON.stringify({ product }) } : {}),
  });
  return { status: res.status, body: await res.json() };
};

const chat = (token, model) => call('/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hola' }], stream: false }),
});

// ---- routing -----------------------------------------------------------------

test('cada alias declara un producto conocido y cada producto tiene alias', () => {
  for (const [id, r] of Object.entries(ROUTING)) {
    assert.ok(PRODUCTS.includes(r.product), `${id} declara un producto desconocido`);
  }
  for (const p of PRODUCTS) assert.ok(aliasesFor(p).length > 0, `${p} se quedó sin alias`);
  assert.deepEqual(aliasesFor('arete'), ['arete-fast', 'arete-vision']);
});

// ---- emisión -----------------------------------------------------------------

test('el token de arete nace con su producto y su alias', async () => {
  const { status, body } = await pedirDemo('arete');
  assert.equal(status, 200);
  assert.equal(body.product, 'arete');
  assert.equal(body.model, 'arete-fast');
  assert.deepEqual(body.models, ['arete-fast', 'arete-vision']);

  const row = await env.DB.prepare('SELECT product FROM tokens WHERE token = ?1').bind(body.token).first();
  assert.equal(row.product, 'arete');
});

test('sin producto en el body se emite para bookreader (clientes ya desplegados)', async () => {
  const { status, body } = await pedirDemo(null);
  assert.equal(status, 200);
  assert.equal(body.product, 'bookreader');
  assert.equal(body.model, 'bookreader-fast');
});

test('un producto desconocido es un error, no un bookreader silencioso', async () => {
  const { status, body } = await pedirDemo('otracosa');
  assert.equal(status, 400);
  assert.equal(body.error.code, 'unknown_product');
});

test('probar una app no deja sin demo a la otra en la misma red y día', async () => {
  assert.equal((await pedirDemo('bookreader')).status, 200);
  assert.equal((await pedirDemo('arete')).status, 200, 'arete debería poder probarse igual');
  // Repetir el MISMO producto sí se rechaza: el límite por red sigue vivo.
  const repe = await pedirDemo('arete');
  assert.equal(repe.status, 429);
  assert.equal(repe.body.error.code, 'demo_already_granted');
});

// ---- uso ---------------------------------------------------------------------

test('un token de arete usa sus alias y NO los de bookreader', async () => {
  const { body } = await pedirDemo('arete');

  const ok = await chat(body.token, 'arete-fast');
  assert.equal(ok.status, 200);
  assert.equal(upstream[0].body.model, 'deepseek-v4-flash', 'el alias se traduce al modelo real');

  const cruzado = await chat(body.token, 'bookreader-fast');
  assert.equal(cruzado.status, 400);
  const err = await cruzado.json();
  assert.equal(err.error.code, 'model_not_found');
  assert.match(err.error.message, /arete-fast/, 'el error dice los alias que SÍ valen');
  assert.equal(upstream.length, 1, 'la llamada cruzada no llega al proveedor');
});

test('/v1/models solo lista los alias del producto del token', async () => {
  const { body } = await pedirDemo('arete');
  const res = await call('/v1/models', { headers: { Authorization: `Bearer ${body.token}` } });
  const ids = (await res.json()).data.map((m) => m.id);
  assert.deepEqual(ids, ['arete-fast', 'arete-vision']);
});

test('el cruce no gasta cuota del token', async () => {
  const { body } = await pedirDemo('arete');
  await chat(body.token, 'bookreader-fast');
  const row = await env.DB.prepare('SELECT remaining FROM tokens WHERE token = ?1').bind(body.token).first();
  assert.equal(row.remaining, Number(env.DEMO_QUOTA));
});

// ---- medición ----------------------------------------------------------------

test('el consumo se desglosa por producto sin perder el total global', async () => {
  const a = (await pedirDemo('arete')).body;
  const b = (await pedirDemo('bookreader')).body;
  await chat(a.token, 'arete-fast');
  await chat(a.token, 'arete-fast');
  await chat(b.token, 'bookreader-fast');

  const porProducto = {};
  for (const p of PRODUCTS) {
    porProducto[p] = await env.DB
      .prepare('SELECT tokens_issued, demo_calls, calls, real_input_tokens FROM product_stats WHERE product = ?1')
      .bind(p).first();
  }
  assert.equal(porProducto.arete.demo_calls, 2);
  assert.equal(porProducto.bookreader.demo_calls, 1);
  assert.equal(porProducto.arete.tokens_issued, 1);
  assert.equal(porProducto.arete.real_input_tokens, 14, 'usage real del proveedor, por producto');

  // La fila global —la que leen los disyuntores— sigue sumando las dos apps.
  const global = await env.DB.prepare('SELECT tokens_issued, demo_calls, calls FROM daily_stats').first();
  assert.equal(global.tokens_issued, 2);
  assert.equal(global.demo_calls, 3);
  assert.equal(global.calls, 3);
});

test('el disyuntor diario cuenta las dos apps juntas: es un solo presupuesto', async () => {
  env.MAX_DAILY_CALLS = '2';
  const a = (await pedirDemo('arete')).body;
  const b = (await pedirDemo('bookreader')).body;
  assert.equal((await chat(a.token, 'arete-fast')).status, 200);
  assert.equal((await chat(b.token, 'bookreader-fast')).status, 200);

  const tercera = await chat(a.token, 'arete-fast');
  assert.equal(tercera.status, 403);
  assert.equal((await tercera.json()).error.code, 'demo_paused');
});
