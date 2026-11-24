// Perfil público por MCP (mcp/src/profile-tools.mjs): leer qué se enseña y escribir la nota y el
// enlace de cada libro, la presentación y las opciones, en settings.json (`public_profile`), con
// `updatedAt` nuevo para que la app lo adopte al fundir. Con el permiso de organizar.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { env as baseEnv, ORIGIN } from './harness.mjs';
import * as C from '../../../app/js/sync/sync-crypto.js';
import { BOOK_1, BOOK_2, buildLayoutFiles } from '../../../mcp/test/helpers/dataset.mjs';

const LICENSE = 'BKRD-TEST-0001';
const SETTINGS = 'bookreader/settings.json';

function call(e, method, path, { body, token, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = 'Bearer ' + token;
  if (body !== undefined && !(body instanceof Uint8Array)) { body = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  if (body instanceof Uint8Array) h['Content-Length'] = String(body.length);
  return worker.fetch(new Request('https://sync.test' + path, { method, body, headers: h }), e);
}

const library = {
  schemaVersion: 1,
  books: {
    [BOOK_1.id]: { title: 'Diseño de datos intensivos', author: 'Kleppmann', format: 'epub', status: 'reading', progress: 30, shelfIds: ['sh_tec'], addedAt: 1, deleted: false, updatedAt: 10 },
    [BOOK_2.id]: { title: 'Pedro Páramo', author: 'Juan Rulfo', format: 'epub', status: 'unread', progress: 0, shelfIds: [], addedAt: 2, deleted: false, updatedAt: 10 },
  },
  shelves: { sh_tec: { name: 'Técnico', createdAt: 1, order: null, rule: null, deleted: false, updatedAt: 1 } },
};
const profile = { updatedAt: 100, enabled: true, handle: 'luis', lang: 'en', bio: '', avatar: 'data:image/webp;base64,AAAA', styleAuto: true,
  showProgress: true, showFilters: true, yearTab: false, now: 'auto', shelves: [{ id: 'sh_tec', name: 'Tech', books: [{ id: BOOK_1.id, show: true, style: 'auto' }] }] };

async function seeded({ withProfile = true } = {}) {
  const e = baseEnv({ DATA_QUOTA_BYTES: String(10 * 1024 * 1024), MAX_BYTES: String(10 * 1024 * 1024) });
  const raw = C.generateKey();
  const k = await C.importKeys(raw);
  const { token: session } = await (await call(e, 'POST', '/v1/sync-token', { body: { license: LICENSE }, headers: { Origin: ORIGIN } })).json();
  const files = { ...buildLayoutFiles(), 'bookreader/library.json': library,
    [SETTINGS]: { theme: 'dark', ...(withProfile ? { public_profile: profile } : {}) } };
  for (const [path, content] of Object.entries(files)) {
    const pid = await C.pathId(k, path);
    const body = new Uint8Array(await (await C.encrypt(k, pid, JSON.stringify(content))).arrayBuffer());
    await call(e, 'PUT', '/v1/o/' + pid, { body, token: session, headers: { 'X-Name': await C.encryptName(k, path), 'X-Kind': 'data' } });
  }
  const token = async (scopes) => (await (await call(e, 'POST', '/v1/mcp-tokens', { token: session, body: { name: 'Claude', key: C.b64url(raw), license: LICENSE, scopes } })).json()).token;
  const readSettings = async () => {
    const pid = await C.pathId(k, SETTINGS);
    return JSON.parse(await C.decryptText(k, pid, await (await call(e, 'GET', '/v1/o/' + pid, { token: session })).blob()));
  };
  return { e, token, readSettings };
}

let n = 0;
async function tool(e, token, name, args) {
  const r = (await (await call(e, 'POST', '/mcp', { token, body: { jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } } })).json()).result;
  return { isError: !!r.isError, text: r.content[0].text, json: r.isError ? null : JSON.parse(r.content[0].text) };
}
const toolNames = async (e, token) => (await (await call(e, 'POST', '/mcp', { token, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).json()).result.tools.map((t) => t.name);

test('leer el perfil con cualquier token; escribirlo solo con el permiso de organizar', async () => {
  const s = await seeded();
  const w = await s.token(['write']);
  const names = await toolNames(s.e, w);
  assert.ok(names.includes('get_public_profile') && !names.includes('update_public_profile'));
  assert.ok((await toolNames(s.e, await s.token(['library']))).includes('update_public_profile'));
  const g = await tool(s.e, w, 'get_public_profile', {});
  assert.equal(g.json.configured, true);
  assert.equal(g.json.hasAvatar, true);
  assert.ok(!JSON.stringify(g.json).includes('base64'));   // la foto no viaja al agente
  assert.deepEqual(g.json.shelves[0].books.map((b) => [b.title, b.show, b.note]), [['Diseño de datos intensivos', true, null]]);
});

test('nota, enlace y presentación: se guardan con updatedAt nuevo y sin tocar el resto de ajustes', async () => {
  const s = await seeded();
  const lib = await s.token(['library']);
  const dry = await tool(s.e, lib, 'update_public_profile', { books: [{ book: 'datos intensivos', note: '  Una nota.  ', link: 'https://example.org/x' }], bio: 'Hola.', dry_run: true });
  assert.equal(dry.json.applied, false);
  assert.equal(dry.json.after[0].note, 'Una nota.');
  assert.equal((await s.readSettings()).public_profile.updatedAt, 100);   // el ensayo no escribe
  const r = await tool(s.e, lib, 'update_public_profile', { books: [{ book: 'datos intensivos', note: '  Una nota.  ', link: 'https://example.org/x' }], bio: 'Hola.', lang: 'es' });
  assert.equal(r.isError, false, r.text);
  const st = await s.readSettings();
  assert.equal(st.theme, 'dark');
  const p = st.public_profile;
  assert.ok(p.updatedAt > 100);
  assert.equal(p.bio, 'Hola.');
  assert.equal(p.lang, 'es');
  assert.equal(p.avatar, 'data:image/webp;base64,AAAA');   // la foto de verdad sigue ahí
  assert.deepEqual(p.shelves[0].books[0], { id: BOOK_1.id, show: true, style: 'auto', note: 'Una nota.', link: 'https://example.org/x' });
  // "" quita la nota y el enlace.
  await tool(s.e, lib, 'update_public_profile', { books: [{ bookId: BOOK_1.id, note: '', link: '' }] });
  assert.deepEqual((await s.readSettings()).public_profile.shelves[0].books[0], { id: BOOK_1.id, show: true, style: 'auto' });
});

test('se niega con claridad: enlace no http, libro fuera de lo público, perfil sin configurar', async () => {
  const s = await seeded();
  const lib = await s.token(['library']);
  const bad = await tool(s.e, lib, 'update_public_profile', { books: [{ bookId: BOOK_1.id, link: 'javascript:alert(1)' }] });
  assert.ok(bad.isError && /http/.test(bad.text));
  const out = await tool(s.e, lib, 'update_public_profile', { books: [{ bookId: BOOK_2.id, note: 'x' }] });
  assert.ok(out.isError && /ninguna estantería pública/.test(out.text));
  const long = await tool(s.e, lib, 'update_public_profile', { books: [{ bookId: BOOK_1.id, note: 'x'.repeat(281) }] });
  assert.ok(long.isError && /280/.test(long.text));
  const s2 = await seeded({ withProfile: false });
  const none = await tool(s2.e, await s2.token(['library']), 'update_public_profile', { bio: 'x' });
  assert.ok(none.isError && /no se ha configurado/.test(none.text));
  const g = await tool(s2.e, await s2.token(['write']), 'get_public_profile', {});
  assert.equal(g.json.configured, false);
});
