// write-tools.mjs — lo que un agente puede CAMBIAR en la biblioteca: tarjetas y mazos (y, más
// adelante, artefactos del Studio). Solo existen con una fuente que sabe escribir (`writeBook`:
// el MCP del Worker del sync) y un token con permiso de escritura (`canWrite`). En el MCP local,
// ni se anuncian.
//
// Reglas, las mismas que sigue la app al escribir una tarjeta (db.js · updateDeck/stampCards),
// porque lo que se escribe aquí lo fusionan después los dispositivos:
//   - cada tarjeta que cambia lleva `updatedAt` y `textAt` nuevos (el merge funde texto y repaso
//     por separado: reescribir una tarjeta NO toca su repaso);
//   - borrar es dejar un tombstone (`deleted`), nunca quitarla del array;
//   - los mazos se identifican por `uid`: el `id` numérico es de cada dispositivo;
//   - cada cambio deja `editedBy` («agent:<nombre del token>») y la versión anterior del
//     fichero queda en el historial (Ajustes → Datos → Historial de versiones).
//
// Todas aceptan `dry_run`: devuelven el antes y el después sin escribir nada.

import { ToolError } from './errors.mjs';
import { resolveBookArg, fold } from './book-arg.mjs';
import { chapterText } from './text-tools.mjs';
import { validateMcqItem, MCQ_LIMITS } from '../../app/js/ai/widgets/mcq.js';
import { verifyQuotes } from '../../app/js/ai/widgets/core.js';

const MAX_CARDS = 100;
const MAX_TEXT = 4000;
const CARD_TYPES = ['basic', 'cloze'];
// Las que se pueden CREAR: también la pregunta con opciones de P43 F4 (widgets/mcq.js). No se
// editan desde aquí (update_cards), como las visuales: para cambiar una, se borra y se crea.
const NEW_TYPES = [...CARD_TYPES, 'mcq'];
const SRC = /^a\d+$/;   // ancla de pasaje, como la cita de los widgets (core.js · citeErrors)
const OPTION_IDS = ['a', 'b', 'c', 'd'];
const CLOZE_HOLE = /\{\{c\d+::[\s\S]*?\}\}/;   // como deck-manager.js · CLOZE_HOLE
const DECK_TYPES = ['basic', 'cloze', 'mixed'];

