// vendor-loader.js — Carga perezosa de las libs vendorizadas.
//
// Antes jszip + epub.js + pdf.js colgaban de <script> clásicos en index.html: 632 KB
// que se descargaban y ejecutaban SIEMPRE, incluso para pintar la biblioteca (que no
// usa ninguna) o para leer un EPUB (que nunca toca los 316 KB de pdf.js). Ahora cada
// una se pide en el momento en que hace falta, con el mismo patrón que ya usaba
// `ai/anki-export.js` para sql.js.
//
// Siguen siendo <script> clásicos servidos desde vendor/ (mismo origen): no son
// módulos ES y se exponen como globales, así que no valdría un `import()`. La CSP
// `script-src 'self'` permite inyectarlos porque el src es de mismo origen.

const cargando = new Map();

// Inyecta un <script> de mismo origen una sola vez. La promesa se cachea por src, así
// que N llamadas concurrentes comparten una única descarga.
function loadScript(src) {
  if (cargando.has(src)) return cargando.get(src);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => {
      cargando.delete(src);   // un fallo de red no debe envenenar el intento siguiente
      reject(new Error(`No se pudo cargar ${src}`));
    };
    document.head.appendChild(s);
  });
  cargando.set(src, p);
  return p;
}

export async function loadJsZip() {
  if (!window.JSZip) await loadScript('vendor/jszip-3.10.1.min.js');
  return window.JSZip;
}

// epub.js necesita JSZip presente (descomprime el .epub), así que va primero.
export async function loadEpubJs() {
  if (window.ePub) return window.ePub;
  await loadJsZip();
  await loadScript('vendor/epub-0.3.93.min.js');
  return window.ePub;
}

export async function loadPdfJs() {
  if (!getPdfGlobal()) await loadScript('vendor/pdf-3.11.174.min.js');
  return getPdfGlobal();
}

// El bundle vendorizado se expone con tres nombres distintos según cómo se empaquetó.
function getPdfGlobal() {
  return window.pdfjsLib || window['pdfjs-dist/build/pdf'] || null;
}

// Arranca la descarga de la lib del formato en cuanto se sabe QUÉ libro se abre, sin
// esperarla. Va en paralelo con leer el ArrayBuffer de IndexedDB —que en un libro
// grande son cientos de ms—, así que para cuando el lector la necesita ya suele estar.
// No cambia la corrección: quien la usa la espera igual, vía loadEpubJs/loadPdfJs.
export function prefetchVendor(kind) {
  const p = kind === 'pdf' ? loadPdfJs() : loadEpubJs();
  p.catch(() => { /* sin red: el error se dará en la carga real, con su mensaje */ });
}
