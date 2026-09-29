// Tarjetas visuales (WU5d): FUENTE de figuras por libro. Es el puente entre "el libro"
// (el PDF abierto en el lector, o los bytes del EPUB en la biblioteca) y los módulos de
// extracción puros (figures-pdf.js / figures-epub.js): dado un libro, devuelve sus
// figuras — del store de artefactos si ya fueron extraídas, y si no, extrayéndolas y
// persistiéndolas para la próxima vez.
//
// El IO pesado va INYECTADO (documento pdf.js, bytes del EPUB, JSZip, save, collect)
// para que los tests corran offline importándolo en la página. Solo el render offscreen
// toca el DOM (canvas SIN montar, patrón renderCoverDataUrl de pdf-reader.js):
// captureRegionImage no sirve acá porque exige la página ya renderizada en el contenedor,
// y una figura puede estar en cualquier página del libro.

import { saveFigure, getFigures } from './figures.js';
import { imageRectsFromOps } from './figures-pdf.js';
import { entriesFromZip, zipReader, collectEpubFigures } from './figures-epub.js';
import { figureSize } from './visual-deck.js';
import * as PdfReader from '../pdf-reader.js';

// Tope por libro: más figuras no caben en un mazo de estudio.
export const MAX_FIGURES = 12;
// Lado mayor del render offscreen de una página antes del recorte. 1400 ≈ la resolución
// con la que pdf-reader rasteriza páginas de revista: a esa escala los recortes de figura
// quedan nítidos para el modelo de visión.
export const RENDER_MAX_PX = 1400;
// Lado mayor del recorte final (mismo tope que captureRegionImage de pdf-reader.js).
const CROP_MAX_PX = 1024;

