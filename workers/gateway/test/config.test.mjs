// Config del gateway: los orígenes que pueden llamarlo.
//
// El bug que fija este spec (visto en el emulador Android, 2026): el deploy de Pages
// (`bookreader-2h5.pages.dev`) no estaba en ALLOWED_ORIGINS. `corsHeaders()` resuelve un
// origen desconocido con `allowed[0]`, así que la respuesta llegaba SIN el ACAO del
// origen que preguntaba y el navegador la bloqueaba: en el cliente el botón «Try the
// demo» moría con «Failed to fetch» (y el medidor de cupo, ciego) — nada que ver con el
// 429 real que devolvía el gateway. En el dominio propio funcionaba, y por eso pasó
// desapercibido.
//
// Se lee el wrangler.jsonc REAL, no una copia: un test con su propia lista no habría
// detectado el olvido.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nuevoEnv, stubUpstream, llamar } from './harness.mjs';

const WRANGLER = join(dirname(fileURLToPath(import.meta.url)), '..', 'wrangler.jsonc');

function origenesDelConfig() {
  const raw = readFileSync(WRANGLER, 'utf8');
  const m = raw.match(/"ALLOWED_ORIGINS"\s*:\s*"([^"]*)"/);
  assert.ok(m, 'wrangler.jsonc debe declarar ALLOWED_ORIGINS');
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

// Destinos de deploy que el producto sirve hoy. Si aparece uno nuevo (otro proyecto de
// Pages, otro dominio), añadirlo aquí Y en wrangler.jsonc.
const REQUERIDOS = [
  'https://bookreader.raiatech.com',
  'https://bookreader-2h5.pages.dev',
  'https://arete.raiatech.com',
  'https://arete-6a8.pages.dev',
];

test('todo destino de deploy está en ALLOWED_ORIGINS', () => {
  const lista = origenesDelConfig();
  for (const o of REQUERIDOS) assert.ok(lista.includes(o), `falta ${o} en ALLOWED_ORIGINS`);
});

test('la lista es de orígenes desnudos y nunca un comodín', () => {
  for (const o of origenesDelConfig()) {
    assert.notEqual(o, '*', 'un comodín abriría el gateway a cualquier sitio');
    assert.equal(o, o.trim(), 'sin espacios alrededor');
    assert.ok(!o.endsWith('/'), `«${o}» no debe llevar slash final: el match es por igualdad exacta`);
    assert.match(o, /^https?:\/\/[^/\s]+$/, `«${o}» no es un origen (esquema + host, sin path)`);
  }
});

test('con la lista real, el origen de Pages recibe su ACAO (demo funcional)', async () => {
  const env = nuevoEnv({ ALLOWED_ORIGINS: origenesDelConfig().join(',') });
  stubUpstream();
  for (const origin of REQUERIDOS) {
    const res = await llamar(env, '/demo-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7', Origin: origin },
    });
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), origin,
      `${origin} debe recibir su propio ACAO, no el primero de la lista`);
  }
});
