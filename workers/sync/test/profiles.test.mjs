// Perfiles públicos alojados (MON7, ADR-064): cualquiera con el sync publica `/@handle/` desde la
// app; se guarda en R2 limpio campo a campo y lo sirve el Worker. Lo que importa: que nada de la
// foto llegue a la página sin pasar por la lista blanca, que un handle sea de uno solo, que
// retirar borre todo, y que lo que no es un perfil alojado siga a Pages.
//
//   npm run test:sync

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { wipeUser } from '../src/index.js';
import { env, ORIGIN } from './harness.mjs';

const SITE = 'https://bookreader.raiatech.com';
const TPL = `<!doctype html><html lang="{{LANG}}"><head><title>{{TITLE}}</title>
<script>window.x = 1;</script><script src="../assets/perfil/estanteria.js"></script></head>
<body><h1>{{NAME}}</h1><div>{{INITIAL}}</div><a href="{{URL}}?ref=embed">x</a></body></html>`;
const WEBP = 'data:image/webp;base64,' + Buffer.from('RIFF0000WEBPVP8 fake').toString('base64');

function req(method, path, { body, token, host = 'https://sync.test' } = {}) {
  const h = { Origin: ORIGIN };
  if (token) h.Authorization = 'Bearer ' + token;
  if (typeof body === 'string') { h['Content-Type'] = 'application/json'; h['Content-Length'] = String(body.length); }
  return new Request(host + path, { method, body, headers: h });
}
async function login(e, license) {
  const r = await worker.fetch(req('POST', '/v1/sync-token', { body: JSON.stringify({ license }) }), e);
  const { token } = await r.json();
  const user = e.DB._raw.prepare('SELECT user FROM tokens ORDER BY rowid DESC LIMIT 1').get().user;
  return { token, user };
}
const snap = (handle, over = {}) => ({
  format: 'bookreader-perfil', version: 2, handle, exportedAt: '2026-11-24T10:00:00Z', showProgress: true,
  profile: { lang: 'es', bio: 'Leo cosas.', name: 'Ana <b>Pérez</b>' },
  now: 'aaaaaaaaaaaa',
  shelves: [{ id: 'tecnico', name: 'Técnico', books: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'] }],
  books: [
    { id: 'aaaaaaaaaaaa', bookId: 'a'.repeat(64), title: 'Libro A', author: 'Autora', status: 'reading', progress: 42, pages: 300,
      spine: { style: 'plain', bg: '#112233', ink: 'red; background:url(x)', title: 'Libro A', author: 'Autora' },
      note: 'Muy bueno', link: 'javascript:alert(1)', coverData: WEBP, secreto: 'no debe salir' },
    { id: 'bbbbbbbbbbbb', bookId: 'b'.repeat(64), title: 'Libro B', author: 'Otro', status: 'finished', link: 'https://example.com/b' },
    { id: 'cccccccccccc', bookId: 'c'.repeat(64), title: 'Suelto, no está en ninguna estantería', status: 'unread' },
  ],
  ...over,
});
const publish = (e, token, s) => worker.fetch(req('POST', '/v1/profile/publish', { body: JSON.stringify(s), token }), e);
const site = (e, path) => worker.fetch(req('GET', path, { host: SITE }), e);

async function setup() {
  const e = env({ PROFILE_TEMPLATE_HTML: TPL });
  const ana = await login(e, 'BKRD-TEST-0001');
  return { e, ana };
}

test('alojado: publica al momento, limpia la foto y no publica el bookId ni lo que no está en una estantería', async () => {
  const { e, ana } = await setup();
  const r = await publish(e, ana.token, snap('ana'));
  assert.equal(r.status, 200);
  const st = await r.json();
  assert.deepEqual([st.state, st.hosted, st.handle, st.url, st.books], ['done', true, 'ana', `${SITE}/@ana/`, 2]);

  const perfil = await (await site(e, '/@ana/perfil.json')).json();
  assert.equal(perfil.owner, 'Ana <b>Pérez</b>');   // se escapa al pintar, no al guardar
  assert.equal(perfil.books.length, 2);
  const raw = JSON.stringify(perfil);
  for (const fuera of ['a'.repeat(64), 'b'.repeat(64), 'secreto', 'javascript:', 'url(x)', 'Suelto']) assert.ok(!raw.includes(fuera), fuera);
  const a = perfil.books.find(b => b.title === 'Libro A');
  assert.deepEqual(a.spine, { style: 'plain', title: 'Libro A', author: 'Autora', bg: '#112233' });
  assert.equal(a.link, undefined);
  assert.equal(perfil.books.find(b => b.title === 'Libro B').link, 'https://example.com/b');
  assert.equal(perfil.now, a.id);
  assert.match(a.coverFile, /^[0-9a-f]{12}\.webp$/);

  const cover = await site(e, `/@ana/c/${a.coverFile}`);
  assert.equal(cover.status, 200);
  assert.equal(cover.headers.get('content-type'), 'image/webp');
  const svg = await site(e, '/@ana/now.svg');
  assert.equal(svg.status, 200);
  assert.match(await svg.text(), /READING NOW[\s\S]*Libro A/);
  // El estado lo ve la app.
  const g = await worker.fetch(req('GET', '/v1/profile/publish', { token: ana.token }), e);
  assert.deepEqual((await g.json()).handle, 'ana');
});

test('alojado: la página escapa el nombre y lleva una CSP con el hash de sus scripts en línea', async () => {
  const { e, ana } = await setup();
  await publish(e, ana.token, snap('ana'));
  const r = await site(e, '/@ana/');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('<h1>Ana &lt;b&gt;Pérez&lt;/b&gt;</h1>'));
  assert.ok(html.includes('lang="es"'));
  assert.ok(html.includes(`${SITE}/@ana/?ref=embed`));
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  // Con ?embed=1 sí se deja incrustar (la web del dueño, un blog); sin él, no.
  const emb = await site(e, '/@ana/?embed=1');
  assert.match(emb.headers.get('content-security-policy'), /frame-ancestors \*/);
  assert.equal(emb.headers.get('x-frame-options'), null);
  // Sin barra final, redirige; una estantería tiene su página para compartir.
  assert.equal((await site(e, '/@ana')).status, 301);
  assert.match(await (await site(e, '/@ana/tecnico/')).text(), /og:title[^>]*Técnico/);
  for (const p of ['/@ana/c/x.html', '/@ana/c/avatar.svg', '/@ana/otra/cosa', '/@ana/%2e%2e/x']) assert.equal((await site(e, p)).status, 404, p);
});

test('alojado: un handle es de uno solo; los reservados y los mal formados no se dan', async () => {
  const { e, ana } = await setup();
  const beto = await login(e, 'BKRD-TEST-0002');
  assert.equal((await publish(e, ana.token, snap('ana'))).status, 200);
  const r = await publish(e, beto.token, snap('ana'));
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, 'handle_taken');
  for (const h of ['app', 'api', 'assets', 'bookreader', 'a', '-ana', 'ana-', 'Ana!', 'x'.repeat(31)]) {
    assert.equal((await publish(e, beto.token, snap(h))).status, 400, h);
  }
});

