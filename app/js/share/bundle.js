// P24 · Formato de intercambio entre lectores. Funciones PURAS: sin DOM, sin IndexedDB,
// sin localStorage. Reciben los registros ya leídos y devuelven el sobre, o al revés.
// Quién lee los stores es share/export.js; quién escribe lo importado, F2.
//
// Un sobre, dos documentos (ver BACKLOG · P24):
//   - dossier: una ESTANTERÍA. N libros, cada uno atado por `bookId` (SHA-256 del
//     fichero): quien tenga el mismo PDF/EPUB recibe las notas ancladas en el pasaje
//     exacto sin que el libro viaje. Un libro suelto es una estantería de uno.
//   - method: perfil + plantilla, sin libro (F3, aún no).
//
// Lo que NO viaja, a propósito:
//   - El fichero del libro. El receptor lo consigue por su cuenta (`source`).
//   - Tombstones, uids, updatedAt: son maquinaria del sync propio. Lo importado vive en
//     un carril aparte y no se fusiona con lo tuyo (en EPUB uid = cfi: mezclarlo pisaría
//     tus subrayados del mismo pasaje).
//   - El estado de repaso de las tarjetas (`srs`): tu calendario no es el suyo.

export const FORMAT = 'bookreader-bundle';
export const VERSION = 1;
export const KINDS = ['dossier'];
export const PARTS = ['highlights', 'notebooks', 'chat', 'artifacts', 'decks'];

// Tope de cordura al leer. Un dossier de una estantería grande con artefactos ronda
// los cientos de KB; 50 MB solo lo pasa algo que no es un dossier.
export const MAX_BYTES = 50 * 1024 * 1024;

const ARXIV_ID = /(?:^|[^\d])(\d{4}\.\d{4,5})(v\d+)?(?:[^\d]|$)/;

