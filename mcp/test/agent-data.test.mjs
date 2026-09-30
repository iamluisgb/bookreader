// agent-data — las tools de mazos y artefactos del Studio (`hasAgentData`).
//
// Igual que redaction.test.mjs, esto habla con el SERVIDOR de verdad por stdio sobre un layout
// escrito en un tmpdir (el fixture de dataset.mjs se sobreescribe a propósito: sus mazos están
// vacíos porque hasta ahora el MCP los ignoraba). Lo que se prueba aquí es el contrato entero:
// qué tools se anuncian según la fuente, los contadores de repaso, los límites, y que un error
// previsto contesta con isError en vez de tirar la sesión.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { connect } from './helpers/mcp-client.mjs';
import { findForbidden } from '../src/redact.mjs';
import { callTool, findTool, toolsFor } from '../src/tools.mjs';
import { BOOK_1, BOOK_2, buildBackupFixture, buildLayoutFiles } from './helpers/dataset.mjs';

const NEW_TOOLS = ['list_decks', 'get_deck', 'list_artifacts', 'get_artifact'];

// El secreto plantado: una clave vetada DENTRO de una tarjeta y de un artefacto. `scrub()` la
// tiene que borrar a cualquier profundidad antes de que el payload llegue a la tool.
const SECRET = '1//0gRefreshTokenPlantadoEnAgentData';

// Día de calendario local, la misma fórmula que la app (ai/srs.js) y que tools.mjs: `srs.due`
// se mide en días, no en milisegundos.
const dayOf = (ts) => {
  const d = new Date(ts);
  return Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 86400000);
};
const TODAY = dayOf(Date.now());

const CARD_TOMBSTONE = {
  uid: 'c-tombstone',
  front: 'Esta tarjeta estaba borrada y no debe aparecer.',
  back: '',
  deleted: true,
  deletedAt: TODAY,
};

// Mazo con los cuatro casos que importan para los contadores:
//   c1 vencida (due ayer), c2 futura, c3 nueva (sin srs), c4 suspendida, c5 tombstone.
const DECK_1 = {
  id: 'd-1-indices',
  bookId: BOOK_1.id,
  name: 'Índices y particiones',
  scope: 'Cap. 3',
  cardType: 'basic',
  createdAt: Date.parse('2026-09-21T08:00:00.000Z'),
  cards: [
    {
      uid: 'c-1',
      type: 'basic',
      front: '¿Qué es un índice de cobertura?',
      back: 'Uno que responde la consulta solo con el árbol del índice.',
      chapter: 'Capítulo 3',
      srs: { due: TODAY - 1, reps: 2, stability: 3.2, difficulty: 5.4 },
    },
    {
      uid: 'c-2',
      type: 'basic',
      front: '¿Qué paga cada ronda de consenso?',
      back: 'Una ida y vuelta de red.',
      chapter: 'Capítulo 9',
      srs: { due: TODAY + 5, reps: 4, stability: 8.1, difficulty: 4.2 },
      drive_refresh_token: SECRET, // clave vetada plantada dentro de una tarjeta
    },
    { uid: 'c-3', type: 'basic', front: '¿Qué es un punto caliente?', back: '', chapter: 'Pág. 42' },
    {
      uid: 'c-4',
      type: 'basic',
      front: 'Tarjeta aparcada',
      back: '',
      suspended: true,
      srs: { due: TODAY + 9, reps: 1 },
    },
    CARD_TOMBSTONE,
  ],
};

// Mazo recién creado: todo nuevo y todo vencido hoy.
const DECK_2 = {
  id: 'd-2-cloze',
  bookId: BOOK_1.id,
  name: 'Huecos',
  scope: '',
  cardType: 'cloze',
  createdAt: Date.parse('2026-09-22T10:00:00.000Z'),
  cards: [
    { uid: 'c-5', type: 'cloze', front: 'La réplica de lectura es para {{c1::lecturas}}', back: '' },
    { uid: 'c-6', type: 'cloze', front: 'El particionado por prefijo evita {{c1::hotspots}}', back: '' },
  ],
};

const SUMMARY_BASE = 'El capítulo argumenta que los índices cuestan escritura. ';
const SUMMARY_RESULT = SUMMARY_BASE + Array.from({ length: 60 }, (_, i) => '<seg' + i + '>').join('');
const MINDMAP_RESULT = { root: 'Consenso', nodes: [{ id: 'n1', label: 'Quórum' }, { id: 'n2', label: 'RPc' }] };
const BIG_RESULT = { data: 'y'.repeat(30000) };

