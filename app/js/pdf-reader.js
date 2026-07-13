import * as Storage from './storage.js';

let pdfjsLib = null;
let pdfDoc = null;
let currentPage = 1;
let totalPages = 0;
let onPageCallback = null;
let readingMode = 'paginated';   // 'paginated' | 'scroll' (continuo), recordado por libro
let lazyObserver = null;         // observer del render perezoso en modo scroll
let scrollRaf = 0;

// ---- Zoom fluido (tipo Adobe): sin re-render ------------------------------
// Cada página se pinta OVERSAMPLEADA (canvas a ~OVERSAMPLE× su tamaño mostrado), así
// ampliar hasta ~OVERSAMPLE× sigue nítido sin re-rasterizar. El zoom vive en el layout:
//   .pdf-page  → caja de tamaño fit·zoom (define el área de scroll → paneo NATIVO)
//   .pdf-scaler→ contenido a tamaño fit con transform: scale(zoom) (canvas + capa de texto)
// Durante el gesto (pinch táctil, pinch de trackpad o Ctrl+rueda) escalamos en vivo el
// #pdf-zoom-layer (GPU, mantecoso) y al terminar "horneamos" (redimensionar cajas +
// scaler), anclando el scroll al punto focal. No se llama a pdf.js en todo el gesto.
let zoom = 1;
let zoomHandlersReady = false;
const PDF_PAD = 20;             // padding del contenedor (coincide con el CSS)
const OVERSAMPLE = 2.5;         // el canvas se pinta 2.5× → nítido al ampliar sin re-render
const MAX_BACKING_PX = 3800;    // tope del lado mayor del canvas (memoria)
const ZOOM_MIN = 1, ZOOM_MAX = 6;

