// Recorte de contexto al LLM (IA1). En vez de mandar el libro anotado ENTERO en
// cada turno, seleccionamos solo los capítulos relevantes para el objetivo usando
// la relevancia por capítulo que ya se calcula (DB.getRatings). Retrieval por
// OBJETIVO (una selección por conversación), no por pregunta: ~80% del beneficio
// sin necesidad de embeddings. Ver decisión de IA1 en el CHANGELOG.
//
// El texto anotado viene troceado con marcadores `\n## <capítulo>` y pasajes
// `[[aN]] texto` (ver segment.js). Aquí se agrupa por capítulo del TOC, se puntúa
// cada uno y se seleccionan por PRESUPUESTO de tokens (no por umbral duro).

export const DEFAULT_BUDGET_TOKENS = 60000;   // tope de contexto de libro por turno

// Estimación barata de tokens (~4 chars/token), igual que segment.js.
export function estimateTokens(s) {
  return Math.round((s || '').length / 4);
}

// Selecciona los capítulos relevantes del libro anotado.
//   annotatedText : el libro con marcadores `## cap` y anclas `[[aN]]`.
//   scores        : { [etiquetaCapítulo]: 0..1 } o null/undefined.
//   opts.tocLabels: etiquetas de capítulo del TOC (para distinguir capítulos
//                   reales de subtítulos internos, que se pliegan a su capítulo).
//   opts.currentChapter : capítulo donde está el lector (inclusión FORZADA).
//   opts.budgetTokens   : tope de tokens de libro.
// Devuelve { text, filtered, tokens, total, kept:[], dropped:[] }.
export function selectContext(annotatedText, scores, opts = {}) {
  const { tocLabels = [], currentChapter = '', budgetTokens = DEFAULT_BUDGET_TOKENS } = opts;
  const total = estimateTokens(annotatedText);

  // Sin puntuaciones todavía (conversación recién creada): se manda el libro
  // entero, como antes. Cero regresión; el siguiente turno ya filtrará.
  if (!scores || !Object.keys(scores).length) {
    return { text: annotatedText, filtered: false, tokens: total, total, kept: [], dropped: [] };
  }

  const tocSet = new Set(tocLabels.map(s => (s || '').trim()).filter(Boolean));
  const forced = new Set([currentChapter].map(s => (s || '').trim()).filter(Boolean));

  // Agrupar líneas por capítulo del TOC. Un `## X` con X en el TOC abre capítulo;
  // un `## Y` que no está en el TOC es un subtítulo interno → pertenece al capítulo
  // en curso (hereda su relevancia). Lo anterior al primer capítulo = front matter.
  const lines = annotatedText.split('\n');
  const segments = [{ chapter: null, lines: [] }];
  let cur = segments[0];
  for (const line of lines) {
    const m = /^##\s+(.*)$/.exec(line);
    if (m && tocSet.has(m[1].trim())) {
      cur = { chapter: m[1].trim(), lines: [] };
      segments.push(cur);
    }
    cur.lines.push(line);
  }

  const items = segments.map((s, i) => {
    const text = s.lines.join('\n');
    const known = s.chapter != null && Object.prototype.hasOwnProperty.call(scores, s.chapter);
    // Obligatorios (siempre): front matter, capítulo actual, y capítulos del TOC
    // que el modelo no llegó a puntuar (no se descarta lo que no se puede juzgar).
    const mandatory = s.chapter == null || forced.has(s.chapter) || !known;
    return { i, text, tokens: estimateTokens(text), chapter: s.chapter, score: known ? scores[s.chapter] : 1, mandatory };
  });

  const keep = new Set();
  let used = 0;
  for (const it of items) if (it.mandatory) { keep.add(it.i); used += it.tokens; }
  // Los opcionales (capítulos puntuados) entran por relevancia descendente hasta el tope.
  const optional = items.filter(it => !it.mandatory).sort((a, b) => b.score - a.score);
  for (const it of optional) {
    if (used + it.tokens > budgetTokens) continue;   // no cabe → prueba el siguiente (más corto)
    keep.add(it.i);
    used += it.tokens;
  }

  const text = items.filter(it => keep.has(it.i)).map(it => it.text).join('\n').trim();
  const kept = items.filter(it => keep.has(it.i) && it.chapter).map(it => it.chapter);
  const dropped = items.filter(it => !keep.has(it.i) && it.chapter).map(it => it.chapter);
  // Si por lo que sea no quedara nada, caemos al libro entero (seguridad).
  if (!text) return { text: annotatedText, filtered: false, tokens: total, total, kept: [], dropped: [] };
  return { text, filtered: true, tokens: used, total, kept, dropped };
}
