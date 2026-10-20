// library-tools.mjs — un agente ORGANIZA la biblioteca: estanterías (normales, anidadas con «/»
// e inteligentes) y, de cada libro, sus estanterías, su estado y su título/autor. Escribe en
// `library.json`, el catálogo que sincronizan los dispositivos.
//
// Con el permiso «Organizar mi biblioteca» (`canOrganize`), aparte del de escritura: mover 300
// libros es más delicado que añadir tarjetas a un mazo. `list_shelves` es de lectura.
//
// Reglas, las de la app al hacer lo mismo (library/store.js, library/shelves.js), porque lo que
// se escribe aquí lo funden después los dispositivos (sync/library-sync.js · STAMPED):
//   - cada libro tocado lleva `updatedAt` nuevo y el sello de su grupo: `shelvesAt` (estanterías),
//     `statusAt` (estado puesto a mano) o `metaAt` (título/autor). Con eso, un pase de página en
//     otro dispositivo que aún no bajó el cambio no lo revierte;
//   - una estantería borrada es un tombstone, y sale de los libros y de las reglas que la citan;
//   - renombrar NUNCA cambia el id (los enlaces compartidos lo usan).
// Cada cambio guarda su deshacer (los valores anteriores de lo tocado), cifrado: en la app,
// Ajustes → Datos → Agentes → Deshacer. Todas aceptan `dry_run`.

import { ToolError } from './errors.mjs';
import { fold } from './book-arg.mjs';
import { cleanRule, hasRule, booksIn, segments, renumber, levelNodes, shelfRows, RULE_FIELDS, SEP } from '../../app/js/library/shelves.js';

const STATUSES = ['unread', 'reading', 'finished'];
const MAX_ITEMS = 500;
const NAME_MAX = 120;

const liveShelves = (lib) => Object.entries(lib.shelves || {}).filter(([, s]) => s && !s.deleted).map(([id, s]) => ({ id, ...s }));
export const liveBooks = (lib) => Object.entries(lib.books || {}).filter(([, b]) => b && !b.deleted).map(([id, b]) => ({ id, ...b }));
const newShelfId = () => 'sh_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const parentOf = (name) => segments(name).slice(0, -1).join(SEP);

function needLibrary(lib) {
  if (!lib || typeof lib.books !== 'object') throw new ToolError('Esta biblioteca no tiene catálogo (library.json) en el sync: ábrela una vez con la app actual.');
  if (!lib.shelves || typeof lib.shelves !== 'object') lib.shelves = {};
  return lib;
}

function cleanName(v, label = 'name') {
  if (typeof v !== 'string' || !v.trim()) throw new ToolError('«' + label + '» no puede ir vacío.');
  const s = segments(v).join(SEP);
  if (s.length > NAME_MAX) throw new ToolError('«' + label + '» pasa de ' + NAME_MAX + ' caracteres.');
  return s;
}

// Una estantería por id o por nombre completo («Técnico/ML», sin tildes ni mayúsculas).
export function findShelf(lib, ref, label = 'shelf') {
  if (typeof ref !== 'string' || !ref.trim()) throw new ToolError('Falta «' + label + '»: su id (de list_shelves) o su nombre completo.');
  const live = liveShelves(lib);
  const byId = live.find((s) => s.id === ref.trim());
  if (byId) return byId;
  const q = fold(segments(ref).join(SEP));
  const hits = live.filter((s) => fold(segments(s.name).join(SEP)) === q);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new ToolError(`Hay ${hits.length} estanterías llamadas «${ref}»: usa su id (${hits.map((s) => s.id).join(', ')}).`);
  throw new ToolError(`No hay ninguna estantería «${ref}». Mira list_shelves.`);
}

