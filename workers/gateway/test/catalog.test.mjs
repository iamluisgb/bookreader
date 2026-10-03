// GET /catalog/:provider — el catálogo de modelos para el cliente BYOK.
//
// Por qué existe: nan responde a /v1/models sin cabeceras CORS, así que la app no podía
// leer la lista aunque el usuario tuviera su clave, y había que escribir el modelo a mano.
// Lo que se fija: se pide al proveedor con NUESTRA clave (la del usuario no viaja), se
// clasifica cada modelo, sale con el CORS del origen y un proveedor desconocido es 404.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nuevoEnv, llamar } from './harness.mjs';
import { modelKind } from '../src/index.js';

function stubModels(ids, status = 200) {
  const llamadas = [];
  globalThis.fetch = async (url, init = {}) => {
    llamadas.push({ url, auth: init.headers?.Authorization });
    return new Response(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) }),
      { status, headers: { 'Content-Type': 'application/json' } });
  };
  return llamadas;
}

test('lista los modelos de nan con su tipo, pedidos con la clave del gateway y con CORS', async () => {
  const env = nuevoEnv();
  const llamadas = stubModels(['qwen3.8-flash', 'whisper', 'kokoro', 'qwen3-embedding', 'rerank', 'flux-2-klein', 'qwen-image-2.1', 'deepseek-v4-flash']);
  const res = await llamar(env, '/catalog/nan', { headers: { Origin: 'https://bookreader.raiatech.com', Authorization: 'Bearer sk-del-usuario' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://bookreader.raiatech.com');
  assert.match(res.headers.get('Cache-Control'), /max-age=3600/);
  const body = await res.json();
  assert.equal(body.provider, 'nan');
  const kinds = Object.fromEntries(body.models.map((m) => [m.id, m.kind]));
  assert.deepEqual(kinds, {
    'deepseek-v4-flash': 'chat', 'flux-2-klein': 'image', 'kokoro': 'tts', 'qwen-image-2.1': 'image',
    'qwen3-embedding': 'embedding', 'qwen3.8-flash': 'chat', 'rerank': 'rerank', 'whisper': 'stt',
  });
  // Al proveedor va NUESTRA clave; la que mandó el cliente no sale del gateway.
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].url, 'https://proveedor.test/v1/models');
  assert.equal(llamadas[0].auth, 'Bearer k');
});

test('proveedor desconocido: 404; proveedor caído: 502 sin lista', async () => {
  const env = nuevoEnv();
  stubModels([]);
  assert.equal((await llamar(env, '/catalog/otro')).status, 404);
  stubModels(['x'], 500);
  assert.equal((await llamar(env, '/catalog/nan')).status, 502);
});

test('modelKind: lo que no es de imagen, voz, embeddings ni rerank es chat', () => {
  assert.equal(modelKind('glm5.3-flash'), 'chat');
  assert.equal(modelKind('mimo-v2.6-flash'), 'chat');
  assert.equal(modelKind('qwen3-embedding'), 'embedding');
});
