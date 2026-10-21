// Subir un libro por MCP (mcp/src/upload-tools.mjs + src/upload.js): el permiso aparte, la URL
// de un solo uso, las comprobaciones del PUT (tamaño, formato, DRM, hash), el fichero cifrado en
// su ruta de siempre, el alta en library.json y su deshacer, y el «ya lo tienes» sin subir nada.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker from '../src/index.js';
import { undoPath } from '../src/mcp.js';
import { env as baseEnv, ORIGIN } from './harness.mjs';
import * as C from '../../../app/js/sync/sync-crypto.js';
import { buildLayoutFiles } from '../../../mcp/test/helpers/dataset.mjs';

const LICENSE = 'BKRD-TEST-0001';
const LIB = 'bookreader/library.json';
const MB = 1024 * 1024;

function call(e, method, path, { body, token, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = 'Bearer ' + token;
  if (body !== undefined && !(body instanceof Uint8Array)) { body = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  if (body instanceof Uint8Array && !h['Content-Length']) h['Content-Length'] = String(body.length);
  return worker.fetch(new Request('https://sync.test' + path, { method, body, headers: h }), e);
}

// Un «EPUB» de mentira: cabecera de zip y relleno. `drm` pone la marca de Adobe al final.
function fakeEpub(size, { drm = false } = {}) {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + 7) & 0xff;
  b.set([0x50, 0x4b, 0x03, 0x04]);
  if (drm) b.set(new TextEncoder().encode('META-INF/rights.xml'), size - 100);
  return b;
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function seeded(extra = {}) {
  const e = baseEnv({
    DATA_QUOTA_BYTES: String(10 * MB), MAX_BYTES: String(20 * MB), FILE_QUOTA_BYTES: String(30 * MB), ...extra,
  });
  const raw = C.generateKey();
  const k = await C.importKeys(raw);
  const { token: session } = await (await call(e, 'POST', '/v1/sync-token', { body: { license: LICENSE }, headers: { Origin: ORIGIN } })).json();
  const put = async (path, content) => {
    const pid = await C.pathId(k, path);
    const body = new Uint8Array(await (await C.encrypt(k, pid, JSON.stringify(content))).arrayBuffer());
    await call(e, 'PUT', '/v1/o/' + pid, { body, token: session, headers: { 'X-Name': await C.encryptName(k, path), 'X-Kind': 'data' } });
  };
  for (const [path, content] of Object.entries({ ...buildLayoutFiles(), [LIB]: { schemaVersion: 1, books: {}, shelves: {} } })) await put(path, content);
  const token = async (scopes) => (await (await call(e, 'POST', '/v1/mcp-tokens', { token: session, body: { name: 'Claude', key: C.b64url(raw), license: LICENSE, scopes } })).json()).token;
  const read = async (path) => {
    const pid = await C.pathId(k, path);
    const res = await call(e, 'GET', '/v1/o/' + pid, { token: session });
    return res.status === 404 ? null : C.decrypt(k, pid, await res.blob());
  };
  const readLib = async () => JSON.parse(await (await read(LIB)).text());
  const changes = async () => (await (await call(e, 'GET', '/v1/mcp-changes', { token: session })).json()).changes;
  const undoOf = async (id) => {
    const { undo } = await (await call(e, 'GET', `/v1/mcp-changes/${id}/undo`, { token: session })).json();
    return JSON.parse(await C.decryptText(k, await C.pathId(k, undoPath(id)), new Blob([C.fromB64url(undo)])));
  };
  return { e, token, put, read, readLib, changes, undoOf };
}

let n = 0;
async function tool(e, token, name, args) {
  const res = await call(e, 'POST', '/mcp', { token, body: { jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } } });
  const r = (await res.json()).result;
  return { isError: !!r.isError, text: r.content[0].text, json: r.isError ? null : JSON.parse(r.content[0].text) };
}
const toolNames = async (e, token) => (await (await call(e, 'POST', '/mcp', { token, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).json()).result.tools.map((t) => t.name);
const pathOf = (url) => new URL(url).pathname;

test('permiso aparte: sin «upload» no se anuncia; con él, create_book_upload y get_book_upload', async () => {
  const s = await seeded();
  const all = await toolNames(s.e, await s.token(['write', 'text', 'library']));
  assert.ok(!all.includes('create_book_upload'));
  const up = await toolNames(s.e, await s.token(['upload']));
  assert.ok(up.includes('create_book_upload') && up.includes('get_book_upload'));
});

test('subida completa de un EPUB de varios trozos: cifrado en su ruta, alta en la biblioteca, deshacer y un solo uso', async () => {
  const s = await seeded();
  const t = await s.token(['upload']);
  const bytes = fakeEpub(9 * MB + 123);   // tres trozos de 4 MB, el último corto
  const id = sha(bytes);
  const c = await tool(s.e, t, 'create_book_upload', { fileName: '/home/yo/Mi libro.epub', size: bytes.length, sha256: id.toUpperCase(), title: 'Mi libro', author: 'Autora' });
  assert.equal(c.isError, false, c.text);
  assert.equal(c.json.status, 'pending');
  assert.equal(c.json.bookId, id);
  assert.match(c.json.curl, /^curl -sS -T 'Mi libro\.epub' 'https:\/\/sync\.test\/v1\/upload\//);

  // En D1 no queda nada legible: ni título ni hash del libro.
  const row = s.e.DB._raw.prepare('SELECT * FROM mcp_uploads').get();
  assert.ok(!JSON.stringify(row).includes('Mi libro') && !JSON.stringify(row).includes(id));

  const putsBefore = s.e.SYNC._ops.put;
  const res = await call(s.e, 'PUT', pathOf(c.json.upload.url), { body: bytes });
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.deepEqual([out.status, out.bookId, out.title], ['added', id, 'Mi libro']);
  assert.ok(out.changeId);

  assert.equal(s.e.SYNC._ops.parts, 2, 'a R2 por partes de dos trozos: 8 MB + el resto');
  assert.equal(s.e.SYNC._ops.put - putsBefore, 1, 'el libro nunca va entero de una vez: el único put es library.json');
  const file = await s.read(`bookreader/files/${id}.epub`);
  assert.equal(sha(new Uint8Array(await file.arrayBuffer())), id, 'el fichero se descifra a los mismos bytes');
  const b = (await s.readLib()).books[id];
  assert.deepEqual(
    [b.title, b.author, b.format, b.fileName, b.size, b.status, b.deleted, b.blob.path, b.origTitle],
    ['Mi libro', 'Autora', 'epub', 'Mi libro.epub', bytes.length, 'unread', false, `bookreader/files/${id}.epub`, ''],
  );
  assert.equal(s.e.DB._raw.prepare(`SELECT kind FROM blobs WHERE size > ?`).get(MB).kind, 'file', 'cuenta en la cuota de libros');

  const ch = await s.changes();
  assert.deepEqual(ch.map((x) => x.summary), [{ booksAdded: 1 }]);
  assert.deepEqual(await s.undoOf(out.changeId), { books: { [id]: null }, shelves: {} });

  const st = await tool(s.e, t, 'get_book_upload', { uploadId: c.json.uploadId });
  assert.deepEqual([st.json.state, st.json.changeId], ['done', out.changeId]);
  const again = await call(s.e, 'PUT', pathOf(c.json.upload.url), { body: bytes });
  assert.equal(again.status, 409, 'la URL es de un solo uso');
  const dup = await tool(s.e, t, 'create_book_upload', { fileName: 'otro.epub', size: bytes.length, sha256: id });
  assert.deepEqual([dup.json.status, dup.json.title], ['exists', 'Mi libro'], 'el mismo libro no se duplica');
});

test('sin título, el del nombre del fichero (y la app lo cambia por el del EPUB al abrirlo)', async () => {
  const s = await seeded();
  const t = await s.token(['upload']);
  const bytes = fakeEpub(5000);
  const c = await tool(s.e, t, 'create_book_upload', { fileName: 'el_principito.epub', size: bytes.length, sha256: sha(bytes) });
  assert.equal((await call(s.e, 'PUT', pathOf(c.json.upload.url), { body: bytes })).status, 200);
  const b = (await s.readLib()).books[sha(bytes)];
  assert.deepEqual([b.title, b.author, 'origTitle' in b], ['el principito', '', false]);
  const lb = (await tool(s.e, t, 'list_books', {})).json.books.find((x) => x.id === sha(bytes));
  assert.deepEqual([lb.format, lb.size, lb.fileInSync], ['epub', 5000, true], 'list_books dice formato, tamaño y si está en el sync');
});

test('el PUT rechaza lo que no es lo declarado, y la subida queda «failed» con el motivo', async () => {
  const s = await seeded();
  const t = await s.token(['upload']);
  const bytes = fakeEpub(6000);
  const create = async (args) => (await tool(s.e, t, 'create_book_upload', { fileName: 'a.epub', size: bytes.length, sha256: sha(bytes), ...args })).json;

  const wrongHash = await create({ sha256: 'a'.repeat(64) });
  const r1 = await call(s.e, 'PUT', pathOf(wrongHash.upload.url), { body: bytes });
  assert.deepEqual([r1.status, (await r1.json()).error], [422, 'hash_mismatch']);
  const st = await tool(s.e, t, 'get_book_upload', { uploadId: wrongHash.uploadId });
  assert.deepEqual([st.json.state, st.json.error], ['failed', 'hash_mismatch']);

  const short = await create({});
  const r2 = await call(s.e, 'PUT', pathOf(short.upload.url), { body: bytes.slice(1) });
  assert.deepEqual([r2.status, (await r2.json()).error], [400, 'size_mismatch']);

  const pdf = await create({ fileName: 'a.pdf' });
  const r3 = await call(s.e, 'PUT', pathOf(pdf.upload.url), { body: bytes });
  assert.deepEqual([r3.status, (await r3.json()).error], [422, 'not_pdf']);

  const drm = fakeEpub(6000, { drm: true });
  const d = (await tool(s.e, t, 'create_book_upload', { fileName: 'drm.epub', size: drm.length, sha256: sha(drm) })).json;
  const r4 = await call(s.e, 'PUT', pathOf(d.upload.url), { body: drm });
  assert.deepEqual([r4.status, (await r4.json()).error], [422, 'drm']);

  const ok = await create({});
  const bad = pathOf(ok.upload.url).replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A'));
  assert.equal((await call(s.e, 'PUT', bad, { body: bytes })).status, 404, 'sin el secreto exacto no hay subida');
  s.e.DB._raw.prepare('UPDATE mcp_uploads SET expires_at = 1 WHERE id = ?').run(ok.uploadId);
  assert.equal((await call(s.e, 'PUT', pathOf(ok.upload.url), { body: bytes })).status, 410);
  assert.equal((await tool(s.e, t, 'get_book_upload', { uploadId: ok.uploadId })).json.state, 'expired');

  // Uno grande con el hash mal: las partes ya subidas se abortan y la cuota se libera.
  const big = fakeEpub(9 * MB);
  const bad2 = (await tool(s.e, t, 'create_book_upload', { fileName: 'g.epub', size: big.length, sha256: 'c'.repeat(64) })).json;
  assert.equal((await call(s.e, 'PUT', pathOf(bad2.upload.url), { body: big })).status, 422);
  assert.equal(s.e.SYNC._uploads.size, 0, 'la subida por partes se abortó');

  assert.equal(s.e.DB._raw.prepare(`SELECT COUNT(*) AS n FROM blobs WHERE kind = 'file'`).get().n, 0, 'nada se guardó');
  assert.deepEqual((await s.readLib()).books, {});
});

test('lo que no cabe o no vale se dice antes de subir: cuota, máximo, formato, hash mal escrito', async () => {
  const s = await seeded({ FILE_QUOTA_BYTES: String(4000), MCP_UPLOAD_MAX_BYTES: String(1 * MB) });
  const t = await s.token(['upload']);
  const h = 'b'.repeat(64);
  const quota = await tool(s.e, t, 'create_book_upload', { fileName: 'a.epub', size: 5000, sha256: h });
  assert.ok(quota.isError && /No cabe/.test(quota.text), quota.text);
  const big = await tool(s.e, t, 'create_book_upload', { fileName: 'a.epub', size: 2 * MB, sha256: h });
  assert.ok(big.isError && /1 MB/.test(big.text));
  const mobi = await tool(s.e, t, 'create_book_upload', { fileName: 'a.mobi', size: 10, sha256: h });
  assert.ok(mobi.isError && /EPUB o PDF/.test(mobi.text));
  const badHash = await tool(s.e, t, 'create_book_upload', { fileName: 'a.epub', size: 10, sha256: 'xyz' });
  assert.ok(badHash.isError && /sha256sum/.test(badHash.text));
  assert.equal(s.e.DB._raw.prepare('SELECT COUNT(*) AS n FROM mcp_uploads').get().n, 0);
});

test('un libro borrado cuyo fichero sigue en el sync vuelve sin subir nada (y se puede deshacer)', async () => {
  const s = await seeded();
  const t = await s.token(['upload']);
  const bytes = fakeEpub(7000);
  const id = sha(bytes);
  const c = await tool(s.e, t, 'create_book_upload', { fileName: 'a.epub', size: bytes.length, sha256: id });
  await call(s.e, 'PUT', pathOf(c.json.upload.url), { body: bytes });
  const lib = await s.readLib();
  lib.books[id] = { title: 'a', deleted: true, deletedAt: 5, updatedAt: 5 };
  await s.put(LIB, lib);

  const back = await tool(s.e, t, 'create_book_upload', { fileName: 'a.epub', size: bytes.length, sha256: id });
  assert.equal(back.isError, false, back.text);
  assert.deepEqual([back.json.status, !!back.json.changeId, 'upload' in back.json], ['added', true, false]);
  const b = (await s.readLib()).books[id];
  assert.ok(!b.deleted && b.updatedAt > 5 && b.blob.path.endsWith(id + '.epub'));
  assert.deepEqual(await s.undoOf(back.json.changeId), { books: { [id]: null }, shelves: {} });
});

test('una suscripción caducada (solo lectura) no sube libros', async () => {
  const s = await seeded();
  const t = await s.token(['upload']);
  s.e.DB._raw.prepare('UPDATE users SET lapsed_at = ?').run(Date.now());
  assert.ok(!(await toolNames(s.e, t)).includes('create_book_upload'));
});