// Libros por `bookIds` o por `books` (títulos o parte, uno por libro).
function findBooks(lib, args) {
  const live = liveBooks(lib);
  const out = [];
  for (const id of Array.isArray(args.bookIds) ? args.bookIds : []) {
    const b = live.find((x) => x.id === id);
    if (!b) throw new ToolError(`No hay ningún libro con id «${id}» en la biblioteca.`);
    out.push(b);
  }
  for (const t of Array.isArray(args.books) ? args.books : []) {
    const q = fold(String(t || '').trim());
    if (!q) continue;
    const exact = live.filter((b) => fold(b.title || '') === q);
    const hits = exact.length ? exact : live.filter((b) => fold(b.title || '').includes(q));
    if (hits.length !== 1) {
      throw new ToolError(hits.length
        ? `«${t}» casa con varios libros: ${hits.slice(0, 10).map((b) => `${b.title} (${b.id})`).join('; ')}. Usa bookIds.`
        : `Ningún libro se llama «${t}».`);
    }
    out.push(hits[0]);
  }
  const unique = [...new Map(out.map((b) => [b.id, b])).values()];
  if (!unique.length) throw new ToolError('Faltan los libros: «bookIds» (de list_books) o «books» (títulos).');
  if (unique.length > MAX_ITEMS) throw new ToolError('Como mucho ' + MAX_ITEMS + ' libros por llamada.');
  return unique;
}

// Una regla de estantería inteligente, como la limpia la app. Las estanterías de la regla
// pueden venir por nombre y solo pueden ser MANUALES (shelves.js).
function ruleFrom(lib, raw, selfId = null) {
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ToolError('«rule» tiene que ser un objeto con ' + RULE_FIELDS.join(', ') + '.');
  const unknown = Object.keys(raw).filter((k) => !RULE_FIELDS.includes(k));
  if (unknown.length) throw new ToolError('Campos de regla desconocidos: ' + unknown.join(', ') + '. Valen: ' + RULE_FIELDS.join(', ') + '.');
  if (raw.status && !STATUSES.includes(raw.status)) throw new ToolError('rule.status: ' + STATUSES.join(' | ') + '.');
  const r = { ...raw };
  if (Array.isArray(r.shelfIds)) {
    r.shelfIds = r.shelfIds.map((ref) => {
      const s = findShelf(lib, ref, 'rule.shelfIds');
      if (hasRule(s.rule)) throw new ToolError(`Una regla solo puede apoyarse en estanterías normales; «${s.name}» es inteligente.`);
      if (s.id === selfId) throw new ToolError('Una estantería no puede apoyarse en sí misma.');
      return s.id;
    });
  }
  const clean = cleanRule(r);
  if (!hasRule(clean)) throw new ToolError('La regla no dice nada: pon al menos una condición.');
  return clean;
}

const shelfRecord = ({ name, createdAt, order = null, rule = null, now }) => ({
  name, createdAt, order, rule, deleted: false, deletedAt: 0, updatedAt: now,
});

// Ejecuta un cambio del catálogo. `fn(lib, now, undo)` devuelve { result, changed, summary }.
// `undo` acumula los valores ANTERIORES de lo que se toca (una vez por libro/estantería).
async function onLibrary(source, args, fn) {
  const dryRun = args.dry_run === true;
  const out = await source.writeLibrary((raw) => {
    const lib = needLibrary(raw);
    const undo = { books: {}, shelves: {} };
    const r = fn(lib, Date.now(), undo);
    return r.changed
      ? { next: lib, result: r.result, undo, summary: r.summary }
      : { next: null, result: r.result };
  }, { dryRun });
  return { source: source.kind, applied: !dryRun, ...out };
}

const keepBook = (undo, id, b) => {
  if (!undo.books[id]) undo.books[id] = { shelfIds: b.shelfIds || [], status: b.status || 'unread', finishedAt: b.finishedAt || null, title: b.title || '', author: b.author || '' };
};
const keepShelf = (undo, id, s) => {
  if (!(id in undo.shelves)) undo.shelves[id] = s ? { name: s.name, createdAt: s.createdAt, order: s.order ?? null, rule: s.rule || null, deleted: !!s.deleted } : null;
};

