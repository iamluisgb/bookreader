// artifact-tools.mjs — un agente CREA artefactos del Studio: mapa mental, infografía y resumen
// (y borra los que sobren). Con el permiso de escritura, como las tarjetas (write-tools.mjs).
//
// Siempre se CREA uno nuevo, nunca se edita: el Studio guarda el historial de cada tipo y lo
// lista entero, así que «mejorar» un mapa es crear otro al lado y borrar el viejo si sobra. Un
// artefacto nuevo tiene clave propia (`<libro>:<tipo>:<uuid>`): no puede chocar con nada de lo
// que hagan los dispositivos.
//
// La forma la decide app/js/ai/artifact-schema.js, el mismo módulo con el que la app los
// genera: los renderers no re-normalizan lo guardado, así que aquí se aplican los mismos
// techos. Las citas (`src`, anclas aN) solo se guardan si existen en el texto del libro que
// subió la app (text-tools.mjs); las que no, se quitan y se cuentan.

import { ToolError } from './errors.mjs';
import { resolveBookArg } from './book-arg.mjs';
import { buildMindmapTree, normalizeInfographic, composeSummary } from '../../app/js/ai/artifact-schema.js';

// La versión de segmentación de la app (app/js/ai/db.js · SEG_VERSION). getArtifacts esconde los
// artefactos de otra versión (sus citas ya no casarían). Un test comprueba que coincide.
export const SEG_VERSION = 6;
const KINDS = ['mindmap', 'infographic', 'summary'];

const agentOf = (source) => 'agent:' + (source.agentName || 'MCP');

// ¿Qué anclas existen? Del fichero de búsqueda del texto (una línea por pasaje: `aN\t…`).
// Sin texto en el sync no hay forma de saberlo: ninguna cita se da por buena.
async function anchorCheck(source, bookId) {
  let text = null;
  try {
    if (source.bookTextFile) text = await source.bookTextFile(bookId, 'search.txt');
  } catch {
    text = null;
  }
  return (id) => !!text && (text.startsWith(id + '\t') || text.includes('\n' + id + '\t'));
}

async function create(source, args, kind, build) {
  const bookId = await resolveBookArg(source, args);
  const titles = await source.titles();
  const scopeName = (typeof args.scope === 'string' && args.scope.trim()) || titles[bookId] || '';
  const exists = await anchorCheck(source, bookId);
  let dropped = 0;
  const keepSrc = (s) => {
    const id = typeof s === 'string' ? (s.match(/a\d+/) || [])[0] : null;
    if (!id) return '';
    if (exists(id)) return id;
    dropped++;
    return '';
  };
  const result = build({ scopeName, keepSrc });
  const dryRun = args.dry_run === true;
  const out = await source.writeBook(bookId, (raw) => {
    const book = raw && typeof raw === 'object' ? raw : { local: {}, convos: [], messages: [], notes: [], ratings: [], artifacts: [], decks: [], attempts: [], meta: null };
    if (!Array.isArray(book.artifacts)) book.artifacts = [];
    const now = Date.now();
    const id = crypto.randomUUID();
    const rec = {
      key: `${bookId}:${kind}:${id}`, id, uid: crypto.randomUUID(), bookId, kind, result,
      params: { scopeName, by: agentOf(source) }, segVersion: SEG_VERSION, createdAt: now, updatedAt: now,
    };
    book.artifacts.push(rec);
    return { next: book, result: { key: rec.key } };
  }, { dryRun });
  return {
    source: source.kind, bookId, applied: !dryRun, kind, scopeName, key: dryRun ? null : out.key,
    citationsDropped: dropped, result,
  };
}

const BOOK_PROPS = {
  bookId: { type: 'string', description: 'Id del libro (de `list_books`).' },
  book: { type: 'string', description: 'O el título del libro (o parte).' },
  scope: { type: 'string', description: 'Capítulo o ámbito que cubre (por defecto, el libro).' },
  dry_run: { type: 'boolean', description: 'true: devuelve el artefacto ya normalizado sin guardarlo.' },
};
const SRC = { type: 'string', description: 'Ancla del pasaje (aN, de read_chapter/search_book).' };

const NODE = {
  type: 'object',
  properties: { label: { type: 'string' }, src: SRC, children: { type: 'array', items: { type: 'object' } } },
  required: ['label'],
};

const CREATE_MINDMAP = {
  name: 'create_mindmap',
  title: 'Crear un mapa mental',
  description:
    'Crea un mapa mental en el Studio del libro: un título y de 2 a 8 ramas, cada una con hasta 6 ' +
    'conceptos (y dos niveles más por debajo). Las etiquetas largas se recortan (el texto entero ' +
    'queda en el detalle del nodo). Cita pasajes con `src` (anclas de read_chapter/search_book). ' +
    'Se añade al historial: no sustituye al que hubiera.',
  capability: 'canWrite',
  inputSchema: {
    type: 'object',
    properties: {
      ...BOOK_PROPS,
      title: { type: 'string' },
      branches: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, children: { type: 'array', items: NODE } }, required: ['label', 'children'] } },
    },
    required: ['branches'],
    additionalProperties: false,
  },
  run: (source, args) => create(source, args, 'mindmap', ({ scopeName, keepSrc }) => {
    const withSrc = (n) => ({ ...n, src: keepSrc(n && n.src), children: Array.isArray(n && n.children) ? n.children.map(withSrc) : undefined });
    const tree = buildMindmapTree({
      title: args.title,
      branches: (Array.isArray(args.branches) ? args.branches : []).map((b) => ({ ...b, children: (b && Array.isArray(b.children) ? b.children : []).map(withSrc) })),
    }, scopeName);
    if (!tree) throw new ToolError('Un mapa necesita al menos 2 ramas con algún concepto dentro.');
    return tree;
  }),
};