const clampZoom = (z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

// Ajuste a ancho (a zoom 1): la página cabe en el ancho disponible; tope 1.5 para no
// agigantar en pantallas anchas. El zoom se aplica aparte (layout), no aquí.
function fitScale(baseWidth) {
  const c = document.getElementById('pdf-container');
  const avail = (c ? c.clientWidth : 800) - PDF_PAD * 2;
  return Math.min(avail > 0 && baseWidth > 0 ? avail / baseWidth : 1.5, 1.5);
}

function pdfPages() {
  const c = document.getElementById('pdf-container');
  return c ? Array.from(c.querySelectorAll('.pdf-page')) : [];
}
function zoomLayer() { return document.getElementById('pdf-zoom-layer'); }

export function getZoom() { return zoom; }

// "Hornea" el zoom en el layout: cada caja pasa a fit·zoom y su scaler a scale(zoom).
// El canvas (oversampleado) se re-escala por CSS → nítido, SIN volver a pdf.js.
function applyCommittedZoom() {
  for (const w of pdfPages()) {
    const fw = parseFloat(w.dataset.fitw || '0'), fh = parseFloat(w.dataset.fith || '0');
    if (fw && fh) { w.style.width = (fw * zoom) + 'px'; w.style.height = (fh * zoom) + 'px'; }
    const s = w.querySelector('.pdf-scaler');
    if (s) s.style.transform = zoom === 1 ? '' : `scale(${zoom})`;
  }
}

// Fija el zoom anclado a un punto de pantalla (client coords). Reposiciona el scroll para
// que ese punto del contenido siga bajo el foco. Sin re-render.
export function setZoom(z, focalClient) {
  const nz = clampZoom(z);
  const container = document.getElementById('pdf-container');
  if (Math.abs(nz - zoom) < 0.0005 || !container) { zoom = nz; applyCommittedZoom(); return; }
  const ratio = nz / zoom;
  const cr = container.getBoundingClientRect();
  const fx = focalClient ? focalClient.x - cr.left : container.clientWidth / 2;
  const fy = focalClient ? focalClient.y - cr.top : container.clientHeight / 2;
  const sl = container.scrollLeft, stp = container.scrollTop;
  zoom = nz;
  applyCommittedZoom();
  // El contenido escaló por `ratio`; el padding del contenedor NO escala.
  container.scrollLeft = Math.max(0, (sl + fx - PDF_PAD) * ratio + PDF_PAD - fx);
  container.scrollTop  = Math.max(0, (stp + fy - PDF_PAD) * ratio + PDF_PAD - fy);
}
export function resetZoom() { setZoom(1); }

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
  zoom = 1;                     // cada libro empieza ajustado a ancho

  const container = document.getElementById('pdf-container');
  container.innerHTML = '';
  // El contenedor es el ÁREA DE SCROLL (block). El centrado y el llenado de ancho los hace
  // #pdf-zoom-layer (flex column, align-items:center). Ponerlo en `flex` aquí lo convertía en
  // flex-item que encogía a su contenido y se pegaba a la izquierda → margen gris a la derecha
  // en pantallas anchas (landscape). Ver CSS de .pdf-container.
  container.style.display = 'block';
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

// Reconstruye el contenedor según el modo actual (paginado o scroll). Las páginas viven
// dentro de #pdf-zoom-layer (lo que escalamos EN VIVO durante el pinch).
async function rerender() {
  if (!pdfDoc) return;
  teardownScroll();
  const container = document.getElementById('pdf-container');
  if (!container) return;
  container.innerHTML = '';
  container.classList.toggle('pdf-scroll', readingMode === 'scroll');
  const layer = document.createElement('div');
  layer.id = 'pdf-zoom-layer';
  container.appendChild(layer);
  ensureZoomHandlers();
  if (readingMode === 'scroll') await renderScroll();
  else await renderPaginated(currentPage);
}

// Gestos de zoom. Todas las rutas comparten el mismo preview EN VIVO: durante el gesto
// solo se escala #pdf-zoom-layer con transform (GPU, sin reflow) y al terminar se hornea
// con setZoom (cajas + scroll anclado al foco). Rutas:
//   - Pinch de 2 dedos (táctil). 1 dedo = scroll/selección NATIVOS (no se tocan).
//   - Ctrl/⌘+rueda y pinch de trackpad (Chrome/Edge/Firefox lo emiten como wheel con
//     ctrlKey): factor exponencial proporcional a deltaY, horneado al acabar la ráfaga.
//   - Pinch de trackpad en Safari (no emite wheel+ctrlKey; usa gesturestart/change/end).
function ensureZoomHandlers() {
  if (zoomHandlersReady) return;
  const container = document.getElementById('pdf-container');
  if (!container) return;
  zoomHandlersReady = true;

  // ---- Preview en vivo compartido -----------------------------------------
  // preview.target = zoom objetivo acumulado; el layer muestra target/zoom (relativo
  // al horneado). El foco (fx,fy) se fija al empezar el gesto.
  let preview = null;                    // { target, fx, fy }
  let wheelTimer = 0;

  const startPreview = (fx, fy) => {
    if (preview) return;
    const layer = zoomLayer();
    if (layer) {                         // origen del preview en el foco (layer aún en identidad)
      const r = layer.getBoundingClientRect();
      layer.style.transformOrigin = `${fx - r.left}px ${fy - r.top}px`;
      layer.style.willChange = 'transform';
    }
    preview = { target: zoom, fx, fy };
  };
  const updatePreview = (target) => {
    if (!preview) return;
    preview.target = clampZoom(target);
    const layer = zoomLayer();
    if (layer) layer.style.transform = `scale(${preview.target / zoom})`;
  };
  const commitPreview = () => {
    clearTimeout(wheelTimer);
    if (!preview) return;
    const { target, fx, fy } = preview;
    preview = null;
    const layer = zoomLayer();
    if (layer) { layer.style.transform = ''; layer.style.willChange = ''; }
    setZoom(target, { x: fx, y: fy });   // hornea + ancla el scroll al foco
  };

  // ---- Pinch táctil (2 dedos) ----------------------------------------------
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  let pinching = false, startDist = 0, startZoom = 1;

  container.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      commitPreview();                   // cierra una ráfaga de rueda a medias, si la había
      pinching = true; startDist = dist(e.touches); startZoom = zoom;
      startPreview((e.touches[0].clientX + e.touches[1].clientX) / 2,
                   (e.touches[0].clientY + e.touches[1].clientY) / 2);
    }
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    if (!pinching || e.touches.length !== 2) return;
    e.preventDefault();                  // corta el paneo/zoom nativo de 2 dedos
    updatePreview(startZoom * (dist(e.touches) / (startDist || 1)));
  }, { passive: false });

  const endPinch = () => {
    if (!pinching) return;
    pinching = false;
    commitPreview();
  };
  container.addEventListener('touchend', endPinch);
  container.addEventListener('touchcancel', endPinch);

  // ---- Rueda / pinch de trackpad (wheel con ctrlKey) ------------------------
  const WHEEL_IDLE_MS = 140;             // sin eventos este tiempo → fin de ráfaga, hornear
  container.addEventListener('wheel', (e) => {
    if ((!e.ctrlKey && !e.metaKey) || pinching) return;
    e.preventDefault();
    // deltaMode: 0 = píxeles (trackpad y Chrome), 1 = líneas (Firefox + ratón), 2 = páginas.
    // Normalizado a píxeles, el factor exponencial es proporcional al gesto: el pinch de
    // trackpad (ráfagas de Δ pequeños) queda suave y dosificable, y una muesca de rueda
    // clásica (|Δ|≈100 px) da ~1.28×.
    const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
    if (!dy) return;
    if (!preview) startPreview(e.clientX, e.clientY);
    updatePreview(preview.target * Math.exp(-dy * 0.0025));
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(commitPreview, WHEEL_IDLE_MS);
  }, { passive: false });

  // ---- Pinch de trackpad en Safari ------------------------------------------
  // e.scale es el factor acumulado del gesto. En iOS estos eventos disparan ADEMÁS de los
  // touch events: el guard `pinching` evita manejar el gesto dos veces.
  let gestureBase = 1;
  container.addEventListener('gesturestart', (e) => {
    if (pinching) return;
    e.preventDefault();                  // corta el zoom nativo de página completa
    commitPreview();
    gestureBase = zoom;
    startPreview(e.clientX, e.clientY);
  });
  container.addEventListener('gesturechange', (e) => {
    if (pinching || !preview) return;
    e.preventDefault();
    updatePreview(gestureBase * e.scale);
  });
  container.addEventListener('gestureend', (e) => {
    if (pinching) return;
    e.preventDefault();
    commitPreview();
  });

  // Al rotar/redimensionar cambia el ancho disponible → recomputar el ajuste (re-fit).
  let rt = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { if (pdfDoc) { const k = currentPage; rerender().then(() => { if (readingMode === 'scroll') goTo(k); }); } }, 200);
  });
}

