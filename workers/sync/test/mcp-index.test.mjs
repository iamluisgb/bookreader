// IA10 F2 · El almacén de pasajes del índice de la biblioteca en el Worker: bloques sellados por
// separado (sync-crypto.js · sealBlocks) que el MCP lee con lecturas por RANGO de R2 y abre uno a
// uno (src/mcp.js · r2Provider.readBlocks). El servidor no puede cambiarlos de sitio.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { r2Provider } from '../src/mcp.js';
import { env as baseEnv, ORIGIN } from './harness.mjs';
import * as C from '../../../app/js/sync/sync-crypto.js';
import { buildTextFiles } from '../../../app/js/sync/book-text-build.js';
import { createIndexer } from '../../../app/js/sync/library-index.js';
import { BOOK_1, BOOK_2, buildLayoutFiles } from '../../../mcp/test/helpers/dataset.mjs';

const LICENSE = 'BKRD-TEST-0001';
const PATH = 'bookreader/index/s/libro.bin';

function call(e, method, path, { body, token, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = 'Bearer ' + token;
  if (body !== undefined && !(body instanceof Uint8Array)) { body = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  if (body instanceof Uint8Array) h['Content-Length'] = String(body.length);
  return worker.fetch(new Request('https://sync.test' + path, { method, body, headers: h }), e);
}

async function seeded() {
  const e = baseEnv({ DATA_QUOTA_BYTES: String(10 * 1024 * 1024), MAX_BYTES: String(10 * 1024 * 1024) });
  const raw = C.generateKey();
  const k = await C.importKeys(raw);
  const session = (await (await call(e, 'POST', '/v1/sync-token', { body: { license: LICENSE }, headers: { Origin: ORIGIN } })).json()).token;
  const enc = new TextEncoder();
  const blocks = Array.from({ length: 6 }, (_, i) => enc.encode(`${i * 10}\tbloque ${i}: ${'x'.repeat(3000 + i)}\n`));
  const put = async (path, body) => {
    const pid = await C.pathId(k, path);
    assert.equal((await call(e, 'PUT', '/v1/o/' + pid, { body, token: session, headers: { 'X-Name': await C.encryptName(k, path), 'X-Kind': 'data' } })).status, 200);
  };
  const { body, offsets } = await C.sealBlocks(k, await C.pathId(k, PATH), blocks);
  await put(PATH, body);
  const user = e.DB._raw.prepare('SELECT id FROM users').get().id;
  return { e, k, raw, user, offsets, put };
}

const spec = (offsets, i) => ({ i, count: offsets.length - 1, offset: offsets[i], length: offsets[i + 1] - offsets[i] });

test('lee solo los bloques pedidos, con una lectura por rango cada uno', async () => {
  const s = await seeded();
  const p = r2Provider(s.e, s.user, s.raw);
  const before = s.e.SYNC._ops.get;
  const used = () => s.e.DB._raw.prepare('SELECT COALESCE(SUM(class_b), 0) AS n FROM usage').get().n;
  const spent = used();
  const out = await p.readBlocks(PATH, [spec(s.offsets, 1), spec(s.offsets, 4)]);
  assert.equal(s.e.SYNC._ops.get - before, 2);
  assert.equal(used() - spent, 2, 'el tope mensual cuenta cada bloque, reservados de una vez');
  assert.match(out[0], /^10\tbloque 1: x{3001}\n$/);
  assert.match(out[1], /^40\tbloque 4: x{3004}\n$/);
  assert.equal(await p.readBlocks('bookreader/index/s/otro.bin', [spec(s.offsets, 0)]), null);
});

test('un bloque en otra posición, de otro fichero o sin su final no se abre', async () => {
  const s = await seeded();
  const p = r2Provider(s.e, s.user, s.raw);
  // Pedir los bytes del bloque 2 diciendo que es el 3: los datos asociados no casan.
  await assert.rejects(p.readBlocks(PATH, [{ ...spec(s.offsets, 2), i: 3 }]));
  // Con otro total (como si se hubieran quitado bloques del final).
  await assert.rejects(p.readBlocks(PATH, [{ ...spec(s.offsets, 2), count: 3 }]));
  // El mismo contenido sellado para otra ruta.
  const other = 'bookreader/index/s/copia.bin';
  const { body } = await C.sealBlocks(s.k, await C.pathId(s.k, PATH), [new TextEncoder().encode('0\tajeno\n')]);
  await s.put(other, body);
  await assert.rejects(p.readBlocks(other, [{ i: 0, count: 1, offset: 0, length: body.length }]));
});

// ---- search_library de punta a punta ---------------------------------------------------------
//
// Un «dispositivo» de test sube el texto e indexa con el constructor de la app
// (library-index.js · createIndexer), cifrando como la app; un agente consulta por /mcp.

const GRAPHS = 'kg00000000000000';
const LIB = 'bookreader/library.json';
const library = () => ({
  schemaVersion: 1,
  books: {
    [BOOK_1.id]: { title: 'Diseño de datos intensivos', format: 'epub', status: 'reading', shelfIds: ['sh_tec'], addedAt: 1, deleted: false, deletedAt: 0, updatedAt: 10 },
    [BOOK_2.id]: { title: 'Pedro Páramo', format: 'epub', status: 'unread', shelfIds: [], addedAt: 2, deleted: false, deletedAt: 0, updatedAt: 10 },
    [GRAPHS]: { title: 'Knowledge Graphs', format: 'epub', status: 'unread', shelfIds: ['sh_ia'], addedAt: 3, deleted: false, deletedAt: 0, updatedAt: 10 },
  },
  shelves: {
    sh_tec: { name: 'Técnico', createdAt: 1, order: null, rule: null, deleted: false, deletedAt: 0, updatedAt: 1 },
    sh_ia: { name: 'Técnico/IA', createdAt: 2, order: null, rule: null, deleted: false, deletedAt: 0, updatedAt: 1 },
    sh_nov: { name: 'Novela', createdAt: 3, order: null, rule: null, deleted: false, deletedAt: 0, updatedAt: 1 },
  },
});

function text(id, topics) {
  const lines = [];
  const starts = [];
  let n = 0;
  for (const c of [1, 2, 3]) {
    const title = `Chapter ${c}`;
    lines.push('', '## ' + title);
    starts.push({ title, from: 'a' + n });
    for (let i = 0; i < 300; i++) {
      lines.push(`[[a${n}]] Paragraph ${i} of chapter ${c} about logs and nodes and writes.${topics[n] ? ' ' + topics[n] : ''}`);
      n++;
    }
  }
  return buildTextFiles(lines.join('\n'), starts, { bookId: id, title: id, segVersion: 6 });
}

// La interfaz de proveedor de la app (read/write/remove/list/writeBlocks), contra el Worker.
function deviceIo(e, k, session) {
  const headers = async (path) => ({ 'X-Name': await C.encryptName(k, path), 'X-Kind': 'data' });
  const meta = async (pid) => {
    const r = await call(e, 'GET', '/v1/meta/' + pid, { token: session });
    return r.status === 200 ? r.json() : null;
  };
  const put = async (path, body) => {
    const pid = await C.pathId(k, path);
    const cur = await meta(pid);
    const h = await headers(path);
    if (cur) h['If-Match'] = String(cur.etag);
    const res = await call(e, 'PUT', '/v1/o/' + pid, { body, token: session, headers: h });
    if (!res.ok) throw Object.assign(new Error('PUT ' + res.status), { code: res.status });
    return { etag: String((await res.json()).etag) };
  };
  return {
    async read(path) {
      const pid = await C.pathId(k, path);
      const res = await call(e, 'GET', '/v1/o/' + pid, { token: session });
      if (res.status === 404) return null;
      return { content: await C.decryptText(k, pid, await res.blob()), etag: res.headers.get('ETag') || '' };
    },
    async write(path, content) {
      const pid = await C.pathId(k, path);
      return put(path, new Uint8Array(await (await C.encrypt(k, pid, content)).arrayBuffer()));
    },
    async writeBlocks(path, blocks) {
      const { body, offsets } = await C.sealBlocks(k, await C.pathId(k, path), blocks);
      return { ...(await put(path, body)), offsets };
    },
    async remove(path) {
      await call(e, 'DELETE', '/v1/o/' + (await C.pathId(k, path)), { token: session });
    },
    async list(prefix) {
      const { items } = await (await call(e, 'GET', '/v1/list', { token: session })).json();
      const out = [];
      for (const it of items) {
        const path = await C.decryptName(k, it.name).catch(() => null);
        if (path && path.startsWith(prefix)) out.push({ path, etag: String(it.etag), modifiedTime: new Date(it.updatedAt).toISOString(), size: it.size });
      }
      return out;
    },
  };
}

async function indexed() {
  const e = baseEnv({ DATA_QUOTA_BYTES: String(20 * 1024 * 1024), MAX_BYTES: String(20 * 1024 * 1024) });
  const raw = C.generateKey();
  const k = await C.importKeys(raw);
  const session = (await (await call(e, 'POST', '/v1/sync-token', { body: { license: LICENSE }, headers: { Origin: ORIGIN } })).json()).token;
  const io = deviceIo(e, k, session);
  for (const [path, content] of Object.entries({ ...buildLayoutFiles(), [LIB]: library() })) await io.write(path, JSON.stringify(content));
  const books = {
    [BOOK_1.id]: text(BOOK_1.id, { 320: 'Raft is a consensus algorithm.', 321: 'Leader election in Raft uses terms.', 700: 'Consensus is hard.' }),
    [GRAPHS]: text(GRAPHS, { 5: 'An ontology defines the classes of a knowledge graph.', 6: 'Ontologies and taxonomies differ.', 610: 'The ontology of the domain.' }),
  };
  for (const [id, f] of Object.entries(books)) {
    await io.write(`bookreader/text/${id}.json`, JSON.stringify(f.toc));
    await io.write(`bookreader/text/${id}/search.txt`, f.search);
    for (const [n, p] of f.parts.entries()) await io.write(`bookreader/text/${id}/p${n}.txt`, p);
  }
  const ix = createIndexer(io, 'bookreader/');
  for (const id of Object.keys(books)) assert.equal(await ix.indexBook(id), true);
  const token = (await (await call(e, 'POST', '/v1/mcp-tokens', { token: session, body: { name: 'Claude', key: C.b64url(raw), license: LICENSE, scopes: ['text'] } })).json()).token;
  return { e, token, books, ix };
}

let rpc = 0;
async function tool(e, token, name, args) {
  const r = (await (await call(e, 'POST', '/mcp', { token, body: { jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } } })).json()).result;
  return { isError: !!r.isError, text: r.content[0].text, json: r.isError ? null : JSON.parse(r.content[0].text) };
}

const original = (f, n) => f.parts.join('\n').split('\n').find((l) => l.startsWith(`[[a${n}]] `)).slice(`[[a${n}]] `.length);

test('search_library: en una llamada, el libro que trata el tema, sus pasajes exactos y lo no buscado', async () => {
  const s = await indexed();
  const gets = s.e.SYNC._ops.get;
  const r = await tool(s.e, s.token, 'search_library', { queries: ['what do we have on ontologies?', 'knowledge graph taxonomy'] });
  assert.equal(r.isError, false, r.text);
  const used = s.e.SYNC._ops.get - gets;
  if (process.env.SHOW_READS) console.log('lecturas de R2 en search_library:', used);
  assert.ok(used <= 40, 'lecturas de R2: ' + used);
  assert.deepEqual(r.json.terms, ['ontology', 'knowledg', 'graph', 'taxonomy']);
  const top = r.json.books[0];
  assert.equal(top.bookId, GRAPHS);
  assert.equal(top.title, 'Knowledge Graphs');
  assert.deepEqual(top.passages.map((p) => p.id).sort(), ['a5', 'a6', 'a610']);
  for (const p of top.passages) {
    assert.equal(p.text, original(s.books[GRAPHS], Number(p.id.slice(1))));
    assert.equal(p.ref, GRAPHS + ':' + p.id);
  }
  assert.equal(top.passages.find((p) => p.id === 'a610').chapterTitle, 'Chapter 3');
  assert.deepEqual(r.json.notSearched.map((b) => b.bookId), [BOOK_2.id]);
  assert.equal(r.json.searched, 2);
});

test('search_library: por estantería (con sus subestanterías), y sin permiso de texto no existe', async () => {
  const s = await indexed();
  const tec = await tool(s.e, s.token, 'search_library', { query: 'raft consensus ontology', shelf: 'Técnico' });
  assert.deepEqual(tec.json.books.map((b) => b.bookId).sort(), [BOOK_1.id, GRAPHS].sort());
  assert.equal(tec.json.shelf, 'Técnico');
  assert.deepEqual(tec.json.notSearched, []);
  const ia = await tool(s.e, s.token, 'search_library', { query: 'raft consensus ontology', shelf: 'técnico/ia' });
  assert.deepEqual(ia.json.books.map((b) => b.bookId), [GRAPHS]);
  const nov = await tool(s.e, s.token, 'search_library', { query: 'raft', shelf: 'Novela' });
  assert.deepEqual(nov.json.books, []);
  const bad = await tool(s.e, s.token, 'search_library', { query: 'raft', shelf: 'No existe' });
  assert.ok(bad.isError && /No hay ninguna estantería/.test(bad.text));
  const sinTexto = await tool(s.e, s.token, 'search_library', {});
  assert.ok(sinTexto.isError && /Falta «query»/.test(sinTexto.text));
});

test('search_library: un libro borrado del índice deja de salir al momento', async () => {
  const s = await indexed();
  await s.ix.removeBook(GRAPHS);
  const r = await tool(s.e, s.token, 'search_library', { query: 'ontology raft' });
  assert.deepEqual(r.json.books.map((b) => b.bookId), [BOOK_1.id]);
  assert.deepEqual(r.json.notSearched.map((b) => b.bookId).sort(), [BOOK_2.id, GRAPHS].sort());
});
