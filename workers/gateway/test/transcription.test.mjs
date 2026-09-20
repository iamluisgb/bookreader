// El dictado por proveedor (voz → texto) a través del gateway.
//
// Antes no existía la ruta: el cliente posteaba a `/v1/audio/transcriptions`, se comía
// el 404 genérico del worker y lo enseñaba como "el proveedor no ofrece transcripción",
// culpando al modelo cuando el que faltaba era el endpoint. Lo que se fija aquí es que
// el dictado cueste cuota como cualquier otra llamada, que no sea un agujero por donde
// subir lo que sea, y que los dos catálogos de alias (chat y voz) no se crucen.
//
//   node --test workers/gateway/test/

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { aliasesFor } from '../src/index.js';
import { nuevoEnv, stubUpstream, llamar, pedirDemo as pedirDemoEn } from './harness.mjs';

let env, upstream;

beforeEach(() => {
  env = nuevoEnv();
  upstream = stubUpstream();
});

const audio = (bytes = 1024) => new File([new Uint8Array(bytes)], 'audio.webm', { type: 'audio/webm' });

const transcribir = (token, model, { file = audio(), prompt, language, extraFile } = {}) => {
  const form = new FormData();
  form.append('file', file);
  if (extraFile) form.append('file', extraFile);
  form.append('model', model);
  if (prompt !== undefined) form.append('prompt', prompt);
  if (language !== undefined) form.append('language', language);
  return llamar(env, '/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  });
};

const demo = async () => (await pedirDemoEn(env, 'bookreader')).body;

// ---- la ruta existe y enruta ---------------------------------------------------

test('transcribe contra el endpoint de audio del proveedor, con el modelo real y no el alias', async () => {
  const { token } = await demo();
  const res = await transcribir(token, 'bookreader-voice');

  assert.equal(res.status, 200);
  assert.equal(upstream.length, 1);
  assert.equal(upstream[0].url, 'https://proveedor.test/v1/audio/transcriptions');
  // El alias es la cara pública; al proveedor va SIEMPRE su id real (ADR-021).
  assert.equal(upstream[0].form.get('model'), 'whisper');
  assert.equal(upstream[0].form.get('file').name, 'audio.webm');
});

test('el id del proveedor se puede cambiar por variable, sin desplegar código', async () => {
  env = nuevoEnv({ NAN_STT_MODEL: 'whisper-large-v3' });
  upstream = stubUpstream();
  const { token } = await demo();

  await transcribir(token, 'bookreader-voice');
  assert.equal(upstream[0].form.get('model'), 'whisper-large-v3');
});

test('el prompt llega al proveedor recortado: es lo que arregla el vocabulario técnico', async () => {
  const { token } = await demo();
  await transcribir(token, 'bookreader-voice', { prompt: 'KV cache, '.repeat(200), language: 'es' });

  assert.equal(upstream[0].form.get('prompt').length, 900);
  assert.equal(upstream[0].form.get('language'), 'es');
});

// ---- cuota ---------------------------------------------------------------------

test('una transcripción cuesta una llamada, igual que una pregunta', async () => {
  const { token, quota } = await demo();
  const res = await transcribir(token, 'bookreader-voice');

  assert.equal(res.headers.get('X-Quota-Remaining'), String(quota - 1));
  assert.equal(res.headers.get('X-Quota-Total'), String(quota));
});

test('el cupo agotado también cierra el dictado (si no, media app seguiría viva)', async () => {
  const { token, quota } = await demo();
  for (let i = 0; i < quota; i++) await transcribir(token, 'bookreader-voice');

  const res = await transcribir(token, 'bookreader-voice');
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, 'demo_exhausted');
});

test('si el proveedor se cae, la llamada vuelve a la cuota: el fallo no lo paga el usuario', async () => {
  upstream = stubUpstream(() => new Response('boom', { status: 502 }));
  const { token, quota } = await demo();

  const res = await transcribir(token, 'bookreader-voice');
  assert.equal(res.status, 502);
  assert.equal(res.headers.get('X-Quota-Remaining'), String(quota));
});

