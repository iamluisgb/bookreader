// profile-tools.mjs — el perfil público (app/js/library/publish.js) por MCP: leer qué se enseña y
// escribir la nota («por qué lo recomiendo») y el enlace de cada libro, la presentación, el idioma
// y lo que se ve o no. La configuración vive en `settings.json` del sync, clave `public_profile`, y
// la app la funde con «gana el cambio más reciente» por `updatedAt` (sync/layout.js), así que cada
// escritura lleva un `updatedAt` nuevo.
//
// Escribir pide el permiso «Organizar mi biblioteca» (`canOrganize`): decide qué es público.
// NO publica: la página pública cambia cuando el usuario pulsa «Descargar para publicar» en la app.
// Tampoco activa el perfil ni hace públicas estanterías: eso se decide en la app, viéndolo.
// Sin deshacer cifrado (ese registro es solo de library.json): devuelve el antes y el después, y
// acepta `dry_run`.

import { ToolError } from './errors.mjs';
import { fold } from './book-arg.mjs';
import { booksInBranch } from '../../app/js/library/shelves.js';

const PROFILE_KEY = 'public_profile';
const NOTE_MAX = 280;
const BIO_MAX = 200;
const MAX_ITEMS = 200;

const liveShelves = (lib) => Object.entries((lib && lib.shelves) || {}).filter(([, s]) => s && !s.deleted).map(([id, s]) => ({ id, ...s }));
const liveBooks = (lib) => Object.entries((lib && lib.books) || {}).filter(([, b]) => b && !b.deleted).map(([id, b]) => ({ id, ...b }));

export function cleanLink(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null; } catch { return null; }
}

function view(cfg, lib) {
  const books = new Map(liveBooks(lib).map((b) => [b.id, b]));
  const shelves = new Map(liveShelves(lib).map((s) => [s.id, s]));
  const handle = cfg.handle || 'luis';
  return {
    enabled: !!cfg.enabled,
    page: `https://bookreader.raiatech.com/@${handle}/`,
    lang: cfg.lang === 'es' ? 'es' : 'en',
    bio: cfg.bio || '',
    hasAvatar: !!cfg.avatar,
    showProgress: cfg.showProgress !== false,
    showFilters: cfg.showFilters !== false,
    yearTab: !!cfg.yearTab,
    now: cfg.now || 'auto',
    shelves: (cfg.shelves || []).filter((s) => shelves.has(s.id)).map((s) => ({
      shelfId: s.id, name: s.name, libraryName: shelves.get(s.id).name,
      books: (s.books || []).filter((b) => books.has(b.id)).map((b) => ({
        bookId: b.id, title: books.get(b.id).title || '', show: !!b.show, style: b.style || 'auto',
        note: b.note || null, link: b.link || null,
      })),
    })),
  };
}

const GET_PUBLIC_PROFILE = {
  name: 'get_public_profile',
  title: 'Ver el perfil público',
  description:
    'Qué enseña la página pública del usuario (bookreader.raiatech.com/@usuario): si está activa, ' +
    'idioma, presentación, estanterías públicas con sus libros (visibles o no) y la nota y el enlace ' +
    'de cada libro. Es la configuración guardada en la app; lo publicado cambia cuando el usuario ' +
    'publica desde la app.',
  capability: 'publicProfile',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async run(source) {
    const [cfg, lib] = await Promise.all([source.publicProfile(), source.library()]);
    if (!cfg) return { source: source.kind, configured: false, hint: 'El perfil público aún no se ha configurado: Ajustes → Perfil público en la app (con ?perfil-preview=1).' };
    return { source: source.kind, configured: true, ...view(cfg, lib) };
  },
};

