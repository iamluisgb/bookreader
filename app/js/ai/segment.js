// Segmentador: recorre el EPUB y produce el "libro anotado" con anclas [[aN]] y
// un mapa anchorId -> CFI para resolver citas. Reemplaza al chunking/embeddings.
// E2.1 + E2.2 del backlog (validado en el spike E0.2).

const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote';
// OJO con la caja: los capítulos de un EPUB se parsean como XHTML (XML), y ahí `tagName`
// CONSERVA la caja del documento ('h2') en vez de normalizarla a mayúsculas como en HTML.
// Con un Set de mayúsculas la comparación no casaba NUNCA: ningún encabezado interno se
// reconocía como tal y todos se colaban como párrafo corriente. De ahí que el libro anotado
// no tuviera fronteras de sección y `retrieval.sectionsByChapter` viniera siempre vacío.
const HEADING_RE = /^h[1-6]$/i;

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

        // Un encabezado marca frontera (`## texto`) PERO sigue siendo un pasaje con su
        // ancla: así el índice conserva su texto (un título es buena señal para BM25) y
        // la numeración de anclas no se mueve — las citas ya guardadas siguen valiendo.
        // El encabezado solo hace de capítulo si la sección no traía etiqueta del TOC.
        if (HEADING_RE.test(el.tagName)) {
          lines.push(`\n## ${text}`);
          if (!tocLabel) currentChapter = text;
        }

        // CFI de RANGO sobre el texto del bloque (no de elemento): así la cita
        // resalta el TROZO exacto, no solo navega al bloque. Fallback al CFI de
        // elemento si el rango falla (algunos EPUB no lo permiten).
        let cfi = null;
        try {
          const range = textRange(doc, el);
          if (range) cfi = section.cfiFromRange(range);
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

// Rango que cubre TODO el texto del bloque, anclado en nodos de TEXTO.
//
// No vale `range.selectNodeContents(el)`: ahí los offsets son índices de HIJO, y
// `cfiFromRange` de epub.js los emite tal cual como offsets de CARÁCTER. El CFI salía
// siempre como "los primeros N caracteres" con N = número de hijos (`,/1:0,/1:3`), así
// que el resaltado de la cita marcaba 1-7 caracteres — o nada, ancho 0, cuando el primer
// hijo era un elemento (`<span>`, `<a>`, `<i>`). Síntoma: pinchas la cita, navega al
// pasaje y no se destaca la frase.
//
// Con los extremos en el primer y el último nodo de texto, el offset ya es de carácter y
// el CFI cubre el bloque entero. Sin nodos de texto (bloque solo con imagen) → null, y
// el llamador cae al CFI de elemento.
function textRange(doc, el) {
  const walker = doc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  let first = null, last = null, node;
  while ((node = walker.nextNode())) {
    if (!node.data.length) continue;
    if (!first) first = node;
    last = node;
  }
  if (!first) return null;
  const range = doc.createRange();
  range.setStart(first, 0);
  range.setEnd(last, last.data.length);
  return range;
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
