// text-tools.mjs — el TEXTO de los libros para un agente: índice, capítulos por páginas y
// búsqueda. Lee lo que sube la app (app/js/sync/book-text.js) en el formato de
// app/js/sync/book-text-build.js: un índice pequeño, trozos de ~250 KB con capítulos enteros y
// un fichero de búsqueda ya plegado. Ninguna tool lee el libro entero: en un Worker, el tiempo
// de CPU es de 10 ms.
//
// Los pasajes llevan las anclas `[[aN]]` de la app: un agente que cita `a1458` en una tarjeta
// (`src`) enlaza al pasaje como lo hace la app.
//
// Solo con el permiso `text` del token (`canReadText`). Un libro sin texto en el sync aún no se
// ha troceado en ningún dispositivo con ese permiso activo: el error lo dice.

import { ToolError } from './errors.mjs';
import { resolveBookArg, fold } from './book-arg.mjs';
import { foldSearch, chapterLines, TEXT_FORMAT } from '../../app/js/sync/book-text-build.js';

const PAGE_WORDS = 6000;
const PAGE_WORDS_MAX = 12000;
const SEARCH_DEFAULT = 8;
const SEARCH_MAX = 20;
const LINE = /^\[\[(a\d+)\]\]\s?(.*)$/;
// Palabras demasiado comunes para puntuar (y caras: casan en casi todas las líneas).
const STOP = new Set(('the of and to in is it that for on as with be by this are was or an at from which ' +
  'de la el en y que los las del un una por con se para al lo su como mas o').split(' '));

// Una palabra que sale más veces que esto casi no puntúa en BM25 (su idf es ~0) y es la que
// más CPU cuesta (una línea que localizar por aparición): se deja de contar. Medido en el Worker:
// una búsqueda de palabras muy comunes pasaba de 90 ms de CPU.
const MAX_HITS_PER_TERM = 1500;

const words = (s) => (s.match(/\S+/g) || []).length;

const NO_TEXT =
  'Este libro aún no tiene texto en el sync. Se sube en cuanto la app lo trocea: ábrelo y usa ' +
  'el agente, la búsqueda o el estudio una vez (con el sync de BookReader y un agente con ' +
  'permiso para leer el texto).';

async function tocOf(source, args) {
  const bookId = await resolveBookArg(source, args);
  const toc = await source.bookText(bookId);
  if (!toc || toc.v !== TEXT_FORMAT || !Array.isArray(toc.chapters) || !toc.chapters.length) throw new ToolError(NO_TEXT);
  return { bookId, toc };
}

async function part(source, bookId, n) {
  const text = await source.bookTextFile(bookId, 'p' + n + '.txt');
  if (text === null) throw new ToolError(NO_TEXT);
  return text;
}

// El capítulo por índice (de get_toc) o por título (o parte, sin tildes).
function pickChapter(chapters, arg) {
  if (typeof arg === 'number' && Number.isInteger(arg)) {
    if (arg < 0 || arg >= chapters.length) throw new ToolError('No hay capítulo ' + arg + ': van del 0 al ' + (chapters.length - 1) + '.');
    return arg;
  }
  if (typeof arg !== 'string' || !arg.trim()) throw new ToolError('Falta «chapter»: su índice (de get_toc) o su título.');
  const q = fold(arg.trim());
  const exact = chapters.findIndex((c) => fold(c.title) === q);
  if (exact >= 0) return exact;
  const hits = chapters.map((c, i) => [i, c]).filter(([, c]) => fold(c.title).includes(q));
  if (hits.length === 1) return hits[0][0];
  const list = (hits.length ? hits : chapters.map((c, i) => [i, c])).slice(0, 20).map(([i, c]) => `${i}: ${c.title || '(sin título)'}`).join('; ');
  throw new ToolError(hits.length ? `«${arg}» casa con varios capítulos: ${list}.` : `Ningún capítulo se llama «${arg}». Hay: ${list}.`);
}

