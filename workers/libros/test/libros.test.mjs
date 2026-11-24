// Tests del Worker de la biblioteca libre. Lo que importa: que solo reenvíe libros del catálogo,
// que ninguna redirección lo saque de la lista de dominios y que no guarde nada.
//
//   npm run test:libros
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { LIBROS, HOSTS } from '../src/index.js';

const ENV = { ALLOWED_ORIGINS: 'https://bookreader.raiatech.com' };
const fetchReal = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetchReal; });
const pedir = (ruta, init = {}) => worker.fetch(new Request('https://w.test' + ruta, { headers: { Origin: 'https://bookreader.raiatech.com' }, ...init }), ENV);
const EPUB = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);

test('el catálogo trae libros por proxy y ninguno directo', () => {
  assert.ok(LIBROS.size >= 5);
  assert.ok(!LIBROS.has('sicp'), 'sicp va directo: no debe pasar por el Worker');
  for (const b of LIBROS.values()) assert.ok(HOSTS.has(new URL(b.url).hostname));
});

test('reenvía un libro del catálogo siguiendo las redirecciones de GitHub', async () => {
  const pedidas = [];
  globalThis.fetch = async (url, init) => {
    pedidas.push(String(url));
    assert.equal(init.redirect, 'manual');
    if (url.hostname === 'github.com') return new Response(null, { status: 302, headers: { Location: 'https://release-assets.githubusercontent.com/x?sig=1' } });
    return new Response(EPUB, { status: 200, headers: { 'Content-Length': String(EPUB.length) } });
  };
  const r = await pedir('/libro/progit-en');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Content-Type'), 'application/epub+zip');
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://bookreader.raiatech.com');
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), EPUB);
  assert.equal(pedidas.length, 2);
});

test('una redirección fuera de la lista se corta sin seguirla', async () => {
  let llamadas = 0;
  globalThis.fetch = async () => { llamadas++; return new Response(null, { status: 302, headers: { Location: 'https://malo.example/x' } }); };
  const r = await pedir('/libro/eloquent-js');
  assert.equal(r.status, 502);
  assert.equal(llamadas, 1);
});

test('no reenvía ids fuera del catálogo ni URLs arbitrarias', async () => {
  globalThis.fetch = async () => { throw new Error('no debería salir a la red'); };
  assert.equal((await pedir('/libro/no-existe')).status, 404);
  assert.equal((await pedir('/libro/sicp')).status, 404);
  assert.equal((await pedir('/?u=https%3A%2F%2Fexample.com%2Fx.epub')).status, 404);
  assert.equal((await pedir('/libro/progit-en', { method: 'POST' })).status, 405);
});

test('sin origen permitido no hay cabecera CORS', async () => {
  globalThis.fetch = async () => new Response(EPUB);
  const r = await worker.fetch(new Request('https://w.test/libro/eloquent-js', { headers: { Origin: 'https://otro.example' } }), ENV);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
});

test('un error de la fuente no se disfraza de libro', async () => {
  globalThis.fetch = async () => new Response('caído', { status: 503 });
  assert.equal((await pedir('/libro/d2l')).status, 502);
});

test('un bucle de redirecciones termina', async () => {
  globalThis.fetch = async (url) => new Response(null, { status: 302, headers: { Location: String(url) } });
  assert.equal((await pedir('/libro/producing-oss')).status, 508);
});
