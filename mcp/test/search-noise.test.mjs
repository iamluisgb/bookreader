// IA11 · La materia auxiliar (Index, Notes, Contents…) no tapa al cuerpo en la búsqueda.
// Caso real que lo motivó: en Protocols, `search_book "melatonin"` devolvía los 5 resultados del
// índice analítico (líneas cortas con el término) y ninguno del capítulo que lo explica.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryProvider } from '../src/providers/memory.mjs';
import { buildTextFiles } from '../../app/js/sync/book-text-build.js';
import { createIndexer } from '../../app/js/sync/library-index.js';
import { searchIndex, isSearchNoise, chapterOf } from '../../app/js/sync/library-index-build.js';
import { searchLines } from '../src/text-tools.mjs';

const BASE = 'bookreader/';

// Cuerpo: pasajes largos que explican el tema. Índice: líneas cortas que sólo lo nombran, que es
// justo lo que BM25 premia por longitud.
function protocols() {
  const lines = [];
  const starts = [];
  let n = 0;
  const chapter = (title, texts) => {
    lines.push('', '## ' + title);
    starts.push({ title, from: 'a' + n });
    for (const t of texts) lines.push(`[[a${n++}]] ${t}`);
  };
  const pad = 'Light exposure in the morning sets the circadian clock and helps the body wind down at night.';
  chapter('Contents', ['Chapter 1 Sleep', 'Chapter 2 Exercise', 'Index']);
  chapter('Chapter 1: Protocols for Sleep', [
    pad, `${pad} Melatonin is a hormone released in darkness; supplementing melatonin is not advised for most adults.`,
    pad, pad, `${pad} A short nap of twenty minutes can restore alertness.`,
  ]);
  chapter('Chapter 2: Protocols for Exercise', [pad, pad, `${pad} Resistance training twice a week.`]);
  chapter('Index', ['melatonin, 12', 'melatonin, supplements, 14', 'melatonin and light, 22', 'melatonin, dosage, 31',
    'nap, 40', 'zeitgeber only in the index, 50']);
  return buildTextFiles(lines.join('\n'), starts, { bookId: 'protocols', title: 'Protocols', segVersion: 6 });
}

const noiseOf = (toc) => new Set(toc.chapters.flatMap((c, i) => (isSearchNoise(c.title) ? [i] : [])));
const titleOf = (toc, i) => toc.chapters[i].title;

test('isSearchNoise: título exacto de materia auxiliar, en inglés y español; el contenido no', () => {
  for (const t of ['Index', 'NOTES', 'Notas', 'BIBLIOGRAFÍA', 'Glossary', 'Table of Contents', 'Contents at a Glance', 'Índice'])
    assert.equal(isSearchNoise(t), true, t);
  for (const t of ['Preface', 'Appendix', 'Field Notes on Raft', 'Index Structures', 'Chapter 9. Notes on Consensus', '', null])
    assert.equal(isSearchNoise(t), false, String(t));
});

test('search_book: sin el filtro gana el índice; con él, el cuerpo va primero', () => {
  const { toc, search } = protocols();
  const before = searchLines(search, 'melatonin', toc.search, 5);
  assert.equal(titleOf(toc, before[0].chapter), 'Index', 'el caso del bug: el índice gana sin filtro');

  const after = searchLines(search, 'melatonin', toc.search, 5, noiseOf(toc));
  assert.equal(titleOf(toc, after[0].chapter), 'Chapter 1: Protocols for Sleep');
  // El índice sólo rellena DESPUÉS de todo el cuerpo.
  const firstAux = after.findIndex((r) => isSearchNoise(titleOf(toc, r.chapter)));
  assert.ok(firstAux > 0 && after.slice(firstAux).every((r) => isSearchNoise(titleOf(toc, r.chapter))));
});

test('search_book: un término que sólo está en el índice sigue saliendo', () => {
  const { toc, search } = protocols();
  const r = searchLines(search, 'zeitgeber', toc.search, 5, noiseOf(toc));
  assert.equal(r.length, 1);
  assert.equal(titleOf(toc, r[0].chapter), 'Index');
});

test('search_library: ningún pasaje de materia auxiliar puntúa', async () => {
  const p = createMemoryProvider();
  const files = protocols();
  const dir = `${BASE}text/protocols/`;
  p.write(`${BASE}text/protocols.json`, JSON.stringify(files.toc));
  p.write(dir + 'search.txt', files.search);
  files.parts.forEach((part, n) => p.write(dir + 'p' + n + '.txt', part));
  const ix = createIndexer(p, BASE);
  assert.equal(await ix.indexBook('protocols'), true);
  const m = await ix.manifest();
  const read = async (path) => (await p.read(path))?.content ?? null;

  const r = await searchIndex(read, BASE, m, ['melatonin'], { perBook: 5 });
  assert.equal(r.books[0].bookId, 'protocols');
  const chapters = r.books[0].passages.map((x) => chapterOf(m.books.protocols.chapters, x.n));
  assert.ok(chapters.length > 0);
  assert.ok(chapters.every((t) => !isSearchNoise(t)), `salió materia auxiliar: ${chapters}`);
});
