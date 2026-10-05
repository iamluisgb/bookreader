// sources/drive.mjs — F2: la fuente es el layout de sync en el proveedor
// (app/js/sync/layout.js):
//
//   <base>manifest.json      índice { schemaVersion, books: { id: { file, title, updatedAt } } }
//   <base>library.json       catálogo real { schemaVersion, books: { id: {...deleted, shelfIds,
//                            status, title} }, shelves: {...} }  ← manda para QUÉ libros hay
//   <base>settings.json      ajustes globales + plantillas propias + `reading_days`
//   <base>books/<id>.json    local (subrayados, marcadores, posición), convos, mensajes,
//                            notas, ratings, artefactos y mazos
//
// El proveedor es una interfaz, no un detalle: `{ read(path) -> { content } | null }`. La
// implementación de verdad es Google Drive (appDataFolder, el mismo sitio donde escribe la
// app); las pruebas usan proveedores simulados en memoria o una carpeta con el layout real
// (ver providers/). Así la fuente de Drive se prueba sin credenciales.
//
// DOS COSAS QUE NO SE HACEN AQUÍ:
//
//  1. `device_id` NO sale nunca. A diferencia del backup, el layout SÍ lleva el identificador
//     de cada equipo: `settings.reading_days[k]` es `{ key: '<día>|<deviceId>', day, deviceId }`.
//     `reading_stats` suma esos registros y tira `key`/`deviceId` (ver redact.mjs). Un
//     `reading_stats` que devolviera los registros crudos publicaría el identificador de
//     cada dispositivo del lector — justo lo que P28 prohíbe.
//  2. El nombre del fichero de un libro viene del manifest, que es un dato remoto. Se valida
//     contra un patrón estricto antes de leer: un manifest manipulado no puede convertir al
//     MCP en un lector de rutas arbitrarias (`../../`), ni con proveedor de disco.

import { SourceError, UnknownBookError } from '../errors.mjs';
import { scrub, sanitizeReadingDay } from '../redact.mjs';
import {
  liveItems,
  summarizeBook,
  normalizeHighlight,
  normalizeNote,
  byTitleThenId,
} from '../model.mjs';

export const DEFAULT_BASE = 'bookreader/';
// `books/<id>.json` y nada más: sin barras extra, sin `..`, sin rutas absolutas.
const SAFE_BOOK_FILE = /^books\/[A-Za-z0-9._-]+\.json$/;

/** ¿La ruta de un libro que viene del manifest es de fiar? */
export function isSafeBookFile(file) {
  return typeof file === 'string' && SAFE_BOOK_FILE.test(file);
}

/**
 * Fuente F2 sobre un proveedor con el layout de sync.
 *
 * @param {{ provider: { read(path: string): Promise<{ content: string }|null> },
 *           base?: string, cacheMs?: number, now?: () => number }} opts
 */
