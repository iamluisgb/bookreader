// El texto de los libros por MCP (mcp/src/text-tools.mjs): get_toc, read_chapter por páginas y
// search_book, sobre el fichero que sube la app (app/js/sync/book-text.js). Con el permiso
// `text`; sin él, ni se anuncian. Y el aviso a los dispositivos (bookText en el token).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { env as baseEnv, ORIGIN } from './harness.mjs';
import * as C from '../../../app/js/sync/sync-crypto.js';
import { BOOK_1, buildLayoutFiles } from '../../../mcp/test/helpers/dataset.mjs';
import { buildTextFiles } from '../../../app/js/sync/book-text-build.js';

const LICENSE = 'BKRD-TEST-0001';

function call(e, method, path, { body, token, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = 'Bearer ' + token;
  if (body !== undefined && !(body instanceof Uint8Array)) { body = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  if (body instanceof Uint8Array) h['Content-Length'] = String(body.length);
  return worker.fetch(new Request('https://sync.test' + path, { method, body, headers: h }), e);
}

// Un libro de ~3000 pasajes en tres capítulos (como uno real de 400 páginas), troceado como lo
// trocea la app.
function bookText() {
  const lines = [];
  const chapters = [];
  let n = 0;
  for (const [ci, title] of ['Chapter 7. Replication', 'Chapter 8. Transactions', 'Chapter 9. Consensus'].entries()) {
    lines.push('', '## ' + title);
    chapters.push({ title, from: 'a' + n });
    for (let i = 0; i < 1000; i++) {
      if (i === 500) lines.push('', '## Section ' + ci + '.2');
      const special = ci === 1 && i === 742 ? ' Write skew happens when two doctors both go off call after checking each other.' : '';
      lines.push(`[[a${n}]] Paragraph ${i} of ${title} talks about databases, nodes and the log of writes.${special}`);
      n++;
    }
  }
  // Como lo sube la app (book-text.js): índice, trozos y búsqueda.
  const f = buildTextFiles(lines.join('\n'), chapters, { bookId: BOOK_1.id, title: BOOK_1.title, segVersion: 6 });
  const dir = `bookreader/text/${BOOK_1.id}/`;
  return {
    [`bookreader/text/${BOOK_1.id}.json`]: JSON.stringify(f.toc),
    [dir + 'search.txt']: f.search,
    ...Object.fromEntries(f.parts.map((p, n) => [dir + 'p' + n + '.txt', p])),
  };
}

async function seeded() {
  const e = baseEnv({ DATA_QUOTA_BYTES: String(20 * 1024 * 1024), MAX_BYTES: String(20 * 1024 * 1024) });
  const raw = C.generateKey();
  const k = await C.importKeys(raw);
  const login = async () => (await call(e, 'POST', '/v1/sync-token', { body: { license: LICENSE }, headers: { Origin: ORIGIN } })).json();
  const session = (await login()).token;
  const files = { ...buildLayoutFiles(), ...bookText() };
  for (const [path, content] of Object.entries(files)) {
    const pid = await C.pathId(k, path);
    const body = new Uint8Array(await (await C.encrypt(k, pid, typeof content === 'string' ? content : JSON.stringify(content))).arrayBuffer());
    assert.equal((await call(e, 'PUT', '/v1/o/' + pid, { body, token: session, headers: { 'X-Name': await C.encryptName(k, path), 'X-Kind': 'data' } })).status, 200);
  }
  const token = async (scopes) => (await (await call(e, 'POST', '/v1/mcp-tokens', {
    token: session, body: { name: 'Claude', key: C.b64url(raw), license: LICENSE, scopes },
  })).json()).token;
  return { e, login, token };
}

let id = 0;
async function tool(e, token, name, args) {
  const r = (await (await call(e, 'POST', '/mcp', { token, body: { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } } })).json()).result;
  return { isError: !!r.isError, text: r.content[0].text, json: r.isError ? null : JSON.parse(r.content[0].text) };
}

test('sin el permiso «text», las tools del texto no existen; y los dispositivos no lo suben', async () => {
  const s = await seeded();
  const t = await s.token(['write']);
  const r = await tool(s.e, t, 'get_toc', { bookId: BOOK_1.id });
  assert.ok(r.isError && /Tool desconocida/.test(r.text));
  assert.equal((await s.login()).bookText, false);
  await s.token(['text']);
  assert.equal((await s.login()).bookText, true, 'con un agente que puede leerlo, los dispositivos lo suben');
});

test('get_toc y read_chapter: capítulos del índice, páginas que se encadenan con nextOffset', async () => {
  const s = await seeded();
  const t = await s.token(['text']);
  const toc = await tool(s.e, t, 'get_toc', { book: 'datos intensivos' });
  assert.deepEqual(toc.json.chapters.map((c) => [c.index, c.title, c.passages]), [[0, 'Chapter 7. Replication', 1000], [1, 'Chapter 8. Transactions', 1000], [2, 'Chapter 9. Consensus', 1000]]);
  let offset = 0;
  let pages = 0;
  const ids = [];
  for (;;) {
    const p = await tool(s.e, t, 'read_chapter', { bookId: BOOK_1.id, chapter: 'transactions', offset, maxWords: 4000 });
    assert.ok(p.json.words <= 4000);
    ids.push(...[...p.json.text.matchAll(/\[\[(a\d+)\]\]/g)].map((m) => m[1]));
    pages++;
    if (p.json.nextOffset === null) break;
    offset = p.json.nextOffset;
  }
  assert.ok(pages > 1);
  assert.equal(ids.length, 1000);
  assert.equal(ids[0], 'a1000');
  assert.equal(ids[999], 'a1999');
  const first = await tool(s.e, t, 'read_chapter', { bookId: BOOK_1.id, chapter: 1, offset: 499, maxWords: 300 });
  assert.match(first.json.text, /## Section 1\.2\n\[\[a1500\]\]/);
});

test('search_book: el pasaje que de verdad habla de ello, con su ancla y capítulo', async () => {
  const s = await seeded();
  const t = await s.token(['text']);
  const t0 = performance.now();
  const r = await tool(s.e, t, 'search_book', { bookId: BOOK_1.id, query: 'médicos write skew doctors', limit: 3 });
  const ms = performance.now() - t0;
  assert.equal(r.json.results[0].id, 'a1742');
  assert.equal(r.json.results[0].chapterTitle, 'Chapter 8. Transactions');
  console.log(`search_book sobre 3000 pasajes: ${ms.toFixed(1)} ms (petición entera, en Node)`);
});

test('un libro sin texto en el sync: error que dice cómo conseguirlo', async () => {
  const s = await seeded();
  const t = await s.token(['text']);
  const books = (await tool(s.e, t, 'list_books', {})).json.books;
  const other = books.find((b) => b.id !== BOOK_1.id);
  const r = await tool(s.e, t, 'get_toc', { bookId: other.id });
  assert.ok(r.isError && /aún no tiene texto/.test(r.text));
});