const BOOK_PROPS = {
  bookId: { type: 'string', description: 'Id del libro (de `list_books`).' },
  book: { type: 'string', description: 'O el título del libro (o parte).' },
};

const GET_TOC = {
  name: 'get_toc',
  title: 'Índice de un libro',
  description:
    'Los capítulos de un libro, con su índice y su tamaño en palabras: el paso previo a ' +
    '`read_chapter`. Solo para libros cuyo texto está en el sync.',
  capability: 'canReadText',
  inputSchema: { type: 'object', properties: { ...BOOK_PROPS }, additionalProperties: false },
  async run(source, args) {
    const { bookId, toc } = await tocOf(source, args);
    const chapters = toc.chapters.map((c, i) => ({ index: i, title: c.title || null, passages: c.passages, words: c.words }));
    return { source: source.kind, bookId, title: toc.title || null, words: chapters.reduce((n, c) => n + c.words, 0), chapters };
  },
};

const READ_CHAPTER = {
  name: 'read_chapter',
  title: 'Leer un capítulo',
  description:
    'El texto de un capítulo, por páginas de unas ' + PAGE_WORDS + ' palabras. Cada pasaje va con ' +
    'su ancla `[[aN]]`: úsala como `src` al crear tarjetas para enlazar al pasaje. Si queda más, ' +
    'la respuesta trae `nextOffset`: repite con `offset` para seguir.',
  capability: 'canReadText',
  inputSchema: {
    type: 'object',
    properties: {
      ...BOOK_PROPS,
      chapter: { type: ['integer', 'string'], description: 'Índice (de get_toc) o título del capítulo.' },
      offset: { type: 'integer', minimum: 0, description: 'Primer pasaje de la página (0 por defecto).' },
      maxWords: { type: 'integer', minimum: 200, maximum: PAGE_WORDS_MAX, description: 'Tamaño de la página en palabras.' },
    },
    required: ['chapter'],
    additionalProperties: false,
  },
  async run(source, args) {
    const { bookId, toc } = await tocOf(source, args);
    const ci = pickChapter(toc.chapters, args.chapter);
    const ch = toc.chapters[ci];
    const next = toc.chapters[ci + 1];
    const lines = chapterLines(await part(source, bookId, ch.part), ch.from, next && next.part === ch.part ? next.from : null);
    // Pasajes con el encabezado de sección que los precede, si lo hay.
    const passages = [];
    let heads = [];
    for (const l of lines) {
      if (l.startsWith('## ')) { heads.push(l); continue; }
      const m = LINE.exec(l);
      if (m) { passages.push({ line: [...heads, l].join('\n'), w: words(m[2]) }); heads = []; }
    }
    const offset = Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 0;
    const max = Number.isInteger(args.maxWords) ? Math.min(PAGE_WORDS_MAX, Math.max(200, args.maxWords)) : PAGE_WORDS;
    const page = [];
    let n = 0;
    for (let i = offset; i < passages.length; i++) {
      if (page.length && n + passages[i].w > max) break;
      page.push(passages[i].line);
      n += passages[i].w;
    }
    const end = offset + page.length;
    return {
      source: source.kind, bookId, chapter: ci, title: ch.title || null,
      passages: passages.length, offset, returned: page.length, words: n,
      nextOffset: end < passages.length ? end : null,
      text: page.join('\n'),
    };
  },
};