function setShelfIds(lib, id, ids, now, undo) {
  const b = lib.books[id];
  const next = [...new Set(ids)];
  if (JSON.stringify(next) === JSON.stringify(b.shelfIds || [])) return false;
  keepBook(undo, id, b);
  lib.books[id] = { ...b, shelfIds: next, shelvesAt: now, updatedAt: now };
  return true;
}

const SHELF_VIEW = (lib, s, books) => ({
  shelfId: s.id, name: s.name, path: segments(s.name), smart: hasRule(s.rule), rule: s.rule || null,
  order: Number.isFinite(s.order) ? s.order : null, books: booksIn(books, s).length,
});

const DRY = { dry_run: { type: 'boolean', description: 'true: enseña el cambio sin hacerlo.' } };
const BOOKS_PROPS = {
  bookIds: { type: 'array', items: { type: 'string' }, description: 'Ids de libros (de list_books).' },
  books: { type: 'array', items: { type: 'string' }, description: 'O títulos (o parte), uno por libro.' },
};
const RULE_SCHEMA = {
  type: ['object', 'null'],
  description: 'Estantería inteligente: status (unread|reading|finished), format, author, title, addedWithinDays, shelfIds (estanterías normales, por id o nombre).',
};

const LIST_SHELVES = {
  name: 'list_shelves',
  title: 'Estanterías',
  description:
    'Las estanterías de la biblioteca en el orden del rail (las anidadas, «Técnico/ML», van con ' +
    'su ruta), con cuántos libros tiene cada una y la regla de las inteligentes. Y cuántos libros ' +
    'no están en ninguna. Para ver qué libros hay en cada una, `list_books` (trae `shelfIds`).',
  capability: 'hasAgentData',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async run(source) {
    const lib = await source.library();
    if (!lib) throw new ToolError('Esta biblioteca no tiene catálogo (library.json).');
    const books = liveBooks(lib);
    // El orden del rail, tal cual lo pinta la app (las filas de grupo no son estanterías).
    const live = liveShelves(lib);
    const byId = new Map(live.map((s) => [s.id, s]));
    const shelves = shelfRows(live).filter((r) => r.shelf).map((r) => byId.get(r.shelf.id));
    const manual = new Set(shelves.filter((s) => !hasRule(s.rule)).map((s) => s.id));
    return {
      source: source.kind, books: books.length,
      unshelved: books.filter((b) => !(b.shelfIds || []).some((id) => manual.has(id))).length,
      shelves: shelves.map((s) => SHELF_VIEW(lib, s, books)),
    };
  },
};

const MOVE_BOOKS = {
  name: 'move_books',
  title: 'Mover libros entre estanterías',
  description:
    'Mete libros en estanterías (`add`) y/o los saca (`remove`), en lote. Estanterías por id o ' +
    'nombre completo; las inteligentes no se rellenan a mano (su regla decide). Para «mover» de ' +
    'una a otra: add la nueva y remove la vieja en la misma llamada.',
  capability: 'canOrganize',
  inputSchema: {
    type: 'object',
    properties: { ...BOOKS_PROPS, add: { type: 'array', items: { type: 'string' } }, remove: { type: 'array', items: { type: 'string' } }, ...DRY },
    additionalProperties: false,
  },
  run: (source, args) => onLibrary(source, args, (lib, now, undo) => {
    const refs = (xs) => (Array.isArray(xs) ? xs : []).map((r) => {
      const s = findShelf(lib, r);
      if (hasRule(s.rule)) throw new ToolError(`«${s.name}» es inteligente: sus libros los decide su regla.`);
      return s;
    });
    const add = refs(args.add);
    const remove = refs(args.remove);
    if (!add.length && !remove.length) throw new ToolError('Di qué hacer: «add» y/o «remove».');
    const books = findBooks(lib, args);
    const moved = [];
    for (const b of books) {
      const cur = lib.books[b.id].shelfIds || [];
      const next = [...cur.filter((id) => !remove.some((s) => s.id === id)), ...add.map((s) => s.id)];
      if (setShelfIds(lib, b.id, next, now, undo)) moved.push({ bookId: b.id, title: b.title || null });
    }
    return {
      changed: moved.length > 0,
      result: { moved, unchanged: books.length - moved.length, add: add.map((s) => s.name), remove: remove.map((s) => s.name) },
      summary: { books: moved.length },
    };
  }),
};

