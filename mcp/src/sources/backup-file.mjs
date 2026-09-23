// sources/backup-file.mjs — F1: la fuente es el JSON que produce la app
// (app/js/backup.js · buildBackup()). Sin OAuth, sin red, sin cuenta.
//
// Forma del fichero:
//
//   { format: 'bookreader-backup', version, exportedAt,
//     localStorage: { 'highlights_<bookId>': [...], 'bookmarks_<bookId>': [...], ... },
//     ai: { convos, messages, notes, ratings, books } }
//
// Lo que este fichero NO trae, y por eso F1 no tiene `reading_stats`:
//   - El registro de lectura vive en su propia IndexedDB (`reading-log.js`) y `buildBackup()`
//     no lo incluye: el backup es una FOTO de localStorage + los stores de IA.
//   - La biblioteca (títulos, estanterías, portadas) tampoco: está en IndexedDB
//     (`library/store.js`). Los títulos de aquí salen de los metadatos del agente
//     (`ai.books`, que solo existen si el libro se segmentó) → muchos libros saldrán
//     con `title: null` y el cliente cae al `id`. Está dicho en el README.
//
// La tolerancia al prefijo (`bookreader_`) es a propósito: `buildBackup()` lo quita al
// exportar, pero un volcado hecho a mano desde las DevTools lo lleva.

import { readFile as fsReadFile } from 'node:fs/promises';
import { SourceError } from '../errors.mjs';
import { scrub } from '../redact.mjs';
import {
  liveItems,
  summarizeBook,
  normalizeHighlight,
  normalizeNote,
  byTitleThenId,
} from '../model.mjs';

export const BACKUP_FORMAT = 'bookreader-backup';
const PREFIX = 'bookreader_';
// Prefijos de localStorage particionados por libro, los mismos que usa sync/layout.js.
const BOOK_PREFIXES = [
  'highlights',
  'bookmarks',
  'lastPosition',
  'lastPositionAt',
  'pdfLastPage',
  'pdfLastPageAt',
  'readingMode',
  'pdfMode',
  'pdfFit',
];

function shortKey(key) {
  return key.startsWith(PREFIX) ? key.slice(PREFIX.length) : key;
}

function splitKey(key) {
  for (const p of BOOK_PREFIXES) {
    if (key.startsWith(p + '_')) return { prefix: p, bookId: key.slice(p.length + 1) };
  }
  return null;
}

/**
 * Índice de libros del backup. Puro (no toca el disco): es lo que testea el test unitario y
 * lo que reutiliza la tool.
 *
 * @param {any} backup objeto ya parseado
 * @returns {Map<string, import('../model.mjs').BookEntry>}
 */
export function indexBackup(backup) {
  const clean = scrub(backup); // defensa en profundidad: aquí no queda ningún vetado
  if (!clean || typeof clean !== 'object' || clean.format !== BACKUP_FORMAT) {
    throw new SourceError(
      'El fichero no es un backup de BookReader (falta format: "' + BACKUP_FORMAT + '").',
    );
  }

  const local = {};
  for (const [k, v] of Object.entries(clean.localStorage || {})) local[shortKey(k)] = v;
  const ai = clean.ai || {};

  /** @type {Map<string, any>} */
  const books = new Map();
  const entryOf = (id) => {
    let e = books.get(id);
    if (!e) {
      e = {
        id,
        title: null,
        highlights: [],
        bookmarks: [],
        notes: [],
        convos: [],
        lastPositionAt: null,
        meta: null,
      };
      books.set(id, e);
    }
    return e;
  };

  // Metadatos del agente: la única fuente de título del backup (y solo si se segmentó).
  for (const b of Array.isArray(ai.books) ? ai.books : []) {
    if (!b || !b.id) continue;
    const e = entryOf(b.id);
    e.meta = b;
    if (b.title) e.title = b.title;
  }

  for (const [key, value] of Object.entries(local)) {
    const bk = splitKey(key);
    if (!bk) continue;
    const e = entryOf(bk.bookId);
    if (bk.prefix === 'highlights') e.highlights = Array.isArray(value) ? value : [];
    else if (bk.prefix === 'bookmarks') e.bookmarks = Array.isArray(value) ? value : [];
    else if (bk.prefix === 'lastPositionAt') e.lastPositionAt = Number(value) || 0;
  }

  const convos = (Array.isArray(ai.convos) ? ai.convos : []).filter(Boolean);
  const convoById = new Map(convos.map((c) => [c.id, c]));
  for (const c of convos) if (c.bookId) entryOf(c.bookId).convos.push(c);

  for (const n of Array.isArray(ai.notes) ? ai.notes : []) {
    if (!n) continue;
    const bookId = n.bookId || (convoById.get(n.convoId) || {}).bookId;
    if (bookId) entryOf(bookId).notes.push(n);
  }

  return books;
}

/**
 * Fuente F1 sobre un fichero de backup.
 *
 * @param {{ path: string, readFile?: typeof fsReadFile }} opts
 */
export function createBackupFileSource({ path, readFile = fsReadFile }) {
  let cache = null;

  async function index() {
    if (cache) return cache;
    let raw;
    try {
      raw = await readFile(path, 'utf8');
    } catch (e) {
      throw new SourceError('No puedo leer el backup «' + path + '»: ' + e.message);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new SourceError('El backup «' + path + '» no es JSON válido: ' + e.message);
    }
    cache = indexBackup(parsed);
    return cache;
  }

  // Los tombstones no salen nunca, y el `bookId`/título se resuelven aquí una sola vez.
  function project(entry) {
    const title = entry.title || (entry.meta && entry.meta.title) || null;
    const convoById = new Map(entry.convos.map((c) => [c.id, c]));
    return {
      book: { id: entry.id, title },
      highlights: liveItems(entry.highlights).map((h) => normalizeHighlight(h, { bookId: entry.id, bookTitle: title })),
      notes: liveItems(entry.notes).map((n) =>
        normalizeNote(n, { bookId: entry.id, bookTitle: title, convo: convoById.get(n.convoId) }),
      ),
    };
  }

  return {
    kind: 'backup-file',
    // El backup no lleva el registro de lectura: la tool `reading_stats` no se registra.
    hasReadingStats: false,
    describe() {
      return 'backup-file:' + path;
    },
    /** Comprueba que el fichero existe y es un backup, sin cargar la biblioteca entera. */
    async ping() {
      await index();
      return { kind: 'backup-file', detail: path };
    },
    async listBooks() {
      const books = await index();
      return [...books.values()].map(summarizeBook).sort(byTitleThenId);
    },
    /** Id + título de un libro, sin bajar sus subrayados. */
    async bookInfo(bookId) {
      const entry = (await index()).get(bookId);
      if (!entry) throw new SourceError('Libro desconocido: ' + bookId);
      return { id: entry.id, title: entry.title || (entry.meta && entry.meta.title) || null };
    },
    /** Títulos por id (para `reading_stats` y para pistas de error). */
    async titles() {
      const out = {};
      for (const entry of (await index()).values()) {
        out[entry.id] = entry.title || (entry.meta && entry.meta.title) || null;
      }
      return out;
    },
    async getHighlights(bookId) {
      const entry = (await index()).get(bookId);
      if (!entry) throw new SourceError('Libro desconocido: ' + bookId);
      return project(entry).highlights;
    },
    async getNotes(bookId) {
      const entry = (await index()).get(bookId);
      if (!entry) throw new SourceError('Libro desconocido: ' + bookId);
      return project(entry).notes;
    },
    /** El backup no trae días de lectura: contrato vacío, no un error. */
    async readingDays() {
      return [];
    },
  };
}