// Como figures.js · normalizeText: tildes, mayúsculas y puntuación fuera (para los duplicados).
function normalizeText(s) {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

const emptyBook = () => ({ local: {}, convos: [], messages: [], notes: [], ratings: [], artifacts: [], decks: [], attempts: [], meta: null });
const live = (xs) => (Array.isArray(xs) ? xs : []).filter((x) => x && !x.deleted);
const agentOf = (source) => 'agent:' + (source.agentName || 'MCP');
const dryRunOf = (args) => args.dry_run === true;

function text(v, name, { required = false } = {}) {
  if (v === undefined || v === null) {
    if (required) throw new ToolError('Falta «' + name + '».');
    return undefined;
  }
  if (typeof v !== 'string') throw new ToolError('«' + name + '» tiene que ser texto.');
  const s = v.trim();
  if (required && !s) throw new ToolError('«' + name + '» no puede ir vacío.');
  if (s.length > MAX_TEXT) throw new ToolError('«' + name + '» pasa de ' + MAX_TEXT + ' caracteres.');
  return s;
}

function list(args, name) {
  const v = args[name];
  if (!Array.isArray(v) || !v.length) throw new ToolError('«' + name + '» tiene que ser una lista no vacía.');
  if (v.length > MAX_CARDS) throw new ToolError('Como mucho ' + MAX_CARDS + ' elementos por llamada en «' + name + '».');
  return v;
}

// El mazo por `deckUid` (estable) o, por compatibilidad, `deckId` (el número de list_decks).
function findDeck(book, args) {
  const uid = typeof args.deckUid === 'string' ? args.deckUid.trim() : '';
  const id = args.deckId !== undefined && args.deckId !== null ? String(args.deckId) : '';
  if (!uid && !id) throw new ToolError('Falta el mazo: pasa «deckUid» (sale en list_decks).');
  const decks = live(book.decks);
  const deck = uid ? decks.find((d) => d.uid === uid) : decks.find((d) => String(d.id) === id);
  if (!deck) {
    const hay = decks.map((d) => `${d.uid} («${d.name || ''}»)`).join(', ');
    throw new ToolError('No hay ese mazo en el libro.' + (hay ? ' Mazos: ' + hay + '.' : ' El libro no tiene mazos.'));
  }
  return deck;
}

// Una tarjeta nueva o un cambio de contenido: se valida como en la app (deck-manager.js ·
// validateCardInput) para que el agente no pueda guardar nada que la app rechazaría.
function checkCard(card, fronts, label) {
  if (!NEW_TYPES.includes(card.type)) throw new ToolError(label + ': «type» tiene que ser basic, cloze o mcq.');
  if (!card.front) throw new ToolError(label + ': el anverso («front») no puede ir vacío.');
  if (card.type === 'cloze' && !CLOZE_HOLE.test(card.front)) {
    throw new ToolError(label + ': una tarjeta cloze necesita al menos un hueco {{c1::…}} en «front».');
  }
  const norm = normalizeText(card.front);
  if (fronts.has(norm)) throw new ToolError(label + ': ya hay una tarjeta con ese anverso en el mazo.');
  fronts.add(norm);
}

const view = (c) => ({
  uid: c.uid, type: c.type || 'basic', front: c.front || '', back: c.back || '', chapter: c.chapter || null,
  ...(c.src ? { src: c.src } : {}),
  ...(c.type === 'mcq' ? { options: (c.options || []).length } : {}),
  suspended: !!c.suspended,
});

// Una pregunta con opciones, con la forma que guarda la app (widgets/practice.js · mcqCard) y
// validada con el mismo código (validateMcqItem). La cita se comprueba contra el texto del
// capítulo en `prepareCards`, antes de escribir.
function mcqFields(input, label) {
  const opts = Array.isArray(input.options) ? input.options : [];
  const item = {
    id: 'q',
    stem: typeof input.front === 'string' ? input.front.trim() : '',
    options: opts.map((o, i) => ({
      id: OPTION_IDS[i] || String(i),
      text: o && typeof o.text === 'string' ? o.text.trim() : o && o.text,
      correct: o && o.correct,
      feedback: o && typeof o.feedback === 'string' ? o.feedback.trim() : o && o.feedback,
    })),
    cite: { quote: typeof input.quote === 'string' ? input.quote.trim() : input.quote, ...(input.src ? { src: input.src } : {}) },
  };
  const errors = validateMcqItem(item, 'pregunta');
  if (errors.length) throw new ToolError(label + ': ' + errors.join('; ') + '.');
  const right = item.options.find((o) => o.correct);
  return {
    back: [right.text, right.feedback].filter(Boolean).join('\n\n'),
    options: item.options,
    quote: item.cite.quote,
  };
}

function newCard(input, i, deck, now, by) {
  if (!input || typeof input !== 'object') throw new ToolError('Tarjeta ' + (i + 1) + ': tiene que ser un objeto.');
  const type = input.type || (deck.cardType === 'cloze' ? 'cloze' : 'basic');
  const card = {
    uid: crypto.randomUUID(),
    type,
    front: text(input.front, 'front', { required: true }),
    back: text(input.back, 'back') || '',
    chapter: text(input.chapter, 'chapter') ?? (deck.scope || ''),
    src: text(input.src, 'src') || '',
    updatedAt: now,
    textAt: now,
    editedBy: by,
  };
  if (card.src && !SRC.test(card.src)) throw new ToolError('Tarjeta ' + (i + 1) + ': «src» es un ancla de pasaje como a42 (sale en read_chapter y search_book).');
  if (type === 'mcq') Object.assign(card, mcqFields(input, 'Tarjeta ' + (i + 1)));
  else if (input.options !== undefined || input.quote !== undefined) {
    throw new ToolError('Tarjeta ' + (i + 1) + ': «options» y «quote» solo van en una tarjeta mcq.');
  }
  return card;
}

// Lo que se comprueba contra el TEXTO del libro antes de escribir (es asíncrono y onBook no):
// la cita de cada pregunta con opciones tiene que estar en su capítulo, y el `src` de cualquier
// tarjeta, ser un pasaje de ese capítulo. Sin texto en el sync, una pregunta con opciones no se
// acepta (la cita es su garantía, ADR-057) y un `src` se acepta solo por su forma.
async function prepareCards(source, args, scopeOf) {
  const cards = Array.isArray(args.cards) ? args.cards : [];
  if (!cards.some((c) => c && (c.type === 'mcq' || c.src))) return;
  const bookId = await resolveBookArg(source, args);
  const scope = await scopeOf(bookId);
  const cache = new Map();
  const textOf = async (ch) => {
    if (!cache.has(ch)) cache.set(ch, ch ? await chapterText(source, bookId, ch) : null);
    return cache.get(ch);
  };
  for (const [i, c] of cards.entries()) {
    if (!c || typeof c !== 'object' || !(c.type === 'mcq' || c.src)) continue;
    const label = 'Tarjeta ' + (i + 1);
    const ch = (typeof c.chapter === 'string' && c.chapter.trim()) || scope || '';
    const t = await textOf(ch);
    if (c.type === 'mcq') {
      if (!t) {
        throw new ToolError(label + ': una pregunta con opciones necesita el texto del capítulo para comprobar la cita ' +
          '(permiso «text» y el libro troceado en el sync) y un capítulo que exista («chapter» o el ámbito del mazo).');
      }
      if (typeof c.quote === 'string' && verifyQuotes([{ where: label, cite: { quote: c.quote } }], t.text).length) {
        throw new ToolError(label + ': la cita («quote») no está en «' + t.title + '». Tiene que ser literal, copiada de read_chapter o search_book.');
      }
    }
    if (c.src && t && SRC.test(String(c.src)) && !t.anchors.has(String(c.src))) {
      throw new ToolError(label + ': el pasaje «' + c.src + '» no es de «' + t.title + '».');
    }
  }
}

const scopeOfDeck = (source, args) => async (bookId) => {
  const deck = (await source.decks(bookId) || []).find((d) => d && d.uid === args.deckUid);
  return deck ? deck.scope || '' : '';
};

// Cambiar el fichero del libro con `fn(book, now, bookId)` → { result, changed }.
async function onBook(source, args, fn) {
  const bookId = await resolveBookArg(source, args);
  const dryRun = dryRunOf(args);
  const result = await source.writeBook(bookId, (raw) => {
    const book = raw && typeof raw === 'object' ? raw : emptyBook();
    if (!Array.isArray(book.decks)) book.decks = [];
    const out = fn(book, Date.now(), bookId);
    return { next: out.changed ? book : null, result: out.result };
  }, { dryRun });
  return { source: source.kind, bookId, applied: !dryRun, ...result };
}

const BOOK_PROPS = {
  bookId: { type: 'string', description: 'Id del libro (de `list_books`).' },
  book: { type: 'string', description: 'O el título del libro (o parte).' },
};
const DECK_PROPS = {
  deckUid: { type: 'string', description: 'Uid del mazo (de `list_decks`).' },
};
const DRY_RUN = { dry_run: { type: 'boolean', description: 'true: enseña el antes y el después sin escribir nada.' } };
const NEW_CARD_SCHEMA = {
  type: 'object',
  properties: {
    type: {
      type: 'string', enum: NEW_TYPES,
      description: 'basic (pregunta/respuesta), cloze (huecos {{c1::…}} en front) o mcq (pregunta con opciones: ' +
        '`front` el enunciado, `options` y `quote`; sin `back`, que sale de la correcta).',
    },
    front: { type: 'string' },
    back: { type: 'string' },
    chapter: { type: 'string', description: 'Capítulo de origen (por defecto, el del mazo).' },
    src: { type: 'string', description: 'Ancla del pasaje (aN, de read_chapter/search_book): «Ver el pasaje» en el repaso.' },
    options: {
      type: 'array', minItems: MCQ_LIMITS.options[0], maxItems: MCQ_LIMITS.options[1],
      description: 'Solo mcq: ' + MCQ_LIMITS.options[0] + '–' + MCQ_LIMITS.options[1] + ' opciones, exactamente una correcta. ' +
        'Cada una con su `feedback`: por qué es la correcta o en qué se equivoca quien la elige.',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, correct: { type: 'boolean' }, feedback: { type: 'string' } },
        required: ['text', 'correct', 'feedback'],
        additionalProperties: false,
      },
    },
    quote: { type: 'string', description: 'Solo mcq: cita LITERAL del capítulo que sostiene la correcta (se comprueba contra el texto).' },
  },
  required: ['front'],
  additionalProperties: false,
};