const ARTIFACT_1 = {
  key: BOOK_1.id + ':summary:a1',
  bookId: BOOK_1.id,
  kind: 'summary',
  result: SUMMARY_RESULT,
  params: { drive_refresh_token: SECRET }, // clave vetada plantada en un artefacto
  createdAt: Date.parse('2026-09-21T08:00:00.000Z'),
  updatedAt: Date.parse('2026-09-21T08:00:00.000Z'),
};
const ARTIFACT_2 = {
  key: BOOK_1.id + ':mindmap:a2',
  bookId: BOOK_1.id,
  kind: 'mindmap',
  result: MINDMAP_RESULT,
  createdAt: Date.parse('2026-09-22T09:00:00.000Z'),
  updatedAt: Date.parse('2026-09-22T09:00:00.000Z'),
};
const ARTIFACT_3 = {
  key: BOOK_1.id + ':infographic:a3',
  bookId: BOOK_1.id,
  kind: 'infographic',
  result: BIG_RESULT,
  createdAt: Date.parse('2026-09-22T09:30:00.000Z'),
  updatedAt: Date.parse('2026-09-22T09:30:00.000Z'),
};

/** El layout del dataset con los mazos y artefactos de este test, escrito en un tmpdir. */
async function agentDataLayout() {
  const dir = await mkdtemp(join(tmpdir(), 'bookreader-mcp-agent-'));
  const files = buildLayoutFiles();
  const bookPath = 'bookreader/books/' + BOOK_1.id + '.json';
  files[bookPath] = {
    ...files[bookPath],
    decks: [DECK_1, DECK_2],
    artifacts: [ARTIFACT_1, ARTIFACT_2, ARTIFACT_3],
  };
  for (const [rel, value] of Object.entries(files)) {
    const target = join(dir, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(value), 'utf8');
  }
  return dir;
}

/** Un backup del dataset, en un tmpdir: F1 no lleva mazos ni artefactos. */
async function backupFile() {
  const dir = await mkdtemp(join(tmpdir(), 'bookreader-mcp-agent-bk-'));
  const path = join(dir, 'backup.json');
  await writeFile(path, JSON.stringify(buildBackupFixture()), 'utf8');
  return path;
}

/**
 * Un backup del formato ACTUAL: el mismo fichero más `ai.decks` / `ai.artifacts` planos
 * (así los exporta la app desde el fix de backup completo). La capacidad se DETECTA, así
 * que con estos campos las tools vuelven a anunciarse.
 */
async function backupFileWithAgentData() {
  const dir = await mkdtemp(join(tmpdir(), 'bookreader-mcp-agent-bk2-'));
  const path = join(dir, 'backup.json');
  const backup = buildBackupFixture();
  backup.ai = { ...backup.ai, decks: [DECK_1, DECK_2], artifacts: [ARTIFACT_1, ARTIFACT_2, ARTIFACT_3] };
  await writeFile(path, JSON.stringify(backup), 'utf8');
  return path;
}

test('las tools de mazos y artefactos solo se anuncian si la fuente trae hasAgentData', () => {
  const capable = { kind: 'stub', hasReadingStats: true, hasAgentData: true };
  const names = (s) => toolsFor(s).map((t) => t.name);
  assert.equal(names(capable).length, 9);
  for (const n of NEW_TOOLS) {
    assert.ok(names(capable).includes(n), n + ' anunciada con la fuente viva');
    assert.ok(!names({ ...capable, hasAgentData: false }).includes(n), n + ' oculta sin hasAgentData');
    assert.equal(findTool({ ...capable, hasAgentData: false }, n), null, n + ' no ejecutable sin hasAgentData');
  }
  // El anuncio de las demás no cambia.
  assert.equal(names({ ...capable, hasAgentData: false }).length, 5);
});

test('con la fuente viva el servidor anuncia las cuatro; con el backup, ninguna', async () => {
  const live = await connect(['--dir', await agentDataLayout()]);
  try {
    const names = await live.toolNames();
    for (const n of NEW_TOOLS) assert.ok(names.includes(n), n + ' anunciada con --dir');
  } finally {
    await live.close();
  }

  const bak = await connect(['--backup', await backupFile()]);
  try {
    const names = await bak.toolNames();
    for (const n of NEW_TOOLS) assert.ok(!names.includes(n), n + ' no se anuncia con --backup');
    const res = await bak.call('list_decks', {});
    assert.equal(res.isError, true, 'llamada a mano sobre backup: isError, no crash');
    assert.match(res.text, /Tool desconocida/);
  } finally {
    await bak.close();
  }
});