const UPDATE_PUBLIC_PROFILE = {
  name: 'update_public_profile',
  title: 'Editar el perfil público',
  description:
    'Escribe en la configuración del perfil público: la nota de cada libro («por qué lo recomiendo», ' +
    'hasta 280 caracteres; "" la quita), su enlace para conseguirlo (solo http/https; "" lo quita), ' +
    'si se ve o no (`show`), y la presentación (`bio`), el idioma (`lang`: en|es) y las opciones de ' +
    'la página. El libro tiene que estar en alguna estantería pública. No publica ni hace públicas ' +
    'estanterías: eso lo hace el usuario en la app. Acepta `dry_run`.',
  capability: 'canEditProfile',
  inputSchema: {
    type: 'object',
    properties: {
      bio: { type: 'string', description: 'Presentación de una línea (hasta 200). "" la quita.' },
      lang: { type: 'string', enum: ['en', 'es'] },
      showProgress: { type: 'boolean' },
      showFilters: { type: 'boolean', description: 'Los filtros por estado (Todos, Leyendo…).' },
      yearTab: { type: 'boolean', description: 'La pestaña «AAAA en libros».' },
      books: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            bookId: { type: 'string' },
            book: { type: 'string', description: 'O el título (o parte).' },
            note: { type: 'string' },
            link: { type: 'string' },
            show: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
      dry_run: { type: 'boolean', description: 'true: enseña el antes y el después sin escribir nada.' },
    },
    additionalProperties: false,
  },
  async run(source, args) {
    const lib = await source.library();
    const books = liveBooks(lib);
    const shelves = liveShelves(lib);
    const changes = Array.isArray(args.books) ? args.books : [];
    if (changes.length > MAX_ITEMS) throw new ToolError('«books»: como mucho ' + MAX_ITEMS + ' libros por llamada.');
    const opts = ['bio', 'lang', 'showProgress', 'showFilters', 'yearTab'].filter((k) => args[k] !== undefined);
    if (!changes.length && !opts.length) throw new ToolError('Nada que cambiar: di `books` y/o alguna opción (bio, lang, showProgress, showFilters, yearTab).');

    // Resolver los libros ANTES de tocar nada: un error a medias no debe dejar medio cambio.
    const resolved = changes.map((ch, i) => {
      if (!ch || typeof ch !== 'object') throw new ToolError(`Libro ${i + 1}: tiene que ser un objeto.`);
      let b = null;
      if (ch.bookId) b = books.find((x) => x.id === ch.bookId);
      else if (ch.book) {
        const q = fold(ch.book);
        const hits = books.filter((x) => fold(x.title || '').includes(q));
        if (hits.length > 1) throw new ToolError(`Libro ${i + 1}: «${ch.book}» coincide con ${hits.length} libros; usa bookId (${hits.slice(0, 5).map((h) => h.id.slice(0, 12)).join(', ')}…).`);
        b = hits[0] || null;
      }
      if (!b) throw new ToolError(`Libro ${i + 1}: no lo encuentro (${ch.bookId || ch.book || 'falta bookId o book'}). Mira list_books.`);
      if (ch.note !== undefined && String(ch.note).trim().length > NOTE_MAX) throw new ToolError(`Libro ${i + 1}: la nota pasa de ${NOTE_MAX} caracteres.`);
      if (ch.link !== undefined && cleanLink(ch.link) === null) throw new ToolError(`Libro ${i + 1}: el enlace tiene que empezar por http:// o https://.`);
      return { ch, b };
    });
    if (args.bio !== undefined && String(args.bio).trim().length > BIO_MAX) throw new ToolError(`«bio» pasa de ${BIO_MAX} caracteres.`);

    const dryRun = args.dry_run === true;
    const out = await source.writeSettings((raw) => {
      if (!raw || typeof raw !== 'object') throw new ToolError('No hay ajustes en el sync todavía: abre la app una vez con el sync activo.');
      const cfg = raw[PROFILE_KEY];
      if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.shelves)) throw new ToolError('El perfil público aún no se ha configurado: Ajustes → Perfil público en la app (con ?perfil-preview=1).');
      const before = view(cfg, lib);
      const next = { ...cfg, shelves: cfg.shelves.map((s) => ({ ...s, books: (s.books || []).map((b) => ({ ...b })) })) };
      if (args.bio !== undefined) next.bio = String(args.bio).trim();
      if (args.lang !== undefined) next.lang = args.lang === 'es' ? 'es' : 'en';
      for (const k of ['showProgress', 'showFilters', 'yearTab']) if (args[k] !== undefined) next[k] = !!args[k];

      const updated = [];
      for (const [i, { ch, b }] of resolved.entries()) {
        // El libro en cada estantería pública que lo contiene. Si la app aún no lo ha visto (entró
        // después), se añade a su lista: oculto, como hace la app con lo nuevo, salvo que se pida `show`.
        const where = next.shelves.filter((s) => {
          const shelf = shelves.find((x) => x.id === s.id);
          return shelf && booksInBranch(books, shelves, shelf).some((x) => x.id === b.id);
        });
        if (!where.length) throw new ToolError(`Libro ${i + 1}: «${b.title}» no está en ninguna estantería pública. Hazla pública en la app (Ajustes → Perfil público).`);
        for (const s of where) {
          let e = s.books.find((x) => x.id === b.id);
          if (!e) { e = { id: b.id, show: false, style: 'auto' }; s.books.push(e); }
          if (ch.note !== undefined) { const n = String(ch.note).trim(); if (n) e.note = n; else delete e.note; }
          if (ch.link !== undefined) { const l = cleanLink(ch.link); if (l) e.link = l; else delete e.link; }
          if (ch.show !== undefined) e.show = !!ch.show;
        }
        updated.push({ bookId: b.id, title: b.title || '', shelves: where.map((s) => s.name) });
      }
      next.updatedAt = Date.now();
      const after = view(next, lib);
      const same = JSON.stringify(before) === JSON.stringify(after);
      const result = { updated, before: pick(before, resolved), after: pick(after, resolved),
        profile: { bio: after.bio, lang: after.lang, showProgress: after.showProgress, showFilters: after.showFilters, yearTab: after.yearTab },
        note: 'Guardado en la configuración. Se ve en la app (Ajustes → Perfil público) y en la página pública cuando el usuario vuelva a publicar.' };
      return same ? { next: null, result: { ...result, unchanged: true } } : { next: { ...raw, [PROFILE_KEY]: next }, result };
    }, { dryRun });
    return { source: source.kind, applied: !dryRun, ...out };
  },
};

// Antes/después solo de los libros tocados, para que el resultado sea legible.
function pick(v, resolved) {
  const ids = new Set(resolved.map((r) => r.b.id));
  const seen = new Map();
  for (const s of v.shelves) for (const b of s.books) if (ids.has(b.bookId) && !seen.has(b.bookId)) seen.set(b.bookId, { bookId: b.bookId, title: b.title, show: b.show, note: b.note, link: b.link });
  return [...seen.values()];
}

export const PROFILE_TOOLS = [GET_PUBLIC_PROFILE, UPDATE_PUBLIC_PROFILE];
