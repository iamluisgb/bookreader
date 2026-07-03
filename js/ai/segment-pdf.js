// Segmentador de PDF (PDF1): produce el MISMO "libro anotado" que segment.js (EPUB)
// —anclas [[aN]] + mapa anchorId -> {page, chapter}— para reutilizar TODO el pipeline de
// retrieval (BM25, router, vecinos, agéntico). Diferencias con el EPUB:
//  - El locator es el número de PÁGINA (no un CFI); la navegación de citas salta a la página.
//  - Los capítulos salen de getOutline() (marcadores del PDF) en vez del TOC del EPUB.
//  - Detectamos PDFs escaneados (sin texto seleccionable): el agente no puede leerlos.
//
// Devuelve { annotatedText, anchors: Map<id,{page,chapter}>, tocLabels, blockCount,
//            tokenEstimate, scanned, pages }.

// Un pasaje se cierra al superar este tamaño (en un límite de frase). Da trozos de varias
// frases —buenos para BM25— sin partir palabras. La cita navega por página igualmente.
const PASSAGE_TARGET = 400;
// Heurística de "escaneado": media de caracteres extraídos por página en la muestra inicial.
const SCAN_SAMPLE_PAGES = 10;
const SCAN_MIN_CHARS_PER_PAGE = 40;

export async function segmentPdf(pdfDoc, onProgress) {
  const total = pdfDoc.numPages;
  const boundaries = await outlineBoundaries(pdfDoc);   // [{page, title, top}] por página
  // tocLabels = solo capítulos de nivel superior (los que abren capítulo y salen en el
  // router/MAPA); las subsecciones son marcadores `##` que heredan, no etiquetas de TOC.
  const tocLabels = boundaries.filter(b => b.top).map(b => b.title);

  const anchors = new Map();
  const lines = [];
  let n = 0;
  let currentChapter = '';
  let bi = 0;                 // índice en boundaries pendiente de "abrir"
  let sampleChars = 0;

  for (let p = 1; p <= total; p++) {
    // Abrir el/las entradas de outline cuya página de inicio ya alcanzamos. Emitimos `##`
    // para TODAS (da estructura al texto), pero solo las de nivel superior cambian el
    // capítulo atribuido a las anclas; las subsecciones heredan el capítulo padre. Es el
    // mismo criterio que en EPUB (evita el bug de atribución tipo "capítulo 9" de DDIA).
    while (bi < boundaries.length && boundaries[bi].page <= p) {
      const b = boundaries[bi];
      if (b.top) currentChapter = b.title;
      lines.push(`\n## ${b.title}`);
      bi++;
    }

    let pageText = '';
    try {
      const page = await pdfDoc.getPage(p);
      const content = await page.getTextContent();
      pageText = reconstruct(content.items);
      page.cleanup?.();
    } catch (e) {
      console.warn('segmentPdf: fallo en página', p, e);
    }

    if (p <= SCAN_SAMPLE_PAGES) sampleChars += pageText.length;

    // Trocear el texto de la página en pasajes de ~PASSAGE_TARGET (en límites de frase).
    for (const passage of chunk(pageText)) {
      const id = 'a' + (n++);
      anchors.set(id, { page: p, chapter: currentChapter });
      lines.push(`[[${id}]] ${passage}`);
    }

    if (onProgress) onProgress(p, total);
  }

  const scanned = n === 0 ||
    (sampleChars / Math.min(SCAN_SAMPLE_PAGES, total)) < SCAN_MIN_CHARS_PER_PAGE;

  const annotatedText = lines.join('\n').trim();
  return {
    annotatedText,
    anchors,
    tocLabels,
    blockCount: n,
    tokenEstimate: Math.round(annotatedText.length / 4),
    scanned,
    pages: total,
  };
}

// Reconstruye el texto de una página a partir de los items de getTextContent(): une por
// líneas (hasEOL), corrige los guiones de corte de línea ("over-\nall" -> "overall") y
// colapsa espacios. No dependemos de coordenadas: hasEOL es fiable en pdf.js 3.x.
function reconstruct(items) {
  let out = '';
  let line = '';
  const flush = () => {
    line = line.replace(/\s+/g, ' ').trim();
    if (!line) return;
    // Guión de corte: si la línea acumulada termina en "-" y la palabra continúa en minúscula,
    // se unen sin el guión ni espacio. Si no, se añade un espacio de separación.
    if (/[\p{L}]-$/u.test(out.trimEnd()) && /^[\p{Ll}]/u.test(line)) {
      out = out.trimEnd().replace(/-$/, '') + line;
    } else {
      out += (out && !/\s$/.test(out) ? ' ' : '') + line;
    }
    line = '';
  };
  for (const it of items) {
    if (typeof it.str === 'string') line += it.str;
    if (it.hasEOL) flush();
  }
  flush();
  return out.replace(/\s+/g, ' ').trim();
}

// Trocea un texto largo en pasajes de ~PASSAGE_TARGET caracteres cortando en fin de frase.
function* chunk(text) {
  if (!text) return;
  if (text.length <= PASSAGE_TARGET) { yield text; return; }
  // Fragmentos por frase, conservando el signo de puntuación final.
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [text];
  let buf = '';
  for (const s of sentences) {
    buf += s;
    if (buf.length >= PASSAGE_TARGET) { yield buf.trim(); buf = ''; }
  }
  if (buf.trim()) yield buf.trim();
}

// Aplana el outline (2 niveles) y resuelve cada entrada a su página de inicio (1-based).
// Devuelve boundaries ordenadas y deduplicadas por página (la primera etiqueta gana).
async function outlineBoundaries(pdfDoc) {
  let outline = null;
  try { outline = await pdfDoc.getOutline(); } catch { /* sin outline */ }
  if (!outline || !outline.length) return [];

  const flat = [];
  const walk = (items, depth) => {
    for (const it of items) {
      flat.push({ it, depth });
      if (depth < 1 && it.items && it.items.length) walk(it.items, depth + 1);
    }
  };
  walk(outline, 0);

  const out = [];
  for (const { it, depth } of flat) {
    const title = (it.title || '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    const page = await destToPage(pdfDoc, it.dest);
    if (page) out.push({ page, title, top: depth === 0 });
  }
  out.sort((a, b) => a.page - b.page);
  // Dedup por página: si dos entradas apuntan a la misma página, nos quedamos la primera.
  const seen = new Set();
  return out.filter(b => (seen.has(b.page) ? false : seen.add(b.page)));
}

async function destToPage(pdfDoc, dest) {
  try {
    let explicit = dest;
    if (typeof dest === 'string') explicit = await pdfDoc.getDestination(dest);
    if (!Array.isArray(explicit) || !explicit.length) return null;
    const ref = explicit[0];
    const idx = await pdfDoc.getPageIndex(ref);   // 0-based
    return idx + 1;
  } catch {
    return null;
  }
}