// BM25 sobre el fichero de búsqueda, sin trocearlo entero: cada término se localiza con
// indexOf (nativo) y solo se puntúan las líneas que casan. Longitud de línea en caracteres.
export function searchLines(text, query, { passages, avgChars }, limit) {
  const terms = [...new Set(foldSearch(query).split(' ').filter((w) => w.length > 1 && !STOP.has(w)))];
  if (!terms.length) throw new ToolError('«query» no tiene ninguna palabra que buscar (las muy comunes no cuentan).');
  const hits = new Map();   // inicio de línea → Map(término → veces)
  const df = new Map();
  let skipped = 0;
  for (const t of terms) {
    // Contar primero, barato (solo indexOf): si es una palabra de casi todas las líneas, fuera.
    let count = 0;
    for (let pos = text.indexOf(t); pos >= 0 && count <= MAX_HITS_PER_TERM; pos = text.indexOf(t, pos + t.length)) count++;
    if (count > MAX_HITS_PER_TERM) { skipped++; continue; }
    const lines = new Set();
    for (let pos = text.indexOf(t); pos >= 0; pos = text.indexOf(t, pos + t.length)) {
      const prev = text.charCodeAt(pos - 1);
      const next = text.charCodeAt(pos + t.length);
      if ((prev !== 32 && prev !== 9) || (next !== 32 && next !== 10)) continue;   // dentro de otra palabra
      const start = text.lastIndexOf('\n', pos) + 1;
      let m = hits.get(start);
      if (!m) hits.set(start, (m = new Map()));
      m.set(t, (m.get(t) || 0) + 1);
      lines.add(start);
    }
    df.set(t, lines.size);
  }
  if (skipped === terms.length) throw new ToolError('Esas palabras salen en casi todo el libro: busca algo más concreto.');
  const N = Math.max(1, passages);
  const avg = Math.max(1, avgChars);
  const k1 = 1.2;
  const b = 0.75;
  const scored = [];
  for (const [start, tf] of hits) {
    const end = text.indexOf('\n', start);
    const len = (end < 0 ? text.length : end) - start;
    let s = 0;
    for (const [t, f] of tf) {
      const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avg));
    }
    scored.push({ start, s });
  }
  scored.sort((x, y) => y.s - x.s);
  return scored.slice(0, limit).map(({ start, s }) => {
    const tab1 = text.indexOf('\t', start);
    const tab2 = text.indexOf('\t', tab1 + 1);
    return { id: text.slice(start, tab1), chapter: Number(text.slice(tab1 + 1, tab2)), score: Math.round(s * 100) / 100 };
  });
}

const SEARCH_BOOK = {
  name: 'search_book',
  title: 'Buscar en el texto de un libro',
  description:
    'Los pasajes de un libro que mejor responden a una búsqueda (palabras clave, no frases ' +
    'exactas), con su ancla `aN` y su capítulo. Para leer alrededor, `read_chapter`.',
  capability: 'canReadText',
  inputSchema: {
    type: 'object',
    properties: {
      ...BOOK_PROPS,
      query: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: SEARCH_MAX },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async run(source, args) {
    if (typeof args.query !== 'string' || !args.query.trim()) throw new ToolError('Falta «query».');
    const { bookId, toc } = await tocOf(source, args);
    const limit = Number.isInteger(args.limit) ? Math.min(SEARCH_MAX, Math.max(1, args.limit)) : SEARCH_DEFAULT;
    const text = await source.bookTextFile(bookId, 'search.txt');
    if (text === null) throw new ToolError(NO_TEXT);
    const found = searchLines(text, args.query, toc.search || {}, limit);
    // El texto original de cada resultado, de su trozo (uno por trozo, aunque salgan varios).
    const parts = new Map();
    const results = [];
    for (const r of found) {
      const ch = toc.chapters[r.chapter];
      if (!ch) continue;
      if (!parts.has(ch.part)) parts.set(ch.part, await part(source, bookId, ch.part));
      const p = parts.get(ch.part);
      const at = p.indexOf(`[[${r.id}]]`);
      const end = at < 0 ? -1 : p.indexOf('\n', at);
      const text = at < 0 ? '' : p.slice(at + r.id.length + 4, end < 0 ? undefined : end).trim();
      results.push({ id: r.id, chapter: r.chapter, chapterTitle: ch.title || null, score: r.score, text });
    }
    return { source: source.kind, bookId, query: args.query, results };
  },
};

export const TEXT_TOOLS = [GET_TOC, READ_CHAPTER, SEARCH_BOOK];
