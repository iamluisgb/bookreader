// IA10 F2 · El índice de la biblioteca (app/js/sync/library-index*.js): lo que construye el
// dispositivo y cómo lo consulta el MCP. Con el proveedor de memoria y libros sintéticos subidos
// como los sube la app (book-text-build.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryProvider } from '../src/providers/memory.mjs';
import { buildTextFiles } from '../../app/js/sync/book-text-build.js';
import { createIndexer } from '../../app/js/sync/library-index.js';
import {
  stem, bookPostings, decodePostings, searchIndex, storePath, blockOf, passageIn, chapterOf,
  manifestPath, MAX_DELTAS, topK, encodeFile, decodeFile, lookup,
} from '../../app/js/sync/library-index-build.js';

const BASE = 'bookreader/';

// Un libro: capítulos de pasajes de relleno, con `topics` repartidos (frase → en qué pasajes).
function book(id, { chapters = 3, perChapter = 40, topics = {}, seed = 1 } = {}) {
  const lines = [];
  const starts = [];
  const filler = ['logs and nodes', 'the river runs north', 'a quiet morning in the city', 'numbers on a page', 'cats sleep all day'];
  let n = 0;
  for (let c = 0; c < chapters; c++) {
    const title = `Chapter ${c + 1} of ${id}`;
    lines.push('', '## ' + title);
    starts.push({ title, from: 'a' + n });
    for (let i = 0; i < perChapter; i++) {
      let text = `Paragraph ${i} about ${filler[(i * seed + c) % filler.length]}.`;
      for (const [phrase, at] of Object.entries(topics)) if (at.includes(n)) text += ' ' + phrase;
      lines.push(`[[a${n}]] ${text}`);
      n++;
    }
  }
  return buildTextFiles(lines.join('\n'), starts, { bookId: id, title: id, segVersion: 6 });
}

function seed(provider, id, files) {
  const dir = `${BASE}text/${id}/`;
  provider.write(`${BASE}text/${id}.json`, JSON.stringify(files.toc));
  provider.write(dir + 'search.txt', files.search);
  files.parts.forEach((p, n) => provider.write(dir + 'p' + n + '.txt', p));
}

const range = (from, to, step = 1) => Array.from({ length: Math.ceil((to - from) / step) }, (_, i) => from + i * step);

const LIBRARY = {
  ddia: book('ddia', { chapters: 4, perChapter: 60, topics: { 'Raft is a consensus algorithm for replicated logs.': [70, 75, 130], 'Leaderless replication with quorums.': range(10, 40, 3) } }),
  graphs: book('graphs', { topics: { 'An ontology defines the classes of a knowledge graph.': [5, 6, 50, 51, 52], 'Ontologies and taxonomies differ.': [90] }, seed: 2 }),
  harness: book('harness', { chapters: 1, perChapter: 30, topics: { 'Evaluating agents needs a harness and evals.': range(0, 30, 3) }, seed: 3 }),
  sre: book('sre', { chapters: 6, perChapter: 80, topics: { 'Agents of change.': [3], 'SLOs and error budgets.': range(100, 300, 7) }, seed: 4 }),
  andes: book('andes', { topics: { 'Atahualpa was captured at Cajamarca.': [12, 13, 80] }, seed: 5 }),
  mesh: book('mesh', { topics: { 'Data mesh: domain ownership of data products.': range(0, 120, 9) }, seed: 6 }),
  ddd: book('ddd', { topics: { 'The ubiquitous language of a bounded context.': range(2, 100, 11), 'Domain ownership.': [40] }, seed: 7 }),
};
const QUERIES = [
  ['ontologies'], ['consensus raft'], ['evaluating agents', 'harness evals'], ['slo error budget'],
  ['atahualpa cajamarca'], ['domain ownership'], ['ubiquitous language'], ['logs nodes'],
];

async function library(ids, { compactAtEnd = false } = {}) {
  const p = createMemoryProvider();
  for (const id of ids) seed(p, id, LIBRARY[id]);
  const ix = createIndexer(p, BASE);
  for (const id of ids) assert.equal(await ix.indexBook(id), true);
  if (compactAtEnd) await ix.compact();
  return { p, ix };
}

const read = (p) => async (path) => (await p.read(path))?.content ?? null;

async function results(p, ix) {
  const m = await ix.manifest();
  const out = [];
  for (const q of QUERIES) {
    const r = await searchIndex(read(p), BASE, m, q);
    out.push(r.books.map((b) => ({ id: b.bookId, score: b.score.toFixed(9), passages: b.passages.map((x) => x.n) })));
  }
  return out;
}

test('raíces: singular y plural casan, en inglés y español', () => {
  for (const [a, b] of [['ontology', 'ontologies'], ['replica', 'replicas'], ['agent', 'agents'], ['evaluate', 'evaluating'],
    ['database', 'databases'], ['node', 'nodes'], ['base', 'based'], ['ontologia', 'ontologias'], ['slo', 'slos']]) {
    assert.equal(stem(a), stem(b), `${a} ≠ ${b}`);
  }
  assert.notEqual(stem('consensus'), stem('consensu'));   // «-us» no es plural
  assert.equal(stem('raft'), 'raft');
});

test('postings: cada término de cada pasaje, con su frecuencia, y vuelta atrás sin pérdidas', () => {
  const { n, avgdl, postings } = bookPostings('a0\t0\tontology ontology graph\na3\t0\tthe graph of ontologies\na9\t1\tnothing here\n');
  assert.equal(n, 3);
  assert.ok(avgdl > 0);
  assert.deepEqual(decodePostings(postings.get('ontology')).map(([id, tf]) => [id, tf]), [[0, 2], [3, 1]]);
  assert.deepEqual(decodePostings(postings.get('graph')).map(([id]) => id), [0, 3]);
  assert.equal(postings.has('the'), false);   // palabras vacías fuera
});

