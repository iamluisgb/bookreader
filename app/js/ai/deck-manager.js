// Capa de datos del gestor de mazos (WU2 de "gestor de mazos").
//
// Helpers PUROS y sin DOM que la pantalla "Mazos" (WU3) va a renderizar: agrupar
// mazos por libro (resolviendo la cadena de alias canónica), resumen por mazo
// para la fila de la lista, y validación/construcción/mutación de tarjetas
// creadas A MANO (solo texto: P→R y cloze; las visuales siguen naciendo en
// visual-deck.js).
//
// Sin escrituras en IndexedDB: la pantalla persiste con DB.updateDeck. Las
// mutaciones devuelven un mazo NUEVO sin tocar el original — el caller decide
// cuándo guardar — y ninguna función lanza: la entrada malformada se ignora,
// igual que en deck-repair.js.

import { canonicalOf } from '../sync/aliases.js';
import { normalizeText } from './figures.js';
import { deckStats } from './srs.js';
import { cardsOf } from './db.js';

// Tipos que la creación a mano permite (Fase 2: solo texto). Las visuales
// ('occlusion', 'diagram', 'drawing') nacen del generador, no del formulario.
export const MANUAL_TYPES = ['basic', 'cloze'];

// Un hueco cloze: {{c1::…}} con índice cualquiera y su cierre.
const CLOZE_HOLE = /\{\{c\d+::[\s\S]*\}\}/;

function safeDecks(decks) {
  return (Array.isArray(decks) ? decks : [])
    .filter(d => d && typeof d === 'object' && d.id != null && !d.deleted);
}

// ---------------------------------------------------------------------------
// Agrupación por libro
// ---------------------------------------------------------------------------

// Agrupa cada mazo bajo el libro cuyo id CANÓNICO coincide (ambos lados pasan
// por canonicalOf: un mazo nacido bajo un id alias cae en el grupo del libro,
// no en huérfanos). Los mazos cuyo libro no está en la biblioteca van a
// `orphans`, identificados por el NOMBRE del mazo — el id del libro ya no dice
// nada útil (puede ser legacy o de otra descarga).
//
// Devuelve { groups: [{ bookId, title, decks }], orphans: [{ deckId, name, cards, bookId }] }:
// `groups` por título; dentro de cada grupo por createdAt desc; `orphans` por
// número de tarjetas desc y luego por nombre. Nunca lanza.
export function groupDecks(decks, books) {
  const byCanon = new Map();          // id canónico -> libro (el primero gana)
  for (const b of (Array.isArray(books) ? books : [])) {
    if (!b || typeof b !== 'object' || !b.id) continue;
    const canon = canonicalOf(b.id);
    if (!byCanon.has(canon)) byCanon.set(canon, b);
  }
  const groups = new Map();           // bookId -> grupo
  const orphans = [];
  for (const d of safeDecks(decks)) {
    const book = byCanon.get(canonicalOf(d.bookId));
    if (!book) {
      orphans.push({ deckId: d.id, name: d.name || '', cards: cardsOf(d).length, bookId: d.bookId });
      continue;
    }
    if (!groups.has(book.id)) groups.set(book.id, { bookId: book.id, title: book.title || '', decks: [] });
    groups.get(book.id).decks.push(d);
  }
  const out = [...groups.values()]
    .map(g => ({ ...g, decks: [...g.decks].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) }))
    .sort((a, b) => String(a.title).localeCompare(String(b.title)));
  orphans.sort((a, b) => (b.cards - a.cards) || String(a.name).localeCompare(String(b.name)));
  return { groups: out, orphans };
}

// ---------------------------------------------------------------------------
// Resumen de una fila
// ---------------------------------------------------------------------------

// Resumen para la fila de la lista: los cubos los calcula Srs.deckStats (las
// suspendidas ya no cuentan como vencidas: isDue las excluye); aquí solo se
// suma el desglose por tipo. Tipos desconocidos se cuentan bajo su propio
// nombre; una tarjeta sin `type` cuenta como 'basic'.
export function deckSummary(deck, now = Date.now()) {
  const cards = cardsOf(deck);
  const st = deckStats(cards, now);
  const porTipo = {};
  for (const c of cards) {
    const t = (c && typeof c.type === 'string' && c.type) || 'basic';
    porTipo[t] = (porTipo[t] || 0) + 1;
  }
  return {
    total: st.total, due: st.due, nuevas: st.nuevas, aprendiendo: st.aprendiendo,
    maduras: st.maduras, suspendidas: st.suspendidas, porTipo,
  };
}