test('token desconocido: 401 antes de leer un solo byte de audio', async () => {
  const res = await transcribir('br-noexiste', 'bookreader-voice');
  assert.equal(res.status, 401);
  assert.equal(upstream.length, 0);
});

// ---- los dos catálogos no se cruzan --------------------------------------------

test('el alias de voz no vale como modelo de chat, ni el de chat como modelo de voz', async () => {
  const { token } = await demo();

  const chat = await llamar(env, '/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'bookreader-voice', messages: [{ role: 'user', content: 'hola' }] }),
  });
  assert.equal(chat.status, 400);
  assert.equal((await chat.json()).error.code, 'model_not_found');

  const voz = await transcribir(token, 'bookreader-fast');
  assert.equal(voz.status, 400);
  assert.equal((await voz.json()).error.code, 'model_not_found');

  assert.equal(upstream.length, 0);
});

test('"Descubrir" no ofrece el alias de voz como modelo de respuesta', async () => {
  const { token, models, sttModel } = await demo();
  assert.ok(!models.includes('bookreader-voice'));
  assert.equal(sttModel, 'bookreader-voice');

  const res = await llamar(env, '/v1/models', { headers: { Authorization: `Bearer ${token}` } });
  const ids = (await res.json()).data.map((m) => m.id);
  assert.deepEqual(ids, aliasesFor('bookreader'));
  assert.ok(!ids.includes('bookreader-voice'));
});

test('el traspaso a otro dispositivo lleva también el modelo de dictado', async () => {
  const { token } = await demo();
  const res = await llamar(env, '/quota', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await res.json()).sttModel, 'bookreader-voice');
});

test('un token de arete no puede dictar por la puerta de bookreader', async () => {
  const { body } = await pedirDemoEn(env, 'arete');
  const res = await transcribir(body.token, 'bookreader-voice');

  assert.equal(res.status, 400);
  assert.equal(upstream.length, 0);
});

// ---- techos de entrada ---------------------------------------------------------

test('el audio tiene techo: una transcripción cuesta lo mismo dure lo que dure', async () => {
  const { token } = await demo();
  const res = await transcribir(token, 'bookreader-voice', { file: audio(21 * 1024 * 1024) });

  assert.equal(res.status, 413);
  assert.equal((await res.json()).error.code, 'audio_too_large');
  assert.equal(upstream.length, 0);
});

test('un solo fichero por llamada: varios serían varias transcripciones cobradas como una', async () => {
  const { token } = await demo();
  const res = await transcribir(token, 'bookreader-voice', { extraFile: audio() });

  assert.equal(res.status, 400);
  assert.equal(upstream.length, 0);
});

test('sin fichero de audio no hay llamada al proveedor', async () => {
  const { token } = await demo();
  const form = new FormData();
  form.append('model', 'bookreader-voice');
  const res = await llamar(env, '/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  });

  assert.equal(res.status, 400);
  assert.equal(upstream.length, 0);
});

// ---- visión (el otro alias que el cliente no puede escribir a mano) --------------

test('la configuración que se emite incluye el alias de visión', async () => {
  const { body } = await pedirDemoEn(env, 'bookreader');
  assert.equal(body.visionModel, 'bookreader-vision');

  const res = await llamar(env, '/quota', { headers: { Authorization: `Bearer ${body.token}` } });
  assert.equal((await res.json()).visionModel, 'bookreader-vision');
});

test('cada producto recibe SU alias de visión, no el de la otra app', async () => {
  const { body } = await pedirDemoEn(env, 'arete');
  assert.equal(body.visionModel, 'arete-vision');
});

test('el alias de visión sigue siendo un modelo de chat normal (está en /v1/models)', async () => {
  const { body } = await pedirDemoEn(env, 'bookreader');
  assert.ok(body.models.includes(body.visionModel));

  const res = await llamar(env, '/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${body.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: body.visionModel, messages: [{ role: 'user', content: 'hola' }] }),
  });
  assert.equal(res.status, 200);
});