test('un backup del formato actual (con mazos y artefactos) vuelve a anunciarlas', async () => {
  const bak = await connect(['--backup', await backupFileWithAgentData()]);
  try {
    const names = await bak.toolNames();
    for (const n of NEW_TOOLS) assert.ok(names.includes(n), n + ' anunciada: el backup trae los datos');

    const decks = await bak.call('list_decks', { bookId: BOOK_1.id });
    assert.equal(decks.isError, false, decks.text);
    const book = decks.json.books.find((b) => b.bookId === BOOK_1.id);
    assert.equal(book.deckCount, 2);
    const d1 = book.decks.find((d) => d.deckId === DECK_1.id);
    assert.deepEqual(
      { cards: d1.cards, due: d1.due, new: d1.new, suspended: d1.suspended },
      { cards: 4, due: 2, new: 1, suspended: 1 },
      'mismos contadores que con el layout: la fuente cambia, la semántica no',
    );

    const deck = await bak.call('get_deck', { bookId: BOOK_1.id, deckId: DECK_1.id });
    assert.equal(deck.isError, false, deck.text);
    assert.equal(deck.json.total, 4);
    assert.ok(deck.json.cards.some((c) => /cobertura/.test(c.front)), 'el texto viaja con get_deck');

    const arts = await bak.call('list_artifacts', { bookId: BOOK_1.id, kind: 'mindmap' });
    assert.equal(arts.isError, false, arts.text);
    assert.equal(arts.json.artifacts.length, 1);
    assert.equal(arts.json.artifacts[0].kind, 'mindmap');

    // El secreto plantado sigue sin asomar por esta fuente.
    assert.deepEqual(findForbidden(JSON.stringify(arts.json)), []);
    assert.deepEqual(findForbidden(JSON.stringify(deck.json)), []);
  } finally {
    await bak.close();
  }
});

test('list_decks resume los contadores de repaso, sin texto de tarjetas', async () => {
  const client = await connect(['--dir', await agentDataLayout()]);
  try {
    const res = await client.call('list_decks', { bookId: BOOK_1.id });
    assert.equal(res.isError, false, res.text);
    const book = res.json.books.find((b) => b.bookId === BOOK_1.id);
    assert.equal(book.deckCount, 2);
    const d1 = book.decks.find((d) => d.deckId === DECK_1.id);
    assert.deepEqual(
      { cards: d1.cards, due: d1.due, new: d1.new, suspended: d1.suspended },
      { cards: 4, due: 2, new: 1, suspended: 1 },
      'vencidas: la de ayer y la nueva; la futura y la suspendida no; el tombstone no cuenta',
    );
    assert.equal(d1.cardType, 'basic');
    assert.equal(d1.scope, 'Cap. 3');
    assert.ok(!('front' in d1), 'el resumen no trae texto de tarjetas');
    // Sin bookId: los dos libros (el de abajo sin mazos, con cero), los dos mazos en total.
    const all = await client.call('list_decks', {});
    assert.equal(all.isError, false, all.text);
    assert.equal(all.json.total, 2);
    const empty = all.json.books.find((b) => b.bookId === BOOK_2.id);
    assert.equal(empty.deckCount, 0);
  } finally {
    await client.close();
  }
});

test('get_deck: por deckId, por scope, con limit y truncated', async () => {
  const client = await connect(['--dir', await agentDataLayout()]);
  try {
    const byId = await client.call('get_deck', { bookId: BOOK_1.id, deckId: DECK_1.id });
    assert.equal(byId.isError, false, byId.text);
    assert.equal(byId.json.total, 4);
    assert.equal(byId.json.truncated, false);
    const nueva = byId.json.cards.find((c) => c.uid === 'c-3');
    assert.equal(nueva.srs, null, 'sin srs es nueva: no se inventa estado');
    const programada = byId.json.cards.find((c) => c.uid === 'c-2');
    assert.deepEqual(programada.srs, { due: TODAY + 5, reps: 4, stability: 8.1, difficulty: 4.2 });
    assert.equal(byId.json.cards.some((c) => c.uid === 'c-tombstone'), false, 'tombstone fuera');

    const byScope = await client.call('get_deck', { bookId: BOOK_1.id, scope: 'Cap. 3' });
    assert.equal(byScope.isError, false, byScope.text);
    assert.equal(byScope.json.deckId, DECK_1.id, 'scope «Cap. 3» encuentra el mazo');

    const limited = await client.call('get_deck', { bookId: BOOK_1.id, deckId: DECK_1.id, limit: 2 });
    assert.equal(limited.isError, false, limited.text);
    assert.equal(limited.json.returned, 2);
    assert.equal(limited.json.total, 4);
    assert.equal(limited.json.truncated, true);
  } finally {
    await client.close();
  }
});

