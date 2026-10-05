// WebMCP (experimental) · BookReader como herramienta de un agente del navegador.
//
// WebMCP deja que una página declare herramientas que un agente que vive en el navegador
// puede llamar («dame los subrayados de tal libro»). La función corre AQUÍ, en esta pestaña,
// sobre los datos locales (IndexedDB/localStorage): no hay servidor ni nada que subir.
//
// Estado (2026-10): borrador del W3C Community Group; Chrome lo trae tras una opción
// experimental / origin trial y ningún agente de uso general lo consume aún (Gemini en Chrome,
// anunciado). La API se movió de `navigator.modelContext` a `document.modelContext`: se mira
// en los dos sitios.
//
// Reglas:
//  - SOLO LECTURA. Ninguna herramienta crea, cambia ni borra nada.
//  - Apagado por defecto: se registra solo si el navegador lo soporta Y el usuario lo activó
//    (Ajustes → Aplicación). Exponer tu biblioteca a un agente es una decisión tuya.
//  - Las herramientas existen mientras la pestaña de BookReader está abierta (es una web).
import * as Storage from './storage.js';

export const PREF = 'webmcp_enabled';

export function modelContext() {
  if (typeof document !== 'undefined' && document.modelContext) return document.modelContext;
  if (typeof navigator !== 'undefined' && navigator.modelContext) return navigator.modelContext;
  return null;
}
export const isSupported = () => !!modelContext();
export const isEnabled = () => Storage.get(PREF, false) === true;

const text = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] });
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

async function allBooks() {
  const Lib = await import('./library/store.js');
  return (await Lib.getAllBooks()).filter((b) => !b.deleted);
}

// Libro por id o por título (también el original del fichero). Ambiguo o sin coincidencia:
// error con candidatos, para que el agente pregunte o afine en vez de adivinar.
async function resolveBook(ref) {
  const books = await allBooks();
  const r = String(ref || '').trim();
  const byId = books.find((b) => b.id === r);
  if (byId) return { book: byId };
  const q = norm(r);
  const hits = books.filter((b) => [b.title, b.origTitle].some((t) => norm(t).includes(q)));
  const exact = hits.filter((b) => norm(b.title) === q);
  if (exact.length === 1) return { book: exact[0] };
  if (hits.length === 1) return { book: hits[0] };
  return { error: hits.length ? 'ambiguous' : 'not_found', candidates: (hits.length ? hits : books).slice(0, 15).map((b) => ({ id: b.id, title: b.title, author: b.author || '' })) };
}

async function highlightsOf(bookId) {
  const { canonicalOf } = await import('./sync/aliases.js');
  const keys = [...new Set([bookId, canonicalOf(bookId)])];
  const out = [];
  for (const k of keys) for (const h of Storage.get('highlights_' + k, []) || []) if (h && !h.deleted) out.push(h);
  const seen = new Set();
  return out.filter((h) => { const id = h.uid || h.id; if (seen.has(id)) return false; seen.add(id); return true; })
    .map((h) => ({ text: h.text, note: h.note || '', chapter: h.chapter || '', page: h.page ?? null, color: h.color || '', createdAt: h.timestamp || h.updatedAt || null }));
}

async function notebookMarkdown(bookId) {
  const DB = await import('./ai/db.js');
  const Backup = await import('./backup.js');
  const convos = ((await DB.getConvos(bookId)) || []).filter((c) => !c.deleted);
  const parts = [];
  for (const c of convos) parts.push(await Backup.buildConvoMarkdown(c.id, { includeChat: false, includeNotebook: true }));
  return parts.join('\n\n---\n\n');
}

