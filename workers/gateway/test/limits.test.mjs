// Tests de los techos de entrada del gateway (MON1 F1.1). Puros: se ejecutan con
// `node --test` sin Worker ni D1 — lo que no es puro (cuota, disyuntores) ya lo
// cubre tests/gateway.spec.ts contra el gateway desplegado.
//
//   node --test workers/gateway/test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pick, measureInput, ipBucket } from '../src/index.js';

test('pick: solo copia las claves permitidas y omite las ausentes', () => {
  const body = { messages: [], stream: true, n: 20, best_of: 5, logprobs: true, model: 'x' };
  const out = pick(body, ['messages', 'stream', 'max_tokens', 'tools']);
  assert.deepEqual(Object.keys(out).sort(), ['messages', 'stream']);
  // Los multiplicadores de coste no sobreviven: una llamada de cuota = una completion.
  assert.equal(out.n, undefined);
  assert.equal(out.best_of, undefined);
});

test('measureInput: cuenta texto plano, partes de texto y argumentos de tool_calls', () => {
  const messages = [
    { role: 'system', content: 'a'.repeat(400) },
    { role: 'user', content: [{ type: 'text', text: 'b'.repeat(400) }] },
    { role: 'assistant', tool_calls: [{ function: { arguments: 'c'.repeat(400) } }] },
  ];
  assert.deepEqual(measureInput(messages), { tokens: 300, images: 0 });
});

test('measureInput: las imágenes se cuentan aparte, no como texto', () => {
  const dataUri = 'data:image/jpeg;base64,' + 'A'.repeat(400_000);
  const { tokens, images } = measureInput([
    { role: 'user', content: [
      { type: 'text', text: 'x'.repeat(40) },
      { type: 'image_url', image_url: { url: dataUri } },
    ] },
  ]);
  assert.equal(images, 1);
  assert.equal(tokens, 10, 'el data URI no infla la estimación de tokens de texto');
});

test('measureInput: tolera entradas ausentes o malformadas sin lanzar', () => {
  assert.deepEqual(measureInput(undefined), { tokens: 0, images: 0 });
  assert.deepEqual(measureInput('no soy un array'), { tokens: 0, images: 0 });
  assert.deepEqual(measureInput([null, {}, { content: 42 }]), { tokens: 0, images: 0 });
});

test('ipBucket: IPv4 agrupa por /24', () => {
  assert.equal(ipBucket('203.0.113.7'), '203.0.113.0/24');
  assert.equal(ipBucket('203.0.113.7'), ipBucket('203.0.113.250'));
  assert.notEqual(ipBucket('203.0.113.7'), ipBucket('203.0.114.7'));
});

test('ipBucket: IPv6 agrupa por /64 — rotar dentro de la propia red no da otro cupo', () => {
  const a = ipBucket('2001:db8:abcd:1234:0:0:0:1');
  assert.equal(a, ipBucket('2001:db8:abcd:1234:ffff:ffff:ffff:ffff'));
  assert.notEqual(a, ipBucket('2001:db8:abcd:9999:0:0:0:1'));
});

test('ipBucket: la forma comprimida y la expandida caen en el mismo bucket', () => {
  assert.equal(ipBucket('2001:db8::1'), ipBucket('2001:0db8:0000:0000:0000:0000:0000:0001'));
  assert.equal(ipBucket('::1'), ipBucket('0:0:0:0:0:0:0:1'));
});
