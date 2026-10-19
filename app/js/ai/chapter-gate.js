// Las tarjetas NUEVAS de un capítulo no entran en el repaso hasta que lo has leído.
// Módulo PURO (sin DOM, sin IDB).
//
// Por qué: el plan por capítulos genera tarjetas de todo el libro de una vez, y el repaso del día
// las mezclaba con lo leído. Repasar un capítulo que no has abierto es adivinar; con las preguntas
// con opciones, además, ensucia la medida de si enseñan (P43 F4).
//
// Qué es «leído»: un capítulo que ya quedó ATRÁS. Al entrar en un capítulo del índice, todos los
// anteriores en el orden del índice se dan por leídos (`advance`); el que lees ahora todavía no,
// igual que el repaso de capítulo del panel (ADR-013). Un libro terminado lo desbloquea todo.
//
// En la ficha del libro (sincronizada):
//   chapterOrder: etiquetas del índice, en orden (aplanado, con subcapítulos)
//   chaptersDone: etiquetas ya leídas
// Sin `chapterOrder` (PDF, o un EPUB que no has vuelto a abrir) no se filtra nada: mejor una
// tarjeta de más que esconder las de un libro del que no sabemos nada.

const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

// Etiquetas del índice de epub.js, en orden de lectura, sin repetidas.
export function flattenToc(items, out = []) {
  for (const it of items || []) {
    const label = String(it && it.label || '').trim();
    if (label && !out.includes(label)) out.push(label);
    if (it && it.subitems) flattenToc(it.subitems, out);
  }
  return out;
}

// Ficha después de entrar en `current`. Devuelve null si no cambia nada (para no escribir). Solo
// suma: volver atrás no «des-lee» lo que ya quedó atrás.
export function advance(book, order, current) {
  if (!Array.isArray(order) || !order.length) return null;
  const idx = order.findIndex((l) => norm(l) === norm(current));
  if (idx < 0) return null;
  const prev = Array.isArray(book?.chaptersDone) ? book.chaptersDone : [];
  const have = new Set(prev.map(norm));
  const done = [...prev];
  for (const l of order.slice(0, idx)) if (!have.has(norm(l))) { done.push(l); have.add(norm(l)); }
  const sameOrder = JSON.stringify(book?.chapterOrder || null) === JSON.stringify(order);
  if (sameOrder && done.length === prev.length) return null;
  return { chapterOrder: order, chaptersDone: done };
}

// ¿Está bloqueada esta tarjeta? Solo las nuevas (las empezadas siguen su calendario) y solo si su
// capítulo (el de la tarjeta o, si no lo tiene, el del mazo) es una entrada del índice que aún no
// has dejado atrás.
export function isLocked(card, deck, book) {
  if (!card || !book || book.status === 'finished' || !Array.isArray(book.chapterOrder)) return false;
  if (card.srs && card.srs.reps > 0) return false;
  const ch = norm(card.chapter || deck?.scope);
  if (!ch) return false;
  if (!book.chapterOrder.some((l) => norm(l) === ch)) return false;
  return !(book.chaptersDone || []).some((l) => norm(l) === ch);
}

// Función de bloqueo para un conjunto de fichas, por id de libro (canónico o no: lo resuelve
// quien llama con `idOf`). Lo que no tenga ficha, sin bloqueo.
export function lockerFor(books, idOf = (x) => x) {
  const byId = new Map((books || []).filter((b) => b && b.id).map((b) => [idOf(b.id), b]));
  return (card, deck) => isLocked(card, deck, byId.get(idOf(deck?.bookId)));
}