const ADD_CARDS = {
  name: 'add_cards',
  title: 'Añadir tarjetas a un mazo',
  description:
    'Añade tarjetas (basic, cloze o mcq) a un mazo existente. Cada una entra como NUEVA para el ' +
    'repaso. Se rechazan las que repiten un anverso del mazo, las cloze sin hueco y las mcq cuya ' +
    'cita no está en el capítulo. Con `src` (ancla de read_chapter) la tarjeta enlaza a su pasaje. ' +
    'Hasta ' + MAX_CARDS + ' por llamada. Con `dry_run` solo enseña lo que añadiría.',
  capability: 'canWrite',
  inputSchema: {
    type: 'object',
    properties: { ...BOOK_PROPS, ...DECK_PROPS, cards: { type: 'array', items: NEW_CARD_SCHEMA }, ...DRY_RUN },
    required: ['deckUid', 'cards'],
    additionalProperties: false,
  },
  run: async (source, args) => (await prepareCards(source, args, scopeOfDeck(source, args)), onBook(source, args, (book, now) => {
    const deck = findDeck(book, args);
    const fronts = new Set(live(deck.cards).map((c) => normalizeText(c.front)));
    const added = list(args, 'cards').map((input, i) => {
      const c = newCard(input, i, deck, now, agentOf(source));
      checkCard(c, fronts, 'Tarjeta ' + (i + 1));
      return c;
    });
    deck.cards = (deck.cards || []).concat(added);
    deck.updatedAt = now;
    return { changed: true, result: { deckUid: deck.uid, added: added.map(view) } };
  })),
};

