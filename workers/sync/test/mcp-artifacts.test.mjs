// Artefactos creados por un agente (mcp/src/artifact-tools.mjs): la forma de la app
// (artifact-schema.js), citas solo si existen en el texto del libro, historial (crear, nunca
// editar) y borrado como tombstone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { env as baseEnv, ORIGIN } from './harness.mjs';
import * as C from '../../../app/js/sync/sync-crypto.js';
import { buildTextFiles } from '../../../app/js/sync/book-text-build.js';
import { SEG_VERSION } from '../../../mcp/src/artifact-tools.mjs';
import { BOOK_1, buildLayoutFiles } from '../../../mcp/test/helpers/dataset.mjs';

const LICENSE = 'BKRD-TEST-0001';
const BOOK_PATH = `bookreader/books/${BOOK_1.id}.json`;

function call(e, method, path, { body, token, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = 'Bearer ' + token;
  if (body !== undefined && !(body instanceof Uint8Array)) { body = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  if (body instanceof Uint8Array) h['Content-Length'] = String(body.length);
  return worker.fetch(new Request('https://sync.test' + path, { method, body, headers: h }), e);
}

async function seeded({ withText = true } = {}) {
  const e = baseEnv({ DATA_QUOTA_BYTES: String(10 * 1024 * 1024), MAX_BYTES: String(10 * 1024 * 1024) });
  const raw = C.generateKey();
  const k = await C.importKeys(raw);
  const { token: session } = await (await call(e, 'POST', '/v1/sync-token', { body: { license: LICENSE }, headers: { Origin: ORIGIN } })).json();
  const files = { ...buildLayoutFiles() };
  if (withText) {
    const lines = ['## Chapter 8. Transactions', ...Array.from({ length: 30 }, (_, i) => `[[a${i}]] Passage ${i} about transactions.`)];
    const f = buildTextFiles(lines.join('\n'), [{ title: 'Chapter 8. Transactions', from: 'a0' }], { bookId: BOOK_1.id, segVersion: 6 });
    files[`bookreader/text/${BOOK_1.id}.json`] = JSON.stringify(f.toc);
    files[`bookreader/text/${BOOK_1.id}/search.txt`] = f.search;
    f.parts.forEach((p, n) => { files[`bookreader/text/${BOOK_1.id}/p${n}.txt`] = p; });
  }
  for (const [path, content] of Object.entries(files)) {
    const pid = await C.pathId(k, path);
    const body = new Uint8Array(await (await C.encrypt(k, pid, typeof content === 'string' ? content : JSON.stringify(content))).arrayBuffer());
    await call(e, 'PUT', '/v1/o/' + pid, { body, token: session, headers: { 'X-Name': await C.encryptName(k, path), 'X-Kind': 'data' } });
  }
  const { token } = await (await call(e, 'POST', '/v1/mcp-tokens', { token: session, body: { name: 'Claude', key: C.b64url(raw), license: LICENSE, scopes: ['write', 'text'] } })).json();
  const readBook = async () => {
    const pid = await C.pathId(k, BOOK_PATH);
    const res = await call(e, 'GET', '/v1/o/' + pid, { token: session });
    return JSON.parse(await C.decryptText(k, pid, await res.blob()));
  };
  return { e, token, readBook };
}

let n = 0;
async function tool(e, token, name, args) {
  const r = (await (await call(e, 'POST', '/mcp', { token, body: { jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } } })).json()).result;
  return { isError: !!r.isError, text: r.content[0].text, json: r.isError ? null : JSON.parse(r.content[0].text) };
}

test('SEG_VERSION del MCP = la de la app (si no, el Studio escondería lo que crea un agente)', () => {
  const db = readFileSync(new URL('../../../app/js/ai/db.js', import.meta.url), 'utf8');
  assert.equal(Number(db.match(/export const SEG_VERSION = (\d+);/)[1]), SEG_VERSION);
});

test('create_mindmap: forma de la app, etiquetas recortadas, citas que existen y las que no fuera', async () => {
  const s = await seeded();
  const long = 'Write skew happens when two transactions read overlapping data and update disjoint objects';
  const r = await tool(s.e, s.token, 'create_mindmap', {
    bookId: BOOK_1.id, scope: 'Chapter 8. Transactions', title: 'Transacciones',
    branches: [
      { label: 'Anomalías', children: [{ label: long, src: 'a3' }, { label: 'Lost update', src: 'a999' }] },
      { label: 'Aislamiento', children: [{ label: 'Snapshot isolation', src: '[[a7]]', children: [{ label: 'MVCC' }] }] },
    ],
  });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.citationsDropped, 1);
  const book = await s.readBook();
  const art = book.artifacts.find((a) => a.kind === 'mindmap');
  assert.match(art.key, new RegExp(`^${BOOK_1.id}:mindmap:[0-9a-f-]{36}$`));
  assert.equal(art.segVersion, 6);
  assert.deepEqual(art.params, { scopeName: 'Chapter 8. Transactions', by: 'agent:Claude' });
  const leaf = art.result.branches[0].children[0];
  assert.ok(leaf.label.length <= 42 && leaf.label.endsWith('…'));
  assert.equal(leaf.full, long);
  assert.deepEqual([leaf.src, art.result.branches[0].children[1].src, art.result.branches[1].children[0].src], ['a3', '', 'a7']);
  assert.equal(art.result.branches[1].children[0].children[0].label, 'MVCC');
  const one = await tool(s.e, s.token, 'create_mindmap', { bookId: BOOK_1.id, branches: [{ label: 'Sola', children: [{ label: 'x' }] }] });
  assert.ok(one.isError && /2 ramas/.test(one.text));
});

