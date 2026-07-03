// P5 · Búsqueda de texto en el libro. Reutiliza el CORPUS SEGMENTADO que ya construimos para
// el agente (`annotatedText` con pasajes `[[aN]]` + mapa de anclas), así que funciona igual en
// EPUB (ancla→CFI) y PDF (ancla→página) con un solo camino, sin re-indexar nada.
//
// Función pura y testable: no toca el DOM ni el lector. Devuelve las coincidencias con su
// locator (cfi o página), el capítulo y un fragmento con la parte que casa aislada.

const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const CTX = 42;   // caracteres de contexto a cada lado del match en el fragmento

export function searchPassages(annotatedText, anchors, query, { limit = 100 } = {}) {
  const q = norm(query).trim();
  if (q.length < 2) return [];
  const get = (id) => (anchors && anchors.get ? anchors.get(id) : anchors?.[id]) || null;

  const results = [];
  let chapter = '';
  for (const line of (annotatedText || '').split('\n')) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) { chapter = h[1].trim(); continue; }
    const m = /^\[\[(a\d+)\]\]\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, id, text] = m;
    const idx = norm(text).indexOf(q);
    if (idx < 0) continue;

    const a = get(id);
    const start = Math.max(0, idx - CTX);
    const end = Math.min(text.length, idx + query.length + CTX);
    results.push({
      id,
      chapter,
      loc: a ? (a.cfi ?? a.page ?? null) : null,
      page: a?.page ?? null,
      before: (start > 0 ? '…' : '') + text.slice(start, idx),
      match: text.slice(idx, idx + query.length),
      after: text.slice(idx + query.length, end) + (end < text.length ? '…' : ''),
    });
    if (results.length >= limit) break;
  }
  return results;
}
