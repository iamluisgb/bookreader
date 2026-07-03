import * as Storage from './storage.js';

let pdfjsLib = null;
let pdfDoc = null;
let currentPage = 1;
let totalPages = 0;
let onPageCallback = null;
let readingMode = 'paginated';   // 'paginated' | 'scroll' (continuo), recordado por libro
let lazyObserver = null;         // observer del render perezoso en modo scroll
let scrollRaf = 0;

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

// Documento pdf.js cargado (para el agente: segment-pdf lo recorre con getTextContent/getOutline).
export function getDocument() {
  return pdfDoc;
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
    try { pdfDoc.destroy(); } catch(e) { console.warn('pdf destroy error:', e); }
    pdfDoc = null;
  }

  currentPage = 1;

  const container = document.getElementById('pdf-container');
  container.innerHTML = '';
  container.style.display = 'flex';
  document.getElementById('landing').style.display = 'none';
  document.getElementById('epub-container').style.display = 'none';

  // TEC1 · pdf.js TRANSFIERE (detacha) el ArrayBuffer que le pasas a getDocument. Si el
  // llamador lo reutiliza después (p. ej. app.js lo guarda en la biblioteca con
  // buffer.slice(0)), petaría sobre un buffer detached y el PDF NO se guardaría. Le
  // pasamos SIEMPRE una copia para que el original del llamador quede intacto.
  const data = arrayBuffer.slice(0);
  const loadingTask = lib.getDocument({ data });
  // TEC1 · Callback de progreso de carga (antes el parámetro estaba sin usar).
  if (typeof onProgress === 'function') {
    loadingTask.onProgress = ({ loaded, total }) => onProgress(total ? loaded / total : 0);
  }
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

  // Modo de lectura recordado por libro (paginado por defecto).
  try {
    const fp = fpKey();
    const m = fp ? Storage.get('pdfMode_' + fp) : null;
    if (m === 'scroll' || m === 'paginated') readingMode = m;
  } catch (e) {}

  await rerender();

  return pdfDoc;
}

// ---- Modo de lectura: paginado vs scroll continuo -------------------------
export function getReadingMode() { return readingMode; }

export async function setReadingMode(mode) {
  if ((mode !== 'scroll' && mode !== 'paginated') || mode === readingMode) return;
  readingMode = mode;
  try { const fp = fpKey(); if (fp) Storage.set('pdfMode_' + fp, mode); } catch (e) {}
  await rerender();
  window.dispatchEvent(new CustomEvent('reader:flow-changed'));
}

function fpKey() { try { return pdfDoc && pdfDoc.fingerprints ? pdfDoc.fingerprints[0] : null; } catch { return null; } }

// Reconstruye el contenedor según el modo actual (paginado o scroll).
async function rerender() {
  if (!pdfDoc) return;
  teardownScroll();
  const container = document.getElementById('pdf-container');
  if (!container) return;
  container.innerHTML = '';
  container.classList.toggle('pdf-scroll', readingMode === 'scroll');
  if (readingMode === 'scroll') await renderScroll();
  else await renderPaginated(currentPage);
}

// Modo paginado: un único wrapper reutilizado (comportamiento clásico).
async function renderPaginated(num) {
  const container = document.getElementById('pdf-container');
  let wrapper = container.querySelector('.pdf-page');
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.className = 'pdf-page';
    container.appendChild(wrapper);
  }
  await renderInto(wrapper, num);
  setCurrentPage(num);
}

