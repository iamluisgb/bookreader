// MON1 F3.1 · `GET /quota` — el estado del token SIN gastar una llamada.
//
// Existe para el traspaso de la demo a otro dispositivo: el que recibe el enlace tiene
// que decidir si guardarlo ANTES de preguntar nada. Lo que se fija aquí es lo que hace
// esa decisión posible: un token inválido se distingue de uno bueno, consultar no
// cuesta cupo, y la respuesta trae la configuración entera (alias incluidos), que es la
// mitad que falta — un token suelto no basta para llamar.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { aliasesFor } from '../src/index.js';
import { nuevoEnv, stubUpstream, llamar, pedirDemo as pedirDemoEn } from './harness.mjs';

let env;

beforeEach(() => {
  env = nuevoEnv();
  stubUpstream();
});

const pedirDemo = (product) => pedirDemoEn(env, product);

const quota = async (token) => {
  const res = await llamar(env, '/quota', { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, headers: res.headers, body: await res.json() };
};

const chat = (token, model) => llamar(env, '/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hola' }], stream: false }),
});

test('devuelve cupo y configuración completa: token, base y alias van juntos', async () => {
  const { body: demo } = await pedirDemo('bookreader');
  const { status, body } = await quota(demo.token);

  assert.equal(status, 200);
  assert.equal(body.remaining, 3);
  assert.equal(body.quota, 3);
  assert.equal(body.tier, 'demo');
  assert.equal(body.product, 'bookreader');
  // El alias es lo que el dispositivo que recibe el enlace tiene que escribir en
  // `ai_model`: sin él, el token guardado apunta a un modelo que no existe.
  assert.deepEqual(body.models, aliasesFor('bookreader'));
  assert.equal(body.model, aliasesFor('bookreader')[0]);
});

test('consultar el cupo no lo gasta', async () => {
  const { body: demo } = await pedirDemo('bookreader');
  await quota(demo.token);
  await quota(demo.token);
  const { body } = await quota(demo.token);
  assert.equal(body.remaining, 3);
});

test('el cupo que devuelve es el de verdad, no el de emisión', async () => {
  const { body: demo } = await pedirDemo('bookreader');
  await chat(demo.token, 'bookreader-fast');
  const { body, headers } = await quota(demo.token);

  assert.equal(body.remaining, 2);
  // Mismas cabeceras que el chat: el cliente tiene UN solo camino para leer el cupo.
  assert.equal(headers.get('X-Quota-Remaining'), '2');
  assert.equal(headers.get('X-Quota-Total'), '3');
});

// Sin esto, un enlace mal copiado dejaría la app configurada contra el gateway con una
// key que solo sabe devolver 401 — y el usuario concluiría que la demo nace rota.
test('un token inventado es 401, no un 200 vacío', async () => {
  const { status, body } = await quota('br-demo-noexiste');
  assert.equal(status, 401);
  assert.equal(body.error.code, 'invalid_token');
});

test('un token revocado también es 401', async () => {
  const { body: demo } = await pedirDemo('bookreader');
  await env.DB.prepare('UPDATE tokens SET active = 0 WHERE token = ?1').bind(demo.token).run();
  const { status } = await quota(demo.token);
  assert.equal(status, 401);
});

test('un token agotado sigue siendo válido: el traspaso puede decir POR QUÉ no vale', async () => {
  const { body: demo } = await pedirDemo('bookreader');
  for (let i = 0; i < 3; i++) await chat(demo.token, 'bookreader-fast');
  const { status, body } = await quota(demo.token);

  assert.equal(status, 200);
  assert.equal(body.remaining, 0);
});

test('el cupo de arete se consulta igual y trae SUS alias', async () => {
  const { body: demo } = await pedirDemo('arete');
  const { body } = await quota(demo.token);
  assert.equal(body.product, 'arete');
  assert.deepEqual(body.models, aliasesFor('arete'));
});

test('las cabeceras de cupo son legibles desde el navegador (CORS)', async () => {
  const { body: demo } = await pedirDemo('bookreader');
  const res = await llamar(env, '/quota', {
    headers: { Authorization: `Bearer ${demo.token}`, Origin: 'https://bookreader.raiatech.com' },
  });
  assert.match(res.headers.get('Access-Control-Expose-Headers') || '', /X-Quota-Remaining/);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://bookreader.raiatech.com');
});
