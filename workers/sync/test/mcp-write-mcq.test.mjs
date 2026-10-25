// Las preguntas con opciones (P43 F4) y el pasaje (`src`) desde el MCP que escribe: la forma que
// guarda la app (widgets/practice.js · mcqCard), validada con su mismo código, y la cita y el
// ancla comprobadas contra el TEXTO del capítulo antes de escribir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { env as baseEnv, ORIGIN } from './harness.mjs';
import * as C from '../../../app/js/sync/sync-crypto.js';
import { BOOK_1, buildLayoutFiles } from '../../../mcp/test/helpers/dataset.mjs';
import { buildTextFiles } from '../../../app/js/sync/book-text-build.js';

const LICENSE = 'BKRD-TEST-0001';
const DECK_UID = 'deck-tx';
const BOOK_PATH = `bookreader/books/${BOOK_1.id}.json`;
const SKEW = 'Write skew happens when two doctors both go off call after checking each other.';

function call(e, method, path, { body, token, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = 'Bearer ' + token;
  if (body !== undefined && !(body instanceof Uint8Array)) { body = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  if (body instanceof Uint8Array) h['Content-Length'] = String(body.length);
  return worker.fetch(new Request('https://sync.test' + path, { method, body, headers: h }), e);
}

// Dos capítulos de 50 pasajes; la frase de write skew, en el pasaje a62 (capítulo 8).
function bookText() {
  const lines = [];
  const chapters = [];
  let n = 0;
  for (const title of ['Chapter 7. Replication', 'Chapter 8. Transactions']) {
    lines.push('', '## ' + title);
    chapters.push({ title, from: 'a' + n });
    for (let i = 0; i < 50; i++) {
      lines.push(`[[a${n}]] Paragraph ${i} of ${title} talks about databases.${n === 62 ? ' ' + SKEW : ''}`);
      n++;
    }
  }
  const f = buildTextFiles(lines.join('\n'), chapters, { bookId: BOOK_1.id, title: BOOK_1.title, segVersion: 6 });
  const dir = `bookreader/text/${BOOK_1.id}/`;
  return {
    [`bookreader/text/${BOOK_1.id}.json`]: JSON.stringify(f.toc),
    [dir + 'search.txt']: f.search,
    ...Object.fromEntries(f.parts.map((p, i) => [dir + 'p' + i + '.txt', p])),
  };
}

function files() {
  const out = { ...buildLayoutFiles(), ...bookText() };
  const book = JSON.parse(JSON.stringify(out[BOOK_PATH]));
  book.decks = [{
    id: 34, uid: DECK_UID, bookId: BOOK_1.id, name: 'Transacciones', scope: 'Chapter 8. Transactions', cardType: 'mixed', createdAt: 1, updatedAt: 1,
    cards: [{ uid: 'c1', type: 'basic', front: 'What is write skew?', back: 'Two transactions update different objects.', src: '', updatedAt: 1, srs: { reps: 3, due: 20800, lastReview: 1000 } }],
  }];
  out[BOOK_PATH] = book;
  return out;
}

async function seeded() {
  const e = baseEnv({ DATA_QUOTA_BYTES: String(10 * 1024 * 1024), MAX_BYTES: String(10 * 1024 * 1024) });
  const raw = C.generateKey();
  const k = await C.importKeys(raw);
  const { token: session } = await (await call(e, 'POST', '/v1/sync-token', { body: { license: LICENSE }, headers: { Origin: ORIGIN } })).json();
  for (const [path, content] of Object.entries(files())) {
    const pid = await C.pathId(k, path);
    const body = new Uint8Array(await (await C.encrypt(k, pid, typeof content === 'string' ? content : JSON.stringify(content))).arrayBuffer());
    assert.equal((await call(e, 'PUT', '/v1/o/' + pid, { body, token: session, headers: { 'X-Name': await C.encryptName(k, path), 'X-Kind': 'data' } })).status, 200);
  }
  const readBook = async () => {
    const pid = await C.pathId(k, BOOK_PATH);
    const res = await call(e, 'GET', '/v1/o/' + pid, { token: session });
    return JSON.parse(await C.decryptText(k, pid, await res.blob()));
  };
  const token = async (scopes) => (await (await call(e, 'POST', '/v1/mcp-tokens', {
    token: session, body: { name: 'Claude', key: C.b64url(raw), license: LICENSE, scopes },
  })).json()).token;
  return { e, readBook, token };
}

let n = 0;
async function tool(e, token, name, args) {
  const res = await call(e, 'POST', '/mcp', { token, body: { jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } } });
  const r = (await res.json()).result;
  return { isError: !!r.isError, text: r.content[0].text, json: r.isError ? null : JSON.parse(r.content[0].text) };
}

const MCQ = {
  type: 'mcq',
  front: 'Two on-call doctors each check that the other is on call, then both go off call. Which anomaly is this?',
  src: 'a62',
  quote: SKEW,
  options: [
    { text: 'Write skew', correct: true, feedback: 'Each reads the same data and updates a different row.' },
    { text: 'Lost update', correct: false, feedback: 'A lost update needs both to write the SAME object.' },
    { text: 'Dirty read', correct: false, feedback: 'Neither reads uncommitted data.' },
  ],
};

test('mcq: se guarda con la forma de la app (opciones con id y feedback, cita, dorso de la correcta) y el pasaje', async () => {
  const s = await seeded();
  const rw = await s.token(['write', 'text']);
  const add = await tool(s.e, rw, 'add_cards', { bookId: BOOK_1.id, deckUid: DECK_UID, cards: [MCQ] });
  assert.ok(!add.isError, add.text);
  assert.equal(add.json.added[0].options, 3);
  const card = (await s.readBook()).decks[0].cards.find((c) => c.uid === add.json.added[0].uid);
  assert.equal(card.type, 'mcq');
  assert.equal(card.src, 'a62');
  assert.equal(card.quote, SKEW);
  assert.deepEqual(card.options.map((o) => o.id), ['a', 'b', 'c']);
  assert.equal(card.options.filter((o) => o.correct).length, 1);
  assert.match(card.back, /^Write skew\n\nEach reads/);
  assert.equal(card.chapter, 'Chapter 8. Transactions');
  assert.equal(card.srs, undefined);
});

test('mcq: la cita que no está en el capítulo, dos correctas o sin feedback se rechazan y no se escribe nada', async () => {
  const s = await seeded();
  const rw = await s.token(['write', 'text']);
  const before = JSON.stringify((await s.readBook()).decks);
  const fake = await tool(s.e, rw, 'add_cards', { bookId: BOOK_1.id, deckUid: DECK_UID, cards: [{ ...MCQ, quote: 'Write skew is when the doctors forget to log their shifts in the database.' }] });
  assert.ok(fake.isError && /no está en «Chapter 8\. Transactions»/.test(fake.text), fake.text);
  const otro = await tool(s.e, rw, 'add_cards', { bookId: BOOK_1.id, deckUid: DECK_UID, cards: [{ ...MCQ, chapter: 'Chapter 7. Replication' }] });
  assert.ok(otro.isError && /no está en «Chapter 7/.test(otro.text), 'la cita se busca en SU capítulo');
  const dos = await tool(s.e, rw, 'add_cards', { bookId: BOOK_1.id, deckUid: DECK_UID, cards: [{ ...MCQ, options: MCQ.options.map((o) => ({ ...o, correct: true })) }] });
  assert.ok(dos.isError && /exactamente una opción correcta/.test(dos.text), dos.text);
  const sinPorque = await tool(s.e, rw, 'add_cards', { bookId: BOOK_1.id, deckUid: DECK_UID, cards: [{ ...MCQ, options: MCQ.options.map((o) => ({ ...o, feedback: ' ' })) }] });
  assert.ok(sinPorque.isError && /feedback/.test(sinPorque.text), sinPorque.text);
  const opcionesEnBasic = await tool(s.e, rw, 'add_cards', { bookId: BOOK_1.id, deckUid: DECK_UID, cards: [{ front: 'x', options: MCQ.options }] });
  assert.ok(opcionesEnBasic.isError && /solo van en una tarjeta mcq/.test(opcionesEnBasic.text));
  assert.equal(JSON.stringify((await s.readBook()).decks), before);
});

test('mcq sin permiso de texto no se acepta: la cita es su garantía', async () => {
  const s = await seeded();
  const w = await s.token(['write']);
  const r = await tool(s.e, w, 'add_cards', { bookId: BOOK_1.id, deckUid: DECK_UID, cards: [MCQ] });
  assert.ok(r.isError && /necesita el texto del capítulo/.test(r.text), r.text);
});

test('src: un pasaje de otro capítulo se rechaza; create_deck con pasaje; update_cards pone el pasaje sin tocar el repaso', async () => {
  const s = await seeded();
  const rw = await s.token(['write', 'text']);
  const fuera = await tool(s.e, rw, 'add_cards', { bookId: BOOK_1.id, deckUid: DECK_UID, cards: [{ front: 'Replication?', back: 'Copies.', src: 'a3' }] });
  assert.ok(fuera.isError && /no es de «Chapter 8/.test(fuera.text), fuera.text);
  const forma = await tool(s.e, rw, 'add_cards', { bookId: BOOK_1.id, deckUid: DECK_UID, cards: [{ front: 'Replication?', back: 'Copies.', src: 'p3' }] });
  assert.ok(forma.isError && /ancla de pasaje/.test(forma.text));

  const deck = await tool(s.e, rw, 'create_deck', { bookId: BOOK_1.id, name: 'Replicación', scope: 'Chapter 7. Replication', cards: [
    { front: 'What does a follower apply?', back: 'The leader’s replication log.', src: 'a3' },
  ] });
  assert.ok(!deck.isError, deck.text);
  assert.equal(deck.json.added[0].src, 'a3');

  const up = await tool(s.e, rw, 'update_cards', { bookId: BOOK_1.id, deckUid: DECK_UID, changes: [{ uid: 'c1', src: 'a62' }] });
  assert.ok(!up.isError, up.text);
  const c1 = (await s.readBook()).decks.find((d) => d.uid === DECK_UID).cards.find((c) => c.uid === 'c1');
  assert.equal(c1.src, 'a62');
  assert.equal(c1.srs.reps, 3, 'el repaso se conserva');

  const mcqUid = (await tool(s.e, rw, 'add_cards', { bookId: BOOK_1.id, deckUid: DECK_UID, cards: [MCQ] })).json.added[0].uid;
  const edit = await tool(s.e, rw, 'update_cards', { bookId: BOOK_1.id, deckUid: DECK_UID, changes: [{ uid: mcqUid, front: 'otra' }] });
  assert.ok(edit.isError && /no se editan desde aquí/.test(edit.text), 'una mcq no se edita desde aquí');
});
