// stdio — las tools de punta a punta (F1), con un cliente MCP de verdad hablando con el
// servidor como proceso hijo. Es la prueba de que esto es un MCP y no una librería con buenas
// intenciones: protocolo, esquemas, arranque por argumentos y forma de los errores.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { connect, SERVER, FIXTURES } from './helpers/mcp-client.mjs';
import { BOOK_1, BOOK_2 } from './helpers/dataset.mjs';

const BACKUP = ['--backup', resolve(FIXTURES, 'backup.json')];

/** Arranca el servidor solo para ver con qué código y qué mensaje sale. */
function run(args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [SERVER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

test('F1 anuncia cuatro tools y NO anuncia reading_stats', async () => {
  const c = await connect(BACKUP);
  try {
    assert.deepEqual(await c.toolNames(), ['list_books', 'get_highlights', 'get_notes', 'search_highlights']);
    const tools = await c.tools();
    for (const t of tools) {
      assert.equal(typeof t.description, 'string');
      assert.ok(t.description.length > 20, 'una tool sin descripción útil es una tool que nadie llama');
      assert.equal(t.inputSchema.type, 'object');
    }
  } finally {
    await c.close();
  }
});

test('list_books devuelve lo que el modelo necesita para elegir libro', async () => {
  const c = await connect(BACKUP);
  try {
    const { isError, json } = await c.call('list_books', {});
    assert.equal(isError, false);
    assert.equal(json.source, 'backup-file');
    assert.deepEqual(
      json.books.map((b) => b.id),
      [BOOK_1.id, BOOK_2.id],
    );
    const b1 = json.books[0];
    assert.equal(b1.title, 'Diseño de datos intensivos');
    assert.equal(b1.highlightCount, 3);
    assert.equal(b1.noteCount, 2);
    assert.equal(b1.bookmarkCount, 1);
    assert.ok(b1.lastReadAt > 0);
    assert.equal(json.books[1].title, null, 'sin metadatos del agente, el título es null (y el README lo dice)');
  } finally {
    await c.close();
  }
});

test('get_highlights: sin tombstones, sin rects de pintado y con la cita del pasaje', async () => {
  const c = await connect(BACKUP);
  try {
    const { json } = await c.call('get_highlights', { bookId: BOOK_1.id });
    assert.equal(json.total, 3);
    assert.equal(json.bookTitle, 'Diseño de datos intensivos');
    assert.ok(!JSON.stringify(json).includes('borrado'));
    for (const h of json.highlights) assert.equal(h.rects, undefined);
    const pdf = json.highlights.find((h) => h.page === 42);
    assert.equal(pdf.chapter, 'Pág. 42');
    assert.ok(json.highlights[0].cfi.startsWith('epubcfi('));
  } finally {
    await c.close();
  }
});

test('get_highlights pagina con limit y offset', async () => {
  const c = await connect(BACKUP);
  try {
    const { json } = await c.call('get_highlights', { bookId: BOOK_1.id, limit: 1, offset: 1 });
    assert.equal(json.total, 3);
    assert.equal(json.returned, 1);
    assert.equal(json.highlights.length, 1);
    assert.match(json.highlights[0].text, /consenso/);
  } finally {
    await c.close();
  }
});

test('get_notes trae la libreta con su contexto de conversación', async () => {
  const c = await connect(BACKUP);
  try {
    const { json } = await c.call('get_notes', { bookId: BOOK_1.id });
    assert.equal(json.total, 2);
    const [n1, n2] = json.notes;
    assert.equal(n1.fieldKey, 'problema_actual');
    assert.equal(n1.fieldLabel, 'Problema actual');
    assert.equal(n1.goal, 'Elegir el índice que aguante mi volumen de pedidos');
    assert.equal(n1.templateId, 't1-extraccion');
    // La nota sin `bookId` se resolvió por su conversación, no se perdió.
    assert.equal(n2.uid, 'n-2-conceptos');
    assert.equal(n2.bookId, BOOK_1.id);
    assert.ok(!json.notes.some((n) => /se borró/.test(n.content)));
  } finally {
    await c.close();
  }
});

test('search_highlights: texto y notas, sin mayúsculas ni acentos, con snippet', async () => {
  const c = await connect(BACKUP);
  try {
    const consenso = await c.call('search_highlights', { query: 'consenso' });
    assert.equal(consenso.json.total, 1);
    assert.match(consenso.json.results[0].snippet, /consenso/);

    // La nota del subrayado también es buscable, no solo el texto.
    const cobertura = await c.call('search_highlights', { query: 'pedidos' });
    assert.equal(cobertura.json.total, 1, 'el término solo está en la nota del subrayado');

    // Sin acentos: «epidemiologia» encuentra «Epidemiología».
    const sinAcentos = await c.call('search_highlights', { query: 'epidemiologia' });
    assert.equal(sinAcentos.json.total, 1);
    const mayusculas = await c.call('search_highlights', { query: 'MEMORIA' });
    assert.equal(mayusculas.json.total, 2, 'b2 tiene dos subrayados que hablan de memoria');

    // Varios términos = todos (AND).
    const and = await c.call('search_highlights', { query: 'memoria ilusion' });
    assert.equal(and.json.total, 1);
    const andImposible = await c.call('search_highlights', { query: 'memoria consenso' });
    assert.equal(andImposible.json.total, 0);

    // Escope por libro.
    const scoped = await c.call('search_highlights', { query: 'memoria', bookId: BOOK_1.id });
    assert.equal(scoped.json.total, 0);

    // Varias palabras en el mismo subrayado suben en el ranking.
    const ranking = await c.call('search_highlights', { query: 'memoria' });
    assert.equal(ranking.json.scope, 'todos los libros');
    assert.equal(ranking.json.returned, 2);
  } finally {
    await c.close();
  }
});

test('un libro desconocido es un error LEGIBLE con la lista de los que hay', async () => {
  const c = await connect(BACKUP);
  try {
    const res = await c.call('get_highlights', { bookId: 'no-existe' });
    assert.equal(res.isError, true);
    assert.match(res.text, /Libro desconocido/);
    assert.match(res.text, new RegExp(BOOK_1.id));
    assert.equal(res.json, null, 'un error se comunica como texto, no como JSON a medias');
  } finally {
    await c.close();
  }
});

test('argumentos que faltan o están mal: error claro, servidor entero', async () => {
  const c = await connect(BACKUP);
  try {
    for (const [name, args] of [
      ['get_highlights', {}],
      ['get_notes', {}],
      ['search_highlights', {}],
      ['search_highlights', { query: '   ' }],
      ['get_highlights', { bookId: BOOK_1.id, limit: 0 }],
      ['get_highlights', { bookId: BOOK_1.id, limit: 'muchos' }],
      ['get_highlights', { bookId: 42 }],
      ['search_highlights', { query: 'x', limit: 9999 }],
    ]) {
      const res = await c.call(name, args);
      assert.equal(res.isError, true, name + ' con ' + JSON.stringify(args) + ' debería fallar');
    }
    const ok = await c.call('list_books', {});
    assert.equal(ok.isError, false);
  } finally {
    await c.close();
  }
});

test('reading_stats no existe en F1 y el error dice qué SÍ hay', async () => {
  const c = await connect(BACKUP);
  try {
    const res = await c.call('reading_stats', { range: '7d' });
    assert.equal(res.isError, true);
    assert.match(res.text, /Tool desconocida/);
    assert.match(res.text, /list_books/);
    assert.ok(!res.text.includes('reading_stats,'));
  } finally {
    await c.close();
  }
});

test('una tool que no existe tampoco tumba la sesión', async () => {
  const c = await connect(BACKUP);
  try {
    const res = await c.raw('no_existe', {});
    assert.equal(res.isError, true);
  } finally {
    await c.close();
  }
});

test('arranque: sin fuente, con fuente rota o con flags mezclados sale con código y por stderr', async () => {
  const sinFuente = await run([]);
  assert.equal(sinFuente.code, 2);
  assert.match(sinFuente.stderr, /--backup o --dir/);
  assert.equal(sinFuente.stdout, '', 'stdout es EL CANAL: ni una línea de más');

  const roto = await run(['--backup', resolve(FIXTURES, 'no-existe.json')]);
  assert.equal(roto.code, 1);
  assert.match(roto.stderr, /No puedo leer el backup/);
  assert.equal(roto.stdout, '');

  const mezcla = await run(['--backup', 'b.json', '--dir', 'd']);
  assert.equal(mezcla.code, 2);
  assert.match(mezcla.stderr, /no las dos/);
});

test('--help y --version salen por stderr sin ensuciar stdout ni esperar a un cliente', async () => {
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stderr, /bookreader-mcp/);
  assert.equal(help.stdout, '');
  const version = await run(['--version']);
  assert.equal(version.code, 0);
  assert.match(version.stderr.trim(), /^\d+\.\d+\.\d+$/);
});
