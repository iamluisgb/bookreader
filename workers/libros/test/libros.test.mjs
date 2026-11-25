// Tests del Worker de la biblioteca libre. Lo que importa: que solo reenvíe libros del catálogo,
// que ninguna redirección lo saque de la lista de dominios y que no guarde nada.
//
//   npm run test:libros
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { LIBROS, HOSTS, PG_IDS, EL_ENLACES } from '../src/index.js';

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

// ── Gutenberg: la URL la construye el Worker, nunca llega del cliente ──────────────────────
test('/pg construye la URL del espejo para un id del catálogo', async () => {
  const n = [...PG_IDS][0];
  const pedidas = [];
  globalThis.fetch = async (url) => {
    pedidas.push(String(url));
    return new Response(EPUB, { status: 200, headers: { 'Content-Type': 'application/epub+zip', 'Content-Length': String(EPUB.length) } });
  };
  const r = await pedir('/pg/' + n);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Content-Type'), 'application/epub+zip');
  assert.equal(pedidas.length, 1);
  assert.equal(pedidas[0], `https://gutenberg.pglaf.org/cache/epub/${n}/pg${n}-images-3.epub`);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://bookreader.raiatech.com');
});

test('/pg no sale a la red con un id fuera del catálogo ni con otra forma de ruta', async () => {
  globalThis.fetch = async () => { throw new Error('no debería salir a la red'); };
  let fuera = 1;
  while (PG_IDS.has(fuera)) fuera++;
  assert.equal((await pedir('/pg/' + fuera)).status, 404);
  assert.equal((await pedir('/pg/abc')).status, 404);
  assert.equal((await pedir('/pg/1/../../x')).status, 404);
});

// ── Elejandría: dos saltos y `Referer` obligatorio ────────────────────────────────────────
test('/el pide el fichero con el Referer de la ficha', async () => {
  const [id, e] = [...EL_ENLACES.entries()][0];
  let visto = null;
  globalThis.fetch = async (url, init) => {
    visto = { url: String(url), ref: new Headers(init.headers).get('Referer') };
    return new Response(EPUB, { status: 200, headers: { 'Content-Type': 'application/epub+zip' } });
  };
  const r = await pedir('/el/' + id);
  assert.equal(r.status, 200);
  assert.equal(visto.url, `https://www.elejandria.com/libro/link_descarga_libro/${id}/${e.fichaid}`);
  assert.match(visto.ref, new RegExp(`/libro/${e.slug}/${e.autor}/${id}$`));
});

test('/el sirve el PDF cuando la ficha no tiene ePub', async () => {
  const [id, e] = [...EL_ENLACES.entries()].find(([, v]) => v.format === 'pdf');
  globalThis.fetch = async () => new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200, headers: { 'Content-Type': 'application/pdf' } });
  const r = await pedir('/el/' + id);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Content-Type'), 'application/pdf');
});

test('/el no sale a la red con un id desconocido', async () => {
  globalThis.fetch = async () => { throw new Error('no debería salir a la red'); };
  assert.equal((await pedir('/el/999999')).status, 404);
});

test('una página HTML donde tocaba un libro es un 502, no un libro', async () => {
  const n = [...PG_IDS][0];
  globalThis.fetch = async () => new Response('<!doctype html><p>mantenimiento</p>', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  assert.equal((await pedir('/pg/' + n)).status, 502);
});

test('el catálogo empaquetado trae los ids de las dos fuentes nuevas', () => {
  assert.ok(PG_IDS.size > 1000, 'Gutenberg en español debería traer miles de obras');
  assert.ok(EL_ENLACES.size > 0, 'Elejandría debería traer enlaces resueltos');
  for (const e of EL_ENLACES.values()) {
    assert.match(e.fichaid, /^\d+$/);
    assert.ok(e.slug && e.autor);
    assert.ok(['epub', 'pdf'].includes(e.format), `formato inesperado: ${e.format}`);
  }
});
