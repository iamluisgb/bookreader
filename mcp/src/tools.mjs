// tools.mjs — la superficie que ve el agente externo. Las tools básicas (libros, subrayados,
// notas, búsqueda) sirven sobre cualquiera de las dos fuentes; `reading_stats` solo existe si la
// fuente lleva el registro de lectura (F2) y las de mazos y artefactos (`hasAgentData`) solo con
// la fuente viva, que es quien los tiene. La definición y la ejecución viven juntas a propósito:
// el esquema y lo que de verdad devuelve la tool se leen en el mismo sitio.
//
// Reglas de la casa:
//   - Nada de escritura. F3 está fuera de P28.
//   - Un error de la petición (libro desconocido, rango inválido) NO revienta la sesión: se
//     devuelve como resultado con isError, en texto que el modelo pueda leer y corregir.
//   - El payload va como JSON en un bloque de texto. Un solo formato, sin sorpresas.

import { ToolError, SourceError, UnknownBookError } from './errors.mjs';
import { aggregateReading, RANGES, GROUP_BY } from './stats.mjs';

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 500;
const MAX_LISTED_IDS = 50;
const DECK_LIMIT_DEFAULT = 100;
const DECK_LIMIT_MAX = 500;
const ARTIFACT_PREVIEW_CHARS = 200;
const ARTIFACT_MAX_CHARS = 20000;

// ---- Validación de argumentos (sin dependencias) ---------------------------

function asObject(args) {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new ToolError('Los argumentos tienen que ser un objeto JSON.');
  }
  return args;
}

function requireString(args, name) {
  const v = args[name];
  if (typeof v !== 'string' || !v.trim()) {
    throw new ToolError('Falta el argumento obligatorio «' + name + '» (texto no vacío).');
  }
  return v.trim();
}

function optionalString(args, name) {
  const v = args[name];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new ToolError('«' + name + '» tiene que ser texto.');
  return v.trim();
}

function optionalInt(args, name, { min, max, def }) {
  const v = args[name];
  if (v === undefined || v === null) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ToolError('«' + name + '» tiene que ser un entero entre ' + min + ' y ' + max + '.');
  }
  return n;
}

// ---- Mazos y artefactos (hasAgentData) -------------------------------------

/** Día de calendario local (días desde epoch, cortando a medianoche local): el criterio de la app. */
function dayOf(ts) {
  const d = new Date(ts);
  return Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 86400000);
}

/** Tarjetas vivas de un mazo: un tombstone del sync no cuenta ni se lista. */
function liveCards(cards) {
  return (Array.isArray(cards) ? cards : []).filter((c) => c && !c.deleted);
}

/**
 * ¿La tarjeta toca hoy? Sin `srs` es nueva y toca; suspendida nunca (mismo criterio que
 * `isDue` en app/js/ai/srs.js: las suspendidas están fuera de la rotación). `due` e
 * `srs.due` se miden en DÍAS de calendario, no en milisegundos: comparar contra `Date.now()`
 * marcaría vencidas TODAS las tarjetas con estado.
 */
function isDue(card, today) {
  if (card.suspended) return false;
  return !card.srs || card.srs.due <= today;
}

/** Fila de `list_decks`: los contadores que hacen falta para saber cómo va el repaso, sin texto. */
function deckRow(deck, today) {
  const cards = liveCards(deck.cards);
  let due = 0;
  let neuvas = 0;
  let suspendidas = 0;
  for (const c of cards) {
    if (c.suspended) suspendidas++;
    else if (!c.srs || c.srs.reps === 0) neuvas++;
    if (isDue(c, today)) due++;
  }
  return {
    deckId: deck.id,
    name: deck.name || null,
    scope: deck.scope || null,
    cardType: deck.cardType || null,
    cards: cards.length,
    due,
    new: neuvas,
    suspended: suspendidas,
    createdAt: Number(deck.createdAt) || null,
    updatedAt: Number(deck.updatedAt) || null,
  };
}