const UPDATE_BOOKS = {
  name: 'update_books',
  title: 'Editar libros',
  description:
    'Cambia el título, el autor o el estado (unread | reading | finished) de libros, en lote. El ' +
    'título y autor originales del fichero se guardan (la app los enseña). Un estado puesto aquí ' +
    'cuenta como puesto a mano: leer en otro dispositivo no lo revierte.',
  capability: 'canOrganize',
  inputSchema: {
    type: 'object',
    properties: {
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: { bookId: { type: 'string' }, title: { type: 'string' }, author: { type: 'string' }, status: { type: 'string', enum: STATUSES } },
          required: ['bookId'],
          additionalProperties: false,
        },
      },
      ...DRY,
    },
    required: ['changes'],
    additionalProperties: false,
  },
  run: (source, args) => onLibrary(source, args, (lib, now, undo) => {
    const changes = Array.isArray(args.changes) ? args.changes : [];
    if (!changes.length || changes.length > MAX_ITEMS) throw new ToolError('«changes»: de 1 a ' + MAX_ITEMS + ' libros.');
    const updated = [];
    for (const [i, ch] of changes.entries()) {
      const b = ch && lib.books[ch.bookId];
      if (!b || b.deleted) throw new ToolError(`Cambio ${i + 1}: no hay ningún libro con id «${ch && ch.bookId}».`);
      const before = { title: b.title || '', author: b.author || '', status: b.status || 'unread' };
      const next = { ...b };
      if (ch.title !== undefined || ch.author !== undefined) {
        const title = ch.title !== undefined ? String(ch.title).trim() || b.origTitle || b.title : b.title;
        const author = ch.author !== undefined ? String(ch.author).trim() : b.author;
        if (title !== b.title || author !== b.author) {
          if (next.origTitle == null) next.origTitle = b.title || '';
          if (next.origAuthor == null) next.origAuthor = b.author || '';
          Object.assign(next, { title, author, metaAt: now });
        }
      }
      if (ch.status !== undefined) {
        if (!STATUSES.includes(ch.status)) throw new ToolError(`Cambio ${i + 1}: status es ${STATUSES.join(' | ')}.`);
        if (ch.status !== (b.status || 'unread')) {
          next.status = ch.status;
          next.statusAt = now;
          if (ch.status === 'finished') next.finishedAt = b.finishedAt || now;
          else delete next.finishedAt;
        }
      }
      const after = { title: next.title || '', author: next.author || '', status: next.status || 'unread' };
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      keepBook(undo, ch.bookId, b);
      lib.books[ch.bookId] = { ...next, updatedAt: now };
      updated.push({ bookId: ch.bookId, before, after });
    }
    return { changed: updated.length > 0, result: { updated }, summary: { books: updated.length } };
  }),
};

const CREATE_SHELF = {
  name: 'create_shelf',
  title: 'Crear una estantería',
  description:
    'Crea una estantería. Anidada con «/» en el nombre («Técnico/Bases de datos»: la app la ' +
    'pinta dentro de «Técnico»). Con `rule`, inteligente: sus libros salen de la regla. Con ' +
    '`books`/`bookIds` (solo normales), la crea ya con esos libros dentro.',
  capability: 'canOrganize',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string' }, rule: RULE_SCHEMA, ...BOOKS_PROPS, ...DRY },
    required: ['name'],
    additionalProperties: false,
  },
  run: (source, args) => onLibrary(source, args, (lib, now, undo) => {
    const name = cleanName(args.name);
    if (liveShelves(lib).some((s) => fold(segments(s.name).join(SEP)) === fold(name))) {
      throw new ToolError(`Ya hay una estantería «${name}».`);
    }
    const id = newShelfId();
    const rule = args.rule === undefined || args.rule === null ? null : ruleFrom(lib, args.rule, id);
    keepShelf(undo, id, null);
    lib.shelves[id] = shelfRecord({ name, createdAt: now, rule, now });
    let added = 0;
    if (args.bookIds || args.books) {
      if (rule) throw new ToolError('Una estantería inteligente no lleva libros a mano: su regla los decide.');
      for (const b of findBooks(lib, args)) if (setShelfIds(lib, b.id, [...(lib.books[b.id].shelfIds || []), id], now, undo)) added++;
    }
    return {
      changed: true,
      result: { shelfId: id, name, smart: !!rule, rule, books: rule ? booksIn(liveBooks(lib), { id, rule }).length : added },
      summary: { shelvesCreated: 1, books: added },
    };
  }),
};

