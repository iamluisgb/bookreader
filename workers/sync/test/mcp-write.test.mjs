// El MCP que ESCRIBE (mcp/src/write-tools.mjs sobre src/mcp.js · r2Provider.update): permisos,
// lo que se guarda (cifrado, con versión), la concurrencia con un dispositivo y las reglas de la
// app (repaso intacto, tombstones, duplicados, cloze sin hueco).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { r2Provider } from '../src/mcp.js';
import { env as baseEnv, ORIGIN } from './harness.mjs';
import * as C from '../../../app/js/sync/sync-crypto.js';
import { BOOK_1, buildLayoutFiles } from '../../../mcp/test/helpers/dataset.mjs';

const LICENSE = 'BKRD-TEST-0001';
const DECK_UID = 'deck-tx';
const BOOK_PATH = `bookreader/books/${BOOK_1.id}.json`;

function call(e, method, path, { body, token, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = 'Bearer ' + token;
  if (body !== undefined && !(body instanceof Uint8Array)) { body = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  if (body instanceof Uint8Array) h['Content-Length'] = String(body.length);
  return worker.fetch(new Request('https://sync.test' + path, { method, body, headers: h }), e);
}

function filesWithDeck() {
  const files = buildLayoutFiles();
  const book = JSON.parse(JSON.stringify(files[BOOK_PATH]));
  book.decks = [{
    id: 34, uid: DECK_UID, bookId: BOOK_1.id, name: 'Transacciones', scope: 'Chapter 8', cardType: 'mixed', createdAt: 1, updatedAt: 1,
    cards: [
      { uid: 'c1', type: 'basic', front: 'What two guarantees does read committed give?', back: 'No dirty reads and no dirty writes.', updatedAt: 1, srs: { reps: 3, due: 20800, lastReview: 1000 } },
      { uid: 'c2', type: 'cloze', front: 'A {{c1::phantom}} is a write that changes a search result.', back: '', updatedAt: 1 },
    ],
  }];
  files[BOOK_PATH] = book;
  return files;
}

async function seeded() {
  const e = baseEnv({ DATA_QUOTA_BYTES: String(10 * 1024 * 1024), MAX_BYTES: String(10 * 1024 * 1024) });
  const raw = C.generateKey();
  const k = await C.importKeys(raw);
  const { token: session } = await (await call(e, 'POST', '/v1/sync-token', { body: { license: LICENSE }, headers: { Origin: ORIGIN } })).json();
  const put = async (path, content, headers = {}) => {
    const pid = await C.pathId(k, path);
    const body = new Uint8Array(await (await C.encrypt(k, pid, typeof content === 'string' ? content : JSON.stringify(content))).arrayBuffer());
    return call(e, 'PUT', '/v1/o/' + pid, { body, token: session, headers: { 'X-Name': await C.encryptName(k, path), 'X-Kind': 'data', ...headers } });
  };
  for (const [path, content] of Object.entries(filesWithDeck())) assert.equal((await put(path, content)).status, 200);
  const readBook = async () => {
    const pid = await C.pathId(k, BOOK_PATH);
    const res = await call(e, 'GET', '/v1/o/' + pid, { token: session });
    return { etag: res.headers.get('ETag'), book: JSON.parse(await C.decryptText(k, pid, await res.blob())) };
  };
  const token = async (scopes) => (await (await call(e, 'POST', '/v1/mcp-tokens', {
    token: session, body: { name: 'Claude', key: C.b64url(raw), license: LICENSE, scopes },
  })).json()).token;
  return { e, raw, k, session, put, readBook, token };
}

let n = 0;
async function tool(e, token, name, args) {
  const res = await call(e, 'POST', '/mcp', { token, body: { jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } } });
  const r = (await res.json()).result;
  return { isError: !!r.isError, text: r.content[0].text, json: r.isError ? null : JSON.parse(r.content[0].text) };
}
const toolNames = async (e, token) => (await (await call(e, 'POST', '/mcp', { token, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).json()).result.tools.map((t) => t.name);

test('permisos: sin «write» las tools de escritura ni se anuncian ni se ejecutan', async () => {
  const s = await seeded();
  const ro = await s.token(undefined);
  assert.ok(!(await toolNames(s.e, ro)).includes('update_cards'));
  const r = await tool(s.e, ro, 'update_cards', { bookId: BOOK_1.id, deckUid: DECK_UID, changes: [{ uid: 'c1', front: 'x' }] });
  assert.ok(r.isError && /Tool desconocida/.test(r.text));
  const rw = await s.token(['write']);
  assert.ok((await toolNames(s.e, rw)).includes('update_cards'));
  const list = await (await call(s.e, 'GET', '/v1/mcp-tokens', { token: s.session })).json();
  assert.deepEqual(list.tokens.map((t) => t.scopes).sort(), [['read'], ['read', 'write']]);
});

test('update_cards: dry_run no escribe; aplicado cambia el texto, conserva el repaso y deja versión', async () => {
  const s = await seeded();
  const rw = await s.token(['write']);
  const before = await s.readBook();
  const change = { uid: 'c1', type: 'cloze', front: 'Read committed guarantees no {{c1::dirty reads}} and no {{c2::dirty writes}}.', back: '' };
  const dry = await tool(s.e, rw, 'update_cards', { book: 'datos intensivos', deckUid: DECK_UID, changes: [change], dry_run: true });
  assert.equal(dry.json.applied, false);
  assert.equal(dry.json.updated[0].before.front, 'What two guarantees does read committed give?');
  assert.equal((await s.readBook()).etag, before.etag, 'dry_run no toca nada');

  const ok = await tool(s.e, rw, 'update_cards', { bookId: BOOK_1.id, deckUid: DECK_UID, changes: [change] });
  assert.equal(ok.json.applied, true);
  const { book, etag } = await s.readBook();
  assert.notEqual(etag, before.etag);
  const c1 = book.decks[0].cards.find((c) => c.uid === 'c1');
  assert.equal(c1.front, change.front);
  assert.deepEqual(c1.srs, { reps: 3, due: 20800, lastReview: 1000 }, 'el repaso no se toca');
  assert.ok(c1.textAt > 1000 && c1.updatedAt === c1.textAt);
  assert.equal(c1.editedBy, 'agent:Claude');
  const versions = s.e.DB._raw.prepare(`SELECT COUNT(*) AS n FROM blobs WHERE state = 'version'`).get().n;
  assert.equal(versions, 1, 'la versión anterior del libro queda en el historial');

  const deck = await tool(s.e, rw, 'get_deck', { bookId: BOOK_1.id, deckUid: DECK_UID });
  assert.equal(deck.json.cards.find((c) => c.uid === 'c1').front, change.front, 'la lectura siguiente ya lo ve');
});

test('las reglas de la app: duplicados, cloze sin hueco, uid inexistente; nada se escribe si falla uno', async () => {
  const s = await seeded();
  const rw = await s.token(['write']);
  const { etag } = await s.readBook();
  const dup = await tool(s.e, rw, 'add_cards', { bookId: BOOK_1.id, deckUid: DECK_UID, cards: [{ front: 'what two guarantees does READ COMMITTED give' }] });
  assert.ok(dup.isError && /mismo anverso|ese anverso/.test(dup.text));
  const hueco = await tool(s.e, rw, 'add_cards', { bookId: BOOK_1.id, deckUid: DECK_UID, cards: [{ type: 'basic', front: 'Ok?' }, { type: 'cloze', front: 'Sin hueco' }] });
  assert.ok(hueco.isError && /Tarjeta 2/.test(hueco.text));
  const nada = await tool(s.e, rw, 'update_cards', { bookId: BOOK_1.id, deckUid: DECK_UID, changes: [{ uid: 'no', front: 'x' }] });
  assert.ok(nada.isError);
  assert.equal((await s.readBook()).etag, etag);
});

test('add, delete y create_deck: tarjetas nuevas sin repaso, borrado como tombstone, mazo con uid', async () => {
  const s = await seeded();
  const rw = await s.token(['write']);
  const add = await tool(s.e, rw, 'add_cards', { bookId: BOOK_1.id, deckUid: DECK_UID, cards: [{ front: 'What is a lost update?', back: 'Two read-modify-write cycles; one clobbers the other.' }] });
  assert.equal(add.json.added.length, 1);
  await tool(s.e, rw, 'delete_cards', { bookId: BOOK_1.id, deckUid: DECK_UID, uids: ['c2'] });
  const nuevo = await tool(s.e, rw, 'create_deck', { bookId: BOOK_1.id, name: 'Lo que subrayé', cards: [{ type: 'cloze', front: 'Consistency is a property of the {{c1::application}}.' }] });
  const { book } = await s.readBook();
  const tx = book.decks.find((d) => d.uid === DECK_UID);
  const added = tx.cards.find((c) => c.uid === add.json.added[0].uid);
  assert.equal(added.srs, undefined);
  assert.equal(added.chapter, 'Chapter 8');
  const c2 = tx.cards.find((c) => c.uid === 'c2');
  assert.ok(c2.deleted && c2.deletedAt && c2.front === '');
  const d = book.decks.find((x) => x.uid === nuevo.json.deckUid);
  assert.equal(d.bookId, BOOK_1.id);
  assert.equal(d.cards.length, 1);
  const decks = await tool(s.e, rw, 'list_decks', {});
  assert.ok(decks.json.books.find((b) => b.bookId === BOOK_1.id).decks.some((x) => x.deckUid === nuevo.json.deckUid));
});

test('concurrencia: si un dispositivo escribe entre la lectura y la escritura, se relee y no se pisa nada', async () => {
  const s = await seeded();
  const user = s.e.DB._raw.prepare('SELECT id FROM users').get().id;
  const p = r2Provider(s.e, user, s.raw, { canWrite: true });
  let calls = 0;
  await p.update(BOOK_PATH, async (book) => {
    calls++;
    if (calls === 1) {
      // El móvil sube su versión justo ahora: un repaso nuevo en c2.
      const movil = JSON.parse(JSON.stringify(book));
      movil.decks[0].cards[1] = { ...movil.decks[0].cards[1], srs: { reps: 1 }, srsAt: 5000, updatedAt: 5000 };
      assert.equal((await s.put(BOOK_PATH, movil)).status, 200);
    }
    book.decks[0].cards[0] = { ...book.decks[0].cards[0], front: 'editada', textAt: 9000, updatedAt: 9000 };
    return { next: book, result: null };
  });
  assert.equal(calls, 2, 'el cambio se aplicó otra vez sobre lo que subió el móvil');
  const { book } = await s.readBook();
  assert.equal(book.decks[0].cards[0].front, 'editada');
  assert.deepEqual(book.decks[0].cards[1].srs, { reps: 1 });
});

test('con la suscripción caducada (en gracia) se lee pero no se escribe', async () => {
  const s = await seeded();
  const rw = await s.token(['write']);
  s.e.DB._raw.prepare('UPDATE users SET lapsed_at = ?').run(Date.now());
  assert.ok(!(await toolNames(s.e, rw)).includes('add_cards'));
  assert.ok((await toolNames(s.e, rw)).includes('get_deck'));
});