const UPDATE_CARDS = {
  name: 'update_cards',
  title: 'Editar tarjetas',
  description:
    'Cambia anverso, reverso, tipo, capítulo, pasaje (`src`) o suspensión de tarjetas de un mazo, por su `uid` ' +
    '(de `get_deck`). El repaso de cada tarjeta se CONSERVA. Para dividir una tarjeta en dos: ' +
    'edítala aquí y añade la otra con `add_cards`. Con `dry_run`, el antes y el después.',
  capability: 'canWrite',
  inputSchema: {
    type: 'object',
    properties: {
      ...BOOK_PROPS, ...DECK_PROPS,
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            uid: { type: 'string' },
            type: { type: 'string', enum: CARD_TYPES },
            front: { type: 'string' },
            back: { type: 'string' },
            chapter: { type: 'string' },
            src: { type: 'string', description: 'Ancla del pasaje (aN); vacío lo quita.' },
            suspended: { type: 'boolean' },
          },
          required: ['uid'],
          additionalProperties: false,
        },
      },
      ...DRY_RUN,
    },
    required: ['deckUid', 'changes'],
    additionalProperties: false,
  },
  run: (source, args) => onBook(source, args, (book, now) => {
    const deck = findDeck(book, args);
    const byUid = new Map(live(deck.cards).map((c) => [c.uid, c]));
    const changes = list(args, 'changes');
    const touched = new Set(changes.map((ch) => ch && ch.uid));
    const fronts = new Set(live(deck.cards).filter((c) => !touched.has(c.uid)).map((c) => normalizeText(c.front)));
    const updated = [];
    for (const [i, ch] of changes.entries()) {
      const cur = ch && byUid.get(ch.uid);
      if (!cur) throw new ToolError('Cambio ' + (i + 1) + ': no hay ninguna tarjeta viva con uid «' + (ch && ch.uid) + '» en el mazo.');
      if (!CARD_TYPES.includes(cur.type || 'basic')) throw new ToolError('Cambio ' + (i + 1) + ': las tarjetas visuales (' + cur.type + ') no se editan desde aquí.');
      const next = { ...cur };
      for (const k of ['type', 'front', 'back', 'chapter']) {
        const v = text(ch[k], k);
        if (v !== undefined) next[k] = v;
      }
      if (typeof ch.src === 'string') {
        const src = ch.src.trim();
        if (src && !SRC.test(src)) throw new ToolError('Cambio ' + (i + 1) + ': «src» es un ancla de pasaje como a42.');
        next.src = src;
      }
      if (typeof ch.suspended === 'boolean') next.suspended = ch.suspended;
      if (!next.type) next.type = 'basic';
      if (!CARD_TYPES.includes(next.type)) throw new ToolError('Cambio ' + (i + 1) + ': «type» tiene que ser basic o cloze.');
      checkCard(next, fronts, 'Cambio ' + (i + 1));
      const before = view(cur);
      const after = view(next);
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      Object.assign(next, { updatedAt: now, textAt: now, editedBy: agentOf(source) });
      deck.cards[deck.cards.indexOf(cur)] = next;
      updated.push({ uid: cur.uid, before, after });
    }
    if (updated.length) deck.updatedAt = now;
    return { changed: updated.length > 0, result: { deckUid: deck.uid, updated } };
  }),
};

