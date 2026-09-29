// Tarjetas visuales (WU4): DETECCIÓN de figuras en páginas PDF + pipeline de recorte y
// persistencia. Sin UI ni llamadas al LLM (la validación/labels viven en figures.js).
//
// Evidencia del experimento (odd/tasks/tarjetas-visuales.md): las figuras del libro son
// imágenes RASTER embebidas, una por página de figura. Detectar una figura = encontrar
// objetos de imagen pintados en la operator list de la página. El rectángulo del dibujo es
// el cuadrado unitario [0,1]² transformado por el CTM vigente.
//
// Sin acceso al DOM: solo matemática de matrices + orquestación async, para poder testear
// importándolo dentro de la página. `crop` y `save` son funciones INYECTADAS (en producción
// captureRegionImage de pdf-reader.js y saveFigure de figures.js).

// Descarta iconos/logos: ningún lado puede quedar por debajo (en unidades de página).
export const MIN_SIDE_PX = 60;
// Descarta imágenes que ocupan casi nada de la página (fracción del área total).
export const MIN_AREA_RATIO = 0.02;
// Descarta imágenes de fondo a página completa.
export const MAX_AREA_RATIO = 0.95;

// Multiplica dos matrices PDF [a,b,c,d,e,f] (convención de vectores fila de PDF):
// el resultado aplica PRIMERO m y DESPUÉS ctm (m ∘ ctm). Con e/f por último:
//   a = a1*a2 + b1*c2          b = a1*b2 + b1*d2
//   c = c1*a2 + d1*c2          d = c1*b2 + d1*d2
//   e = e1*a2 + f1*c2 + e2     f = e1*b2 + f1*d2 + f2
// Tolerante a entradas malformadas: componente no finita → 0 (nunca lanza).
export function mulMatrix(m, ctm) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const [a1, b1, c1, d1, e1, f1] = [0, 1, 2, 3, 4, 5].map(i => n(m?.[i]));
  const [a2, b2, c2, d2, e2, f2] = [0, 1, 2, 3, 4, 5].map(i => n(ctm?.[i]));
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

// Redondea a 3 decimales (clave de dedupe de rects casi idénticos).
const key3 = (v) => Math.round(v * 1000) / 1000;

