// tools — la superficie por dentro, con una fuente de mentira que solo apunta qué le piden.
//
// Los tests de stdio prueban el protocolo y las dos fuentes de verdad; estos prueban la DECISIÓN
// de la tool, que es lo que se rompe en silencio: qué consulta a la fuente, en qué orden y qué
// contesta cuando el que llama se equivoca. Un `listBooks()` escondido en el camino de una
// búsqueda no se ve en el resultado — se ve aquí.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callTool, toolsFor } from '../src/tools.mjs';
import { SourceError, UnknownBookError } from '../src/errors.mjs';

/** Fuente de mentira: apunta cada llamada y contesta lo mínimo. */
function stubSource(overrides = {}) {
  const calls = [];
  const source = {
    kind: 'stub',
    hasReadingStats: true,
    describe: () => 'stub',
    async ping() {
      calls.push('ping');
      return { kind: 'stub' };
    },
    async listBooks() {
      calls.push('listBooks');
      return [{ id: 'b1', title: 'Uno' }];
    },
    async titles() {
      calls.push('titles');
      return { b1: 'Uno' };
    },
    async bookInfo(bookId) {
      calls.push('bookInfo:' + bookId);
      return { id: bookId, title: 'Uno' };
    },
    async getHighlights(bookId) {
      calls.push('getHighlights:' + bookId);
      return [
        {
          uid: 'h1',
          bookId,
          bookTitle: 'Uno',
          text: 'El consenso no es gratis.',
          note: '',
          chapter: 'Cap 1',
          page: null,
          timestamp: 1,
        },
      ];
    },
    async getNotes(bookId) {
      calls.push('getNotes:' + bookId);
      return [];
    },
    async readingDays() {
      calls.push('readingDays');
      return [];
    },
    ...overrides,
  };
  return { source, calls };
}

const payload = (res) => JSON.parse(res.content[0].text);

test('buscar en toda la biblioteca no abre cada libro para saber cuáles hay', async () => {
  const { source, calls } = stubSource();
  const res = await callTool(source, 'search_highlights', { query: 'consenso' });
  assert.equal(res.isError, undefined);
  assert.equal(payload(res).total, 1);
  assert.ok(calls.includes('titles'), 'los ids salen del manifest');
  assert.ok(!calls.includes('listBooks'), 'una búsqueda no debe costar un listBooks (N lecturas)');
  // Y sí baja los subrayados de los libros donde busca: eso es la búsqueda, no un extra.
  assert.deepEqual(
    calls.filter((c) => c.startsWith('getHighlights:')),
    ['getHighlights:b1'],
  );
});

test('un bookId que no existe se corrige con un error, no con «cero resultados»', async () => {
  const { source } = stubSource({
    async bookInfo() {
      throw new UnknownBookError('b9');
    },
    async getHighlights() {
      throw new UnknownBookError('b9');
    },
  });
  const res = await callTool(source, 'search_highlights', { query: 'consenso', bookId: 'b9' });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Libro desconocido: b9/);
});

test('buscar en todos los libros sí ignora un libro ilegible', async () => {
  const { source, calls } = stubSource({
    async titles() {
      calls.push('titles');
      return { b1: 'Uno', b2: 'Roto' };
    },
    async getHighlights(bookId) {
      calls.push('getHighlights:' + bookId);
      if (bookId === 'b2') throw new SourceError('no puedo leer books/b2.json');
      return [
        { uid: 'h1', bookId, bookTitle: 'Uno', text: 'consenso', note: '', timestamp: 1 },
      ];
    },
  });
  const res = await callTool(source, 'search_highlights', { query: 'consenso' });
  assert.equal(res.isError, undefined);
  assert.equal(payload(res).total, 1, 'el libro roto no tumba la búsqueda de los demás');
});

test('reading_stats solo se anuncia si la fuente lleva el registro de lectura', () => {
  const { source } = stubSource();
  assert.ok(toolsFor(source).some((t) => t.name === 'reading_stats'));
  assert.ok(!toolsFor({ ...source, hasReadingStats: false }).some((t) => t.name === 'reading_stats'));
  assert.equal(toolsFor(source).length, 5);
});

test('reading_stats también dice «ese libro no existe» en vez de devolver ceros', async () => {
  const { source } = stubSource();
  const res = await callTool(source, 'reading_stats', { range: 'all', bookId: 'b9' });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Libro desconocido: b9/);
  const ok = await callTool(source, 'reading_stats', { range: 'all', bookId: 'b1' });
  assert.equal(ok.isError, undefined);
});

test('una tool vetada por la fuente no se ejecuta aunque se llame a mano', async () => {
  const { source, calls } = stubSource({ hasReadingStats: false });
  const res = await callTool(source, 'reading_stats', { range: '7d' });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Tool desconocida/);
  assert.ok(!calls.includes('readingDays'), 'ni siquiera se molesta a la fuente');
});

// «Los subrayados de Pedro Páramo»: por título, sin pasar por list_books.
test('get_highlights y get_notes: aceptan el título del libro (book) además del id', async () => {
  const titles = { b1: 'Pedro Páramo', b2: 'Designing Data-Intensive Applications', b3: 'Designing Interfaces' };
  const { source, calls } = stubSource({ async titles() { calls.push('titles'); return titles; } });
  assert.equal(payload(await callTool(source, 'get_highlights', { book: 'pedro paramo' })).bookId, 'b1');
  assert.ok(calls.includes('getHighlights:b1'));
  assert.equal(payload(await callTool(source, 'get_notes', { book: 'Data-Intensive' })).bookId, 'b2');
  // Ambiguo, inexistente o sin libro: error con lo necesario para corregir, no una adivinanza.
  const amb = await callTool(source, 'get_highlights', { book: 'designing' });
  assert.equal(amb.isError, true);
  assert.match(amb.content[0].text, /casa con varios libros.*Designing Data-Intensive.*Designing Interfaces/);
  assert.match((await callTool(source, 'get_highlights', { book: 'Quijote' })).content[0].text, /Ningún libro se llama «Quijote»/);
  assert.match((await callTool(source, 'get_highlights', {})).content[0].text, /pasa «bookId».*o «book»/);
  // Con id, como siempre (sin leer títulos de más).
  calls.length = 0;
  assert.equal(payload(await callTool(source, 'get_highlights', { bookId: 'b3' })).bookId, 'b3');
  assert.ok(!calls.includes('titles'));
});
