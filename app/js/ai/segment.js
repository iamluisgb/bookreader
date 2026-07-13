// Segmentador: recorre el EPUB y produce el "libro anotado" con anclas [[aN]] y
// un mapa anchorId -> CFI para resolver citas. Reemplaza al chunking/embeddings.
// E2.1 + E2.2 del backlog (validado en el spike E0.2).

const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote';
const HEADINGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

// Devuelve { annotatedText, anchors: Map<id,{cfi,chapter}>, tokenEstimate, blockCount }.
export async function segmentBook(book, onProgress) {
  await book.ready;
  const anchors = new Map();
  const lines = [];
  let n = 0;
  let currentChapter = '';

  const spineLen = book.spine.length;
  for (let i = 0; i < spineLen; i++) {
    const section = book.spine.get(i);
    if (!section) continue;
    try {
      await section.load(book.load.bind(book));
      const doc = section.document;
      if (!doc || !doc.body) { section.unload?.(); continue; }

      // Título de capítulo: etiqueta del TOC para este href si existe.
      const tocLabel = findTocLabel(book, section.href);
      if (tocLabel) { currentChapter = tocLabel; lines.push(`\n## ${tocLabel}`); }

      const blocks = doc.body.querySelectorAll(BLOCK_SELECTOR);
      for (const el of blocks) {
        const text = collapse(el.textContent);
        if (!text || text.length < 2) continue;

        if (HEADINGS.has(el.tagName)) {
          currentChapter = text;
          lines.push(`\n## ${text}`);
          continue;
        }

        // CFI de RANGO sobre el texto del bloque (no de elemento): así la cita
        // resalta el TROZO exacto, no solo navega al bloque. Fallback al CFI de
        // elemento si el rango falla (algunos EPUB no lo permiten).
        let cfi = null;
        try {
          const range = doc.createRange();
          range.selectNodeContents(el);
          cfi = section.cfiFromRange(range);
        } catch { /* rango sin cfi */ }
        if (!cfi) { try { cfi = section.cfiFromElement(el); } catch { /* sin cfi para este nodo */ } }
        const id = 'a' + (n++);
        // Registrar SIEMPRE el ancla: si el CFI falla (ocurre en algunos EPUB, a veces
        // en TODOS los bloques), antes el id quedaba en el texto pero NO en el mapa →
        // el agente lo citaba y salía crudo «[[aN]]». Con href/capítulo la cita al menos
        // navega al capítulo aunque no haya CFI puntual.
        anchors.set(id, { cfi: cfi || null, chapter: currentChapter, href: section.href });
        lines.push(`[[${id}]] ${text}`);
      }
      section.unload?.();
    } catch (e) {
      console.warn('Segmentación: fallo en sección', i, e);
      section.unload?.();
    }
    if (onProgress) onProgress(i + 1, spineLen);
  }

  const annotatedText = lines.join('\n').trim();
  return {
    annotatedText,
    anchors,
    blockCount: n,
    tokenEstimate: Math.round(annotatedText.length / 4),
  };
}

function collapse(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

function findTocLabel(book, href) {
  const toc = book.navigation?.toc;
  if (!toc) return null;
  const base = href.split('#')[0].split('/').pop();
  const hit = toc.find(t => {
    const th = (t.href || '').split('#')[0].split('/').pop();
    return th && base && th === base;
  });
  return hit ? hit.label.trim() : null;
}