const UPDATE_SHELF = {
  name: 'update_shelf',
  title: 'Renombrar o cambiar una estantería',
  description:
    'Renombra una estantería (también para moverla en el árbol: «ML» → «Técnico/ML») o cambia ' +
    'su regla (`rule: null` la vuelve normal, sin libros). El id no cambia: los enlaces ' +
    'compartidos siguen funcionando.',
  capability: 'canOrganize',
  inputSchema: {
    type: 'object',
    properties: { shelf: { type: 'string', description: 'Id o nombre completo.' }, name: { type: 'string' }, rule: RULE_SCHEMA, ...DRY },
    required: ['shelf'],
    additionalProperties: false,
  },
  run: (source, args) => onLibrary(source, args, (lib, now, undo) => {
    const s = findShelf(lib, args.shelf);
    const cur = lib.shelves[s.id];
    const next = { ...cur };
    if (args.name !== undefined) {
      const name = cleanName(args.name);
      if (liveShelves(lib).some((x) => x.id !== s.id && fold(segments(x.name).join(SEP)) === fold(name))) throw new ToolError(`Ya hay otra estantería «${name}».`);
      next.name = name;
    }
    if (args.rule !== undefined) {
      next.rule = args.rule === null ? null : ruleFrom(lib, args.rule, s.id);
      // Una estantería que pasa a inteligente deja de tener libros a mano.
      if (next.rule && !hasRule(cur.rule)) {
        for (const b of liveBooks(lib)) if ((b.shelfIds || []).includes(s.id)) setShelfIds(lib, b.id, b.shelfIds.filter((x) => x !== s.id), now, undo);
      }
    }
    if (JSON.stringify([next.name, next.rule || null]) === JSON.stringify([cur.name, cur.rule || null])) {
      return { changed: false, result: { shelfId: s.id, name: cur.name, unchanged: true } };
    }
    keepShelf(undo, s.id, cur);
    lib.shelves[s.id] = { ...next, updatedAt: now };
    return { changed: true, result: { shelfId: s.id, before: { name: cur.name, rule: cur.rule || null }, after: { name: next.name, rule: next.rule || null } }, summary: { shelvesChanged: 1 } };
  }),
};