export function createDriveSource({ provider, base = DEFAULT_BASE, cacheMs = 15000, now = Date.now }) {
  /**
   * @typedef {{ at: number, manifest: any, library: any, entries: Map<string, any>, settings: any }} Load
   * @type {Load|null}
   */
  let cache = null;
  /** @type {Promise<Load>|null} */
  let loading = null;

  const fresh = () => Boolean(cache && cacheMs > 0 && now() - cache.at < cacheMs);

  async function readJson(path) {
    const res = await provider.read(path);
    if (!res) return null;
    try {
      return scrub(JSON.parse(res.content));
    } catch (e) {
      throw new SourceError('«' + path + '» no es JSON válido: ' + e.message);
    }
  }

  /**
   * Carga (o reutiliza) el manifest y lo que cuelga de él. El TTL es del CONJUNTO, no de cada
   * fichero: una recarga invalida todo y así los libros no pueden quedar de dos épocas
   * distintas. Mientras una carga está en vuelo, las llamadas que entren se cuelgan de ella en
   * vez de repetir lecturas (dentro de una misma tool, sin TTL, el manifest se leía una vez por
   * libro — que es justo el gasto que el TTL pretendía ahorrar).
   *
   * @returns {Promise<Load>}
   */
  async function load() {
    if (fresh()) return cache;
    if (!loading) {
      loading = (async () => {
        const raw = await readJson(base + 'manifest.json');
        if (!raw || typeof raw !== 'object' || !raw.books || typeof raw.books !== 'object') {
          throw new SourceError(
            'No hay un manifest.json utilizable en «' + base + '»: ¿sync activado alguna vez?',
          );
        }
        // El catálogo manda para QUÉ libros hay (incluye `deleted`). Es OPCIONAL: si falta o no
        // se puede leer (layout viejo, raíz que no es carpeta), se cae al manifest sin más.
        let library = null;
        try {
          library = await readJson(base + 'library.json');
        } catch {
          library = null;
        }
        const hasLibrary = library && typeof library.books === 'object' && library.books !== null;
        return { at: now(), manifest: raw, library: hasLibrary ? library : null, entries: new Map(), settings: null };
      })();
      loading.then(
        (c) => {
          cache = c;
          loading = null;
        },
        () => {
          loading = null;
        },
      );
    }
    return loading;
  }

  /** Un libro del load dado: así una tool paga UNA lectura de manifest aunque recorra 40 libros. */
  async function entryFrom(c, id) {
    const info = c.manifest.books[id];
    const libBook = c.library ? c.library.books[id] : null;
    // Con `library.json`, él manda: es el catálogo, y trae los tombstones. Un id que no está
    // —o está borrado— NO es de la biblioteca, aunque su fichero de datos siga en el manifest:
    // es el caso que metía libros fantasma (y borrados) en `list_books`.
    if (c.library) {
      if (!libBook || libBook.deleted) return null;
    } else if (!info) {
      return null;
    }
    const cached = c.entries.get(id);
    if (cached) return cached;

    const file = (info && info.file) || 'books/' + id + '.json';
    const entry = {
      id,
      title: (libBook && libBook.title) || (info && info.title) || null,
      status: (libBook && libBook.status) || null,
      shelfIds: (libBook && libBook.shelfIds) || [],
      highlights: [],
      bookmarks: [],
      notes: [],
      convos: [],
      decks: [],
      artifacts: [],
      lastPositionAt: null,
      meta: null,
    };
    if (!isSafeBookFile(file)) {
      // Ruta que no cumple el patrón del layout: no se lee y se dice por qué en list_books.
      entry.error = 'manifest: ruta de libro no permitida (' + String(file) + ')';
      c.entries.set(id, entry);
      return entry;
    }
    const path = base + file;
    const raw = await readJson(path);
    if (!raw) {
      entry.error = 'falta ' + path;
      c.entries.set(id, entry);
      return entry;
    }
    const local = raw.local || {};
    entry.title = (libBook && libBook.title) || (info && info.title) || (raw.meta && raw.meta.title) || null;
    entry.highlights = local['highlights_' + id];
    entry.bookmarks = local['bookmarks_' + id];
    entry.notes = raw.notes;
    entry.convos = raw.convos;
    entry.decks = raw.decks;
    entry.artifacts = raw.artifacts;
    entry.lastPositionAt = Number(local['lastPositionAt_' + id]) || null;
    entry.meta = raw.meta || null;
    c.entries.set(id, entry);
    return entry;
  }

  function project(entry) {
    const title = entry.title || (entry.meta && entry.meta.title) || null;
    const convoById = new Map(liveItems(entry.convos).map((c) => [c.id, c]));
    return {
      book: { id: entry.id, title },
      highlights: liveItems(entry.highlights).map((h) =>
        normalizeHighlight(h, { bookId: entry.id, bookTitle: title }),
      ),
      notes: liveItems(entry.notes).map((n) =>
        normalizeNote(n, { bookId: entry.id, bookTitle: title, convo: convoById.get(n.convoId) }),
      ),
    };
  }

  return {
    kind: 'drive',
    // El registro de lectura viaja en settings.json (P25 F3): aquí SÍ hay estadísticas.
    hasReadingStats: true,
    // El layout lleva mazos y artefactos del Studio en cada books/<id>.json (el backup no).
    hasAgentData: true,
    describe() {
      return 'drive:' + base;
    },
    /** Comprueba que hay manifest utilizable (una lectura) para fallar al arrancar, no al usar. */
    async ping() {
      await load();
      return { kind: 'drive', detail: base };
    },
    /**
     * Resumen de todos los libros. Cuesta una lectura por libro: los contadores no están en
     * el manifest, y el manifest es un índice, no un duplicado de los datos (es justo lo que
     * hace que el layout no se desincronice). Con TTL, el coste se paga una vez por ventana.
     */
    async listBooks() {
      const c = await load();
      // Con catálogo, la lista sale de él (vivos); sin él, del manifest (layout viejo).
      const ids = c.library ? Object.keys(c.library.books) : Object.keys(c.manifest.books);
      const out = [];
      for (const id of ids) {
        const entry = await entryFrom(c, id);
        if (!entry) continue;
        const summary = summarizeBook(entry);
        if (entry.error) summary.error = entry.error;
        out.push(summary);
      }
      return out.sort(byTitleThenId);
    },
    /** Id + título de un libro, sin bajar su fichero. */
    async bookInfo(bookId) {
      const entry = await entryFrom(await load(), bookId);
      if (!entry) throw new UnknownBookError(bookId);
      return { id: entry.id, title: entry.title || (entry.meta && entry.meta.title) || null };
    },
    /** Títulos por id, del catálogo (o del manifest si no lo hay): ni una lectura de más. */
    async titles() {
      const c = await load();
      if (c.library) {
        return Object.fromEntries(
          Object.entries(c.library.books)
            .filter(([, b]) => b && !b.deleted)
            .map(([id, b]) => [id, b.title || null]),
        );
      }
      return Object.fromEntries(
        Object.entries(c.manifest.books).map(([id, info]) => [id, (info && info.title) || null]),
      );
    },
    async getHighlights(bookId) {
      const entry = await entryFrom(await load(), bookId);
      if (!entry) throw new UnknownBookError(bookId);
      return project(entry).highlights;
    },
    async getNotes(bookId) {
      const entry = await entryFrom(await load(), bookId);
      if (!entry) throw new UnknownBookError(bookId);
      return project(entry).notes;
    },
    /** Mazos del libro, ya sin tombstones. Solo en la fuente viva: el backup no los lleva. */
    async decks(bookId) {
      const entry = await entryFrom(await load(), bookId);
      if (!entry) throw new UnknownBookError(bookId);
      return liveItems(entry.decks);
    },
    /** Artefactos del Studio del libro (resúmenes, mapas, infografías), sin tombstones. */
    async artifacts(bookId) {
      const entry = await entryFrom(await load(), bookId);
      if (!entry) throw new UnknownBookError(bookId);
      return liveItems(entry.artifacts);
    },
    /** Días de lectura del layout, sin `key` ni `deviceId` (ver redact.mjs). */
    async readingDays() {
      const c = await load();
      if (c.settings) return c.settings;
      const settings = await readJson(base + 'settings.json');
      const days = Array.isArray(settings && settings.reading_days) ? settings.reading_days : [];
      c.settings = days.map(sanitizeReadingDay).filter(Boolean);
      return c.settings;
    },
  };
}