const DELETE_CARDS = {
  name: 'delete_cards',
  title: 'Borrar tarjetas',
  description:
    'Borra tarjetas de un mazo por su `uid`, con su repaso. El borrado llega a todos los ' +
    'dispositivos. Para apartarla sin perder el repaso, mejor `update_cards` con suspended=true.',
  capability: 'canWrite',
  inputSchema: {
    type: 'object',
    properties: { ...BOOK_PROPS, ...DECK_PROPS, uids: { type: 'array', items: { type: 'string' } }, ...DRY_RUN },
    required: ['deckUid', 'uids'],
    additionalProperties: false,
  },
  run: (source, args) => onBook(source, args, (book, now) => {
    const deck = findDeck(book, args);
    const deleted = [];
    for (const uid of list(args, 'uids')) {
      const i = (deck.cards || []).findIndex((c) => c && c.uid === uid && !c.deleted);
      if (i < 0) throw new ToolError('No hay ninguna tarjeta viva con uid «' + uid + '» en el mazo.');
      deleted.push(view(deck.cards[i]));
      deck.cards[i] = { ...deck.cards[i], front: '', back: '', deleted: true, deletedAt: now, updatedAt: now, textAt: now, editedBy: agentOf(source) };
    }
    deck.updatedAt = now;
    return { changed: true, result: { deckUid: deck.uid, deleted } };
  }),
};

const CREATE_DECK = {
  name: 'create_deck',
  title: 'Crear un mazo',
  description:
    'Crea un mazo para un libro (o un capítulo, con `scope`), opcionalmente con sus primeras ' +
    'tarjetas (las mismas reglas que add_cards, mcq incluidas). Devuelve su `deckUid`. Con `dry_run`, solo lo enseña.',
  capability: 'canWrite',
  inputSchema: {
    type: 'object',
    properties: {
      ...BOOK_PROPS,
      name: { type: 'string', description: 'Nombre del mazo.' },
      scope: { type: 'string', description: 'Capítulo o ámbito (vacío = el libro entero).' },
      cardType: { type: 'string', enum: DECK_TYPES },
      cards: { type: 'array', items: NEW_CARD_SCHEMA },
      ...DRY_RUN,
    },
    required: ['name'],
    additionalProperties: false,
  },
  run: async (source, args) => (await prepareCards(source, args, async () => (typeof args.scope === 'string' ? args.scope.trim() : '')), onBook(source, args, (book, now, bookId) => {
    const name = text(args.name, 'name', { required: true });
    const scope = text(args.scope, 'scope') || '';
    const cardType = args.cardType === undefined ? 'mixed' : args.cardType;
    if (!DECK_TYPES.includes(cardType)) throw new ToolError('«cardType» tiene que ser basic, cloze o mixed.');
    if (live(book.decks).some((d) => fold(d.name || '') === fold(name))) throw new ToolError('Ya hay un mazo con ese nombre en el libro.');
    const deck = { uid: crypto.randomUUID(), bookId, name, scope, cardType, cards: [], exercises: [], createdAt: now, updatedAt: now, editedBy: agentOf(source) };
    const fronts = new Set();
    if (args.cards !== undefined) {
      deck.cards = list(args, 'cards').map((input, i) => {
        const c = newCard(input, i, deck, now, agentOf(source));
        checkCard(c, fronts, 'Tarjeta ' + (i + 1));
        return c;
      });
    }
    book.decks.push(deck);
    return { changed: true, result: { deckUid: deck.uid, name, scope, cardType, added: deck.cards.map(view) } };
  })),
};

export const WRITE_TOOLS = [ADD_CARDS, UPDATE_CARDS, DELETE_CARDS, CREATE_DECK];