/** Tarjeta para `get_deck`: el texto y el estado SRS relevante, sin el ruido interno. */
function cardRow(c) {
  return {
    uid: c.uid || null,
    type: c.type || 'basic',
    front: c.front || '',
    back: c.back || '',
    chapter: c.chapter || null,
    src: c.src || null,
    suspended: Boolean(c.suspended),
    srs: c.srs
      ? {
          due: c.srs.due ?? null,
          reps: c.srs.reps ?? 0,
          stability: c.srs.stability ?? null,
          difficulty: c.srs.difficulty ?? null,
        }
      : null,
  };
}

/** Vista corta del `result` de un artefacto: nunca el contenido entero. */
function previewOf(result, max) {
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? null);
  return String(text || '').slice(0, max);
}

// ---- Búsqueda --------------------------------------------------------------

/** Sin acentos y en minúsculas: «diseño» y «diseno» son la misma palabra. */
function fold(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function termsOf(query) {
  return fold(query).split(/\s+/).filter(Boolean);
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/** Trozo alrededor de la primera coincidencia, para que el modelo vea el contexto. */
export function snippetAround(text, term, width = 80) {
  const src = String(text || '');
  const folded = fold(src);
  const at = folded.indexOf(term);
  if (at === -1) return src.slice(0, width * 2);
  const from = Math.max(0, at - width);
  const to = Math.min(src.length, at + term.length + width);
  return (from > 0 ? '…' : '') + src.slice(from, to) + (to < src.length ? '…' : '');
}

/**
 * Coincidencias de un subrayado contra los términos, en texto y en su nota. Todos los
 * términos tienen que aparecer (AND): una búsqueda de dos palabras quiere las dos.
 */
export function matchHighlight(highlight, terms) {
  const haystack = fold(highlight.text + ' ' + highlight.note);
  if (!terms.every((t) => haystack.includes(t))) return null;
  const score = terms.reduce((n, t) => n + countOccurrences(haystack, t), 0);
  return { score, snippet: snippetAround(highlight.text || highlight.note, terms[0]) };
}

// ---- Definición de las tools -----------------------------------------------

const LIST_BOOKS = {
  name: 'list_books',
  title: 'Listar los libros con anotaciones',
  description:
    'Devuelve los libros de la biblioteca del lector con cuántos subrayados, marcadores y ' +
    'notas de libreta tiene cada uno, y cuándo fue la última actividad. Empieza siempre por ' +
    'aquí para saber qué bookIds existen.\n\n' +
    'Ojo con el título: en la fuente de backup (`--backup`) solo hay título para los libros ' +
    'que pasaron por el agente, así que puede venir `null` — usa el `id` entonces.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async run(source) {
    return { source: source.kind, books: await source.listBooks() };
  },
};

const GET_HIGHLIGHTS = {
  name: 'get_highlights',
  title: 'Subrayados de un libro',
  description:
    'Los subrayados (y sus notas al margen) de UN libro, en el orden en que están guardados. ' +
    'Los subrayados borrados no aparecen. El `note` de cada subrayado es la nota que el lector ' +
    'escribió sobre ese pasaje; las notas de libreta son otra cosa (usa `get_notes`).',
  inputSchema: {
    type: 'object',
    properties: {
      bookId: { type: 'string', description: 'Id del libro, tal como sale en `list_books`.' },
      limit: { type: 'integer', minimum: 1, maximum: LIMIT_MAX, description: 'Máximo a devolver (50 por defecto).' },
      offset: { type: 'integer', minimum: 0, description: 'Desplazamiento, para paginar un libro con muchos subrayados.' },
    },
    required: ['bookId'],
    additionalProperties: false,
  },
  async run(source, args) {
    const bookId = requireString(args, 'bookId');
    const limit = optionalInt(args, 'limit', { min: 1, max: LIMIT_MAX, def: LIMIT_DEFAULT });
    const offset = optionalInt(args, 'offset', { min: 0, max: Number.MAX_SAFE_INTEGER, def: 0 });
    const highlights = await source.getHighlights(bookId);
    const book = await source.bookInfo(bookId);
    const page = highlights.slice(offset, offset + limit);
    return {
      source: source.kind,
      bookId,
      bookTitle: book.title,
      total: highlights.length,
      offset,
      limit,
      returned: page.length,
      highlights: page,
    };
  },
};

const GET_NOTES = {
  name: 'get_notes',
  title: 'Notas de libreta de un libro',
  description:
    'Las notas de la libreta de un libro: los campos que el lector fue rellenando con el ' +
    'agente (problema actual, conceptos, plan de acción…). Cada nota trae su `fieldKey`, una ' +
    'etiqueta humanizada y el objetivo de la conversación de la que salió. Las notas borradas ' +
    'no aparecen.',
  inputSchema: {
    type: 'object',
    properties: {
      bookId: { type: 'string', description: 'Id del libro, tal como sale en `list_books`.' },
      limit: { type: 'integer', minimum: 1, maximum: LIMIT_MAX, description: 'Máximo a devolver (50 por defecto).' },
      offset: { type: 'integer', minimum: 0, description: 'Desplazamiento, para paginar.' },
    },
    required: ['bookId'],
    additionalProperties: false,
  },
  async run(source, args) {
    const bookId = requireString(args, 'bookId');
    const limit = optionalInt(args, 'limit', { min: 1, max: LIMIT_MAX, def: LIMIT_DEFAULT });
    const offset = optionalInt(args, 'offset', { min: 0, max: Number.MAX_SAFE_INTEGER, def: 0 });
    const notes = await source.getNotes(bookId);
    const book = await source.bookInfo(bookId);
    const page = notes.slice(offset, offset + limit);
    return {
      source: source.kind,
      bookId,
      bookTitle: book.title,
      total: notes.length,
      offset,
      limit,
      returned: page.length,
      notes: page,
    };
  },
};

const SEARCH_HIGHLIGHTS = {
  name: 'search_highlights',
  title: 'Buscar en los subrayados',
  description:
    'Busca en el texto de TODOS los subrayados y en sus notas, sin distinguir mayúsculas ni ' +
    'acentos («diseno» encuentra «diseño»). Todos los términos tienen que aparecer en el ' +
    'subrayado o en su nota (AND). Devuelve también un `snippet` con el contexto, útil para ' +
    'citar sin volcar el libro entero.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Lo que se busca. Varias palabras = todas tienen que aparecer.' },
      bookId: { type: 'string', description: 'Opcional: limita la búsqueda a un libro.' },
      limit: { type: 'integer', minimum: 1, maximum: LIMIT_MAX, description: 'Máximo a devolver (50 por defecto).' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async run(source, args) {
    const query = requireString(args, 'query');
    const bookId = optionalString(args, 'bookId');
    const limit = optionalInt(args, 'limit', { min: 1, max: LIMIT_MAX, def: LIMIT_DEFAULT });
    const terms = termsOf(query);
    if (!terms.length) throw new ToolError('La consulta no tiene ningún término buscable.');

    // Un `bookId` explícito se valida ANTES de buscar. Sin esto, un id con una letra mal devolvía
    // «cero resultados», que se lee como «ese libro no tiene nada subrayado» y no como «ese libro
    // no existe» — y el que se equivoca es el modelo, que puede corregirse si se le dice.
    if (bookId) await source.bookInfo(bookId);

    // Los ids salen de `titles()` (el manifest: UNA lectura en la fuente de Drive) y no de
    // `listBooks()` (una lectura POR LIBRO): buscar en toda la biblioteca no debe costar abrir
    // todos los libros antes de buscar.
    const books = bookId ? [bookId] : Object.keys(await source.titles());
    const results = [];
    for (const id of books) {
      let highlights;
      try {
        highlights = await source.getHighlights(id);
      } catch (e) {
        if (e instanceof SourceError) continue; // un libro ilegible no tumba la búsqueda
        throw e;
      }
      for (const h of highlights) {
        const m = matchHighlight(h, terms);
        if (m) results.push({ ...h, score: m.score, snippet: m.snippet });
      }
    }
    results.sort((a, b) => b.score - a.score || (b.timestamp || 0) - (a.timestamp || 0));
    return {
      source: source.kind,
      query,
      terms,
      scope: bookId || 'todos los libros',
      total: results.length,
      returned: Math.min(limit, results.length),
      results: results.slice(0, limit),
    };
  },
};

const READING_STATS = {
  name: 'reading_stats',
  title: 'Estadísticas de lectura',
  description:
    'Cuánto se ha leído de verdad en un rango: minutos y palabras de lectura a ritmo ' +
    'plausible (los saltos y el tiempo con el libro abierto sin leer no cuentan). Suma los ' +
    'dispositivos del lector, así que no hay desglose por dispositivo a propósito. ' +
    'Disponible solo con la fuente de Drive: el backup no lleva el registro de lectura.',
  capability: 'hasReadingStats',
  inputSchema: {
    type: 'object',
    properties: {
      range: {
        type: 'string',
        enum: RANGES,
        description: 'Ventana: today, 7d, 30d, 90d, 365d o all (7d por defecto).',
      },
      bookId: { type: 'string', description: 'Opcional: limita las cuentas a un libro.' },
      groupBy: {
        type: 'string',
        enum: GROUP_BY,
        description: 'Agrupación del desglose temporal: day, week o month (day por defecto).',
      },
    },
    additionalProperties: false,
  },
  async run(source, args) {
    const range = optionalString(args, 'range') || '7d';
    const bookId = optionalString(args, 'bookId');
    const groupBy = optionalString(args, 'groupBy') || 'day';
    const titles = await source.titles();
    // Mismo criterio que en la búsqueda: un `bookId` que no existe es un error, no un cero.
    if (bookId && !Object.hasOwn(titles, bookId)) {
      throw new UnknownBookError(bookId);
    }
    const days = await source.readingDays();
    return { source: source.kind, ...aggregateReading(days, { range, bookId, groupBy, titleOf: (id) => titles[id] || null }) };
  },
};

const LIST_DECKS = {
  name: 'list_decks',
  title: 'Mazos de flashcards',
  description:
    'Los mazos de flashcards del lector con sus contadores de repaso: cuántas tarjetas tiene ' +
    'cada uno, cuántas vencen hoy, cuántas son nuevas y cuántas hay suspendidas. Es el ' +
    'resumen para saber cómo va el estudio: NO devuelve el texto de las tarjetas (para eso, ' +
    '`get_deck`). Sin `bookId` recorre toda la biblioteca; con él, solo ese libro. ' +
    'Disponible solo con la fuente viva: el backup no lleva los mazos.',
  capability: 'hasAgentData',
  inputSchema: {
    type: 'object',
    properties: {
      bookId: { type: 'string', description: 'Opcional: limita el listado a un libro.' },
    },
    additionalProperties: false,
  },
  async run(source, args) {
    const bookId = optionalString(args, 'bookId');
    const today = dayOf(Date.now());
    const titles = await source.titles();
    const ids = bookId ? [bookId] : Object.keys(titles);
    const books = [];
    for (const id of ids) {
      const decks = await source.decks(id);
      const rows = decks.map((d) => ({ ...deckRow(d, today), bookId: id, bookTitle: titles[id] || null }));
      books.push({ bookId: id, bookTitle: titles[id] || null, deckCount: rows.length, decks: rows });
    }
    return {
      source: source.kind,
      total: books.reduce((n, b) => n + b.deckCount, 0),
      books,
    };
  },
};

const GET_DECK = {
  name: 'get_deck',
  title: 'Tarjetas de un mazo',
  description:
    'Las tarjetas de UN mazo: frente, dorso, capítulo de origen, si está suspendida y su ' +
    'estado de repaso (`due`, `reps`, `stability`, `difficulty`; una tarjeta sin `srs` es ' +
    'nueva). El mazo se identifica por `deckId` (sale en `list_decks`) o por `scope` (el ' +
    'ámbito del libro para el que se generó). Con `limit` se pagina un mazo grande.',
  capability: 'hasAgentData',
  inputSchema: {
    type: 'object',
    properties: {
      bookId: { type: 'string', description: 'Id del libro, tal como sale en `list_books`.' },
      deckId: { type: 'string', description: 'Id del mazo (uno de los dos: `deckId` o `scope`).' },
      scope: { type: 'string', description: 'Ámbito del mazo dentro del libro (uno de los dos).' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: DECK_LIMIT_MAX,
        description: 'Máximo de tarjetas a devolver (100 por defecto, 500 como tope).',
      },
    },
    required: ['bookId'],
    additionalProperties: false,
  },
  async run(source, args) {
    const bookId = requireString(args, 'bookId');
    const deckId = optionalString(args, 'deckId');
    const scope = optionalString(args, 'scope');
    if (!deckId && !scope) {
      throw new ToolError(
        'Falta identificar el mazo: pasa «deckId» (sale en `list_decks`) o «scope».',
      );
    }
    const limit = optionalInt(args, 'limit', { min: 1, max: DECK_LIMIT_MAX, def: DECK_LIMIT_DEFAULT });
    const decks = await source.decks(bookId);
    const deck = deckId
      ? decks.find((d) => String(d && d.id) === String(deckId))
      : decks.find((d) => ((d && d.scope) || '') === scope);
    if (!deck) {
      const disponibles = decks
        .map((d) => (d && d.id != null ? String(d.id) : '(sin id)') + (d.name ? ' («' + d.name + '»)' : ''))
        .join(', ');
      throw new ToolError(
        'No hay un mazo que coincida con ' +
          (deckId ? 'deckId «' + deckId + '»' : 'scope «' + scope + '»') +
          ' en ese libro.' +
          (disponibles ? ' Mazos disponibles: ' + disponibles + '.' : ' El libro no tiene mazos.'),
      );
    }
    const cards = liveCards(deck.cards);
    const page = cards.slice(0, limit).map(cardRow);
    return {
      source: source.kind,
      bookId,
      bookTitle: (await source.bookInfo(bookId)).title,
      deckId: deck.id,
      name: deck.name || null,
      scope: deck.scope || null,
      cardType: deck.cardType || null,
      total: cards.length,
      limit,
      returned: page.length,
      truncated: cards.length > page.length,
      cards: page,
    };
  },
};

const LIST_ARTIFACTS = {
  name: 'list_artifacts',
  title: 'Artefactos del Studio',
  description:
    'Qué salió del Studio (resúmenes, mapas mentales, infografías, figuras) y de qué libro, ' +
    'con una `preview` de como mucho 200 caracteres del contenido: metadatos para elegir qué ' +
    'abrir, nunca el contenido entero (para eso, `get_artifact`). Con `kind` filtras por tipo ' +
    '(summary, mindmap, infographic, figures). Solo con la fuente viva: el backup no los lleva.',
  capability: 'hasAgentData',
  inputSchema: {
    type: 'object',
    properties: {
      bookId: { type: 'string', description: 'Opcional: limita el listado a un libro.' },
      kind: {
        type: 'string',
        description: 'Opcional: filtra por tipo de artefacto (summary, mindmap, infographic, figures).',
      },
    },
    additionalProperties: false,
  },
  async run(source, args) {
    const bookId = optionalString(args, 'bookId');
    const kind = optionalString(args, 'kind');
    const titles = await source.titles();
    const ids = bookId ? [bookId] : Object.keys(titles);
    const artifacts = [];
    for (const id of ids) {
      for (const a of await source.artifacts(id)) {
        if (kind && a.kind !== kind) continue;
        artifacts.push({
          key: a.key,
          bookId: id,
          bookTitle: titles[id] || null,
          kind: a.kind || null,
          createdAt: Number(a.createdAt) || null,
          updatedAt: Number(a.updatedAt) || null,
          preview: previewOf(a.result, ARTIFACT_PREVIEW_CHARS),
        });
      }
    }
    return { source: source.kind, total: artifacts.length, artifacts };
  },
};

const GET_ARTIFACT = {
  name: 'get_artifact',
  title: 'Contenido de un artefacto',
  description:
    'El `result` completo de UN artefacto del Studio (el que sale en `list_artifacts`), ' +
    'serializado como texto con un tope de 20000 caracteres: si lo excede, se trunca y se ' +
    'avisa con `truncated: true` y `totalChars`. Solo con la fuente viva.',
  capability: 'hasAgentData',
  inputSchema: {
    type: 'object',
    properties: {
      bookId: { type: 'string', description: 'Id del libro al que pertenece el artefacto.' },
      key: { type: 'string', description: 'Clave del artefacto, tal como sale en `list_artifacts`.' },
    },
    required: ['bookId', 'key'],
    additionalProperties: false,
  },
  async run(source, args) {
    const bookId = requireString(args, 'bookId');
    const key = requireString(args, 'key');
    const artifacts = await source.artifacts(bookId);
    const artifact = artifacts.find((a) => String(a && a.key) === String(key));
    if (!artifact) {
      throw new ToolError(
        'No hay un artefacto con key «' + key +
          '» en ese libro. Usa `list_artifacts` para ver las claves que hay.',
      );
    }
    const text = typeof artifact.result === 'string' ? artifact.result : JSON.stringify(artifact.result ?? null);
    const truncated = text.length > ARTIFACT_MAX_CHARS;
    return {
      source: source.kind,
      bookId,
      key: artifact.key,
      kind: artifact.kind || null,
      createdAt: Number(artifact.createdAt) || null,
      updatedAt: Number(artifact.updatedAt) || null,
      totalChars: text.length,
      truncated,
      result: truncated ? text.slice(0, ARTIFACT_MAX_CHARS) : text,
    };
  },
};

/** Todas las definiciones, en el orden en que se anuncian. `capability` nombra el flag de la
 * fuente que tiene que estar a `true` para que la tool se anuncie (si no lo lleva, sale siempre). */
export const ALL_TOOLS = [
  LIST_BOOKS,
  GET_HIGHLIGHTS,
  GET_NOTES,
  SEARCH_HIGHLIGHTS,
  READING_STATS,
  LIST_DECKS,
  GET_DECK,
  LIST_ARTIFACTS,
  GET_ARTIFACT,
];

/**
 * Lo que se anuncia por MCP para una fuente concreta. Una tool que la fuente no puede
 * responder NO se anuncia (y no se ejecuta aunque se la llame a mano): una tool que siempre
 * responde «no hay datos» es peor que una tool que no existe — el modelo no la llama.
 */
export function toolsFor(source) {
  return ALL_TOOLS.filter((t) => !t.capability || source[t.capability]).map(
    ({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema }),
  );
}

/** El ejecutor de una tool, o `null`. */
export function findTool(source, name) {
  const found = ALL_TOOLS.find((t) => t.name === name);
  if (!found) return null;
  if (found.capability && !source[found.capability]) return null;
  return found;
}

function idsHint(books) {
  const ids = books.map((b) => b.id);
  const shown = ids.slice(0, MAX_LISTED_IDS);
  return (
    'Libros disponibles: ' +
    shown.join(', ') +
    (ids.length > shown.length ? ', … (' + ids.length + ' en total)' : '')
  );
}

/**
 * Ejecuta una tool y devuelve un resultado MCP (`{ content, isError? }`). Nunca lanza por un
 * fallo previsto: el modelo tiene que poder leerlo y corregir la llamada.
 */
export async function callTool(source, name, rawArgs) {
  const tool = findTool(source, name);
  if (!tool) {
    const disponibles = toolsFor(source).map((t) => t.name).join(', ');
    return errorResult('Tool desconocida: «' + name + '». Disponibles: ' + disponibles + '.');
  }
  try {
    const payload = await tool.run(source, asObject(rawArgs));
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  } catch (e) {
    if (e instanceof UnknownBookError) {
      try {
        return errorResult(e.message + '. ' + idsHint(await source.listBooks()));
      } catch {
        return errorResult(e.message);
      }
    }
    if (e instanceof ToolError || e instanceof SourceError) return errorResult(e.message);
    throw e;
  }
}

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