// ---------------------------------------------------------------------------
// Tarjeta creada a mano
// ---------------------------------------------------------------------------

// Valida una tarjeta manual. Devuelve { ok: true } o { ok: false, reason } con
// un motivo en inglés corto y ESTABLE (los tests pinian el contrato):
// 'empty-front' | 'bad-type' | 'cloze-without-hole' | 'duplicate'.
// El dorso puede quedar vacío (una tarjeta de solo pregunta vale) y el
// duplicado se compara con normalizeText: ignora tildes, mayúsculas y puntuación.
export function validateCardInput(input, { existingFronts = [] } = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const front = String(src.front ?? '');
  if (!front.trim()) return { ok: false, reason: 'empty-front' };
  if (!MANUAL_TYPES.includes(src.type)) return { ok: false, reason: 'bad-type' };
  if (src.type === 'cloze' && !CLOZE_HOLE.test(front)) return { ok: false, reason: 'cloze-without-hole' };
  const norm = normalizeText(front);
  for (const f of existingFronts || []) {
    if (normalizeText(f) === norm) return { ok: false, reason: 'duplicate' };
  }
  return { ok: true };
}

// Construye la tarjeta persistible. Asume entrada YA validada (no valida):
// chapter/src vacíos (el modal los rellena al generar desde el libro; a mano
// no hay capítulo de origen), uid nuevo y sello updatedAt — db.stampCards
// conserva el uid y el sello en el guardado.
export function makeCard(input, now = Date.now()) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    type: src.type,
    front: String(src.front ?? '').trim(),
    back: String(src.back ?? '').trim(),
    chapter: '',
    src: '',
    uid: crypto.randomUUID(),
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Mutaciones puras de tarjetas
// ---------------------------------------------------------------------------

// Copia del mazo con array de tarjetas nuevo; los objetos de tarjeta se
// reemplazan (no se mutan) en las operaciones que los cambian, porque la
// pantalla mantiene la referencia original hasta que el usuario guarda.
function cloneDeck(deck) {
  if (!deck || typeof deck !== 'object') return deck;
  return { ...deck, cards: Array.isArray(deck.cards) ? [...deck.cards] : [] };
}

function inRange(cards, index) {
  return Number.isInteger(index) && index >= 0 && index < cards.length;
}

// Agrega al final. Índice/entrada inválidos: el mazo vuelve tal cual (copia).
export function addCard(deck, card) {
  const next = cloneDeck(deck);
  if (next && typeof next === 'object' && card && typeof card === 'object') next.cards.push(card);
  return next;
}

export function removeCard(deck, index) {
  const next = cloneDeck(deck);
  if (next && typeof next === 'object' && inRange(next.cards, index)) next.cards.splice(index, 1);
  return next;
}

// Alterna `suspended` (la pantalla persiste el mazo con DB.updateDeck y el
// merge sella por tarjeta). Nunca muta la tarjeta original.
export function toggleSuspendCard(deck, index) {
  const next = cloneDeck(deck);
  if (!next || typeof next !== 'object' || !inRange(next.cards, index)) return next;
  const c = next.cards[index];
  if (c && typeof c === 'object') next.cards[index] = { ...c, suspended: !c.suspended };
  return next;
}

// Edita frente y dorso, recorta espacios y sella `updatedAt` de la tarjeta
// (sin sello el merge por tarjeta pisaría la edición al sincronizar). Las
// demás tarjetas quedan intactas — mismas referencias.
export function updateCardText(deck, index, patch) {
  const next = cloneDeck(deck);
  if (!next || typeof next !== 'object' || !inRange(next.cards, index)) return next;
  const c = next.cards[index];
  if (!c || typeof c !== 'object') return next;
  const p = patch && typeof patch === 'object' ? patch : {};
  next.cards[index] = {
    ...c,
    front: String(p.front ?? c.front ?? '').trim(),
    back: String(p.back ?? c.back ?? '').trim(),
    updatedAt: Date.now(),
  };
  return next;
}