test('construido libro a libro (con compactaciones) ≡ construido de golpe', async () => {
  const ids = Object.keys(LIBRARY);
  assert.ok(ids.length > MAX_DELTAS + 1);
  const a = await library(ids);
  const b = await library(ids, { compactAtEnd: true });
  const ma = await a.ix.manifest();
  assert.ok(ma.gen, 'hubo al menos una compactación');
  assert.ok(ma.deltas.length <= MAX_DELTAS);
  assert.deepEqual((await b.ix.manifest()).deltas, []);
  assert.deepEqual(await results(a.p, a.ix), await results(b.p, b.ix));
});

test('añadir y quitar un libro deja el índice como estaba, y no quedan sus ficheros', async () => {
  const ids = Object.keys(LIBRARY).filter((id) => id !== 'graphs');
  const without = await library(ids, { compactAtEnd: true });
  const { p, ix } = await library([...ids, 'graphs'], { compactAtEnd: true });
  assert.ok((await results(p, ix))[0].some((b) => b.id === 'graphs'));
  await ix.removeBook('graphs');
  assert.deepEqual(await results(p, ix), await results(without.p, without.ix));
  const m = await ix.manifest();
  assert.equal(m.books.graphs, undefined);
  assert.equal(p.paths().includes(storePath(BASE, 'graphs')), false);
  assert.equal(p.paths().includes(storePath(BASE, 'ddia')), true);
  // Solo lo vivo: manifiesto, particiones de la generación actual y almacenes.
  const index = p.paths().filter((x) => x.startsWith(BASE + 'index/'));
  for (const path of index) {
    assert.ok(path === manifestPath(BASE) || path.includes(`/b${m.gen}/`) || path.includes('/s/'), path);
  }
});

test('re-trocear un libro: cuentan sus postings nuevos y no los viejos', async () => {
  const { p, ix } = await library(['ddia', 'andes']);
  const before = await searchIndex(read(p), BASE, await ix.manifest(), 'atahualpa');
  assert.deepEqual(before.books.map((b) => b.bookId), ['andes']);
  seed(p, 'andes', book('andes', { topics: { 'Pizarro reached Tumbes.': [3] }, seed: 5 }));
  await ix.indexBook('andes');
  const m = await ix.manifest();
  assert.deepEqual((await searchIndex(read(p), BASE, m, 'atahualpa')).books, []);
  assert.deepEqual((await searchIndex(read(p), BASE, m, 'pizarro tumbes')).books.map((b) => [b.bookId, b.passages[0].n]), [['andes', 3]]);
});

test('el almacén devuelve el pasaje exacto, con su capítulo, leyendo un solo bloque', async () => {
  const { p, ix } = await library(['ddia']);
  const m = await ix.manifest();
  const meta = m.books.ddia;
  const r = await searchIndex(read(p), BASE, m, 'raft consensus');
  const n = r.books[0].passages[0].n;
  const i = blockOf(meta.store.starts, n);
  const { offsets } = meta.store;
  const [block] = await p.readBlocks(storePath(BASE, 'ddia'), [{ i, count: offsets.length - 1, offset: offsets[i], length: offsets[i + 1] - offsets[i] }]);
  const original = LIBRARY.ddia.parts.join('\n').split('\n').find((l) => l.startsWith(`[[a${n}]] `)).slice(`[[a${n}]] `.length);
  assert.equal(passageIn(block, n), original);
  assert.equal(chapterOf(meta.chapters, n), 'Chapter 2 of ddia');
});

test('ranking: un libro corto que trata el tema gana a uno largo que lo nombra de pasada', async () => {
  const { p, ix } = await library(Object.keys(LIBRARY), { compactAtEnd: true });
  const r = await searchIndex(read(p), BASE, await ix.manifest(), ['evaluating agents']);
  assert.equal(r.books[0].bookId, 'harness');
  assert.ok(r.books.some((b) => b.bookId === 'sre'), 'sre también sale («agents» una vez)');
});

test('una consulta en plural encuentra el singular, y lee pocos ficheros', async () => {
  const { p, ix } = await library(Object.keys(LIBRARY), { compactAtEnd: true });
  const r = await searchIndex(read(p), BASE, await ix.manifest(), ['what do we have on ontologies?']);
  assert.equal(r.books[0].bookId, 'graphs');
  assert.deepEqual(r.terms, ['ontology']);
  assert.equal(r.reads, 1);   // una partición, sin deltas
});

test('topK ≡ ordenar y cortar (con empates, al menor número)', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let round = 0; round < 200; round++) {
    const size = 1 + Math.floor(rnd() * 60);
    const score = Float64Array.from({ length: size }, () => Math.floor(rnd() * 8) / 8);
    const ns = Array.from({ length: size }, (_, i) => i).sort(() => rnd() - 0.5);
    const k = 1 + Math.floor(rnd() * 6);
    const want = [...ns].sort((a, b) => score[b] - score[a] || a - b).slice(0, k);
    assert.deepEqual(topK(ns, score, k), want);
  }
});

test('un delta con secciones por partición: cada término se encuentra, y vuelve entero al compactar', () => {
  const { postings } = bookPostings(LIBRARY.ddia.search);
  const plain = encodeFile(new Map([['ddia', postings]]));
  const sectioned = encodeFile(new Map([['ddia', postings]]), { sections: true });
  for (const t of postings.keys()) assert.deepEqual(lookup(sectioned, t), lookup(plain, t), t);
  assert.deepEqual(lookup(sectioned, 'zzzz'), []);
  assert.deepEqual(decodeFile(sectioned), decodeFile(plain));
});