// Camina la lista de operadores PDF manteniendo una pila de transformación y devuelve los
// rects FRACCIONALES (0..1, origen arriba-izquierda, eje Y invertido respecto a PDF) de
// las imágenes pintadas que sobreviven los filtros. Ordenado de arriba a abajo y de
// izquierda a derecha. NUNCA lanza: ante entradas malformadas devuelve [].
export function imageRectsFromOps(opsList, { pageWidth, pageHeight, minSidePx = MIN_SIDE_PX, minAreaRatio = MIN_AREA_RATIO, maxAreaRatio = MAX_AREA_RATIO } = {}) {
  try {
    const { fnArray, argsArray, OPS } = opsList || {};
    if (!Array.isArray(fnArray) || !Array.isArray(argsArray)) return [];
    if (!OPS || typeof OPS !== 'object') return [];
    if (![pageWidth, pageHeight].every(v => Number.isFinite(v) && v > 0)) return [];
    const pageArea = pageWidth * pageHeight;
    const is = (fn, name) => fn === OPS[name];
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const seen = new Set();
    const rects = [];
    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i];
      const args = Array.isArray(argsArray[i]) ? argsArray[i] : [];
      if (is(fn, 'save')) {
        stack.push(ctm);
      } else if (is(fn, 'restore')) {
        // Underflow de pila (ops malformadas): se conserva el CTM actual.
        ctm = stack.pop() || ctm;
      } else if (is(fn, 'transform')) {
        // cm: el nuevo CTM es la matriz del operador compuesta con el vigente.
        if (args.length >= 6 && args.every(Number.isFinite)) ctm = mulMatrix(args, ctm);
      } else if (is(fn, 'paintImageXObject') || is(fn, 'paintInlineImageXObject') || is(fn, 'paintImageMaskXObject')) {
        // El dibujo ocupa el cuadrado unitario [0,1]² bajo el CTM: se transforman las 4
        // esquinas y se toma el bbox. Con escala positiva y sin rotación/skew (el caso de
        // estos PDF) reduce a x=e, y=f, w=|a|, h=|d|, pero también cubre escala negativa.
        const [a, b, c, d, e, f] = ctm;
        // Esquinas (u,v) ∈ {0,1}² → x = a*u + c*v + e, y = b*u + d*v + f.
        const xs = [0, 1].flatMap(u => [a * u + c * 0 + e, a * u + c * 1 + e]);
        const ys = [0, 1].flatMap(v => [b * 0 + d * v + f, b * 1 + d * v + f]);
        const x0 = Math.min(...xs);
        const x1 = Math.max(...xs);
        const yBottom = Math.min(...ys);
        const yTop = Math.max(...ys);
        const w = x1 - x0;
        const h = yTop - yBottom;
        const rect = {
          x: x0 / pageWidth,
          y: (pageHeight - yTop) / pageHeight, // eje Y invertido: PDF crece hacia arriba
          w: w / pageWidth,
          h: h / pageHeight,
        };
        // Completamente fuera de página → descartada (los recortes parciales se dejan:
        // figureRectToBox clampea al área visible).
        if (rect.x >= 1 || rect.y >= 1 || rect.x + rect.w <= 0 || rect.y + rect.h <= 0) continue;
        // Lado mínimo en unidades de página (≈ px del PDF).
        if (w < minSidePx || h < minSidePx) continue;
        const ratio = (w * h) / pageArea;
        if (ratio < minAreaRatio || ratio > maxAreaRatio) continue;
        const key = `${key3(rect.x)},${key3(rect.y)},${key3(rect.w)},${key3(rect.h)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rects.push(rect);
      }
    }
    // Arriba a abajo, izquierda a derecha.
    return rects.sort((p, q) => (p.y - q.y) || (p.x - q.x));
  } catch {
    return [];
  }
}

// AbortError sin DOM: Error con name 'AbortError', la convención que espera el caller.
function abortError() {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

const isAbort = (err) => !!err && (err.name === 'AbortError' || err.code === 'AbortError');

// Resuelve la operator list y el mapa OPS para una página. Acepta:
//   - ops con { fnArray, argsArray } ya obtenida (y opcionalmente .OPS),
//   - ops como solo mapa { OPS },
//   - nada: se pide page.getOperatorList() y el mapa OPS sale de ops.OPS, list.OPS o page.ops.
async function resolvePageOps(page, ops) {
  let list = null;
  let OPS = null;
  if (ops && typeof ops === 'object') {
    if (Array.isArray(ops.fnArray) && Array.isArray(ops.argsArray)) list = ops;
    if (ops.OPS && typeof ops.OPS === 'object') OPS = ops.OPS;
  }
  if (!list && page && typeof page.getOperatorList === 'function') {
    list = await page.getOperatorList();
    if (!OPS && list && list.OPS && typeof list.OPS === 'object') OPS = list.OPS;
  }
  if (!OPS && page && page.ops && typeof page.ops === 'object') OPS = page.ops;
  return { list, OPS };
}

// Extrae las figuras (rects de imágenes raster) de UNA página y las recorta con `crop`.
// page: objeto con getOperatorList(). Devuelve [{ rect, dataUrl }]. Un recorte que falla
// se omite y se sigue con las demás. Abort (signal pre-abortada, abortada a mitad, o un
// crop que rechace con AbortError) ⇒ rechaza con AbortError.
export async function extractPageFigures(
  { page, ops, crop, pageWidth, pageHeight, signal, minSidePx, minAreaRatio, maxAreaRatio } = {},
) {
  if (signal && signal.aborted) throw abortError();
  const { list, OPS } = await resolvePageOps(page, ops);
  if (!list || !OPS || typeof crop !== 'function') return [];
  const rects = imageRectsFromOps(
    { fnArray: list.fnArray, argsArray: list.argsArray, OPS },
    { pageWidth, pageHeight, minSidePx, minAreaRatio, maxAreaRatio },
  );
  const out = [];
  for (const rect of rects) {
    if (signal && signal.aborted) throw abortError();
    let dataUrl;
    try {
      dataUrl = await crop(page, rect);
    } catch (err) {
      if (isAbort(err)) throw err;   // abort real: no se traga
      continue;                      // recorte fallido: figura omitida, se sigue
    }
    if (signal && signal.aborted) throw abortError();
    if (typeof dataUrl === 'string' && dataUrl) out.push({ rect, dataUrl });
  }
  return out;
}

// Extrae y persiste las figuras de un libro. pages = [{ page, pageWidth, pageHeight,
// pageNumber }]. Recorre SECUENCIALMENTE (un canvas a la vez: renderizar en paralelo
// satura memoria en libros grandes). `save` inyectada: async (figure) → clave. Si save
// falla para una figura se registra en `failed` y sigue. Abort ⇒ AbortError.
// Devuelve { saved: [{ key, page, rect }], figures: [{ key, page, rect, dataUrl }],
//            failed: [{ page, error }] }.
export async function extractBookFigures({ pages, crop, ops, save, onProgress, signal, bookId } = {}) {
  if (signal && signal.aborted) throw abortError();
  const list = Array.isArray(pages) ? pages : [];
  const total = list.length;
  const saved = [];
  const figures = [];
  const failed = [];
  let done = 0;
  for (const entry of list) {
    const pageNumber = entry && Number.isFinite(entry.pageNumber) ? entry.pageNumber : null;
    let pageFigs;
    try {
      // `ops` puede venir a nivel libro (mapa OPS compartido) o por página.
      pageFigs = await extractPageFigures({
        page: entry?.page,
        ops: entry?.ops || ops,
        crop,
        pageWidth: entry?.pageWidth,
        pageHeight: entry?.pageHeight,
        signal,
      });
    } catch (err) {
      if (isAbort(err)) throw err;
      // La página entera falló (p.ej. getOperatorList): se registra y se sigue.
      failed.push({ page: pageNumber, error: String(err?.message || err) });
      done++;
      onProgress?.({ done, total, page: pageNumber });
      continue;
    }
    for (const fig of pageFigs) {
      if (signal && signal.aborted) throw abortError();
      try {
        const key = await save({ bookId, page: pageNumber, rect: fig.rect, dataUrl: fig.dataUrl, source: 'pdf' });
        saved.push({ key, page: pageNumber, rect: fig.rect });
        figures.push({ key, page: pageNumber, rect: fig.rect, dataUrl: fig.dataUrl });
      } catch (err) {
        if (isAbort(err)) throw err;
        failed.push({ page: pageNumber, error: String(err?.message || err) });
      }
    }
    done++;
    onProgress?.({ done, total, page: pageNumber });
  }
  return { saved, figures, failed };
}