// Modo scroll: todas las páginas apiladas en vertical, con render PEREZOSO (solo las
// cercanas al viewport se pintan; las lejanas se liberan) para no reventar memoria con
// cientos de canvas HiDPI.
async function renderScroll() {
  const container = document.getElementById('pdf-container');
  // Aspecto de la página 1 para dimensionar los placeholders (evita cargar las N páginas).
  const scale = 1.5;
  let w = 600, h = 800;
  try {
    const p1 = await pdfDoc.getPage(1);
    const vp = p1.getViewport({ scale });
    w = vp.width; h = vp.height;
  } catch (e) {}

  for (let n = 1; n <= totalPages; n++) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page';
    wrapper.dataset.page = String(n);
    wrapper.style.width = w + 'px';
    wrapper.style.height = h + 'px';
    container.appendChild(wrapper);
  }

  lazyObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const wrapper = e.target;
      const n = +wrapper.dataset.page;
      if (e.isIntersecting) {
        if (!wrapper.dataset.rendered) renderInto(wrapper, n);
      } else if (wrapper.dataset.rendered) {
        freeWrapper(wrapper);
      }
    }
  }, { root: container, rootMargin: '150% 0px' });
  container.querySelectorAll('.pdf-page').forEach(el => lazyObserver.observe(el));

  container.addEventListener('scroll', onScroll, { passive: true });

  // Posicionar en la última página vista y refrescar UI.
  const target = container.querySelector(`.pdf-page[data-page="${currentPage}"]`);
  if (target) container.scrollTop = target.offsetTop;
  setCurrentPage(currentPage);
}

// Página actual en modo scroll = la más centrada en el viewport (throttle con rAF).
function onScroll() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const container = document.getElementById('pdf-container');
    if (!container) return;
    const mid = container.scrollTop + container.clientHeight / 2;
    let best = currentPage, bestD = Infinity;
    container.querySelectorAll('.pdf-page').forEach(el => {
      const c = el.offsetTop + el.offsetHeight / 2;
      const d = Math.abs(c - mid);
      if (d < bestD) { bestD = d; best = +el.dataset.page; }
    });
    if (best !== currentPage) setCurrentPage(best);
  });
}

function teardownScroll() {
  const container = document.getElementById('pdf-container');
  if (lazyObserver) { try { lazyObserver.disconnect(); } catch (e) {} lazyObserver = null; }
  if (container) container.removeEventListener('scroll', onScroll);
}

// Libera el canvas/capas de una página fuera de vista (memoria acotada en scroll).
function freeWrapper(wrapper) {
  if (wrapper._renderTask) { try { wrapper._renderTask.cancel(); } catch (e) {} wrapper._renderTask = null; }
  const canvas = wrapper.querySelector('canvas');
  if (canvas) { canvas.width = 0; canvas.height = 0; }
  const tl = wrapper.querySelector('.textLayer'); if (tl) tl.innerHTML = '';
  const hl = wrapper.querySelector('.pdf-hl-layer'); if (hl) hl.innerHTML = '';
  wrapper.dataset.rendered = '';
}

// Renderiza una página (canvas HiDPI + capa de texto) en un wrapper dado. Común a ambos
// modos. Cancela el render en curso DEL PROPIO wrapper (evita el crash de doble render()).
async function renderInto(wrapper, num) {
  if (!pdfDoc) return;
  const page = await pdfDoc.getPage(num);
  const scale = 1.5;
  // TEC1 · Nitidez HiDPI: el canvas se PINTA a scale*dpr y se MUESTRA al tamaño lógico.
  const dpr = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale });
  const renderViewport = page.getViewport({ scale: scale * dpr });

  wrapper.dataset.page = String(num);
  wrapper.style.width = viewport.width + 'px';
  wrapper.style.height = viewport.height + 'px';
  wrapper.style.setProperty('--scale-factor', String(scale));

  let canvas = wrapper.querySelector('canvas');
  if (!canvas) { canvas = document.createElement('canvas'); wrapper.appendChild(canvas); }
  const ctx = canvas.getContext('2d');
  canvas.width = Math.floor(renderViewport.width);
  canvas.height = Math.floor(renderViewport.height);
  canvas.style.width = Math.floor(viewport.width) + 'px';
  canvas.style.height = Math.floor(viewport.height) + 'px';

  if (wrapper._renderTask) { try { wrapper._renderTask.cancel(); } catch (e) {} }
  const task = page.render({ canvasContext: ctx, viewport: renderViewport });
  wrapper._renderTask = task;
  try {
    await task.promise;
  } catch (e) {
    if (e && e.name === 'RenderingCancelledException') return;   // lo reemplaza un render posterior
    throw e;
  }
  if (wrapper._renderTask === task) wrapper._renderTask = null;

  await renderTextLayer(page, viewport, wrapper);
  wrapper.dataset.rendered = '1';

  // Re-pintar los subrayados de esta página (app.js escucha este evento).
  window.dispatchEvent(new CustomEvent('reader:pdf-page-rendered', { detail: { page: num } }));
}