const REORDER_SHELVES = {
  name: 'reorder_shelves',
  title: 'Ordenar estanterías',
  description:
    'Fija el orden de UN nivel del árbol (lo que cuelga del mismo padre): `order` es la lista en ' +
    'el orden deseado, de estanterías o de carpetas («Técnico», que existe solo porque hay ' +
    '«Técnico/…»); lo que no nombres va detrás, en el orden que tenía. Una carpeta se mueve con ' +
    'todo lo que lleva dentro.',
  capability: 'canOrganize',
  inputSchema: {
    type: 'object',
    properties: { order: { type: 'array', items: { type: 'string' }, description: 'Ids o rutas completas («Técnico», «Técnico/ML»), todas del mismo nivel.' }, ...DRY },
    required: ['order'],
    additionalProperties: false,
  },
  run: (source, args) => onLibrary(source, args, (lib, now, undo) => {
    const refs = Array.isArray(args.order) ? args.order : [];
    if (!refs.length) throw new ToolError('«order» no puede ir vacío.');
    const live = liveShelves(lib);
    const wanted = refs.map((r) => nodePathOf(lib, live, r));
    const parent = parentOf(wanted[0]);
    if (wanted.some((p) => parentOf(p) !== parent)) throw new ToolError('Todas tienen que ser del mismo nivel (mismo padre en el nombre).');
    const level = levelNodes(live, parent).map((n) => n.path);
    const seq = [...new Set([...wanted, ...level])];
    // Una sola numeración para toda la biblioteca (shelves.js · renumber): un grupo se coloca
    // por el menor `order` de lo que lleva dentro, comparado con el de sus hermanas.
    const patches = renumber(live, (at, nodes) => at === parent ? seq.map((p) => nodes.find((n) => n.path === p)) : nodes);
    for (const { id, order } of patches) {
      keepShelf(undo, id, lib.shelves[id]);
      lib.shelves[id] = { ...lib.shelves[id], order, updatedAt: now };
    }
    const label = (p) => p.split(SEP).pop();
    return { changed: patches.length > 0, result: { parent: parent || null, order: seq.map(label) }, summary: { shelvesChanged: patches.length } };
  }),
};

// La ruta del nodo de un nivel: una estantería (id o nombre) o una carpeta que solo existe
// porque hay estanterías debajo («Técnico» con «Técnico/ML»).
function nodePathOf(lib, live, ref) {
  try {
    return segments(findShelf(lib, ref, 'order').name).join(SEP);
  } catch (e) {
    const q = typeof ref === 'string' ? fold(segments(ref).join(SEP)) : '';
    for (const s of live) {
      const parts = segments(s.name);
      for (let i = 1; i < parts.length; i++) {
        const path = parts.slice(0, i).join(SEP);
        if (fold(path) === q) return path;
      }
    }
    throw e;
  }
}

const DELETE_SHELF = {
  name: 'delete_shelf',
  title: 'Borrar una estantería',
  description:
    'Borra una estantería (los libros NO se borran: salen de ella) y la quita de las reglas de ' +
    'las inteligentes que la citen. Si estaba compartida por enlace, el enlace sigue abierto, ' +
    'pero la app ya no la lista entre tus enlaces: avísale al usuario.',
  capability: 'canOrganize',
  inputSchema: {
    type: 'object',
    properties: { shelf: { type: 'string', description: 'Id o nombre completo.' }, ...DRY },
    required: ['shelf'],
    additionalProperties: false,
  },
  run: (source, args) => onLibrary(source, args, (lib, now, undo) => {
    const s = findShelf(lib, args.shelf);
    keepShelf(undo, s.id, lib.shelves[s.id]);
    lib.shelves[s.id] = { ...lib.shelves[s.id], deleted: true, deletedAt: now, updatedAt: now };
    let books = 0;
    for (const b of liveBooks(lib)) {
      if ((b.shelfIds || []).includes(s.id) && setShelfIds(lib, b.id, b.shelfIds.filter((x) => x !== s.id), now, undo)) books++;
    }
    let rules = 0;
    for (const o of liveShelves(lib)) {
      if (o.rule && Array.isArray(o.rule.shelfIds) && o.rule.shelfIds.includes(s.id)) {
        keepShelf(undo, o.id, lib.shelves[o.id]);
        const rule = cleanRule({ ...o.rule, shelfIds: o.rule.shelfIds.filter((x) => x !== s.id) });
        lib.shelves[o.id] = { ...lib.shelves[o.id], rule: hasRule(rule) ? rule : null, updatedAt: now };
        rules++;
      }
    }
    return {
      changed: true,
      result: { shelfId: s.id, name: s.name, booksTakenOut: books, rulesUpdated: rules },
      summary: { shelvesDeleted: 1, books, shelvesChanged: rules },
    };
  }),
};

export const LIBRARY_TOOLS = [LIST_SHELVES, MOVE_BOOKS, UPDATE_BOOKS, CREATE_SHELF, UPDATE_SHELF, REORDER_SHELVES, DELETE_SHELF];