test('get_deck y list_decks contestan los errores con isError, nunca revientan', async () => {
  const client = await connect(['--dir', await agentDataLayout()]);
  try {
    const badBook = await client.call('get_deck', { bookId: 'no-existe', deckId: 'x' });
    assert.equal(badBook.isError, true);
    assert.match(badBook.text, /Libro desconocido/);

    const badList = await client.call('list_decks', { bookId: 'no-existe' });
    assert.equal(badList.isError, true);
    assert.match(badList.text, /Libro desconocido/);

    const noId = await client.call('get_deck', { bookId: BOOK_1.id });
    assert.equal(noId.isError, true);
    assert.match(noId.text, /deckId/);

    const unknown = await client.call('get_deck', { bookId: BOOK_1.id, scope: 'no-existe' });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /No hay un mazo/);

    const noBook = await client.call('get_deck', { deckId: DECK_1.id });
    assert.equal(noBook.isError, true);
    assert.match(noBook.text, /bookId/);
  } finally {
    await client.close();
  }
});

test('list_artifacts: preview de 200 como mucho y filtro por kind', async () => {
  const client = await connect(['--dir', await agentDataLayout()]);
  try {
    const all = await client.call('list_artifacts', { bookId: BOOK_1.id });
    assert.equal(all.isError, false, all.text);
    assert.equal(all.json.total, 3);
    const summary = all.json.artifacts.find((a) => a.kind === 'summary');
    assert.equal(summary.preview.length, 200, 'preview cortado en 200');
    assert.ok(!all.text.includes(SUMMARY_RESULT.slice(250, 300)), 'nunca el contenido entero');

    const onlyMindmap = await client.call('list_artifacts', { kind: 'mindmap' });
    assert.equal(onlyMindmap.isError, false, onlyMindmap.text);
    assert.equal(onlyMindmap.json.total, 1);
    assert.equal(onlyMindmap.json.artifacts[0].kind, 'mindmap');
    assert.equal(onlyMindmap.json.artifacts[0].bookId, BOOK_1.id);
  } finally {
    await client.close();
  }
});

test('get_artifact: objeto serializado y tope de 20000 con truncated', async () => {
  const client = await connect(['--dir', await agentDataLayout()]);
  try {
    const mm = await client.call('get_artifact', { bookId: BOOK_1.id, key: ARTIFACT_2.key });
    assert.equal(mm.isError, false, mm.text);
    assert.equal(mm.json.truncated, false);
    assert.deepEqual(JSON.parse(mm.json.result), MINDMAP_RESULT, 'el objeto sale serializado y completo');

    const big = await client.call('get_artifact', { bookId: BOOK_1.id, key: ARTIFACT_3.key });
    assert.equal(big.isError, false, big.text);
    assert.equal(big.json.truncated, true);
    assert.equal(big.json.result.length, 20000, 'se devuelve el tope, no un error');
    assert.equal(big.json.totalChars, JSON.stringify(BIG_RESULT).length, 'y se dice cuánto era');

    const missing = await client.call('get_artifact', { bookId: BOOK_1.id, key: 'no-existe' });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /No hay un artefacto/);
  } finally {
    await client.close();
  }
});

test('un secreto plantado en un mazo o en un artefacto no sale por ninguna tool nueva', async () => {
  const client = await connect(['--dir', await agentDataLayout()]);
  try {
    const calls = [
      ['list_decks', {}],
      ['get_deck', { bookId: BOOK_1.id, deckId: DECK_1.id }],
      ['list_artifacts', {}],
      ['get_artifact', { bookId: BOOK_1.id, key: ARTIFACT_3.key }],
    ];
    for (const [name, args] of calls) {
      const res = await client.call(name, args);
      assert.equal(res.isError, false, name + ' falló: ' + res.text);
      assert.ok(!res.text.includes(SECRET), name + ' filtra el valor del secreto');
      assert.ok(!res.text.includes('drive_refresh_token'), name + ' devuelve la clave vetada');
      if (res.json) {
        assert.deepEqual(findForbidden(res.json, { needles: [SECRET] }), [], name + ' pasa findForbidden');
      }
    }
  } finally {
    await client.close();
  }
});

// Y una comprobación en proceso de la decisión de la tool (mismo estilo que tools.test.mjs):
// `callTool` sobre una fuente sin la capacidad ni siquiera consulta a la fuente.
test('una tool de mazos vetada por la fuente no se ejecuta aunque se la llame a mano', async () => {
  let asked = false;
  const source = {
    kind: 'stub',
    hasReadingStats: true,
    hasAgentData: false,
    titles: async () => {
      asked = true;
      return {};
    },
    decks: async () => {
      asked = true;
      return [];
    },
  };
  const res = await callTool(source, 'list_decks', {});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Tool desconocida/);
  assert.equal(asked, false, 'ni siquiera se molesta a la fuente');
});