// Markdown del libro listo para una base de conocimiento (Obsidian, Logseq, Notion):
// frontmatter, subrayados con sus notas y la libreta.
export async function bookMarkdown(book) {
  const hl = await highlightsOf(book.id);
  const yaml = (s) => JSON.stringify(String(s || ''));
  const out = ['---', `title: ${yaml(book.title)}`, `author: ${yaml(book.author)}`, 'source: BookReader',
    `progress: ${Math.round(book.progress || 0)}`, 'tags: [libro, bookreader]', '---', '', `# ${book.title || 'Libro'}`, ''];
  if (book.author) out.push(`*${book.author}*`, '');
  if (hl.length) {
    out.push('## Subrayados', '');
    for (const h of hl) {
      const where = [h.chapter, h.page != null ? `p. ${h.page}` : ''].filter(Boolean).join(' · ');
      out.push(`> ${String(h.text || '').replace(/\s+/g, ' ').trim()}`);
      if (where) out.push(`> — ${where}`);
      if (h.note) out.push('', h.note.trim());
      out.push('');
    }
  }
  const nb = await notebookMarkdown(book.id);
  if (nb.trim()) out.push('## Libreta', '', nb.replace(/^# .*\n/, '').trim(), '');
  return out.join('\n');
}

// Pasajes del libro (el texto segmentado que usa el agente) que contienen los términos.
async function searchBook(bookId, query, limit) {
  const DB = await import('./ai/db.js');
  const rec = await DB.get('bookText', bookId);
  if (!rec?.annotatedText) return null;
  const terms = norm(query).split(/\s+/).filter((w) => w.length > 2);
  if (!terms.length) return [];
  const hits = [];
  let chapter = '';
  for (const line of rec.annotatedText.split('\n')) {
    const h = /^## (.*)$/.exec(line);
    if (h) { chapter = h[1].trim(); continue; }
    const m = /^\[\[(a\d+)\]\]\s*(.*)$/.exec(line);
    if (!m) continue;
    const t = norm(m[2]);
    const score = terms.filter((w) => t.includes(w)).length;
    if (score) hits.push({ score, chapter, text: m[2] });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit).map(({ chapter, text }) => ({ chapter, text }));
}

const BOOK_ARG = { type: 'string', description: 'Título del libro (o parte de él) o su id. Si no lo sabes, usa list_books.' };

export const TOOLS = [
  {
    name: 'list_books',
    description: 'Lista los libros de la biblioteca del usuario en BookReader (título, autor, progreso y cuántos subrayados tiene). Filtra por texto en el título si se da `query`.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Texto a buscar en el título (opcional).' } } },
    async execute({ query = '' } = {}) {
      const q = norm(query);
      const books = (await allBooks()).filter((b) => !q || [b.title, b.origTitle, b.author].some((t) => norm(t).includes(q)));
      const rows = [];
      for (const b of books.slice(0, 100)) rows.push({ id: b.id, title: b.title, author: b.author || '', progress: Math.round(b.progress || 0), status: b.status || 'unread', highlights: (await highlightsOf(b.id)).length });
      return text(rows);
    },
  },
  {
    name: 'get_highlights',
    description: 'Devuelve los subrayados de un libro con sus notas, capítulo o página.',
    inputSchema: { type: 'object', properties: { book: BOOK_ARG }, required: ['book'] },
    async execute({ book }) {
      const r = await resolveBook(book);
      if (r.error) return text({ error: r.error, candidates: r.candidates });
      return text({ book: { id: r.book.id, title: r.book.title, author: r.book.author || '' }, highlights: await highlightsOf(r.book.id) });
    },
  },
  {
    name: 'get_notebook',
    description: 'Devuelve en Markdown la libreta de un libro: lo que el usuario y el agente apuntaron al leerlo, por campos de su plantilla.',
    inputSchema: { type: 'object', properties: { book: BOOK_ARG }, required: ['book'] },
    async execute({ book }) {
      const r = await resolveBook(book);
      if (r.error) return text({ error: r.error, candidates: r.candidates });
      const md = await notebookMarkdown(r.book.id);
      return text(md.trim() || `«${r.book.title}» no tiene libreta todavía.`);
    },
  },
  {
    name: 'search_book',
    description: 'Busca pasajes del texto de un libro que contengan los términos dados. Solo funciona con libros que el agente de BookReader ya ha preparado (abiertos con el agente al menos una vez).',
    inputSchema: { type: 'object', properties: { book: BOOK_ARG, query: { type: 'string', description: 'Términos a buscar.' }, limit: { type: 'number', description: 'Máximo de pasajes (por defecto 8).' } }, required: ['book', 'query'] },
    async execute({ book, query, limit = 8 }) {
      const r = await resolveBook(book);
      if (r.error) return text({ error: r.error, candidates: r.candidates });
      const hits = await searchBook(r.book.id, query, Math.min(Math.max(1, Number(limit) || 8), 30));
      if (hits === null) return text({ error: 'not_prepared', message: `«${r.book.title}» aún no está preparado para buscar: ábrelo en BookReader con el agente una vez.` });
      return text({ book: r.book.title, passages: hits });
    },
  },
  {
    name: 'export_markdown',
    description: 'Exporta un libro a Markdown listo para una base de conocimiento (Obsidian, Logseq, Notion): metadatos, subrayados con notas y libreta.',
    inputSchema: { type: 'object', properties: { book: BOOK_ARG }, required: ['book'] },
    async execute({ book }) {
      const r = await resolveBook(book);
      if (r.error) return text({ error: r.error, candidates: r.candidates });
      return text(await bookMarkdown(r.book));
    },
  },
];

let registered = [];

export function register() {
  const mc = modelContext();
  if (!mc || registered.length) return 0;
  for (const tool of TOOLS) {
    try {
      const handle = mc.registerTool({ ...tool, annotations: { readOnlyHint: true } });
      registered.push({ name: tool.name, handle });
    } catch (e) { console.warn('WebMCP: no se pudo registrar', tool.name, e); }
  }
  return registered.length;
}

export function unregister() {
  const mc = modelContext();
  for (const { name, handle } of registered) {
    try {
      if (typeof handle === 'function') handle();
      else if (handle && typeof handle.unregister === 'function') handle.unregister();
      else mc?.unregisterTool?.(name);
    } catch { /* ya no estaba */ }
  }
  registered = [];
}

export function setEnabled(on) {
  Storage.set(PREF, !!on);
  if (on) register(); else unregister();
}

// Arranque: no hace nada si el navegador no lo soporta o el usuario no lo activó.
export function init() {
  if (isSupported() && isEnabled()) register();
}