// Enlace de origen de un libro. Es lo que hace funcionar los papers: el receptor
// descarga el mismo PDF, el hash coincide y las notas se pintan. Si el registro ya
// trae `source` manda ese; si no, se intenta reconocer un id de arXiv en el nombre del
// fichero ("2401.12345v2.pdf"), que es como se bajan casi todos.
export function sourceOf(book) {
  if (book?.source && /^https?:\/\//i.test(book.source)) return book.source;
  if (book?.format !== 'pdf') return null;
  const m = ARXIV_ID.exec(book?.fileName || '');
  return m ? `https://arxiv.org/abs/${m[1]}${m[2] || ''}` : null;
}

const live = (arr) => (arr || []).filter(x => x && !x.deleted);

function highlightOut(h) {
  const out = { text: h.text || '', color: h.color || null, note: h.note || '', chapter: h.chapter || '' };
  if (h.cfi) out.cfi = h.cfi;
  if (h.page != null) { out.page = h.page; out.rects = h.rects || []; }
  if (h.timestamp) out.ts = h.timestamp;
  return out;
}

function notebookOut(convo, notes, messages, withChat) {
  const out = {
    templateId: convo.templateId,
    title: convo.title || null,
    goal: convo.goal || '',
    createdAt: convo.createdAt || null,
    notes: live(notes).map(n => ({
      fieldKey: n.fieldKey, content: n.content || '',
      sourceCfis: n.sourceCfis || [], ts: n.ts || null,
    })),
  };
  if (withChat) out.messages = (messages || []).map(m => ({ role: m.role, content: m.content || '', ts: m.ts || null }));
  return out;
}

function artifactOut(a) {
  return { kind: a.kind, result: a.result, params: a.params || {}, segVersion: a.segVersion, createdAt: a.createdAt || null };
}

function deckOut(d) {
  return {
    name: d.name || '', cardType: d.cardType || null, scope: d.scope || null, createdAt: d.createdAt || null,
    // Sin `srs` (calendario propio), sin uid/updatedAt (sync propio).
    cards: live(d.cards).map(({ srs: _s, uid: _u, updatedAt: _t, ...card }) => card),
  };
}

// ¿Qué notebooks hay que llevar con plantilla incrustada? Las de fábrica las tiene todo
// el mundo; una `custom` no, y sin su definición los `fieldKey` no se pueden pintar.
function templatesUsed(books, customTemplates) {
  const ids = new Set();
  for (const b of books) for (const nb of b.notebooks || []) ids.add(nb.templateId);
  return (customTemplates || []).filter(t => ids.has(t.id)).map(t => ({ ...t }));
}

// Construye el dossier.
//   shelf: { name }
//   books: [{ book, highlights, convos: [{ convo, notes, messages }], artifacts, decks }]
//          — `book` es el registro de la biblioteca (o de la capa IA si no está en ella).
//   parts: subconjunto de PARTS.
//   customTemplates: las plantillas propias del usuario (para incrustar las usadas).
export function build({ shelf, books, parts = PARTS, author = '', customTemplates = [], now = Date.now() }) {
  const want = new Set(parts);
  const outBooks = (books || []).map(({ book, highlights, convos, artifacts, decks }) => {
    const b = {
      bookId: book.id,
      title: book.title || '',
      author: book.author || '',
      format: book.format || null,
      source: sourceOf(book),
    };
    if (want.has('highlights')) b.highlights = live(highlights).map(highlightOut);
    if (want.has('notebooks')) {
      b.notebooks = (convos || [])
        .map(({ convo, notes, messages }) => notebookOut(convo, notes, messages, want.has('chat')))
        .filter(nb => nb.notes.length || nb.messages?.length);
    }
    if (want.has('artifacts')) b.artifacts = live(artifacts).filter(a => a.result != null).map(artifactOut);
    if (want.has('decks')) b.decks = live(decks).map(deckOut).filter(d => d.cards.length);
    return b;
  });
  return {
    format: FORMAT,
    version: VERSION,
    kind: 'dossier',
    exportedAt: new Date(now).toISOString(),
    author: String(author || '').trim().slice(0, 80),
    shelf: { name: String(shelf?.name || '').trim() || 'Estantería' },
    parts: PARTS.filter(p => want.has(p)),
    templates: templatesUsed(outBooks, customTemplates),
    books: outBooks,
  };
}

// Cuánto contenido lleva un dossier, por libro y total. Lo usa el diálogo de exportar
// (para no mandar un fichero vacío sin avisar) y la vista de importar.
export function counts(bundle) {
  const per = (bundle?.books || []).map(b => ({
    bookId: b.bookId,
    highlights: (b.highlights || []).length,
    notes: (b.notebooks || []).reduce((n, nb) => n + nb.notes.length, 0),
    artifacts: (b.artifacts || []).length,
    cards: (b.decks || []).reduce((n, d) => n + d.cards.length, 0),
  }));
  const total = per.reduce((acc, c) => {
    for (const k of ['highlights', 'notes', 'artifacts', 'cards']) acc[k] += c[k];
    return acc;
  }, { highlights: 0, notes: 0, artifacts: 0, cards: 0 });
  return { per, total, empty: !Object.values(total).some(Boolean) };
}

// Nombre de fichero: «knowledge-graphs.bookreader». Lo que cuenta es que la extensión
// sea reconocible en un chat; el contenido es JSON.
export function filename(bundle) {
  const slug = (bundle?.shelf?.name || 'estanteria')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${slug || 'estanteria'}.bookreader`;
}

export function serialize(bundle) {
  return JSON.stringify(bundle);
}

// Devuelve la lista de problemas (vacía = válido). Es una frontera de confianza: el
// fichero viene de otra persona. Importar es DATOS, nunca ejecución, y lo que no encaje
// con la forma esperada se rechaza en vez de "arreglarse" a medias.
export function validate(obj) {
  const errs = [];
  const isStr = (v) => typeof v === 'string';
  if (!obj || typeof obj !== 'object') return ['no es un objeto'];
  if (obj.format !== FORMAT) errs.push('formato desconocido');
  if (!Number.isInteger(obj.version) || obj.version < 1) errs.push('versión inválida');
  else if (obj.version > VERSION) errs.push(`versión ${obj.version} posterior a la soportada (${VERSION})`);
  if (!KINDS.includes(obj.kind)) errs.push(`tipo «${obj.kind}» no soportado`);
  if (!Array.isArray(obj.books)) { errs.push('falta la lista de libros'); return errs; }
  if (obj.templates != null && !Array.isArray(obj.templates)) errs.push('plantillas inválidas');
  obj.books.forEach((b, i) => {
    const at = `libro ${i + 1}`;
    if (!b || typeof b !== 'object') { errs.push(`${at}: no es un objeto`); return; }
    if (!isStr(b.bookId) || !/^[0-9a-f]{64}$/.test(b.bookId)) errs.push(`${at}: bookId inválido`);
    if (!isStr(b.title)) errs.push(`${at}: título inválido`);
    if (b.source != null && !(isStr(b.source) && /^https?:\/\//i.test(b.source))) errs.push(`${at}: enlace de origen inválido`);
    for (const k of ['highlights', 'notebooks', 'artifacts', 'decks']) {
      if (b[k] != null && !Array.isArray(b[k])) errs.push(`${at}: ${k} no es una lista`);
    }
    (b.highlights || []).forEach((h, j) => {
      if (!h || !isStr(h.text)) errs.push(`${at}, subrayado ${j + 1}: sin texto`);
      else if (h.cfi == null && h.page == null) errs.push(`${at}, subrayado ${j + 1}: sin ancla`);
    });
    (b.notebooks || []).forEach((nb, j) => {
      if (!nb || !isStr(nb.templateId) || !Array.isArray(nb.notes)) errs.push(`${at}, libreta ${j + 1}: inválida`);
      else if (nb.notes.some(n => !n || !isStr(n.fieldKey) || !isStr(n.content))) errs.push(`${at}, libreta ${j + 1}: nota inválida`);
    });
    (b.artifacts || []).forEach((a, j) => {
      if (!a || !isStr(a.kind) || a.result == null) errs.push(`${at}, artefacto ${j + 1}: inválido`);
    });
    (b.decks || []).forEach((d, j) => {
      if (!d || !Array.isArray(d.cards)) errs.push(`${at}, mazo ${j + 1}: inválido`);
    });
  });
  return errs;
}

// Texto → dossier validado. Lanza con la lista de problemas si no lo es.
export function parse(text) {
  if (typeof text !== 'string') throw new Error('El fichero no es texto.');
  if (text.length > MAX_BYTES) throw new Error('El fichero es demasiado grande para ser un dossier.');
  let obj;
  try { obj = JSON.parse(text); } catch (cause) { throw new Error('El fichero no es un dossier de BookReader (JSON inválido).', { cause }); }
  const errs = validate(obj);
  if (errs.length) {
    const e = new Error('Dossier inválido: ' + errs.slice(0, 5).join('; ') + (errs.length > 5 ? '…' : ''));
    e.problems = errs;
    throw e;
  }
  return obj;
}
