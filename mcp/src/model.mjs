// model.mjs — la forma en la que salen los datos, una sola para las dos fuentes.
//
// La app tiene DOS representaciones de lo mismo: el backup (`localStorage` aplanado +
// `ai.*`) y el layout de sync (`books/<id>.json` con `local` + stores). Si cada fuente
// hablara su dialecto, la superficie de tools sería la misma solo de nombre. Aquí se
// normaliza una vez: cada fuente construye una `BookEntry` genérica y este módulo la
// convierte en lo que devuelve la tool. Hay un test de paridad que lo comprueba con las dos
// fuentes sobre datos equivalentes.

/**
 * @typedef {Object} BookEntry Lo que cada fuente sabe de un libro, ya sin tombstones.
 * @property {string} id
 * @property {string|null} title
 * @property {Array} highlights
 * @property {Array} bookmarks
 * @property {Array} notes
 * @property {Array} convos
 * @property {number|null} lastPositionAt sello de la última posición de lectura, si lo hay
 * @property {object|null} meta metadatos del agente (título de respaldo), si los hay
 */

/** Un item borrado (tombstone del sync) no se lee nunca: el borrado también viaja. */
export function liveItems(list) {
  return (Array.isArray(list) ? list : []).filter((it) => it && !it.deleted);
}

function stamp(it) {
  return Number(it && (it.updatedAt || it.timestamp || it.ts)) || 0;
}

function maxStamp(items) {
  let max = 0;
  for (const it of items) max = Math.max(max, stamp(it));
  return max;
}

/**
 * Subrayado normalizado. `cfi` se conserva (es la cita del pasaje) y `rects` no (son
 * coordenadas de pintado: ruido para un agente externo).
 */
export function normalizeHighlight(raw, { bookId, bookTitle }) {
  return {
    uid: raw.uid || raw.id || raw.cfi || null,
    bookId,
    bookTitle,
    text: normalizeText(raw.text),
    note: normalizeText(raw.note),
    chapter: raw.chapter || null,
    page: raw.page ?? null,
    color: raw.color || null,
    cfi: raw.cfi || null,
    timestamp: Number(raw.timestamp) || null,
    updatedAt: Number(raw.updatedAt) || null,
  };
}

/**
 * Nota de libreta normalizada. El `fieldKey` viaja con una etiqueta humanizada
 * («por_que_importa» → «Por que importa»): las etiquetas de verdad viven en
 * app/js/ai/templates.js, que no se importa aquí porque tira de i18n y de las plantillas
 * propias del usuario (DOM + localStorage).
 */
export function normalizeNote(raw, { bookId, bookTitle, convo }) {
  return {
    uid: raw.uid || null,
    bookId,
    bookTitle,
    convoId: raw.convoId || null,
    templateId: (convo && convo.templateId) || null,
    goal: normalizeText((convo && convo.goal) || ''),
    fieldKey: raw.fieldKey || null,
    fieldLabel: humanizeFieldKey(raw.fieldKey),
    content: normalizeText(raw.content),
    sourceCfis: Array.isArray(raw.sourceCfis) ? raw.sourceCfis : [],
    ts: Number(raw.ts) || null,
    updatedAt: Number(raw.updatedAt) || null,
  };
}

/**
 * Resumen de un libro para `list_books`: lo que el agente necesita para elegir de qué
 * libro hablar sin bajarse los subrayados de todos.
 *
 * `lastActivityAt` se calcula SIEMPRE del contenido (nunca del `updatedAt` del manifest, que
 * solo tiene una de las dos fuentes): es lo que hace comparables los resultados.
 */
export function summarizeBook(entry) {
  const highlights = liveItems(entry.highlights);
  const bookmarks = liveItems(entry.bookmarks);
  const notes = liveItems(entry.notes);
  const convos = Array.isArray(entry.convos) ? entry.convos : [];
  const lastPositionAt = Number(entry.lastPositionAt) || null;
  const stamps = [
    maxStamp(highlights),
    maxStamp(bookmarks),
    maxStamp(notes),
    maxStamp(convos.map((c) => ({ ts: c.lastUsedAt || c.createdAt }))),
    lastPositionAt || 0,
  ];
  return {
    id: entry.id,
    title: entry.title || (entry.meta && entry.meta.title) || null,
    highlightCount: highlights.length,
    bookmarkCount: bookmarks.length,
    noteCount: notes.length,
    convoCount: convos.length,
    lastReadAt: lastPositionAt,
    lastActivityAt: Math.max(0, ...stamps) || null,
  };
}

/** Quita espacios de sobra y colapsa saltos de línea: los datos vienen del lector. */
export function normalizeText(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

/** «conceptos_frameworks» → «Conceptos frameworks». Sin diccionario: no inventa etiquetas. */
export function humanizeFieldKey(key) {
  const s = String(key || '').replace(/[_-]+/g, ' ').trim();
  if (!s) return null;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Índice bookId → convos, para resolver a qué libro pertenece una nota o un mensaje (los
 * dos pueden venir sin `bookId` y solo con `convoId`).
 */
export function convosByBook(convos) {
  const map = new Map();
  for (const c of Array.isArray(convos) ? convos : []) {
    if (!c || !c.bookId) continue;
    const list = map.get(c.bookId) || [];
    list.push(c);
    map.set(c.bookId, list);
  }
  return map;
}

/** Orden estable de los listados: por título (los sin título al final) y luego por id. */
export function byTitleThenId(a, b) {
  const at = a.title || '\uffff';
  const bt = b.title || '\uffff';
  if (at !== bt) return at < bt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
