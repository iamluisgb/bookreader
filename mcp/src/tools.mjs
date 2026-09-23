// tools.mjs — la superficie que ve el agente externo. Cuatro tools sobre cualquiera de las
// dos fuentes, más `reading_stats`, que solo existe si la fuente lleva el registro de lectura
// (F2). La definición y la ejecución viven juntas a propósito: el esquema y lo que de verdad
// devuelve la tool se leen en el mismo sitio.
//
// Reglas de la casa:
//   - Nada de escritura. F3 está fuera de P28.
//   - Un error de la petición (libro desconocido, rango inválido) NO revienta la sesión: se
//     devuelve como resultado con isError, en texto que el modelo pueda leer y corregir.
//   - El payload va como JSON en un bloque de texto. Un solo formato, sin sorpresas.

import { ToolError, SourceError } from './errors.mjs';
import { aggregateReading, RANGES, GROUP_BY } from './stats.mjs';

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 500;
const MAX_LISTED_IDS = 50;

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
    return {
      source: source.kind,
      bookId,
      bookTitle: book.title,
      total: highlights.length,
      offset,
      limit,
      returned: highlights.slice(offset, offset + limit).length,
      highlights: highlights.slice(offset, offset + limit),
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
    return {
      source: source.kind,
      bookId,
      bookTitle: book.title,
      total: notes.length,
      offset,
      limit,
      returned: notes.slice(offset, offset + limit).length,
      notes: notes.slice(offset, offset + limit),
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

    const books = bookId ? [bookId] : (await source.listBooks()).map((b) => b.id);
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
    const days = await source.readingDays();
    return { source: source.kind, ...aggregateReading(days, { range, bookId, groupBy, titleOf: (id) => titles[id] || null }) };
  },
};

/** Todas las definiciones, en el orden en que se anuncian. */
export const ALL_TOOLS = [LIST_BOOKS, GET_HIGHLIGHTS, GET_NOTES, SEARCH_HIGHLIGHTS, READING_STATS];

/**
 * Lo que se anuncia por MCP para una fuente concreta. `reading_stats` NO se anuncia si la
 * fuente no lleva el registro de lectura: una tool que siempre responde «no hay datos» es
 * peor que una tool que no existe — el modelo no la llama.
 */
export function toolsFor(source) {
  return ALL_TOOLS.filter((t) => t.name !== 'reading_stats' || source.hasReadingStats).map(
    ({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema }),
  );
}

/** El ejecutor de una tool, o `null`. */
export function findTool(source, name) {
  const found = ALL_TOOLS.find((t) => t.name === name);
  if (!found) return null;
  if (found.name === 'reading_stats' && !source.hasReadingStats) return null;
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
    if (e instanceof SourceError && /Libro desconocido/.test(e.message)) {
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
