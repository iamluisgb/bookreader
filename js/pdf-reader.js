import * as Storage from './storage.js';

let pdfjsLib = null;
let pdfDoc = null;
let currentPage = 1;
let totalPages = 0;
let onPageCallback = null;

function getPdfjs() {
  if (pdfjsLib) return pdfjsLib;
  // El bundle (vendorizado) lo expone como window.pdfjsLib o window["pdfjs-dist/build/pdf"]
  pdfjsLib = window.pdfjsLib || window['pdfjs-dist/build/pdf'] || window['pdfjsLib'];
  if (pdfjsLib) {
    try {
      // Worker local (mismo origen): funciona offline y bajo CSP worker-src 'self'.
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker-3.11.174.min.js';
    } catch(e) {
      console.warn('pdf.js worker setup error:', e);
    }
  }
  return pdfjsLib;
}

export function isLoaded() {
  return pdfDoc !== null;
}

export function getCurrentPage() {
  return currentPage;
}

export function getTotalPages() {
  return totalPages;
}

export async function load(arrayBuffer, onProgress) {
  const lib = getPdfjs();
  if (!lib) {
    throw new Error('pdf.js not loaded');
  }

  if (pdfDoc) {
    try { pdfDoc.destroy(); } catch(e) {}
    pdfDoc = null;
  }

  currentPage = 1;

  const container = document.getElementById('pdf-container');
  container.innerHTML = '';
  container.style.display = 'flex';
  document.getElementById('landing').style.display = 'none';
  document.getElementById('epub-container').style.display = 'none';

  const loadingTask = lib.getDocument({ data: arrayBuffer });
  pdfDoc = await loadingTask.promise;
  totalPages = pdfDoc.numPages;

  // Restore last page
  try {
    const fp = pdfDoc.fingerprints ? pdfDoc.fingerprints[0] : null;
    if (fp) {
      const lastPage = Storage.get('pdfLastPage_' + fp);
      if (lastPage && lastPage >= 1 && lastPage <= totalPages) {
        currentPage = lastPage;
      }
    }
  } catch(e) {}

  await renderPage(currentPage);

  return pdfDoc;
}

async function renderPage(num) {
  if (!pdfDoc) return;

  const page = await pdfDoc.getPage(num);
  const scale = 1.5;
  const viewport = page.getViewport({ scale });

  const container = document.getElementById('pdf-container');
  if (!container) return;

  // Page wrapper stacks the canvas and the selectable text layer on top.
  let wrapper = container.querySelector('.pdf-page');
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.className = 'pdf-page';
    container.appendChild(wrapper);
  }
  wrapper.style.width = viewport.width + 'px';
  wrapper.style.height = viewport.height + 'px';
  // pdf.js text layer positions glyphs relative to this custom property.
  wrapper.style.setProperty('--scale-factor', String(scale));

  let canvas = wrapper.querySelector('canvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'pdf-canvas';
    wrapper.appendChild(canvas);
  }

  const ctx = canvas.getContext('2d');
  canvas.height = viewport.height;
  canvas.width = viewport.width;

  await page.render({ canvasContext: ctx, viewport }).promise;

  await renderTextLayer(page, viewport, wrapper);

  saveLastPage();
  updateProgress();

  if (onPageCallback) {
    onPageCallback(currentPage, totalPages);
  }
}

// Overlay an invisible, selectable text layer on top of the rendered canvas
// so the user can select and copy text (and, later, create highlights).
async function renderTextLayer(page, viewport, wrapper) {
  const lib = getPdfjs();
  if (!lib || typeof lib.renderTextLayer !== 'function') return;

  let layer = wrapper.querySelector('.textLayer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'textLayer';
    wrapper.appendChild(layer);
  }
  layer.innerHTML = '';
  layer.style.width = viewport.width + 'px';
  layer.style.height = viewport.height + 'px';

  try {
    const textContent = await page.getTextContent();
    const task = lib.renderTextLayer({
      textContentSource: textContent,
      container: layer,
      viewport,
      textDivs: [],
    });
    await task.promise;
  } catch (e) {
    console.warn('Could not render PDF text layer:', e);
  }
}

function saveLastPage() {
  if (pdfDoc) {
    try {
      const fp = pdfDoc.fingerprints ? pdfDoc.fingerprints[0] : null;
      if (fp) Storage.set('pdfLastPage_' + fp, currentPage);
    } catch(e) {}
  }
}

function updateProgress() {
  if (!pdfDoc) return;
  const pct = Math.round((currentPage / totalPages) * 100);

  const bar = document.getElementById('progress-bar');
  const text = document.getElementById('progress-text');
  const pageEl = document.getElementById('progress-page');
  if (bar) bar.style.width = pct + '%';
  if (text) text.textContent = pct + '%';
  if (pageEl) pageEl.textContent = `Pág. ${currentPage} / ${totalPages}`;
}

// Salto por fracción [0..1] de la barra de progreso → página correspondiente.
export async function seekToFraction(f) {
  if (!totalPages) return;
  const p = Math.min(totalPages, Math.max(1, Math.round(f * totalPages)));
  await goTo(p);
}

export async function prev() {
  if (currentPage > 1) {
    currentPage--;
    await renderPage(currentPage);
  }
}

export async function next() {
  if (currentPage < totalPages) {
    currentPage++;
    await renderPage(currentPage);
  }
}

export async function goTo(page) {
  if (page >= 1 && page <= totalPages) {
    currentPage = page;
    await renderPage(currentPage);
  }
}

export function onPage(cb) {
  onPageCallback = cb;
}
