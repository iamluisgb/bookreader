// review_cards (mcp/src/write-tools.mjs): apuntar desde fuera de la app un repaso hecho por el
// lector, como lo apunta el modo Estudiar (estado FSRS nuevo, `srsAt`, registro en `attempts`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { env as baseEnv, ORIGIN } from './harness.mjs';
import * as C from '../../../app/js/sync/sync-crypto.js';
import { BOOK_1, buildLayoutFiles } from '../../../mcp/test/helpers/dataset.mjs';
import { gradeAt } from '../../../mcp/src/write-tools.mjs';
import { withParameters, DEFAULT_PARAMETERS } from '../../../app/js/ai/srs.js';

const LICENSE = 'BKRD-TEST-0001';
const DECK_UID = 'deck-rv';
const BOOK_PATH = `bookreader/books/${BOOK_1.id}.json`;
const SETTINGS_PATH = 'bookreader/settings.json';
const DAY = 86400000;

function call(e, method, path, { body, token, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = 'Bearer ' + token;
  if (body !== undefined && !(body instanceof Uint8Array)) { body = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  if (body instanceof Uint8Array) h['Content-Length'] = String(body.length);
  return worker.fetch(new Request('https://sync.test' + path, { method, body, headers: h }), e);
}

function files({ fsrs = null } = {}) {
  const out = buildLayoutFiles();
  const book = JSON.parse(JSON.stringify(out[BOOK_PATH]));
  book.decks = [{
    id: 7, uid: DECK_UID, bookId: BOOK_1.id, name: 'Repaso', scope: 'Chapter 8', cardType: 'mixed', createdAt: 1, updatedAt: 1,
    cards: [
      { uid: 'c1', type: 'basic', front: 'Read committed?', back: 'No dirty reads or writes.', updatedAt: 1, textAt: 5,
        srs: { reps: 2, lapses: 0, interval: 3, due: 20000, lastReview: Date.now() - 4 * DAY, stability: 3.2, difficulty: 5 } },
      { uid: 'c2', type: 'basic', front: 'Phantom?', back: 'A write that changes a search result.', updatedAt: 1 },
      { uid: 'c3', type: 'basic', front: 'Suspendida', back: 'x', updatedAt: 1, suspended: true },
    ],
  }];
  out[BOOK_PATH] = book;
  if (fsrs) out[SETTINGS_PATH] = { ...(out[SETTINGS_PATH] || {}), fsrs_params: { w: fsrs, ts: 1 } };
  return out;
}

async function seeded(opts) {
  const e = baseEnv({ DATA_QUOTA_BYTES: String(10 * 1024 * 1024), MAX_BYTES: String(10 * 1024 * 1024) });
  const raw = C.generateKey();
  const k = await C.importKeys(raw);
  const { token: session } = await (await call(e, 'POST', '/v1/sync-token', { body: { license: LICENSE }, headers: { Origin: ORIGIN } })).json();
  for (const [path, content] of Object.entries(files(opts))) {
    const pid = await C.pathId(k, path);
    const body = new Uint8Array(await (await C.encrypt(k, pid, JSON.stringify(content))).arrayBuffer());
    const res = await call(e, 'PUT', '/v1/o/' + pid, { body, token: session, headers: { 'X-Name': await C.encryptName(k, path), 'X-Kind': 'data' } });
    assert.equal(res.status, 200);
  }
  const readBook = async () => {
    const pid = await C.pathId(k, BOOK_PATH);
    const res = await call(e, 'GET', '/v1/o/' + pid, { token: session });
    return { etag: res.headers.get('ETag'), book: JSON.parse(await C.decryptText(k, pid, await res.blob())) };
  };
  const token = async (scopes) => (await (await call(e, 'POST', '/v1/mcp-tokens', {
    token: session, body: { name: 'Orca', key: C.b64url(raw), license: LICENSE, scopes },
  })).json()).token;
  return { e, readBook, token };
}

let n = 0;
async function tool(e, token, name, args) {
  const res = await call(e, 'POST', '/mcp', { token, body: { jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } } });
  const r = (await res.json()).result;
  return { isError: !!r.isError, text: r.content[0].text, json: r.isError ? null : JSON.parse(r.content[0].text) };
}
const toolNames = async (e, token) => (await (await call(e, 'POST', '/mcp', { token, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).json()).result.tools.map((t) => t.name);

test('review_cards solo existe con permiso de escritura', async () => {
  const s = await seeded();
  assert.ok(!(await toolNames(s.e, await s.token(undefined))).includes('review_cards'));
  assert.ok((await toolNames(s.e, await s.token(['write']))).includes('review_cards'));
});

test('apunta el repaso como la app: estado FSRS nuevo, srsAt, texto intacto y registro de intento', async () => {
  const s = await seeded();
  const rw = await s.token(['write']);
  const before = (await s.readBook()).book.decks[0].cards;
  const at = Date.now() - 60000;
  const r = await tool(s.e, rw, 'review_cards', {
    bookId: BOOK_1.id, deckUid: DECK_UID, tzOffset: -60,
    reviews: [{ uid: 'c1', rating: 'good', at, latencyMs: 4200, reviewId: 'rv-1' }, { uid: 'c2', rating: 'again', at, reviewId: 'rv-2' }],
  });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.applied.length, 2);
  assert.equal(r.json.personalParameters, false);

  const { book } = await s.readBook();
  const [c1, c2] = book.decks[0].cards;
  assert.deepEqual(c1.srs, gradeAt(before[0].srs, 'good', at, -60), 'el mismo cálculo que la app');
  assert.equal(c1.srs.lastReview, at);
  assert.equal(c1.srs.reps, 3);
  assert.ok(c1.srs.due > before[0].srs.due);
  assert.ok(c1.srsAt > 0 && c1.updatedAt === c1.srsAt);
  assert.equal(c1.textAt, 5, 'el texto no cambia: el merge no debe pisar ediciones');
  assert.equal(c2.srs.lapses, 1);
  assert.equal(c2.srs.reps, 0);

  const attempts = book.attempts.filter((a) => a.deckUid === DECK_UID);
  assert.equal(attempts.length, 2);
  assert.deepEqual(
    { ...attempts[0], cardHash: typeof attempts[0].cardHash },
    { uid: 'rv-1', cardUid: 'c1', deckUid: DECK_UID, bookId: BOOK_1.id, ts: at, mode: 'reveal', verdict: null, exact: null,
      grade: 'good', prevInterval: 3, latencyMs: 4200, arm: null, answer: null, cardHash: 'string', asked: false },
  );
  assert.equal(attempts[1].prevInterval, null, 'tarjeta nueva');

  const stats = await tool(s.e, rw, 'get_attempts', { bookId: BOOK_1.id, deckUid: DECK_UID });
  assert.equal(stats.isError, false, stats.text);
  assert.equal(stats.json.attempts.length, 2, 'get_attempts ya los ve');
});

test('con el mismo reviewId no se apunta dos veces', async () => {
  const s = await seeded();
  const rw = await s.token(['write']);
  const args = { bookId: BOOK_1.id, deckUid: DECK_UID, reviews: [{ uid: 'c2', rating: 'good', reviewId: 'rv-x' }] };
  assert.equal((await tool(s.e, rw, 'review_cards', args)).json.applied.length, 1);
  const { etag } = await s.readBook();
  const again = await tool(s.e, rw, 'review_cards', args);
  assert.deepEqual(again.json.applied, []);
  assert.equal(again.json.skipped[0].reason, 'ya apuntado');
  assert.equal((await s.readBook()).etag, etag, 'nada que escribir');
});

test('suspendida, uid desconocido o nota inválida: error y no se escribe nada', async () => {
  const s = await seeded();
  const rw = await s.token(['write']);
  const { etag } = await s.readBook();
  for (const reviews of [
    [{ uid: 'c1', rating: 'good' }, { uid: 'c3', rating: 'good' }],
    [{ uid: 'nope', rating: 'good' }],
    [{ uid: 'c1', rating: 'bien' }],
    [{ uid: 'c1', rating: 'good', at: Date.now() + DAY }],
  ]) {
    const r = await tool(s.e, rw, 'review_cards', { bookId: BOOK_1.id, deckUid: DECK_UID, reviews });
    assert.ok(r.isError, JSON.stringify(reviews));
  }
  assert.equal((await s.readBook()).etag, etag);
});

test('usa los parámetros FSRS personales del lector', async () => {
  const w = DEFAULT_PARAMETERS.slice();
  w[2] = 9.5;   // estabilidad inicial de «good» mucho mayor que la de serie
  const s = await seeded({ fsrs: w });
  const rw = await s.token(['write']);
  const at = Date.now() - 1000;
  const r = await tool(s.e, rw, 'review_cards', { bookId: BOOK_1.id, deckUid: DECK_UID, tzOffset: 0, reviews: [{ uid: 'c2', rating: 'good', at }] });
  assert.equal(r.json.personalParameters, true);
  const expected = withParameters(w, () => gradeAt(null, 'good', at, 0));
  const byDefault = gradeAt(null, 'good', at, 0);
  assert.equal(r.json.applied[0].interval, expected.interval);
  assert.notEqual(expected.interval, byDefault.interval);
});

test('gradeAt: «hoy» es el día del lector, no el del servidor', () => {
  const at = Date.UTC(2026, 10, 21, 23, 30);   // 23:30 UTC = 00:30 del día siguiente en Madrid
  const madrid = gradeAt(null, 'good', at, -60);
  const utc = gradeAt(null, 'good', at, 0);
  assert.equal(madrid.due - utc.due, 1);
  assert.equal(madrid.lastReview, at);
});
