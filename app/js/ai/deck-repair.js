// Reparación de identidad de mazos (WU1 de "gestor de mazos").
//
// Un mazo guarda el bookId con el que se creó y nunca lo actualizaba. La
// biblioteca sí migra identidades (hash del fichero; alias canónico cuando el
// mismo libro se re-descarga de otro mirror), y aliases.reconcile() remapeaba
// SOLO subrayados y marcadores: el mazo quedaba HUÉRFANO — sus vencidas
// seguían contando en el total de repaso (studyScopes), pero ninguna fila del
// libro ni el modal de flashcards lo alcanzaban. Síntoma reportado: borrar un
// libro y volver a descargarlo dejaba sus tarjetas sin dueño visible.
//
// Reparación por TÍTULO, independiente del id: si el nombre del mazo,
// normalizado con normTitle, coincide con el título de EXACTAMENTE UN libro de
// la biblioteca, se reasigna. Con dos libros del mismo título no se adivina —
// la ambigüedad es una decisión del usuario (reparación manual: Fase 2).
//
// El matcher es puro y DOM-free a propósito: los tests lo importan dentro de la
// página y la orquestación no toca nada de la interfaz.

import * as DB from './db.js';
import * as LibStore from '../library/store.js';
import { canonicalOf, normTitle } from '../sync/aliases.js';

// Huérfanos con sus candidatos: [{ deck, candidates }]. Un mazo es huérfano
// cuando su bookId —resuelto por la cadena de alias— no corresponde a ningún
// libro de la biblioteca. Nunca lanza: las entradas malformadas se ignoran.
function analyzeDecks(decks, books) {
  const safeBooks = (Array.isArray(books) ? books : [])
    .filter(b => b && typeof b === 'object' && b.id);
  const byTitle = new Map();
  for (const b of safeBooks) {
    const t = normTitle(b.title || '');
    if (!t) continue;
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push(b);
  }
  // Ids canónicos de la biblioteca: un mazo cuyo bookId resuelve a uno de
  // estos (directamente o vía alias) ya tiene dueño.
  const canonIds = new Set(safeBooks.map(b => canonicalOf(b.id)));
  const orphans = [];
  for (const d of (Array.isArray(decks) ? decks : [])) {
    if (!d || typeof d !== 'object' || d.id == null || d.deleted) continue;
    if (canonIds.has(canonicalOf(d.bookId))) continue;
    const t = normTitle(d.name || '');
    if (!t) continue;
    orphans.push({ deck: d, candidates: byTitle.get(t) || [] });
  }
  return orphans;
}

// Puro: propuestas de reasignación [{ deckId, uid, bookId, from, name }],
// ordenadas por deckId. Solo propone cuando el título normalizado del mazo
// coincide con EXACTAMENTE UN libro — si hay dos con el mismo título, la
// ambigüedad nunca se adivina. Nunca lanza.
export function matchDecksByTitle(decks, books) {
  try {
    return analyzeDecks(decks, books)
      .filter(x => x.candidates.length === 1)
      .map(({ deck, candidates }) => ({
        deckId: deck.id, uid: deck.uid, bookId: candidates[0].id, from: deck.bookId, name: deck.name,
      }))
      .sort((a, b) => (a.deckId < b.deckId ? -1 : a.deckId > b.deckId ? 1 : 0));
  } catch {
    return [];
  }
}

// Orquesta la reparación al arrancar: lee mazos y libros, aplica las
// propuestas con DB.remapDecks y devuelve
//   { repaired: [{ deckId, name, bookId }], skipped, orphans }
// donde `skipped` son los huérfanos sin match único y `orphans` el total de
// huérfanos. Nunca lanza: si algo falla devuelve ceros y el error.
export async function repairOrphanDecks({ books } = {}) {
  try {
    const [decks, libs] = await Promise.all([
      DB.getAllDecks(),
      books ?? LibStore.getAllBooks(),
    ]);
    const analysis = analyzeDecks(decks, libs);
    const proposals = analysis.filter(x => x.candidates.length === 1);
    for (const { deck, candidates } of proposals) {
      await DB.remapDecks(deck.bookId, candidates[0].id);
    }
    return {
      repaired: proposals.map(({ deck, candidates }) => ({
        deckId: deck.id, name: deck.name, bookId: candidates[0].id,
      })),
      skipped: analysis.length - proposals.length,
      orphans: analysis.length,
    };
  } catch (e) {
    return { repaired: [], skipped: 0, orphans: 0, error: e };
  }
}