const CREATE_INFOGRAPHIC = {
  name: 'create_infographic',
  title: 'Crear una infografía',
  description:
    'Crea una infografía (póster) del libro con la plantilla de la app: `thesis`, hasta 8 `ideas` ' +
    '({head, body, src}), hasta 3 `panels` ({kind: flow|cols|rows, title, items}: flow/cols ' +
    'items {head, sub?, body}, rows items {tag, body}), hasta 2 `aside` ({label, body}) y una ' +
    '`quote` {text, attribution}. Rótulos ≤48 caracteres, cuerpos ≤170: lo que pase se recorta.',
  capability: 'canWrite',
  inputSchema: {
    type: 'object',
    properties: {
      ...BOOK_PROPS,
      kicker: { type: 'string' },
      thesis: { type: 'string' },
      ideasTitle: { type: 'string' },
      ideas: { type: 'array', items: { type: 'object', properties: { head: { type: 'string' }, body: { type: 'string' }, src: SRC }, required: ['head', 'body'] } },
      panels: { type: 'array', items: { type: 'object' } },
      aside: { type: 'array', items: { type: 'object' } },
      quote: { type: 'object', properties: { text: { type: 'string' }, attribution: { type: 'string' } } },
    },
    required: ['thesis'],
    additionalProperties: false,
  },
  run: (source, args) => create(source, args, 'infographic', ({ keepSrc }) => {
    const ids = new Set();
    const mark = (it) => {
      const s = keepSrc(it && it.src);
      if (s) ids.add(s);
      return { ...it, src: s };
    };
    const raw = {
      kicker: args.kicker, thesis: args.thesis, ideasTitle: args.ideasTitle, aside: args.aside, quote: args.quote,
      ideas: (Array.isArray(args.ideas) ? args.ideas : []).map(mark),
      panels: (Array.isArray(args.panels) ? args.panels : []).map((p) => ({ ...p, items: (p && Array.isArray(p.items) ? p.items : []).map(mark) })),
    };
    const out = normalizeInfographic(raw, ids);
    if (!out.ideas.length && !out.panels.length) throw new ToolError('Una infografía necesita al menos una idea ({head, body}) o un panel con elementos.');
    delete out.invalid;
    return out;
  }),
};

const CREATE_SUMMARY = {
  name: 'create_summary',
  title: 'Crear un resumen',
  description:
    'Crea un resumen en el Studio con el esqueleto de la app: `tldr` (un párrafo), `ideas` ' +
    'principales, `sections` por capítulo ({title, bullets: [{text, src}]}) y `takeaways`. Cada ' +
    'viñeta con `src` enlaza al pasaje.',
  capability: 'canWrite',
  inputSchema: {
    type: 'object',
    properties: {
      ...BOOK_PROPS,
      tldr: { type: 'string' },
      ideas: { type: 'array', items: { type: ['string', 'object'] } },
      sections: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, bullets: { type: 'array', items: { type: ['string', 'object'] } } }, required: ['title', 'bullets'] } },
      takeaways: { type: 'array', items: { type: ['string', 'object'] } },
    },
    additionalProperties: false,
  },
  run: (source, args) => create(source, args, 'summary', ({ scopeName, keepSrc }) => {
    const fix = (b) => (b && typeof b === 'object' ? { ...b, src: keepSrc(b.src) } : b);
    const { markdown, empty } = composeSummary({
      tldr: args.tldr,
      ideas: (args.ideas || []).map(fix),
      sections: (args.sections || []).map((s) => ({ ...s, bullets: (s && Array.isArray(s.bullets) ? s.bullets : []).map(fix) })),
      takeaways: (args.takeaways || []).map(fix),
    }, scopeName);
    if (empty) throw new ToolError('Un resumen necesita al menos el TL;DR, alguna idea o una sección con viñetas.');
    return markdown;
  }),
};

const DELETE_ARTIFACT = {
  name: 'delete_artifact',
  title: 'Borrar un artefacto',
  description:
    'Borra un mapa mental, infografía o resumen del Studio por su `key` (de `list_artifacts`). El ' +
    'borrado llega a todos los dispositivos.',
  capability: 'canWrite',
  inputSchema: {
    type: 'object',
    properties: { bookId: BOOK_PROPS.bookId, book: BOOK_PROPS.book, key: { type: 'string' }, dry_run: BOOK_PROPS.dry_run },
    required: ['key'],
    additionalProperties: false,
  },
  async run(source, args) {
    const bookId = await resolveBookArg(source, args);
    const dryRun = args.dry_run === true;
    const out = await source.writeBook(bookId, (raw) => {
      const list = raw && Array.isArray(raw.artifacts) ? raw.artifacts : [];
      const i = list.findIndex((a) => a && a.key === args.key && !a.deleted);
      if (i < 0) throw new ToolError('No hay ningún artefacto con esa key en el libro (mira list_artifacts).');
      if (!KINDS.includes(list[i].kind)) throw new ToolError('Desde aquí solo se borran mapas mentales, infografías y resúmenes.');
      const now = Date.now();
      const gone = { key: list[i].key, kind: list[i].kind, scopeName: (list[i].params && list[i].params.scopeName) || null };
      list[i] = { ...list[i], result: null, deleted: true, deletedAt: now, updatedAt: now };
      return { next: raw, result: gone };
    }, { dryRun });
    return { source: source.kind, bookId, applied: !dryRun, deleted: out };
  },
};

export const ARTIFACT_TOOLS = [CREATE_MINDMAP, CREATE_INFOGRAPHIC, CREATE_SUMMARY, DELETE_ARTIFACT];