test('sin texto del libro en el sync, ninguna cita se da por buena', async () => {
  const s = await seeded({ withText: false });
  const r = await tool(s.e, s.token, 'create_summary', { bookId: BOOK_1.id, tldr: 'Resumen corto.', sections: [{ title: 'Cap. 8', bullets: [{ text: 'Idea', src: 'a1' }] }] });
  assert.equal(r.json.citationsDropped, 1);
  assert.ok(!r.json.result.includes('[['));
});

test('create_infographic y create_summary: techos de la app; dry_run no guarda nada', async () => {
  const s = await seeded();
  const before = (await s.readBook()).artifacts.length;
  const info = await tool(s.e, s.token, 'create_infographic', {
    bookId: BOOK_1.id, thesis: 'T'.repeat(400), dry_run: true,
    ideas: Array.from({ length: 12 }, (_, i) => ({ head: 'Idea ' + i, body: 'Cuerpo ' + i, src: 'a' + i })),
    panels: [{ kind: 'flow', title: 'Cadena', items: [{ head: 'Paso', body: 'Algo' }] }, { kind: 'nope', items: [{ head: 'x', body: 'y' }] }],
    quote: { text: 'Una cita.', attribution: 'Kleppmann' },
  });
  assert.equal(info.isError, false, info.text);
  assert.equal(info.json.applied, false);
  assert.equal(info.json.result.ideas.length, 8);
  assert.ok(info.json.result.thesis.length <= 261);
  assert.deepEqual(info.json.result.panels.map((p) => p.kind), ['flow']);
  assert.equal(info.json.result.ideas[0].src, 'a0');
  assert.equal((await s.readBook()).artifacts.length, before, 'dry_run');

  const sum = await tool(s.e, s.token, 'create_summary', {
    bookId: BOOK_1.id, scope: 'Chapter 8', tldr: 'Las transacciones simplifican los errores.',
    ideas: ['ACID es un contrato'], sections: [{ title: 'Aislamiento', bullets: [{ text: 'Snapshot isolation evita lecturas sucias', src: 'a2' }] }],
    takeaways: [{ text: 'Serializable cuesta', src: 'a5' }],
  });
  assert.equal(sum.json.result, '# Resumen — Chapter 8\n\nLas transacciones simplifican los errores.\n\n## Ideas principales\n\n- ACID es un contrato\n\n## Aislamiento\n\n- Snapshot isolation evita lecturas sucias [[a2]]\n\n## Qué llevarte\n\n- Serializable cuesta [[a5]]\n');
  const listed = await tool(s.e, s.token, 'list_artifacts', { bookId: BOOK_1.id, kind: 'summary' });
  assert.ok(JSON.stringify(listed.json).includes(sum.json.key));
});

test('delete_artifact: tombstone; los que no son del Studio no se tocan', async () => {
  const s = await seeded();
  const m = await tool(s.e, s.token, 'create_summary', { bookId: BOOK_1.id, tldr: 'x' });
  const d = await tool(s.e, s.token, 'delete_artifact', { bookId: BOOK_1.id, key: m.json.key });
  assert.equal(d.json.deleted.kind, 'summary');
  const art = (await s.readBook()).artifacts.find((a) => a.key === m.json.key);
  assert.ok(art.deleted && art.result === null);
  const again = await tool(s.e, s.token, 'delete_artifact', { bookId: BOOK_1.id, key: m.json.key });
  assert.ok(again.isError);
});
