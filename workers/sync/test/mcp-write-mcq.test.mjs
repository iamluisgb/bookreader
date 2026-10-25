// Los widgets de estudio (P43) desde el MCP: preguntas con opciones (tarjetas `mcq`), el pasaje
// (`src`), matrices para rellenar (`deck.exercises`) y la lectura de intentos (P53). La forma es
// la que guarda la app, validada con su mismo código, y las citas y anclas se comprueban contra
// el TEXTO del capítulo antes de escribir.

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

// Dos repasos de c1 (el primero fallado) y una matriz que nadie del mazo tiene (otro hash).
const ATTEMPTS = [
  { uid: 't1', cardUid: 'c1', deckUid: DECK_UID, bookId: BOOK_1.id, ts: 1000, mode: 'written', verdict: 'wrong', exact: null, grade: 1, answer: 'no sé' },
  { uid: 't2', cardUid: 'c1', deckUid: DECK_UID, bookId: BOOK_1.id, ts: 2000, mode: 'written', verdict: 'good', exact: null, grade: 3, answer: 'dos médicos' },
  { uid: 't3', cardUid: null, deckUid: null, bookId: BOOK_1.id, ts: 3000, mode: 'widget', verdict: 'partial', exact: false, cardHash: 'deadbeef', widget: { type: 'matrix', correct: 3, total: 4 } },
];

