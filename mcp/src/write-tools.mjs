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

const MAX_CARDS = 100;
const MAX_TEXT = 4000;
const CARD_TYPES = ['basic', 'cloze'];
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
  if (!CARD_TYPES.includes(card.type)) throw new ToolError(label + ': «type» tiene que ser basic o cloze.');
  if (!card.front) throw new ToolError(label + ': el anverso («front») no puede ir vacío.');
  if (card.type === 'cloze' && !CLOZE_HOLE.test(card.front)) {
    throw new ToolError(label + ': una tarjeta cloze necesita al menos un hueco {{c1::…}} en «front».');
  }
  const norm = normalizeText(card.front);
  if (fronts.has(norm)) throw new ToolError(label + ': ya hay una tarjeta con ese anverso en el mazo.');
  fronts.add(norm);
}

const view = (c) => ({ uid: c.uid, type: c.type || 'basic', front: c.front || '', back: c.back || '', chapter: c.chapter || null, suspended: !!c.suspended });

function newCard(input, i, deck, now, by) {
  if (!input || typeof input !== 'object') throw new ToolError('Tarjeta ' + (i + 1) + ': tiene que ser un objeto.');
  return {
    uid: crypto.randomUUID(),
    type: input.type || (deck.cardType === 'cloze' ? 'cloze' : 'basic'),
    front: text(input.front, 'front', { required: true }),
    back: text(input.back, 'back') || '',
    chapter: text(input.chapter, 'chapter') ?? (deck.scope || ''),
    src: '',
    updatedAt: now,
    textAt: now,
    editedBy: by,
  };
}

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
    type: { type: 'string', enum: CARD_TYPES, description: 'basic (pregunta/respuesta) o cloze (huecos {{c1::…}} en front).' },
    front: { type: 'string' },
    back: { type: 'string' },
    chapter: { type: 'string', description: 'Capítulo de origen (por defecto, el del mazo).' },
  },
  required: ['front'],
  additionalProperties: false,
};

const ADD_CARDS = {
  name: 'add_cards',
  title: 'Añadir tarjetas a un mazo',
  description:
    'Añade tarjetas (basic o cloze) a un mazo existente. Cada una entra como NUEVA para el ' +
    'repaso. Se rechazan las que repiten un anverso del mazo y las cloze sin hueco. Hasta ' +
    MAX_CARDS + ' por llamada. Con `dry_run` solo enseña lo que añadiría.',
  capability: 'canWrite',
  inputSchema: {
    type: 'object',
    properties: { ...BOOK_PROPS, ...DECK_PROPS, cards: { type: 'array', items: NEW_CARD_SCHEMA }, ...DRY_RUN },
    required: ['deckUid', 'cards'],
    additionalProperties: false,
  },
  run: (source, args) => onBook(source, args, (book, now) => {
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
  }),
};

const UPDATE_CARDS = {
  name: 'update_cards',
  title: 'Editar tarjetas',
  description:
    'Cambia anverso, reverso, tipo, capítulo o suspensión de tarjetas de un mazo, por su `uid` ' +
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
      if (typeof ch.suspended === 'boolean') next.suspended = ch.suspended;
      if (!next.type) next.type = 'basic';
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
    'tarjetas. Devuelve su `deckUid`. Con `dry_run`, solo lo enseña.',
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
  run: (source, args) => onBook(source, args, (book, now, bookId) => {
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
  }),
};

export const WRITE_TOOLS = [ADD_CARDS, UPDATE_CARDS, DELETE_CARDS, CREATE_DECK];
