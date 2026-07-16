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

// PDF6 · Encabezados estructurales de documentos "planos" (temarios, textos legales, BOE):
// cuando el PDF no trae outline, se sintetiza el TOC detectándolos en el texto. `top`
// abre capítulo (TÍTULO/TEMA/PARTE/ANEXO/DISPOSICIONES…); CAPÍTULO/SECCIÓN son marcadores
// ## que heredan capítulo — salvo antes del primer top, donde se promocionan (documentos
// solo-CAPÍTULOS). Conservador: línea corta, patrón al inicio, y se descartan las líneas
// de índice (acaban en número de página). Pura y testeable.
const TOP_RE = /^(t[íi]tulo|libro|parte|tema|anexo|ap[ée]ndice)\s+(preliminar|\d+|[ivxlcdm]+)\b/i;
const TOP_DISP_RE = /^disposiciones?\s+(adicionales?|transitorias?|derogatorias?|finales?)\b/i;
const SUB_RE = /^(cap[íi]tulo|secci[óo]n)\s+(preliminar|\d+|[ivxlcdm]+)\b/i;
export function detectHeading(line) {
  const s = (line || '').replace(/\s+/g, ' ').trim();
  if (!s || s.length > 90) return null;
  if (/[.·]\s*\d+$/.test(s)) return null;   // línea de índice con nº de página ("… 25")
  if (TOP_RE.test(s) || TOP_DISP_RE.test(s)) return { title: s, top: true };
  if (SUB_RE.test(s)) return { title: s, top: false };
  return null;
}

export async function segmentPdf(pdfDoc, onProgress) {
  const total = pdfDoc.numPages;
  const boundaries = await outlineBoundaries(pdfDoc);   // [{page, title, top}] por página
  // PDF6 · Sin outline → TOC sintético desde los encabezados del propio texto. Con él
  // funcionan resumen (trozos coherentes), atenuación, y el ámbito de flashcards/mapa.
  const synthetic = boundaries.length === 0;
  const synthToc = [];
  let sawTop = false;
  // tocLabels = solo CAPÍTULOS (los que abren capítulo y salen en el router/MAPA); las
  // subsecciones son marcadores `##` que heredan, no etiquetas de TOC. Qué es "capítulo"
  // lo decide outlineBoundaries: nivel superior, salvo en libros "Part → Chapter", donde
  // las Parts son contenedores y los capítulos reales son sus hijos.
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

    let pageText = '', pageLines = [];
    try {
      const page = await pdfDoc.getPage(p);
      const content = await page.getTextContent();
      ({ text: pageText, lines: pageLines } = reconstruct(content.items));
      page.cleanup?.();
    } catch (e) {
      console.warn('segmentPdf: fallo en página', p, e);
    }

    // PDF6 · Encabezados sintéticos (solo sin outline). Granularidad de página, como el
    // camino con outline: el encabezado abre al inicio de su página.
    if (synthetic) {
      for (const ln of pageLines) {
        const h = detectHeading(ln);
        if (!h) continue;
        const opens = h.top || !sawTop;   // CAPÍTULO sin TÍTULO previo se promociona
        if (h.top) sawTop = true;
        if (opens) { currentChapter = h.title; synthToc.push(h.title); }
        lines.push(`\n## ${h.title}`);
      }
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
    tocLabels: tocLabels.length ? tocLabels : synthToc,
    blockCount: n,
    tokenEstimate: Math.round(annotatedText.length / 4),
    scanned,
    pages: total,
  };
}

// Reconstruye el texto de una página a partir de los items de getTextContent(): une por
// líneas (hasEOL), corrige los guiones de corte de línea ("over-\nall" -> "overall") y
// colapsa espacios. No dependemos de coordenadas: hasEOL es fiable en pdf.js 3.x.
// Devuelve también las LÍNEAS lógicas crudas (antes de fusionar): PDF6 detecta en ellas
// los encabezados estructurales ("TÍTULO III…"), que fusionadas se perderían en el párrafo.
function reconstruct(items) {
  let out = '';
  let line = '';
  const rawLines = [];
  const flush = () => {
    line = line.replace(/\s+/g, ' ').trim();
    if (!line) return;
    rawLines.push(line);
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
  return { text: out.replace(/\s+/g, ' ').trim(), lines: rawLines };
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

// Contenedor organizativo del outline ("Part 2 …", "Parte III …", "Section 1 …"): agrupa
// capítulos pero NO es un capítulo. Sin esta distinción, en libros "Part → Chapter" todo
// el contenido quedaría atribuido a la Part: el router perdería los capítulos ("flashcards
// del capítulo 12" no casaría) y el selector de flashcards solo ofrecería Parts.
function isContainer(title) {
  return /^(part|parte|section|sección|unit|unidad)\s+(\d+|[ivxlcdm]+)\b/i.test((title || '').trim());
}

// Aplana el outline (2 niveles; 3 bajo contenedores) y resuelve cada entrada a su página
// de inicio (1-based). `top` marca las entradas que ABREN capítulo: las de nivel superior,
// salvo los contenedores tipo "Part N", cuyos hijos directos son los capítulos reales.
// Devuelve boundaries ordenadas y deduplicadas por página (a igual página gana el capítulo).
async function outlineBoundaries(pdfDoc) {
  let outline = null;
  try { outline = await pdfDoc.getOutline(); } catch { /* sin outline */ }
  if (!outline || !outline.length) return [];

  const flat = [];
  const walk = (items, depth, parentContainer) => {
    for (const it of items) {
      const container = depth === 0 && isContainer(it.title);
      const top = depth === 0 ? !container : (depth === 1 && parentContainer);
      flat.push({ it, top });
      // Bajo un contenedor se desciende un nivel más de lo normal, para conservar las
      // subsecciones de los capítulos como marcadores ## (paridad con libros sin Parts).
      if (it.items && it.items.length && (depth < 1 || (depth === 1 && parentContainer))) {
        walk(it.items, depth + 1, container);
      }
    }
  };
  walk(outline, 0, false);

  const out = [];
  for (const { it, top } of flat) {
    const title = (it.title || '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    const page = await destToPage(pdfDoc, it.dest);
    if (page) out.push({ page, title, top });
  }
  // A igual página, el capítulo (top) va antes que el contenedor/subsección → el dedup
  // conserva la etiqueta que abre capítulo (una Part suele empezar donde su capítulo 1).
  out.sort((a, b) => a.page - b.page || Number(b.top) - Number(a.top));
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