test('alojado: cambiar de handle libera el viejo y borra sus objetos; volver a publicar borra lo que sobra', async () => {
  const { e, ana } = await setup();
  await publish(e, ana.token, snap('ana'));
  const viejas = [...e.SYNC._m.keys()].filter(k => k.startsWith('profiles/ana/'));
  assert.ok(viejas.length >= 3);
  // Sin el libro A (y su portada) y con otro handle.
  const s2 = snap('ana-lee', { now: null });
  s2.shelves[0].books = ['bbbbbbbbbbbb'];
  assert.equal((await publish(e, ana.token, s2)).status, 200);
  assert.deepEqual([...e.SYNC._m.keys()].filter(k => k.startsWith('profiles/ana/')), []);
  assert.deepEqual([...e.SYNC._m.keys()].filter(k => k.startsWith('profiles/ana-lee/')), ['profiles/ana-lee/perfil.json']);
  // El viejo queda libre para otro.
  const beto = await login(e, 'BKRD-TEST-0002');
  assert.equal((await publish(e, beto.token, snap('ana'))).status, 200);
});

test('alojado: retirar borra todo; lo que no es un perfil alojado no lo sirve este Worker', async () => {
  const { e, ana } = await setup();
  await publish(e, ana.token, snap('ana'));
  const d = await worker.fetch(req('DELETE', '/v1/profile/publish', { token: ana.token }), e);
  assert.equal((await d.json()).state, 'none');
  assert.deepEqual([...e.SYNC._m.keys()].filter(k => k.startsWith('profiles/')), []);
  // Fuera del dominio público, un perfil que no existe es 404 (en el dominio, seguiría a Pages).
  assert.equal((await worker.fetch(req('GET', '/@ana/'), e)).status, 404);
  assert.equal((await worker.fetch(req('GET', '/@luis/'), e)).status, 404);
});

test('alojado: borrar la cuenta (o el fin del periodo de gracia) se lleva el perfil; caducado no se sirve', async () => {
  const { e, ana } = await setup();
  await publish(e, ana.token, snap('ana'));
  e.DB._raw.prepare('UPDATE users SET lapsed_at = ? WHERE id = ?').run(Date.now(), ana.user);
  assert.equal((await worker.fetch(req('GET', '/@ana/perfil.json'), e)).status, 404);
  await wipeUser(e, ana.user);
  assert.equal(e.DB._raw.prepare('SELECT COUNT(*) n FROM profiles').get().n, 0);
  assert.deepEqual([...e.SYNC._m.keys()].filter(k => k.startsWith('profiles/')), []);
});

test('alojado: portadas enormes o fotos mal formadas se rechazan sin escribir nada', async () => {
  const { e, ana } = await setup();
  const big = snap('ana');
  big.books[0].coverData = 'data:image/webp;base64,' + Buffer.alloc(500 * 1024).toString('base64');
  const r = await publish(e, ana.token, big);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'cover_too_large');
  assert.equal((await publish(e, ana.token, snap('ana', { shelves: [] }))).status, 400);
  assert.equal((await publish(e, ana.token, { ...snap('ana'), format: 'otra' })).status, 400);
  assert.deepEqual([...e.SYNC._m.keys()].filter(k => k.startsWith('profiles/')), []);
});

test('vista previa: un perfil que aún no existe sale con la plantilla vacía y sin indexar', async () => {
  const { e } = await setup();
  const r = await site(e, '/@nueva/?draft=1');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-robots-tag'), 'noindex');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.ok((await r.text()).includes('<h1>nueva</h1>'));
});
