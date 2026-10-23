// Organizar la biblioteca por MCP (mcp/src/library-tools.mjs): el permiso aparte, los sellos que
// necesita el merge de los dispositivos (shelvesAt, statusAt, metaAt), la cascada al borrar una
// estantería, las inteligentes, y el deshacer cifrado de cada cambio.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { undoPath } from '../src/mcp.js';
import { env as baseEnv, ORIGIN } from './harness.mjs';
import * as C from '../../../app/js/sync/sync-crypto.js';
import { BOOK_1, BOOK_2, buildLayoutFiles } from '../../../mcp/test/helpers/dataset.mjs';

const LICENSE = 'BKRD-TEST-0001';
const LIB = 'bookreader/library.json';

function call(e, method, path, { body, token, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = 'Bearer ' + token;
  if (body !== undefined && !(body instanceof Uint8Array)) { body = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  if (body instanceof Uint8Array) h['Content-Length'] = String(body.length);
  return worker.fetch(new Request('https://sync.test' + path, { method, body, headers: h }), e);
}

const library = () => ({
  schemaVersion: 1,
  books: {
    [BOOK_1.id]: { title: 'Diseño de datos intensivos', author: 'Kleppmann', format: 'epub', status: 'reading', progress: 30, shelfIds: ['sh_tec'], addedAt: 1, deleted: false, deletedAt: 0, updatedAt: 10 },
    [BOOK_2.id]: { title: 'Pedro Páramo', author: 'Juan Rulfo', format: 'epub', status: 'unread', progress: 0, shelfIds: [], addedAt: 2, deleted: false, deletedAt: 0, updatedAt: 10 },
  },
  shelves: {
    sh_tec: { name: 'Técnico', createdAt: 1, order: null, rule: null, deleted: false, deletedAt: 0, updatedAt: 1 },
    sh_fav: { name: 'Favoritos', createdAt: 2, order: null, rule: null, deleted: false, deletedAt: 0, updatedAt: 1 },
    sh_smart: { name: 'Técnico pendientes', createdAt: 3, order: null, rule: { shelfIds: ['sh_tec'], status: 'unread' }, deleted: false, deletedAt: 0, updatedAt: 1 },
  },
});

async function seeded() {
  const e = baseEnv({ DATA_QUOTA_BYTES: String(10 * 1024 * 1024), MAX_BYTES: String(10 * 1024 * 1024) });
  const raw = C.generateKey();
  const k = await C.importKeys(raw);
  const { token: session } = await (await call(e, 'POST', '/v1/sync-token', { body: { license: LICENSE }, headers: { Origin: ORIGIN } })).json();
  for (const [path, content] of Object.entries({ ...buildLayoutFiles(), [LIB]: library() })) {
    const pid = await C.pathId(k, path);
    const body = new Uint8Array(await (await C.encrypt(k, pid, JSON.stringify(content))).arrayBuffer());
    await call(e, 'PUT', '/v1/o/' + pid, { body, token: session, headers: { 'X-Name': await C.encryptName(k, path), 'X-Kind': 'data' } });
  }
  const token = async (scopes) => (await (await call(e, 'POST', '/v1/mcp-tokens', { token: session, body: { name: 'Claude', key: C.b64url(raw), license: LICENSE, scopes } })).json()).token;
  const readLib = async () => {
    const pid = await C.pathId(k, LIB);
    const res = await call(e, 'GET', '/v1/o/' + pid, { token: session });
    return JSON.parse(await C.decryptText(k, pid, await res.blob()));
  };
  const changes = async () => (await (await call(e, 'GET', '/v1/mcp-changes', { token: session })).json()).changes;
  const undoOf = async (id) => {
    const { undo } = await (await call(e, 'GET', `/v1/mcp-changes/${id}/undo`, { token: session })).json();
    return { b64: undo, value: JSON.parse(await C.decryptText(k, await C.pathId(k, undoPath(id)), new Blob([C.fromB64url(undo)]))) };
  };
  return { e, token, readLib, changes, undoOf };
}

let n = 0;
async function tool(e, token, name, args) {
  const res = await call(e, 'POST', '/mcp', { token, body: { jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } } });
  const r = (await res.json()).result;
  return { isError: !!r.isError, text: r.content[0].text, json: r.isError ? null : JSON.parse(r.content[0].text) };
}
const toolNames = async (e, token) => (await (await call(e, 'POST', '/mcp', { token, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).json()).result.tools.map((t) => t.name);

test('permiso aparte: con «write» no se organiza; list_shelves es de lectura', async () => {
  const s = await seeded();
  const w = await s.token(['write']);
  const names = await toolNames(s.e, w);
  assert.ok(names.includes('list_shelves') && !names.includes('move_books'));
  assert.ok((await toolNames(s.e, await s.token(['library']))).includes('move_books'));
  const sh = await tool(s.e, w, 'list_shelves', {});
  assert.deepEqual(sh.json.shelves.map((x) => [x.name, x.books, x.smart]), [['Técnico', 1, false], ['Favoritos', 0, false], ['Técnico pendientes', 0, true]]);
  assert.equal(sh.json.unshelved, 1);
  const lb = await tool(s.e, w, 'list_books', {});
  assert.deepEqual(lb.json.books.find((b) => b.id === BOOK_1.id).shelfIds, ['sh_tec']);
});

test('create_shelf anidada con libros + move_books: sellos para el merge, versión, y deshacer cifrado', async () => {
  const s = await seeded();
  const t = await s.token(['library']);
  const c = await tool(s.e, t, 'create_shelf', { name: ' Técnico / Bases de datos ', books: ['diseño de datos'] });
  assert.equal(c.isError, false, c.text);
  assert.equal(c.json.name, 'Técnico/Bases de datos');
  assert.ok(c.json.changeId);
  const m = await tool(s.e, t, 'move_books', { bookIds: [BOOK_1.id, BOOK_2.id], add: ['favoritos'], remove: ['Técnico'] });
  assert.deepEqual(m.json.moved.map((x) => x.bookId).sort(), [BOOK_1.id, BOOK_2.id].sort());
  const lib = await s.readLib();
  const b1 = lib.books[BOOK_1.id];
  assert.deepEqual(b1.shelfIds, [c.json.shelfId, 'sh_fav']);
  assert.ok(b1.shelvesAt > 10 && b1.updatedAt === b1.shelvesAt);
  assert.equal(b1.progress, 30, 'lo demás del libro no se toca');
  assert.deepEqual(lib.shelves[c.json.shelfId], { name: 'Técnico/Bases de datos', createdAt: lib.shelves[c.json.shelfId].createdAt, order: null, rule: null, deleted: false, deletedAt: 0, updatedAt: lib.shelves[c.json.shelfId].updatedAt });
  assert.equal(s.e.DB._raw.prepare(`SELECT COUNT(*) AS n FROM blobs WHERE state = 'version'`).get().n, 2, 'library.json guarda versión en cada cambio del agente');

  const ch = await s.changes();
  assert.deepEqual(ch.map((x) => [x.agent, x.summary]), [['Claude', { books: 2 }], ['Claude', { shelvesCreated: 1, books: 1 }]]);
  const u = await s.undoOf(m.json.changeId);
  assert.ok(!Buffer.from(C.fromB64url(u.b64)).toString('latin1').includes('Diseño'), 'el servidor guarda el deshacer cifrado');
  assert.deepEqual(u.value.books[BOOK_1.id].shelfIds, ['sh_tec', c.json.shelfId]);
  assert.deepEqual(u.value.books[BOOK_2.id].shelfIds, []);
  assert.deepEqual((await s.undoOf(c.json.changeId)).value.shelves, { [c.json.shelfId]: null });
});

test('update_books: título con original y metaAt; estado a mano con statusAt y finishedAt', async () => {
  const s = await seeded();
  const t = await s.token(['library']);
  const r = await tool(s.e, t, 'update_books', { changes: [{ bookId: BOOK_1.id, title: 'DDIA', status: 'finished' }, { bookId: BOOK_2.id, status: 'unread' }] });
  assert.equal(r.json.updated.length, 1, 'el que no cambia no cuenta');
  const b = (await s.readLib()).books[BOOK_1.id];
  assert.equal(b.title, 'DDIA');
  assert.equal(b.origTitle, 'Diseño de datos intensivos');
  assert.ok(b.metaAt && b.statusAt && b.finishedAt);
  await tool(s.e, t, 'update_books', { changes: [{ bookId: BOOK_1.id, status: 'reading' }] });
  assert.equal((await s.readLib()).books[BOOK_1.id].finishedAt, undefined);
  const bad = await tool(s.e, t, 'update_books', { changes: [{ bookId: BOOK_1.id, status: 'leido' }] });
  assert.ok(bad.isError);
});

test('delete_shelf: los libros salen de ella y las reglas que la citan se limpian; las inteligentes no se rellenan a mano', async () => {
  const s = await seeded();
  const t = await s.token(['library']);
  const smart = await tool(s.e, t, 'move_books', { bookIds: [BOOK_2.id], add: ['Técnico pendientes'] });
  assert.ok(smart.isError && /inteligente/.test(smart.text));
  const d = await tool(s.e, t, 'delete_shelf', { shelf: 'Técnico' });
  assert.deepEqual([d.json.booksTakenOut, d.json.rulesUpdated], [1, 1]);
  const lib = await s.readLib();
  assert.ok(lib.shelves.sh_tec.deleted && lib.shelves.sh_tec.deletedAt);
  assert.deepEqual(lib.books[BOOK_1.id].shelfIds, []);
  assert.deepEqual(lib.shelves.sh_smart.rule, { status: 'unread' });
  const u = (await s.undoOf(d.json.changeId)).value;
  assert.equal(u.shelves.sh_tec.name, 'Técnico');
  assert.deepEqual(u.shelves.sh_smart.rule, { shelfIds: ['sh_tec'], status: 'unread' });
});

test('inteligentes y orden: regla por nombres, solo sobre normales; reorder del mismo nivel; dry_run sin rastro', async () => {
  const s = await seeded();
  const t = await s.token(['library']);
  const bad = await tool(s.e, t, 'create_shelf', { name: 'X', rule: { shelfIds: ['Técnico pendientes'] } });
  assert.ok(bad.isError && /normales/.test(bad.text));
  const ok = await tool(s.e, t, 'create_shelf', { name: 'Leyendo técnico', rule: { shelfIds: ['técnico'], status: 'reading' } });
  assert.deepEqual([ok.json.smart, ok.json.books, ok.json.rule], [true, 1, { status: 'reading', shelfIds: ['sh_tec'] }]);
  const before = (await s.changes()).length;
  const dry = await tool(s.e, t, 'reorder_shelves', { order: ['Técnico', 'Favoritos'], dry_run: true });
  assert.equal(dry.json.applied, false);
  assert.equal((await s.changes()).length, before, 'dry_run no deja cambio');
  await tool(s.e, t, 'reorder_shelves', { order: ['Técnico', 'Favoritos'] });
  const lib = await s.readLib();
  assert.deepEqual([lib.shelves.sh_tec.order, lib.shelves.sh_fav.order], [0, 1]);
  const rn = await tool(s.e, t, 'update_shelf', { shelf: 'sh_fav', name: 'Técnico/Favoritos' });
  assert.equal(rn.json.after.name, 'Técnico/Favoritos');
  assert.equal((await s.readLib()).shelves.sh_fav.createdAt, 2, 'mismo id y misma estantería');
});

test('reorder de una carpeta: «Libros» (solo existe por «Libros/…») se coloca con todo lo que lleva dentro', async () => {
  const s = await seeded();
  const t = await s.token(['library']);
  await tool(s.e, t, 'create_shelf', { name: 'Libros/Ensayo' });
  await tool(s.e, t, 'create_shelf', { name: 'Libros/Novela' });
  const r = await tool(s.e, t, 'reorder_shelves', { order: ['Favoritos', 'libros', 'Técnico'] });
  assert.deepEqual(r.json.order, ['Favoritos', 'Libros', 'Técnico', 'Técnico pendientes']);
  const lib = await s.readLib();
  const byName = Object.fromEntries(Object.values(lib.shelves).map((x) => [x.name, x.order]));
  // Una sola secuencia, en el orden del rail: la carpeta ocupa el hueco de sus estanterías.
  assert.deepEqual(byName, { Favoritos: 0, 'Libros/Ensayo': 1, 'Libros/Novela': 2, Técnico: 3, 'Técnico pendientes': 4 });
  const list = await tool(s.e, t, 'list_shelves', {});
  assert.deepEqual(list.json.shelves.map((x) => x.name), ['Favoritos', 'Libros/Ensayo', 'Libros/Novela', 'Técnico', 'Técnico pendientes'], 'list_shelves, en el orden del rail');
  const mixed = await tool(s.e, t, 'reorder_shelves', { order: ['Libros/Novela', 'Favoritos'] });
  assert.ok(mixed.isError && /mismo nivel/.test(mixed.text));
});

test('delete_books: permiso propio, dry_run sin rastro, tombstone como la app y la ficha entera en el deshacer', async () => {
  const s = await seeded();
  assert.ok(!(await toolNames(s.e, await s.token(['library', 'upload', 'write']))).includes('delete_books'));
  const t = await s.token(['delete']);
  assert.ok((await toolNames(s.e, t)).includes('delete_books'));

  const dry = await tool(s.e, t, 'delete_books', { books: ['pedro'], dry_run: true });
  assert.deepEqual(dry.json.deleted, [{ bookId: BOOK_2.id, title: 'Pedro Páramo', author: 'Juan Rulfo' }]);
  assert.equal((await s.readLib()).books[BOOK_2.id].deleted, false);
  assert.equal((await s.changes()).length, 0);

  const d = await tool(s.e, t, 'delete_books', { bookIds: [BOOK_1.id] });
  assert.equal(d.isError, false, d.text);
  const b = (await s.readLib()).books[BOOK_1.id];
  assert.equal(b.deleted, true);
  assert.ok(b.deletedAt > 10 && b.updatedAt === b.deletedAt);
  assert.equal(b.author, undefined);   // como deleteBook: el tombstone no lleva metadatos
  const [ch] = await s.changes();
  assert.deepEqual(ch.summary, { booksDeleted: 1 });
  const u = (await s.undoOf(d.json.changeId)).value;
  assert.equal(u.restore[BOOK_1.id].author, 'Kleppmann');
  assert.deepEqual(u.restore[BOOK_1.id].shelfIds, ['sh_tec']);
  // Ya borrado: no se borra dos veces.
  const again = await tool(s.e, t, 'delete_books', { bookIds: [BOOK_1.id] });
  assert.ok(again.isError && /ningún libro/.test(again.text));
  assert.ok(!(await tool(s.e, t, 'list_books', {})).json.books.some((x) => x.id === BOOK_1.id));
});