// AbortError sin DOM: Error con name 'AbortError', la convención que espera el caller.
function abortError() {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

const isAbort = (err) => !!err && (err.name === 'AbortError' || err.code === 'AbortError');

// ---------------------------------------------------------------------------
// Recorte y render offscreen.
// ---------------------------------------------------------------------------

// Métricas del recorte de `rect` fraccional ({x,y,w,h} en 0..1) sobre un canvas: fuente
// (sx, sy, sw, sh) y destino (dw, dh) ya reescalado. MISMA semántica de recorte que
// captureRegionImage de pdf-reader.js: se puede AMPLIAR hasta 2× cuando el recorte es
// chico (más píxeles útiles para el modelo) y los recortes por debajo de 8 px por lado
// se descartan. null si el canvas no tiene tamaño o el rect es inválido.
function cropMetrics(canvas, rect, maxPx) {
  if (!canvas || !canvas.width || !canvas.height) return null;
  if (!rect || typeof rect !== 'object') return null;
  if (![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)) return null;
  if (rect.w <= 0 || rect.h <= 0) return null;
  const sx = Math.max(0, Math.round(rect.x * canvas.width));
  const sy = Math.max(0, Math.round(rect.y * canvas.height));
  const sw = Math.min(canvas.width - sx, Math.round(rect.w * canvas.width));
  const sh = Math.min(canvas.height - sy, Math.round(rect.h * canvas.height));
  if (sw < 8 || sh < 8) return null;                     // recorte degenerado: no sirve
  const scale = Math.min(2, maxPx / Math.max(sw, sh));
  return {
    sx, sy, sw, sh,
    dw: Math.max(1, Math.round(sw * scale)),
    dh: Math.max(1, Math.round(sh * scale)),
  };
}

// Recorta `rect` fraccional del canvas y devuelve un data URL JPEG (0.85), reescalando
// hasta maxPx como máximo (hasta 2× hacia arriba en recortes chicos). null si el canvas
// no tiene tamaño, si el recorte queda por debajo de 8 px por lado o si el rect es
// inválido. NUNCA lanza.
export function cropRectFromCanvas(canvas, rect, maxPx = CROP_MAX_PX) {
  try {
    const m = cropMetrics(canvas, rect, maxPx);
    if (!m) return null;
    const off = document.createElement('canvas');
    off.width = m.dw;
    off.height = m.dh;
    off.getContext('2d').drawImage(canvas, m.sx, m.sy, m.sw, m.sh, 0, 0, m.dw, m.dh);
    return off.toDataURL('image/jpeg', 0.85);
  } catch {
    return null;
  }
}

// Renderiza la página (objeto pdf.js) en un canvas FUERA DE PANTALLA — no toca el
// #pdf-container — y lo devuelve. Escala tal que el lado mayor del canvas no pase de
// maxPx. null si no se puede renderizar (nunca lanza): la página se saltea y se sigue.
export async function renderPageCanvas(page, maxPx = RENDER_MAX_PX) {
  try {
    if (!page || typeof page.getViewport !== 'function' || typeof page.render !== 'function') return null;
    const base = page.getViewport({ scale: 1 });
    if (!base || !(base.width > 0) || !(base.height > 0)) return null;
    const viewport = page.getViewport({ scale: maxPx / Math.max(base.width, base.height) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return canvas;
  } catch {
    return null;
  }
}

// Mapa OPS de pdf.js, para las operator lists que no lo traen (el objeto que devuelve
// getOperatorList() no siempre lo incluye). Se carga UNA vez con lazy import: pdf.js ya
// está en memoria cuando hay un PDF abierto, y los tests con listas sintéticas inyectan
// su propio OPS y nunca llegan acá.
let pdfJsOpsCache = null;
async function pdfJsOps() {
  if (pdfJsOpsCache) return pdfJsOpsCache;
  const VL = await import('../vendor-loader.js');
  const lib = await VL.loadPdfJs();
  pdfJsOpsCache = lib.OPS || null;
  return pdfJsOpsCache;
}

// ---------------------------------------------------------------------------
// Extracción + persistencia por formato.
// ---------------------------------------------------------------------------

// Extrae y guarda las figuras de un PDF. `doc` es un documento pdf.js; las páginas van
// de `fromPage` a `toPage` (0 = hasta el final). Por página: detección de rects con
// imageRectsFromOps (o `extract` inyectada) y, SOLO si la página tiene imágenes, un
// render offscreen (una sola vez por página) del que se recorta cada rect. `save`
// inyectada (por defecto saveFigure) recibe { bookId, page, rect, dataUrl, labels: [],
// caption: `p. N`, source: 'pdf', width, height } — width/height son los PÍXELES REALES
// del recorte: sin ellos el grounding descarta todas las etiquetas (ver WU5c).
// Corta al llegar a maxFigures (truncated: true). Un save que falla va a `failed` y la
// corrida sigue. Abort ⇒ rechaza con AbortError.
// Devuelve { figures, saved, failed, pagesScanned, truncated }.
export async function figuresForPdf({
  bookId, doc, extract, save, onProgress, signal,
  maxFigures = MAX_FIGURES, fromPage = 1, toPage = 0,
} = {}) {
  if (signal && signal.aborted) throw abortError();
  const figures = [];
  const saved = [];
  const failed = [];
  if (!doc) return { figures, saved, failed, pagesScanned: 0, truncated: false };
  const doExtract = typeof extract === 'function' ? extract : imageRectsFromOps;
  const doSave = typeof save === 'function' ? save : saveFigure;
  const total = Number.isFinite(doc.numPages) && doc.numPages > 0 ? doc.numPages : 0;
  const start = Math.max(1, Number.isFinite(fromPage) ? fromPage : 1);
  const end = toPage > 0 ? Math.min(toPage, total || toPage) : total;
  const pagesTotal = end >= start ? end - start + 1 : 0;
  let pagesScanned = 0;
  let truncated = false;

  for (let n = start; n <= end; n++) {
    if (signal && signal.aborted) throw abortError();
    if (figures.length >= maxFigures) { truncated = true; break; }
    let page;
    try {
      page = await doc.getPage(n);
    } catch (err) {
      if (isAbort(err)) throw err;
      failed.push({ page: n, error: String(err?.message || err) });
      pagesScanned++;
      onProgress?.({ done: pagesScanned, total: pagesTotal, page: n });
      continue;
    }
    let rects;
    try {
      const vp = page.getViewport({ scale: 1 });
      const list = await page.getOperatorList();
      const OPS = (list && list.OPS)
        || (page.ops && typeof page.ops === 'object' ? page.ops : null)
        || await pdfJsOps();
      if (!OPS) throw new Error('no OPS map');
      rects = doExtract(
        { fnArray: list.fnArray, argsArray: list.argsArray, OPS },
        { pageWidth: vp.width, pageHeight: vp.height },
      );
      if (!Array.isArray(rects)) rects = [];
    } catch (err) {
      if (isAbort(err)) throw err;
      failed.push({ page: n, error: String(err?.message || err) });
      pagesScanned++;
      onProgress?.({ done: pagesScanned, total: pagesTotal, page: n });
      continue;
    }
    // Página sin imágenes: no se renderiza (el render es lo caro).
    if (rects.length) {
      const canvas = await renderPageCanvas(page);
      if (canvas) {
        for (const rect of rects) {
          if (signal && signal.aborted) throw abortError();
          if (figures.length >= maxFigures) { truncated = true; break; }
          const dataUrl = cropRectFromCanvas(canvas, rect, CROP_MAX_PX);
          if (!dataUrl) continue;                      // recorte degenerado: figura omitida
          const m = cropMetrics(canvas, rect, CROP_MAX_PX);
          const figure = {
            bookId,
            page: n,
            rect,
            dataUrl,
            labels: [],
            caption: `p. ${n}`,
            source: 'pdf',
            width: m ? m.dw : 0,
            height: m ? m.dh : 0,
          };
          try {
            const key = await doSave(figure);
            figures.push({ key, ...figure });
            saved.push({ key, page: n });
          } catch (err) {
            if (isAbort(err)) throw err;
            failed.push({ page: n, error: String(err?.message || err) });
          }
        }
      }
    }
    pagesScanned++;
    onProgress?.({ done: pagesScanned, total: pagesTotal, page: n });
  }
  return { figures, saved, failed, pagesScanned, truncated };
}

// Extrae y guarda las figuras de un EPUB. `bytes` = ArrayBuffer del archivo; `JSZip` es
// el constructor (vendor-loader). Arma entries + zipReader sobre el zip cargado y usa
// `collect` (inyectada; por defecto collectEpubFigures) para obtener
// [{ path, dataUrl, chapter, size }]. Cada figura se guarda con `save` (por defecto
// saveFigure) como { bookId, page: null, rect: null, dataUrl, labels: [], caption:
// <capítulo>, source: 'epub', width, height } — dimensiones decodificadas del dataUrl con
// figureSize de visual-deck (WU5c: sin ellas el grounding no produce etiquetas).
// Corta al llegar a maxFigures. Devuelve { figures, saved, failed, truncated }.
export async function figuresForEpub({
  bookId, bytes, JSZip, collect, save, onProgress, signal, maxFigures = MAX_FIGURES,
} = {}) {
  if (signal && signal.aborted) throw abortError();
  const figures = [];
  const saved = [];
  const failed = [];
  let truncated = false;
  const doSave = typeof save === 'function' ? save : saveFigure;
  if (!bytes || typeof JSZip !== 'function') {
    return { figures, saved, failed, truncated };
  }
  const doCollect = typeof collect === 'function' ? collect : collectEpubFigures;
  const zip = await JSZip.loadAsync(bytes);
  const reader = zipReader(zip);
  const collected = await doCollect({
    entries: entriesFromZip(zip),
    readText: reader.readText,
    readImage: reader.readImage,
    signal,
  });
  let done = 0;
  for (const fig of Array.isArray(collected) ? collected : []) {
    if (signal && signal.aborted) throw abortError();
    if (figures.length >= maxFigures) { truncated = true; break; }
    const size = await figureSize(fig);                  // {width,height} | null
    const figure = {
      bookId,
      page: null,          // un EPUB no tiene páginas: la referencia es el capítulo
      rect: null,
      dataUrl: fig.dataUrl,
      labels: [],
      caption: fig.chapter || '',
      source: 'epub',
      width: size ? size.width : 0,
      height: size ? size.height : 0,
    };
    try {
      const key = await doSave(figure);
      figures.push({ key, ...figure, path: fig.path });
      saved.push({ key, path: fig.path });
    } catch (err) {
      if (isAbort(err)) throw err;
      failed.push({ path: fig.path, error: String(err?.message || err) });
    }
    done++;
    onProgress?.({ done, total: collected.length });
  }
  return { figures, saved, failed, truncated };
}

// ---------------------------------------------------------------------------
// Resolución por libro: store primero, extracción después.
// ---------------------------------------------------------------------------

// Figuras de un libro: del store de artefactos si ya fueron extraídas (cached: true,
// cero trabajo de extracción), y si no, extraídas y persistidas según el formato:
//   pdf  → el documento abierto en el lector (PdfReader.getDocument, o deps.getDocument
//          inyectada). Sin documento abierto ⇒ { reason: 'no-document' } sin extraer:
//          no vale la pena cargar el binario solo para esto.
//   epub → los bytes del registro de la biblioteca (record.file, ArrayBuffer o Blob;
//          deps.readBytes inyectable para tests), con JSZip del vendor-loader.
// AbortError se propaga; cualquier otro error devuelve
// { figures: [], cached: false, reason: <mensaje> } — la extracción de figuras nunca
// tira abajo el flujo del caller.
export async function ensureBookFigures({ bookId, format, record, signal, onProgress, deps = {} } = {}) {
  try {
    if (signal && signal.aborted) throw abortError();
    if (!bookId) return { figures: [], cached: false, reason: 'no-book' };

    // (1) Store primero: figuras ya extraídas no se reextraen nunca.
    const existing = await getFigures(bookId);
    if (existing.length) return { figures: existing, cached: true };

    const fmt = format || (record && record.format) || '';

    if (fmt === 'pdf') {
      // (2) El documento tiene que ser el del libro abierto en el lector.
      let doc = null;
      try {
        doc = deps.getDocument ? await deps.getDocument() : await PdfReader.getDocument();
      } catch (err) {
        if (isAbort(err)) throw err;
        doc = null;
      }
      if (!doc) return { figures: [], cached: false, reason: 'no-document' };
      const out = await figuresForPdf({ bookId, doc, save: saveFigure, onProgress, signal });
      return { figures: out.figures, cached: false, reason: '' };
    }

    if (fmt === 'epub') {
      // (2) Los bytes viven en el registro de la biblioteca (puede ser Blob o ArrayBuffer).
      const bytes = deps.readBytes
        ? await deps.readBytes(record)
        : (record && record.file
          ? (record.file.arrayBuffer ? await record.file.arrayBuffer() : record.file)
          : null);
      const VL = await import('../vendor-loader.js');
      const JSZip = await VL.loadJsZip();
      const out = await figuresForEpub({ bookId, bytes, JSZip, save: saveFigure, onProgress, signal });
      return { figures: out.figures, cached: false, reason: '' };
    }

    return { figures: [], cached: false, reason: 'unsupported-format' };
  } catch (err) {
    if (isAbort(err)) throw err;
    return { figures: [], cached: false, reason: String(err?.message || err) };
  }
}