// Modo paginado: un único wrapper reutilizado (comportamiento clásico).
async function renderPaginated(num) {
  const layer = zoomLayer();
  let wrapper = layer.querySelector('.pdf-page');
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.className = 'pdf-page';
    layer.appendChild(wrapper);
  }
  await renderInto(wrapper, num);
  setCurrentPage(num);
}

// Modo scroll: todas las páginas apiladas en vertical, con render PEREZOSO (solo las
// cercanas al viewport se pintan; las lejanas se liberan) para no reventar memoria con
// cientos de canvas HiDPI.
async function renderScroll() {
  const container = document.getElementById('pdf-container');
  const layer = zoomLayer();
  // Aspecto FIT (a zoom 1) de la página 1 para dimensionar los placeholders.
  let w = 600, h = 800;
  try {
    const p1 = await pdfDoc.getPage(1);
    const vp = p1.getViewport({ scale: fitScale(p1.getViewport({ scale: 1 }).width) });
    w = vp.width; h = vp.height;
  } catch (e) {}

  for (let n = 1; n <= totalPages; n++) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page';
    wrapper.dataset.page = String(n);
    wrapper.dataset.fitw = String(w);
    wrapper.dataset.fith = String(h);
    wrapper.style.width = (w * zoom) + 'px';
    wrapper.style.height = (h * zoom) + 'px';
    layer.appendChild(wrapper);
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
  const target = layer.querySelector(`.pdf-page[data-page="${currentPage}"]`);
  if (target) { const cr = container.getBoundingClientRect(), tr = target.getBoundingClientRect(); container.scrollTop += tr.top - cr.top; }
  setCurrentPage(currentPage);
}

// Página actual en modo scroll = la más centrada en el viewport (throttle con rAF).
function onScroll() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const container = document.getElementById('pdf-container');
    if (!container) return;
    const cr = container.getBoundingClientRect();
    const midY = cr.top + container.clientHeight / 2;
    let best = currentPage, bestD = Infinity;
    container.querySelectorAll('.pdf-page').forEach(el => {
      const r = el.getBoundingClientRect();
      const c = r.top + r.height / 2;
      const d = Math.abs(c - midY);
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
  const base = page.getViewport({ scale: 1 });
  const fit = fitScale(base.width);
  const viewport = page.getViewport({ scale: fit });          // tamaño FIT (a zoom 1)
  // El canvas se pinta OVERSAMPLEADO (fit·OVERSAMPLE·dpr), con tope del lado mayor, para
  // que al ampliar por CSS siga nítido sin re-render. Se MUESTRA a tamaño fit.
  const dpr = window.devicePixelRatio || 1;
  let renderScale = fit * OVERSAMPLE * dpr;
  const longest = Math.max(base.width, base.height) * renderScale;
  if (longest > MAX_BACKING_PX) renderScale *= MAX_BACKING_PX / longest;
  const renderViewport = page.getViewport({ scale: renderScale });

  wrapper.dataset.page = String(num);
  wrapper.dataset.fitw = String(viewport.width);
  wrapper.dataset.fith = String(viewport.height);
  wrapper.style.width = (viewport.width * zoom) + 'px';       // caja = fit·zoom (área de scroll)
  wrapper.style.height = (viewport.height * zoom) + 'px';
  wrapper.style.setProperty('--scale-factor', String(fit));

  // Contenedor interno que escala todo junto (canvas + capa de texto) al zoom actual.
  let scaler = wrapper.querySelector('.pdf-scaler');
  if (!scaler) { scaler = document.createElement('div'); scaler.className = 'pdf-scaler'; wrapper.appendChild(scaler); }
  scaler.style.width = viewport.width + 'px';
  scaler.style.height = viewport.height + 'px';
  scaler.style.transform = zoom === 1 ? '' : `scale(${zoom})`;

  let canvas = scaler.querySelector('canvas');
  if (!canvas) { canvas = document.createElement('canvas'); scaler.appendChild(canvas); }
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

  await renderTextLayer(page, viewport, scaler);
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
      if (fp) {
        Storage.set('pdfLastPage_' + fp, currentPage);
        // Sello para el LWW del sync (la posición es un escalar sin updatedAt propio)
        Storage.set('pdfLastPageAt_' + fp, Date.now());
        window.dispatchEvent(new CustomEvent('bookreader:data-changed'));
      }
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
    if (target) { const cr = container.getBoundingClientRect(), tr = target.getBoundingClientRect(); container.scrollTop += tr.top - cr.top; }
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
  let outline;
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
