// MON1 F4 · El gateway sirve a dos apps (bookreader y arete). Lo que se fija aquí es
// la procedencia: cada token nace con su producto, solo puede usar los alias de ese
// producto, y el consumo queda desglosado.
//
// El worker se conduce entero contra SQLite real (ver test/harness.mjs).
//
//   node --test workers/gateway/test/

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { aliasesFor, ROUTING, PRODUCTS } from '../src/index.js';
import { nuevoEnv, stubUpstream, llamar, pedirDemo as pedirDemoEn } from './harness.mjs';

let env, upstream;

beforeEach(() => {
  env = nuevoEnv();
  upstream = stubUpstream();
});

const call = (path, init = {}) => llamar(env, path, init);
const pedirDemo = (product) => pedirDemoEn(env, product);

const chat = (token, model, extra = {}) => call('/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hola' }], stream: false, ...extra }),
});

// ---- cupo visible (F5) --------------------------------------------------------

test('cada respuesta dice cuánto queda Y sobre cuánto: el % no depende del cliente', async () => {
  const { body } = await pedirDemo('arete');
  assert.equal(body.quota, 3);

  const res = await chat(body.token, 'arete-fast');
  assert.equal(res.headers.get('X-Quota-Remaining'), '2');
  assert.equal(res.headers.get('X-Quota-Total'), '3');
  // Recibirlas no basta: sin exponerlas, el navegador no deja que el JS las lea.
  const expuestas = res.headers.get('Access-Control-Expose-Headers') || '';
  assert.match(expuestas, /X-Quota-Remaining/);
  assert.match(expuestas, /X-Quota-Total/);
});

test('el total se congela al emitir: subir DEMO_QUOTA no mueve la barra de un token vivo', async () => {
  const { body } = await pedirDemo('arete');
  env.DEMO_QUOTA = '500';                       // se sube la cuota a mitad de camino
  const res = await chat(body.token, 'arete-fast');
  assert.equal(res.headers.get('X-Quota-Total'), '3', 'el denominador es el del día de la emisión');
});

test('las llamadas auxiliares no descuentan cupo, pero sí exigen tenerlo', async () => {
  const { body } = await pedirDemo('bookreader');

  const aux = await chat(body.token, 'bookreader-lite');
  assert.equal(aux.status, 200);
  assert.equal(aux.headers.get('X-Quota-Remaining'), '3', 'el alias lite es gratis');
  assert.equal(upstream[0].body.model, 'qwen3.6');

  // Agotar el cupo con las que sí cuentan y comprobar que la auxiliar deja de pasar:
  // media app funcionando con el cupo agotado sería inexplicable para el usuario.
  for (let i = 0; i < 3; i++) await chat(body.token, 'bookreader-fast');
  const sinCupo = await chat(body.token, 'bookreader-lite');
  assert.equal(sinCupo.status, 403);
  assert.equal((await sinCupo.json()).error.code, 'demo_exhausted');
});

test('las auxiliares siguen contando para el disyuntor diario (es antiabuso)', async () => {
  const { body } = await pedirDemo('bookreader');
  await chat(body.token, 'bookreader-lite');
  const row = await env.DB.prepare('SELECT demo_calls FROM daily_stats').first();
  assert.equal(row.demo_calls, 1);
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