function files() {
  const out = { ...buildLayoutFiles(), ...bookText() };
  const book = JSON.parse(JSON.stringify(out[BOOK_PATH]));
  book.decks = [{
    id: 34, uid: DECK_UID, bookId: BOOK_1.id, name: 'Transacciones', scope: 'Chapter 8. Transactions', cardType: 'mixed', createdAt: 1, updatedAt: 1,
    cards: [{ uid: 'c1', type: 'basic', front: 'What is write skew?', back: 'Two transactions update different objects.', src: '', updatedAt: 1, srs: { reps: 3, due: 20800, lastReview: 1000 } }],
  }];
  book.attempts = ATTEMPTS;
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

const MATRIX = {
  title: 'Anomalies',
  prompt: 'Which anomaly is this?',
  rows: [{ id: 'skew', label: 'Write skew' }, { id: 'lost', label: 'Lost update' }],
  columns: [{ id: 'obj', label: 'Objects written', options: ['Same', 'Different'] }, { id: 'ex', label: 'Example', options: ['Doctors', 'Counter'] }],
  cells: [
    { row: 'skew', col: 'obj', answer: 'Different', why: 'Each doctor updates their own row.', cite: { quote: SKEW, src: 'a62' } },
    { row: 'skew', col: 'ex', answer: 'Doctors', why: 'The on-call example.', cite: { quote: SKEW } },
    { row: 'lost', col: 'obj', answer: 'Same', given: true },
    { row: 'lost', col: 'ex', answer: 'Counter', why: 'Two increments.', cite: { quote: 'Paragraph 3 of Chapter 8. Transactions talks about databases.' } },
  ],
};

test('add_exercise: la matriz entra en deck.exercises con la forma de la app; get_deck la enseña; delete deja tombstone', async () => {
  const s = await seeded();
  const rw = await s.token(['write', 'text']);
  const r = await tool(s.e, rw, 'add_exercise', { bookId: BOOK_1.id, deckUid: DECK_UID, ...MATRIX });
  assert.ok(!r.isError, r.text);
  assert.equal(r.json.added.cells, 4);
  const deck = (await s.readBook()).decks.find((d) => d.uid === DECK_UID);
  const ex = deck.exercises[0];
  assert.equal(ex.type, 'matrix');
  assert.equal(ex.spec.type, 'matrix');
  assert.equal(ex.spec.version, 1);
  assert.equal(ex.spec.chapter, 'Chapter 8. Transactions');
  assert.equal(ex.last, null);
  assert.deepEqual(ex.spec.cells[2], { row: 'lost', col: 'obj', answer: 'Same', given: true });
  assert.equal(deck.cards.length, 1, 'las tarjetas no se tocan');

  const got = await tool(s.e, rw, 'get_deck', { bookId: BOOK_1.id, deckUid: DECK_UID });
  assert.deepEqual(got.json.exercises.map((e) => [e.uid, e.cells, e.given]), [[ex.uid, 4, 1]]);

  const del = await tool(s.e, rw, 'delete_exercise', { bookId: BOOK_1.id, deckUid: DECK_UID, uid: ex.uid });
  assert.ok(!del.isError, del.text);
  const after = (await s.readBook()).decks.find((d) => d.uid === DECK_UID).exercises[0];
  assert.ok(after.deleted && !after.spec);
  assert.equal((await tool(s.e, rw, 'get_deck', { bookId: BOOK_1.id, deckUid: DECK_UID })).json.exercises.length, 0);
});

test('add_exercise rechaza citas que no están, demasiadas celdas dadas, respuestas fuera de las opciones y sin texto', async () => {
  const s = await seeded();
  const rw = await s.token(['write', 'text']);
  const before = JSON.stringify((await s.readBook()).decks);
  const cita = await tool(s.e, rw, 'add_exercise', { bookId: BOOK_1.id, deckUid: DECK_UID, ...MATRIX,
    cells: MATRIX.cells.map((c) => (c.row === 'lost' && c.col === 'ex' ? { ...c, cite: { quote: 'Counters are always safe in every database ever made.' } } : c)) });
  assert.ok(cita.isError && /lost\|ex/.test(cita.text), cita.text);
  const dadas = await tool(s.e, rw, 'add_exercise', { bookId: BOOK_1.id, deckUid: DECK_UID, ...MATRIX,
    cells: MATRIX.cells.map((c) => ({ row: c.row, col: c.col, answer: c.answer, given: true })) });
  assert.ok(dadas.isError && /demasiadas celdas dadas/.test(dadas.text), dadas.text);
  const fuera = await tool(s.e, rw, 'add_exercise', { bookId: BOOK_1.id, deckUid: DECK_UID, ...MATRIX,
    cells: MATRIX.cells.map((c, i) => (i === 0 ? { ...c, answer: 'Both' } : c)) });
  assert.ok(fuera.isError && /no es una opción de su columna/.test(fuera.text), fuera.text);
  const ancla = await tool(s.e, rw, 'add_exercise', { bookId: BOOK_1.id, deckUid: DECK_UID, ...MATRIX,
    cells: MATRIX.cells.map((c, i) => (i === 0 ? { ...c, cite: { quote: SKEW, src: 'a3' } } : c)) });
  assert.ok(ancla.isError && /pasaje que no es de/.test(ancla.text), ancla.text);
  const w = await s.token(['write']);
  const sinTexto = await tool(s.e, w, 'add_exercise', { bookId: BOOK_1.id, deckUid: DECK_UID, ...MATRIX });
  assert.ok(sinTexto.isError && /necesita el texto del capítulo/.test(sinTexto.text));
  assert.equal(JSON.stringify((await s.readBook()).decks), before);
});

test('get_attempts: resumen por modo con el acierto a la primera, matrices hechas y respuestas solo con permiso de texto', async () => {
  const s = await seeded();
  const rw = await s.token(['write', 'text']);
  const all = await tool(s.e, rw, 'get_attempts', { bookId: BOOK_1.id });
  assert.ok(!all.isError, all.text);
  assert.equal(all.json.total, 3);
  const w = all.json.summary.byMode.written;
  assert.deepEqual([w.attempts, w.correct, w.correctRate], [2, 1, 50]);
  assert.deepEqual([w.firstTry.cards, w.firstTry.correct, w.firstTry.rate], [1, 0, 0], 'el primer intento de c1 fue fallado');
  assert.deepEqual(all.json.summary.matrixCells, { correct: 3, total: 4, rate: 75 });
  assert.equal(all.json.attempts[0].ts, 3000, 'los más recientes primero');
  assert.equal(all.json.attempts.find((a) => a.cardUid === 'c1').answer, 'dos médicos');

  const del = await tool(s.e, rw, 'get_attempts', { bookId: BOOK_1.id, deckUid: DECK_UID });
  assert.equal(del.json.total, 2, 'con mazo: sus tarjetas y solo las matrices de ese mazo');
  await tool(s.e, rw, 'add_exercise', { bookId: BOOK_1.id, deckUid: DECK_UID, ...MATRIX });
  assert.deepEqual((await tool(s.e, rw, 'get_attempts', { bookId: BOOK_1.id, deckUid: DECK_UID, limit: 0 })).json.summary.exercises.generated, 1);

  const soloLeer = await s.token([]);
  const sin = await tool(s.e, soloLeer, 'get_attempts', { bookId: BOOK_1.id });
  assert.ok(!sin.isError, sin.text);
  assert.ok(sin.json.attempts.every((a) => !('answer' in a)), 'sin permiso de texto no viaja lo que escribió');
});
