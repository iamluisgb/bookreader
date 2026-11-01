// Lista de espera de Plus (ADR-061): el formulario de la landing apunta un email.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { usage } from '../src/index.js';
import { env, ORIGIN } from './harness.mjs';

const join = (e, body, origin = ORIGIN, ip = '1.2.3.4') => worker.fetch(new Request('https://sync.test/v1/waitlist', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...(origin ? { Origin: origin } : {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body),
}), e);
const rows = (e) => e.DB._raw.prepare('SELECT email, lang FROM waitlist ORDER BY email').all();

test('apunta el email una vez, en minúsculas y con su idioma, y lo cuenta /v1/usage', async () => {
  const e = env();
  const r = await join(e, { email: '  Ana@Example.com ', lang: 'es' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  // Repetir contesta lo mismo (no delata quién está) y no duplica.
  assert.equal((await join(e, { email: 'ana@example.com', lang: 'en' })).status, 200);
  assert.equal((await join(e, { email: 'bo@example.org' })).status, 200);
  assert.deepEqual(rows(e).map((x) => ({ ...x })), [{ email: 'ana@example.com', lang: 'es' }, { email: 'bo@example.org', lang: 'en' }]);
  assert.equal((await usage(e)).waitlist, 2);
});

test('rechaza lo que no es un email, otra web y el cuerpo roto; el campo trampa no apunta nada', async () => {
  const e = env();
  for (const email of ['', 'sin-arroba', 'a@b', 'a b@c.com', 'x'.repeat(250) + '@e.com', 42]) {
    assert.equal((await join(e, { email })).status, 400, String(email));
  }
  assert.equal((await join(e, { email: 'a@b.com' }, 'https://otra.web')).status, 403);
  assert.equal((await join(e, { email: 'a@b.com' }, null)).status, 403);   // sin Origin: no es la landing
  assert.equal((await join(e, '{roto')).status, 400);
  const bot = await join(e, { email: 'bot@spam.com', website: 'http://spam' });
  assert.equal(bot.status, 200);
  assert.equal(rows(e).length, 0);
});

test('con el tope por IP agotado contesta 429', async () => {
  const e = env({}); e.WAITLIST = { limit: async ({ key }) => ({ success: key !== '9.9.9.9' }) };
  assert.equal((await join(e, { email: 'c@d.com' }, ORIGIN, '9.9.9.9')).status, 429);
  assert.equal((await join(e, { email: 'c@d.com' }, ORIGIN, '1.1.1.1')).status, 200);
});