// Fija la página actual y refresca progreso/almacenamiento/callback (ambos modos).
function setCurrentPage(num) {
  currentPage = num;
  saveLastPage();
  updateProgress();
  if (onPageCallback) onPageCallback(currentPage, totalPages);
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
  if (currentPage > 1) await goTo(currentPage - 1);
}

export async function next() {
  if (currentPage < totalPages) await goTo(currentPage + 1);
}

export async function goTo(page) {
  if (page < 1 || page > totalPages) return;
  if (readingMode === 'scroll') {
    // Desplazar hasta la página; el observer la pinta si aún no lo estaba.
    const container = document.getElementById('pdf-container');
    const target = container?.querySelector(`.pdf-page[data-page="${page}"]`);
    if (target) container.scrollTo({ top: target.offsetTop, behavior: 'auto' });
    setCurrentPage(page);
  } else {
    await renderPaginated(page);
  }
}

export function onPage(cb) {
  onPageCallback = cb;
}

// Captura la página ACTUAL renderizada como data URL (JPEG), reescalada al lado largo
// `maxPx` para acotar tokens/coste del turno de visión. Devuelve null si aún no está
// pintada (canvas sin tamaño). Reusa el canvas que ya renderizamos.
export function capturePageImage(maxPx = 1024) {
  const canvas = document.querySelector(`#pdf-container .pdf-page[data-page="${currentPage}"] canvas`)
    || document.querySelector('#pdf-container canvas');
  if (!canvas || !canvas.width || !canvas.height) return null;
  const scale = Math.min(1, maxPx / Math.max(canvas.width, canvas.height));
  if (scale >= 1) return canvas.toDataURL('image/jpeg', 0.85);
  const off = document.createElement('canvas');
  off.width = Math.round(canvas.width * scale);
  off.height = Math.round(canvas.height * scale);
  off.getContext('2d').drawImage(canvas, 0, 0, off.width, off.height);
  return off.toDataURL('image/jpeg', 0.85);
}

// Portada para la estantería: renderiza la PÁGINA 1 en un canvas propio (fuera de pantalla)
// y devuelve un data URL JPEG reescalado (lado largo ≈ maxPx). '' si no se puede.
export async function renderCoverDataUrl(maxPx = 400) {
  if (!pdfDoc) return '';
  try {
    const page = await pdfDoc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = maxPx / Math.max(base.width, base.height);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.8);
  } catch (e) {
    console.warn('pdf cover render error:', e);
    return '';
  }
}

// Índice del PDF para el sidebar: outline anidado con la página de inicio ya resuelta.
// Devuelve [{ label, page, subitems: [...] }] (vacío si el PDF no trae outline).
export async function getOutlineItems() {
  if (!pdfDoc) return [];
  let outline = null;
  try { outline = await pdfDoc.getOutline(); } catch { return []; }
  if (!outline || !outline.length) return [];
  const build = async (items) => {
    const out = [];
    for (const it of items) {
      const label = (it.title || '').replace(/\s+/g, ' ').trim();
      if (!label) continue;
      const page = await destToPage(it.dest);
      const subitems = (it.items && it.items.length) ? await build(it.items) : [];
      out.push({ label, page, subitems });
    }
    return out;
  };
  return build(outline);
}

async function destToPage(dest) {
  try {
    let explicit = dest;
    if (typeof dest === 'string') explicit = await pdfDoc.getDestination(dest);
    if (!Array.isArray(explicit) || !explicit.length) return null;
    const idx = await pdfDoc.getPageIndex(explicit[0]);   // 0-based
    return idx + 1;
  } catch {
    return null;
  }
}
