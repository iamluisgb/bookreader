import * as Storage from './storage.js';
import { loadPdfJs } from './vendor-loader.js';
import * as AxisLock from './pdf-axis-lock.js';

let pdfjsLib = null;
let pdfDoc = null;
// El lector en pantalla (ver isLoaded/deactivate). `claimSeq` arbitra entre una carga en
// vuelo y el lector que se le adelanta.
let active = false;
let claimSeq = 0;
let currentPage = 1;
let totalPages = 0;
let onPageCallback = null;
let readingMode = 'paginated';   // 'paginated' | 'scroll' (continuo), recordado por libro
// Id CANÓNICO del libro (SHA-256 del fichero), que app.js pasa a load(). Ver `bookKey()`.
let canonicalId = null;
let lazyObserver = null;         // observer del render perezoso en modo scroll
// Páginas que el observer da por cercanas (viewport + rootMargin). Es la lista corta
// sobre la que onScroll decide cuál está centrada, en vez de recorrer el documento.
const cercanas = new Set();
let scrollRaf = 0;

// ---- Zoom fluido (tipo Adobe): sin re-render ------------------------------
// DOS CAPAS. La BASE es la página entera, pintada oversampleada (canvas a ~OVERSAMPLE× su
// tamaño mostrado): nunca se retira, así que siempre hay algo que enseñar y ampliar hasta
// ~OVERSAMPLE× sigue nítido sin re-rasterizar. Encima, al quedarse quieto a más zoom, se
// superpone un PARCHE de detalle del trozo visible a la resolución exacta (ver más abajo).
// El zoom vive en el layout:
//   .pdf-page  → caja de tamaño fit·zoom (define el área de scroll → paneo NATIVO)
//   .pdf-scaler→ contenido a tamaño fit con transform: scale(zoom) (canvas + capa de texto)
// Durante el gesto (pinch táctil, pinch de trackpad o Ctrl+rueda) escalamos en vivo el
// #pdf-zoom-layer (GPU, mantecoso) y al terminar "horneamos" (redimensionar cajas +
// scaler), anclando el scroll al punto focal. No se llama a pdf.js en todo el gesto.
let zoom = 1;
let zoomHandlersReady = false;
let zoomPreviewing = false;     // hay un gesto de zoom en curso (preview con transform)
let fitWidth = 0;               // ancho de contenedor con el que se calcularon las cajas
const PDF_PAD = 20;             // padding del contenedor (coincide con el CSS)
const OVERSAMPLE = 1.5;         // el canvas base se pinta 1.5× → preview nítido sin re-render
const MAX_BACKING_PX = 3000;    // tope del lado mayor del canvas base (memoria)
const ZOOM_MIN = 1, ZOOM_MAX = 6;

const clampZoom = (z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

// ---- Recorte de márgenes: "Ajustar al texto" (ADR-033) --------------------
// El zoom mínimo del lector es "página entera, márgenes blancos incluidos": para que la
// mancha de texto llene la pantalla hay que pasar de zoom 1, y a partir de ahí el contenido
// excede el viewport POR CONSTRUCCIÓN → aparece scroll horizontal y la columna se descoloca
// de lado al leer. La cura no es bloquear el eje X (eso congela el síntoma y deja una vista
// torcida), sino que la unidad de ajuste deje de ser el PAPEL y pase a ser la MANCHA.
//
// El recorte es una VENTANA HORIZONTAL sobre la página, en fracciones de su ancho, uniforme
// para todo el documento (calculada por muestreo, ver computeCrop). Vive en el layout, igual
// que el zoom, y por las mismas razones (ADR-025: el zoom es compositor puro):
//   .pdf-page  → caja de ancho fitw·cropW·zoom (lo que se ve y define el área de scroll)
//   .pdf-scaler→ sigue siendo la página ENTERA, desplazada -fitw·cropX·zoom
// Es decir: el sistema de coordenadas interno del scaler NO cambia. Todo lo que mide en
// unidades fit —el parche de detalle, la capa de texto, el re-fit— sigue valiendo tal cual;
// solo hay que sumar el desplazamiento donde se cruza el borde de la caja con el contenido.
let fitMode = 'page';           // 'page' (ajusta al papel) | 'text' (recorta los márgenes)
let cropX = 0, cropW = 1;       // ventana ACTIVA, en fracción del ancho de página

function applyCrop(win) {
  cropX = win && win.w > 0 ? win.x : 0;
  cropW = win && win.w > 0 ? win.w : 1;
}

// Desplazamiento del contenido dentro de la caja, en unidades fit.
function cropOffset(fitw) { return fitw * cropX; }

// Ajuste a ancho (a zoom 1): lo que se VE cabe en el ancho disponible. Con recorte, "lo que
// se ve" es la mancha y no el papel — de ahí sale la ganancia de tamaño de letra en móvil.
//
// El tope acota el ANCHO RESULTANTE (lo que mediría el papel a escala 1.5), no la escala.
// Acotando la escala, en una pantalla ancha —donde el tope ya mordía— el recorte no podía
// crecer para compensar y la página se quedaba en una tira estrecha en el centro: pedías
// "ajustar al texto" y salía más pequeño. Sin recorte las dos formas son idénticas.
const FIT_MAX = 1.5;
function fitScale(baseWidth) {
  const c = document.getElementById('pdf-container');
  const avail = (c ? c.clientWidth : 800) - PDF_PAD * 2;
  const visible = baseWidth * cropW;
  if (!(avail > 0) || !(visible > 0)) return FIT_MAX;
  return Math.min(avail, baseWidth * FIT_MAX) / visible;
}

function pdfPages() {
  const c = document.getElementById('pdf-container');
  return c ? Array.from(c.querySelectorAll('.pdf-page')) : [];
}
function zoomLayer() { return document.getElementById('pdf-zoom-layer'); }

export function getZoom() { return zoom; }

// Coloca UNA página: la caja es la ventana de recorte a zoom actual, y el scaler —que sigue
// siendo la página entera— se desplaza para que el borde izquierdo del recorte caiga en 0.
// Con transform-origin 0 0, `translateX(t) scale(z)` lleva el punto fit `p` a `z·p + t`;
// queremos que fit `fitw·cropX` caiga en 0, así que t = -fitw·cropX·zoom.
function layoutWrapper(w) {
  const fw = parseFloat(w.dataset.fitw || '0'), fh = parseFloat(w.dataset.fith || '0');
  if (!fw || !fh) return;
  w.style.width = (fw * cropW * zoom) + 'px';
  w.style.height = (fh * zoom) + 'px';
  // El recorte lo leen también los subrayados y las citas, que guardan sus rects en
  // fracciones de PÁGINA COMPLETA y tienen que mapearlos a esta caja (ver highlights-ui.js).
  w.dataset.cropx = String(cropX);
  w.dataset.cropw = String(cropW);
  const s = w.querySelector('.pdf-scaler');
  if (s) {
    const tx = -cropOffset(fw) * zoom;
    const t = tx ? `translateX(${tx}px)` : '';
    s.style.transform = (zoom === 1 ? t : `${t} scale(${zoom})`).trim();
  }
}

// "Hornea" el zoom en el layout: cada caja pasa a fit·cropW·zoom y su scaler a scale(zoom).
// El canvas (oversampleado) se re-escala por CSS → nítido, SIN volver a pdf.js.
function applyCommittedZoom() {
  const layer = zoomLayer();
  if (layer) layer.style.setProperty('--pdf-zoom', String(zoom));   // el gap escala con el zoom
  for (const w of pdfPages()) layoutWrapper(w);
  scheduleDetail();
}

// ---- Capa de detalle (parche nítido bajo demanda) --------------------------
// El canvas base se pinta a fit·OVERSAMPLE·dpr: nítido hasta ~OVERSAMPLE× con memoria
// acotada. Más allá, en vez de subir el oversample de TODAS las páginas —coste que crece
// con el zoom Y con el nº de páginas montadas en modo scroll—, al quedarse quieto se
// rasteriza SOLO el trozo visible a la resolución exacta del zoom y se superpone al base.
//
// La base NUNCA se retira, así que el parche solo AÑADE nitidez: en ningún momento del
// gesto hay hueco en blanco. Y como vive dentro del .pdf-scaler posicionado en unidades
// fit, sigue siendo geométricamente correcto a cualquier zoom posterior — al ampliar más
// se queda blando (y se repinta al parar), al reducir sobra resolución (y se descarta).
// Por eso tampoco hay que esconderlo durante el pinch: escala con todo lo demás.
const DETAIL_IDLE_MS = 220;      // quietud (zoom o scroll) antes de pedir el parche
const DETAIL_MAX_PX = 3000;      // tope del lado mayor del parche
const DETAIL_MAX_AREA = 4.5e6;   // tope de área del parche (~18 MB de backing)
const DETAIL_MARGIN = 0.08;      // margen alrededor del viewport (aguanta paneos cortos)
let detailTimer = 0;
let detailSeq = 0;               // invalida los parches en vuelo (cambió el zoom/scroll/doc)

function scheduleDetail() {
  clearTimeout(detailTimer);
  detailTimer = setTimeout(() => { runDetail().catch(e => console.warn('pdf detail:', e)); }, DETAIL_IDLE_MS);
}

// Cancela y suelta el parche de una página (fuera de vista, re-fit, o ya no hace falta).
function dropDetail(wrapper) {
  if (wrapper._detailTask) { try { wrapper._detailTask.cancel(); } catch (e) {} wrapper._detailTask = null; }
  const d = wrapper.querySelector('canvas.pdf-detail');
  if (d) { d.width = d.height = 0; d.remove(); }
  wrapper.dataset.detailKey = '';
}

function dropAllDetail() {
  detailSeq++;
  clearTimeout(detailTimer);
  for (const w of pdfPages()) dropDetail(w);
}

// Recorre las páginas montadas: pinta parche en las visibles que lo necesiten y suelta el
// de las que no. Secuencial a propósito — un solo render de pdf.js a la vez.
async function runDetail() {
  const container = document.getElementById('pdf-container');
  if (!pdfDoc || !container) return;
  if (zoomPreviewing) { scheduleDetail(); return; }   // mitad de un gesto: las medidas mienten
  const seq = ++detailSeq;
  const cr = container.getBoundingClientRect();
  const need = zoom * (window.devicePixelRatio || 1);  // px de backing por unidad fit que pide el zoom
  for (const w of pdfPages()) {
    if (seq !== detailSeq) return;
    if (!w.dataset.rendered) continue;
    const r = w.getBoundingClientRect();
    const vis = {
      top: Math.max(r.top, cr.top), bottom: Math.min(r.bottom, cr.bottom),
      left: Math.max(r.left, cr.left), right: Math.min(r.right, cr.right),
    };
    const rbase = parseFloat(w.dataset.rratio || '0');
    // Fuera de vista, o el base ya da resolución de sobra → no gastar memoria.
    if (vis.bottom - vis.top < 1 || vis.right - vis.left < 1 || !rbase || need <= rbase * 1.05) {
      dropDetail(w);
      continue;
    }
    await renderDetail(w, r, vis, need, seq);
  }
}

async function renderDetail(wrapper, wr, vis, need, seq) {
  const num = +wrapper.dataset.page || currentPage;
  const fitw = parseFloat(wrapper.dataset.fitw || '0');
  const fith = parseFloat(wrapper.dataset.fith || '0');
  const basew = parseFloat(wrapper.dataset.basew || '0');
  if (!fitw || !fith || !basew) return;
  const fit = fitw / basew;                 // px CSS por unidad PDF (a zoom 1)

  // Región visible de la página en unidades fit (el sistema del .pdf-scaler), con margen.
  // Con recorte, el borde izquierdo de la CAJA (wr.left) no es el de la página: es la unidad
  // fit `cropOffset(fitw)`. Sin este sumando el parche saldría desplazado justo lo recortado.
  const mx = (vis.right - vis.left) * DETAIL_MARGIN, my = (vis.bottom - vis.top) * DETAIL_MARGIN;
  const ux = Math.max(0, cropOffset(fitw) + (vis.left - mx - wr.left) / zoom);
  const uy = Math.max(0, (vis.top - my - wr.top) / zoom);
  const uw = Math.min((vis.right - vis.left + 2 * mx) / zoom, fitw - ux);
  const uh = Math.min((vis.bottom - vis.top + 2 * my) / zoom, fith - uy);
  if (uw < 1 || uh < 1) return;

  // Resolución del parche: la exacta del zoom, acotada por lado y por área → la memoria del
  // parche NO crece con el zoom (a más zoom, menos página cabe en el mismo viewport).
  const rbase = parseFloat(wrapper.dataset.rratio || '0');
  const r = Math.min(need, DETAIL_MAX_PX / Math.max(uw, uh), Math.sqrt(DETAIL_MAX_AREA / (uw * uh)));
  if (r <= rbase * 1.05) return;            // tras acotar ya no mejora al base

  const key = [num, Math.round(ux), Math.round(uy), Math.round(uw), Math.round(uh), r.toFixed(2)].join(':');
  if (wrapper.dataset.detailKey === key) return;   // ese parche ya está puesto

  const page = await pdfDoc.getPage(num);
  if (seq !== detailSeq) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'pdf-detail';
  canvas.width = Math.max(1, Math.floor(uw * r));
  canvas.height = Math.max(1, Math.floor(uh * r));
  canvas.style.left = ux + 'px';
  canvas.style.top = uy + 'px';
  canvas.style.width = uw + 'px';           // tamaño fit → escala con el scaler
  canvas.style.height = uh + 'px';

  if (wrapper._detailTask) { try { wrapper._detailTask.cancel(); } catch (e) {} }
  // `transform` desplaza el origen antes del viewport: se pide la página entera a la escala
  // del parche pero solo cae en el canvas el rectángulo que interesa (recorte, no reescalado).
  const task = page.render({
    canvasContext: canvas.getContext('2d'),
    viewport: page.getViewport({ scale: fit * r }),
    transform: [1, 0, 0, 1, -ux * r, -uy * r],
  });
  wrapper._detailTask = task;
  try {
    await task.promise;
  } catch (e) {
    canvas.width = canvas.height = 0;
    if (e && e.name === 'RenderingCancelledException') return;
    throw e;
  }
  if (wrapper._detailTask === task) wrapper._detailTask = null;
  const scaler = wrapper.querySelector('.pdf-scaler');
  if (seq !== detailSeq || !scaler) { canvas.width = canvas.height = 0; return; }

  // DOBLE BUFFER, igual que el base: el parche viejo no se quita hasta tener el nuevo listo.
  // Va justo encima del canvas base y DEBAJO de la capa de texto (que debe seguir arriba
  // para poder seleccionar).
  const prev = scaler.querySelector('canvas.pdf-detail');
  if (prev) { scaler.replaceChild(canvas, prev); prev.width = prev.height = 0; }
  else {
    const base = scaler.querySelector('canvas:not(.pdf-detail)');
    scaler.insertBefore(canvas, base ? base.nextSibling : scaler.firstChild);
  }
  wrapper.dataset.detailKey = key;
}

// Página bajo un punto de pantalla (o la más cercana). Es el ANCLA del zoom: su caja escala
// exactamente por el zoom alrededor de su esquina, así que sirve de sistema de referencia
// estable — a diferencia del contenedor, cuyo padding, centrado y huecos no escalan.
function pageAt(clientY) {
  const pages = pdfPages();
  let best = null, bestD = Infinity;
  for (const p of pages) {
    const r = p.getBoundingClientRect();
    const d = clientY < r.top ? r.top - clientY : clientY > r.bottom ? clientY - r.bottom : 0;
    if (d < bestD) { bestD = d; best = p; }
    if (d === 0) break;
  }
  return best;
}

// Fija el zoom anclado a un punto de pantalla (client coords). Reposiciona el scroll para
// que ese punto del contenido siga bajo el foco. Sin re-render.
//
// La corrección se MIDE, no se calcula: antes se aplicaba la fórmula "todo escala por ratio
// desde el padding", pero ni el padding, ni el centrado del layer, ni los huecos entre
// páginas escalan igual, y el scroll además se recorta en los bordes. Cada desajuste era un
// saltito al soltar los dedos. Ahora anotamos dónde cae el foco DENTRO de la página ancla,
// horneamos, y corregimos el scroll con la posición real resultante.
export function setZoom(z, focalClient) {
  // Se ancla el scroll al foco moviendo scrollLeft a mano: si venía un eje decidido de un
  // gesto anterior (ADR-034), soltarlo antes o repondría el X justo después de anclarlo.
  AxisLock.release();
  const nz = clampZoom(z);
  const container = document.getElementById('pdf-container');
  if (Math.abs(nz - zoom) < 0.0005 || !container) { zoom = nz; applyCommittedZoom(); return; }
  const cr = container.getBoundingClientRect();
  const fx = focalClient ? focalClient.x : cr.left + container.clientWidth / 2;
  const fy = focalClient ? focalClient.y : cr.top + container.clientHeight / 2;
  const anchor = pageAt(fy);
  if (!anchor) { zoom = nz; applyCommittedZoom(); return; }
  // Punto del contenido bajo el foco, en unidades "a zoom 1" de la página ancla.
  const before = anchor.getBoundingClientRect();
  const ux = (fx - before.left) / zoom, uy = (fy - before.top) / zoom;
  zoom = nz;
  applyCommittedZoom();
  // getBoundingClientRect fuerza el layout: ya son las posiciones nuevas.
  const after = anchor.getBoundingClientRect();
  container.scrollLeft += (after.left + ux * zoom) - fx;
  container.scrollTop  += (after.top  + uy * zoom) - fy;
}
export function resetZoom() { setZoom(1); }

// Síncrono: devuelve la lib SI ya está en memoria. Vale para todo lo que corre
// durante el renderizado, que por definición sucede después de load().
function getPdfjs() {
  if (pdfjsLib) return pdfjsLib;
  // El bundle (vendorizado) lo expone como window.pdfjsLib o window["pdfjs-dist/build/pdf"]
  pdfjsLib = window.pdfjsLib || window['pdfjs-dist/build/pdf'] || window['pdfjsLib'];
  if (pdfjsLib) configurarWorker();
  return pdfjsLib;
}

// El único sitio que puede encontrarse la lib SIN cargar es load(): pdf.js ya no viene
// en el arranque, se pide al abrir el primer PDF (ver js/vendor-loader.js).
async function ensurePdfjs() {
  if (getPdfjs()) return pdfjsLib;
  await loadPdfJs();
  return getPdfjs();
}

function configurarWorker() {
  try {
    // Worker local (mismo origen): funciona offline y bajo CSP worker-src 'self'.
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker-3.11.174.min.js';
  } catch(e) {
    console.warn('pdf.js worker setup error:', e);
  }
}

// "Cargado" = hay documento Y es el lector que está en pantalla (ver deactivate y el
// gemelo en epub-reader.js).
export function isLoaded() {
  return pdfDoc !== null && active;
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

// Deja de ser el lector activo (lo llama app.js al abrir un EPUB). Baja la BANDERA, no el
// documento: el agente puede estar recorriéndolo para segmentarlo bajo su propio id, y una
// carga aún en vuelo no debe quedarse sin documento a medias (ver el gemelo en
// epub-reader.js y tests/book-switch.spec.ts).
export function deactivate() {
  teardownScroll();
  canonicalId = null;
  active = false;
  claimSeq++;
}

export async function load(arrayBuffer, onProgress, bookId = null) {
  canonicalId = bookId || null;
  const lib = await ensurePdfjs();
  if (!lib) {
    throw new Error('pdf.js not loaded');
  }

  const mine = ++claimSeq;
  active = true;
  if (pdfDoc) {
    try { pdfDoc.destroy(); } catch(e) { console.warn('pdf destroy error:', e); }
    pdfDoc = null;
  }
  flatOutline = null;

  currentPage = 1;
  zoom = 1;                     // cada libro empieza ajustado a ancho
  fitMode = 'page';             // ...y sin recorte, hasta leer lo guardado de ESTE libro
  applyCrop(null);

  const container = document.getElementById('pdf-container');
  container.innerHTML = '';
  // El contenedor es el ÁREA DE SCROLL (block). El centrado y el llenado de ancho los hace
  // #pdf-zoom-layer (flex column, align-items:center). Ponerlo en `flex` aquí lo convertía en
  // flex-item que encogía a su contenido y se pegaba a la izquierda → margen gris a la derecha
  // en pantallas anchas (landscape). Ver CSS de .pdf-container.
  container.style.display = 'block';
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

  // Trasladar lo guardado bajo la huella de pdf.js al id canónico (ver bookKey()).
  try { migrateLegacyKeys(); } catch (e) { console.warn('migración de claves por libro:', e); }

  // Restore last page
  try {
    const k = bookKey();
    if (k) {
      const lastPage = Storage.get('pdfLastPage_' + k);
      if (lastPage && lastPage >= 1 && lastPage <= totalPages) {
        currentPage = lastPage;
      }
    }
  } catch(e) {}

  // Modo de lectura recordado por libro (paginado por defecto).
  try {
    const k = bookKey();
    const m = k ? Storage.get('pdfMode_' + k) : null;
    if (m === 'scroll' || m === 'paginated') readingMode = m;
  } catch (e) {}

  // Ajuste de ancho recordado por libro (al papel por defecto). El recorte se resuelve
  // ANTES del primer render: entrar sin él y recortar después obligaría a re-rasterizar
  // el documento entero y a mover el scroll delante del usuario.
  try {
    const k = bookKey();
    if (k && Storage.get('pdfFit_' + k) === 'text') {
      fitMode = 'text';
      await ensureCrop();
    }
  } catch (e) { console.warn('recorte de márgenes:', e); }

  await rerender();

  if (claimSeq !== mine) active = false;   // otro lector tomó la pantalla mientras cargaba
  return pdfDoc;
}

// ---- Modo de lectura: paginado vs scroll continuo -------------------------
export function getReadingMode() { return readingMode; }

export async function setReadingMode(mode) {
  if ((mode !== 'scroll' && mode !== 'paginated') || mode === readingMode) return;
  readingMode = mode;
  try { const k = bookKey(); if (k) Storage.set('pdfMode_' + k, mode); } catch (e) {}
  await rerender();
  window.dispatchEvent(new CustomEvent('reader:flow-changed'));
}

// ---- Ajuste de ancho: al papel o a la mancha (ADR-033) --------------------
export function getFitMode() { return fitMode; }

// Cambiar de ajuste cambia `fit` (la escala a la que se rasteriza), así que hay que volver
// a pintar: no es un cambio de compositor como el zoom. Se reconstruye por el mismo camino
// que el cambio de modo de lectura, que ya sabe recolocarse en la página actual.
export async function setFitMode(mode) {
  if ((mode !== 'page' && mode !== 'text') || mode === fitMode) return;
  fitMode = mode;
  try { const k = bookKey(); if (k) Storage.set('pdfFit_' + k, mode); } catch (e) {}
  if (mode === 'text') await ensureCrop();
  else applyCrop(null);
  // El zoom que tuvieras era el apaño para llenar el ancho; el recorte ya lo hace. Dejarlo
  // puesto amplía SOBRE el recorte y devuelve el scroll horizontal que veníamos a quitar.
  zoom = 1;
  await rerender();
  window.dispatchEvent(new CustomEvent('reader:flow-changed'));
}

// Ventana de recorte del libro actual: la calculada (y cacheada) o ninguna.
async function ensureCrop() {
  const k = bookKey();
  let win = null;
  try {
    const guardado = k ? Storage.get('pdfCrop_' + k) : null;
    if (guardado && guardado.w > 0) win = guardado;
  } catch (e) {}
  if (!win) {
    win = await computeCrop();
    // Derivado y barato de rehacer: se cachea en local pero NO se sincroniza (ver layout.js).
    try { if (k && win) Storage.set('pdfCrop_' + k, win); } catch (e) {}
  }
  applyCrop(win);
}

// ---- Cálculo del recorte ---------------------------------------------------
// Se mide sobre PÍXELES, no sobre la capa de texto: así funciona igual en un PDF digital,
// en uno escaneado (que no tiene capa de texto) y en uno con figuras a sangre. Se rasteriza
// una muestra de páginas a ~200 px de ancho —calderilla— y se busca la primera y la última
// columna con tinta.
//
// El recorte es UNIFORME para todo el documento a propósito: uno por página haría que la
// anchura bailara al pasar páginas en modo scroll. Y se agrega por PERCENTIL, no por mínimo:
// una sola página a sangre (portada, una lámina) no puede anular el recorte de las otras 300.
const CROP_SAMPLES = 8;          // páginas muestreadas
const CROP_SCAN_W = 200;         // ancho de rasterizado del muestreo, en px
const CROP_PAD = 0.015;          // aire a cada lado, en fracción de ancho (que no roce el texto)
const CROP_MIN_W = 0.5;          // nunca quitar más de la mitad del ancho (red de seguridad)
const CROP_NOOP_W = 0.985;       // por debajo de esto no hay márgenes que quitar

function samplePages() {
  // La portada suele ir a sangre y no dice nada de los márgenes del cuerpo.
  const first = totalPages >= 6 ? 2 : 1;
  const n = Math.min(CROP_SAMPLES, totalPages - first + 1);
  if (n <= 0) return [1];
  const span = totalPages - first;
  const out = new Set();
  for (let i = 0; i < n; i++) out.add(first + Math.round(span * (n === 1 ? 0 : i / (n - 1))));
  return [...out];
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.round(p * (sorted.length - 1));
  return sorted[Math.max(0, Math.min(sorted.length - 1, i))];
}

async function computeCrop() {
  if (!pdfDoc) return null;
  const lefts = [], rights = [];
  for (const n of samplePages()) {
    let b = null;
    try { b = await inkBounds(n); } catch (e) { console.warn('muestreo de márgenes:', e); }
    if (b) { lefts.push(b.left); rights.push(b.right); }
  }
  if (lefts.length < 2) return null;          // sin muestra suficiente, no inventamos nada
  lefts.sort((a, b) => a - b);
  rights.sort((a, b) => a - b);
  let x = Math.max(0, percentile(lefts, 0.15) - CROP_PAD);
  const x1 = Math.min(1, percentile(rights, 0.85) + CROP_PAD);
  let w = x1 - x;
  if (!(w > 0)) return null;
  // Conservador a propósito: si el recorte saliera agresivo, se abre hasta CROP_MIN_W. Una
  // tabla más ancha que la mancha se sigue viendo casi entera, y siempre queda «Página».
  if (w < CROP_MIN_W) {
    x = Math.max(0, x - (CROP_MIN_W - w) / 2);
    w = Math.min(1 - x, CROP_MIN_W);
  }
  if (w >= CROP_NOOP_W) return { x: 0, w: 1 };
  return { x: +x.toFixed(4), w: +w.toFixed(4) };
}

// Primera y última columna con tinta de una página, en fracción de su ancho.
async function inkBounds(num) {
  const page = await pdfDoc.getPage(num);
  const base = page.getViewport({ scale: 1 });
  if (!base.width) return null;
  const vp = page.getViewport({ scale: CROP_SCAN_W / base.width });
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.floor(vp.width));
  cv.height = Math.max(1, Math.floor(vp.height));
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  // Fondo blanco explícito: un PDF sin caja de papel se rasteriza sobre transparente, y
  // entonces "oscuro" y "vacío" serían indistinguibles al leer los píxeles.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const { data } = ctx.getImageData(0, 0, cv.width, cv.height);
  const n = cv.width * cv.height;
  const lum = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; p < n; i += 4, p++) {
    const l = (data[i] * 77 + data[i + 1] * 151 + data[i + 2] * 28) >> 8;
    lum[p] = l; hist[l]++;
  }
  // Umbral RELATIVO al fondo (su mediana): un escaneo sobre papel gris no es "todo tinta".
  let acc = 0, med = 255;
  for (let l = 0; l < 256; l++) { acc += hist[l]; if (acc * 2 >= n) { med = l; break; } }
  const thr = Math.min(med - 18, 235);
  const W = cv.width, H = cv.height;
  let min = W, max = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (lum[row + x] <= thr) {
        if (x < min) min = x;
        if (x > max) max = x;
      }
    }
  }
  cv.width = cv.height = 0;                   // suelta el backing del muestreo
  if (max < 0) return null;                   // página en blanco: no opina
  return { left: min / W, right: (max + 1) / W };
}

// Clave de lo que se guarda por libro (última página, modo). El id canónico es el SHA-256
// del fichero, el MISMO que usan biblioteca, subrayados y sync. Antes se usaba la huella de
// pdf.js, que metía la posición en otro espacio de ids: viajaba al proveedor como "libro
// fantasma" sin título y la reconciliación de alias no la alcanzaba. Ver BACKLOG TEC5.
function bookKey() { return canonicalId || fpKey(); }

function fpKey() { try { return pdfDoc && pdfDoc.fingerprints ? pdfDoc.fingerprints[0] : null; } catch { return null; } }

const CLAVES_POR_LIBRO = ['pdfLastPage', 'pdfLastPageAt', 'pdfMode', 'pdfFit', 'pdfCrop'];

// Traslada lo guardado bajo la huella de pdf.js al id canónico, una vez por libro. Gana el
// más reciente por `pdfLastPageAt` —el mismo LWW de escalares que aplica el sync— y la
// clave vieja se BORRA: si se dejara, `buildSnapshot()` la seguiría subiendo como fantasma.
function migrateLegacyKeys() {
  const viejo = fpKey();
  if (!canonicalId || !viejo || viejo === canonicalId) return;
  if (Storage.get('pdfLastPage_' + viejo) != null) {
    const tNuevo = Number(Storage.get('pdfLastPageAt_' + canonicalId)) || 0;
    const tViejo = Number(Storage.get('pdfLastPageAt_' + viejo)) || 0;
    if (tViejo > tNuevo) {
      Storage.set('pdfLastPage_' + canonicalId, Storage.get('pdfLastPage_' + viejo));
      Storage.set('pdfLastPageAt_' + canonicalId, tViejo);
    }
  }
  // Escalares sin sello (modo de lectura, ajuste de ancho): solo se adoptan si aquí no
  // había nada elegido. El recorte cacheado no se traslada: se recalcula solo y es barato.
  for (const p of ['pdfMode', 'pdfFit']) {
    const v = Storage.get(p + '_' + viejo);
    if (v != null && Storage.get(p + '_' + canonicalId) == null) Storage.set(p + '_' + canonicalId, v);
  }
  for (const p of CLAVES_POR_LIBRO) Storage.remove(p + '_' + viejo);
}

// Reconstruye el contenedor según el modo actual (paginado o scroll). Las páginas viven
// dentro de #pdf-zoom-layer (lo que escalamos EN VIVO durante el pinch).
async function rerender() {
  if (!pdfDoc) return;
  teardownScroll();
  dropAllDetail();                 // se va a vaciar el contenedor: invalida parches en vuelo
  const container = document.getElementById('pdf-container');
  if (!container) return;
  fitWidth = container.clientWidth;
  container.innerHTML = '';
  container.classList.toggle('pdf-scroll', readingMode === 'scroll');
  const layer = document.createElement('div');
  layer.id = 'pdf-zoom-layer';
  container.appendChild(layer);
  ensureZoomHandlers();
  if (readingMode === 'scroll') await renderScroll();
  else await renderPaginated(currentPage);
}

// Re-ajuste al nuevo ancho SIN reconstruir nada: se recalculan las cajas (fit·zoom) sobre los
// mismos elementos y se ancla el scroll a la página que estabas leyendo. El canvas está
// oversampleado, así que mientras tanto se re-escala por CSS y sigue nítido; después se
// re-rasteriza lo que está a la vista (con doble buffer, sin hueco en blanco).
async function refit() {
  const container = document.getElementById('pdf-container');
  if (!pdfDoc || !container) return;
  const avail = container.clientWidth;
  if (!avail || avail === fitWidth) return;   // el alto no afecta al ajuste: nada que hacer
  fitWidth = avail;
  const pages = pdfPages();
  if (!pages.length) return;
  // Cambia `fit`, y los parches están posicionados en unidades fit → dejan de encajar.
  dropAllDetail();

  // Ancla: la página del borde superior y en qué fracción de ella estás (volver al mismo
  // sitio, no al principio de la página).
  const cr = container.getBoundingClientRect();
  const anchor = pageAt(cr.top + 1) || pages[0];
  const ar = anchor.getBoundingClientRect();
  const fracY = ar.height ? (cr.top - ar.top) / ar.height : 0;

  for (const w of pages) {
    const bw = parseFloat(w.dataset.basew || '0'), bh = parseFloat(w.dataset.baseh || '0');
    if (!bw || !bh) continue;
    const f = fitScale(bw);
    const fw = bw * f, fh = bh * f;
    w.dataset.fitw = String(fw);
    w.dataset.fith = String(fh);
    w.style.setProperty('--scale-factor', String(f));
    const s = w.querySelector('.pdf-scaler');
    if (s) { s.style.width = fw + 'px'; s.style.height = fh + 'px'; }
    const cv = w.querySelector('canvas');
    if (cv) { cv.style.width = Math.floor(fw) + 'px'; cv.style.height = Math.floor(fh) + 'px'; }
  }
  applyCommittedZoom();

  const nr = anchor.getBoundingClientRect();
  container.scrollTop += (nr.top + fracY * nr.height) - cr.top;

  // Solo lo pintado: las demás las repinta el observer perezoso cuando toque.
  for (const w of pages) {
    if (w.dataset.rendered) renderInto(w, +w.dataset.page || currentPage);
  }
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
  AxisLock.install(container);          // eje dominante por gesto (ADR-034)

  // ---- Preview en vivo compartido -----------------------------------------
  // preview.target = zoom objetivo acumulado; el layer muestra target/zoom (relativo
  // al horneado). El foco (fx,fy) se fija al empezar el gesto.
  let preview = null;                    // { target, fx, fy }
  let wheelTimer = 0;

  const startPreview = (fx, fy) => {
    if (preview) return;
    // Durante el gesto las medidas son las del transform en vivo, no las del zoom horneado:
    // cualquier parche pedido ahora saldría recortado por el sitio equivocado.
    zoomPreviewing = true;
    clearTimeout(detailTimer);
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
    zoomPreviewing = false;
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
  //
  // Solo importa el ANCHO: `fitScale` no mira el alto. En móvil el alto cambia
  // constantemente (la barra de URL se pliega al hacer scroll, y al ampliar con dos dedos),
  // y cada uno de esos avisos disparaba un rerender() completo — el contenedor se vaciaba y
  // la vista saltaba al principio de la página. Justo el "se recarga y me mueve la vista".
  let rt = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(refit, 200);
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
  let w = 600, h = 800, bw = 0, bh = 0;
  try {
    const p1 = await pdfDoc.getPage(1);
    const base = p1.getViewport({ scale: 1 });
    bw = base.width; bh = base.height;
    const vp = p1.getViewport({ scale: fitScale(bw) });
    w = vp.width; h = vp.height;
  } catch (e) {}

  for (let n = 1; n <= totalPages; n++) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page';
    wrapper.dataset.page = String(n);
    wrapper.dataset.fitw = String(w);
    wrapper.dataset.fith = String(h);
    // Tamaño SIN escalar: deja re-calcular el ajuste al cambiar el ancho sin volver a pdf.js.
    if (bw && bh) { wrapper.dataset.basew = String(bw); wrapper.dataset.baseh = String(bh); }
    layoutWrapper(wrapper);
    layer.appendChild(wrapper);
  }

  cercanas.clear();
  lazyObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const wrapper = e.target;
      const n = +wrapper.dataset.page;
      if (e.isIntersecting) {
        cercanas.add(wrapper);
        if (!wrapper.dataset.rendered) renderInto(wrapper, n);
      } else {
        cercanas.delete(wrapper);
        if (wrapper.dataset.rendered) freeWrapper(wrapper);
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
//
// Se mide SOLO lo que el IntersectionObserver dice que está cerca, no las `.pdf-page` del
// documento entero. Antes eran un querySelectorAll y un getBoundingClientRect por página
// en CADA frame de scroll: en un PDF de 600 páginas, 600 reflows forzados por frame para
// averiguar cuál está en el centro. El observer ya lleva esa cuenta (con rootMargin 150%,
// así que la centrada está siempre en el conjunto) y sale gratis.
function onScroll() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const container = document.getElementById('pdf-container');
    if (!container) return;
    const cr = container.getBoundingClientRect();
    const midY = cr.top + container.clientHeight / 2;
    let best = currentPage, bestD = Infinity;
    // Si el observer aún no ha entregado su primer lote, se mira todo (una vez).
    const candidatas = cercanas.size ? cercanas : container.querySelectorAll('.pdf-page');
    for (const el of candidatas) {
      const r = el.getBoundingClientRect();
      const c = r.top + r.height / 2;
      const d = Math.abs(c - midY);
      if (d < bestD) { bestD = d; best = +el.dataset.page; }
    }
    if (best !== currentPage) setCurrentPage(best);
    scheduleDetail();     // al parar el paneo, recubrir lo que ahora se ve
  });
}

function teardownScroll() {
  const container = document.getElementById('pdf-container');
  cercanas.clear();
  if (lazyObserver) { try { lazyObserver.disconnect(); } catch (e) {} lazyObserver = null; }
  if (container) container.removeEventListener('scroll', onScroll);
}

// Libera el canvas/capas de una página fuera de vista (memoria acotada en scroll).
function freeWrapper(wrapper) {
  if (wrapper._renderTask) { try { wrapper._renderTask.cancel(); } catch (e) {} wrapper._renderTask = null; }
  dropDetail(wrapper);
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
  wrapper.dataset.basew = String(base.width);
  wrapper.dataset.baseh = String(base.height);
  // Resolución REAL del base (px de backing por unidad fit, tras el tope): es lo que decide
  // a partir de qué zoom hace falta parche de detalle.
  wrapper.dataset.rratio = String(renderScale / fit);
  wrapper.style.setProperty('--scale-factor', String(fit));

  // Contenedor interno que escala todo junto (canvas + capa de texto) al zoom actual. Mide
  // la página ENTERA aunque haya recorte: lo que recorta es la caja de fuera (layoutWrapper).
  let scaler = wrapper.querySelector('.pdf-scaler');
  if (!scaler) { scaler = document.createElement('div'); scaler.className = 'pdf-scaler'; wrapper.appendChild(scaler); }
  scaler.style.width = viewport.width + 'px';
  scaler.style.height = viewport.height + 'px';
  layoutWrapper(wrapper);                                     // caja = fit·cropW·zoom (área de scroll)

  // DOBLE BUFFER: se pinta en un canvas nuevo y solo se cuelga del DOM cuando está listo.
  // Reutilizarlo obligaba a poner canvas.width (que lo BORRA) antes de repintar, así que
  // re-rasterizar —al cambiar el ancho— dejaba la página en blanco mientras tanto.
  const prev = scaler.querySelector('canvas:not(.pdf-detail)');
  const canvas = document.createElement('canvas');
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

  // El canvas va SIEMPRE el primero: la capa de texto y la de subrayados se pintan encima.
  if (prev && prev.parentNode === scaler) {
    scaler.replaceChild(canvas, prev);
    prev.width = prev.height = 0;                 // libera el backing del viejo
  } else {
    scaler.insertBefore(canvas, scaler.firstChild);
  }

  await renderTextLayer(page, viewport, scaler);
  wrapper.dataset.rendered = '1';
  scheduleDetail();     // si estamos a zoom alto, el base recién puesto pide parche

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
      const fp = bookKey();
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

// IA6 v2 · Captura de una REGIÓN de una página, no de la página entera. `rect` es
// fraccional ({x,y,w,h} en 0..1 sobre la página), el mismo sistema de coordenadas que usan
// los subrayados de PDF — así una zona se puede guardar, repintar o volver a capturar
// aunque cambie el zoom. Recortar baja los tokens del turno de visión y, sobre todo, le
// dice al modelo QUÉ mirar: con la página entera responde en promedio sobre todo.
export function captureRegionImage(page, rect, maxPx = 1024) {
  const canvas = document.querySelector(`#pdf-container .pdf-page[data-page="${page}"] canvas`)
    || document.querySelector('#pdf-container canvas');
  if (!canvas || !canvas.width || !canvas.height || !rect) return null;
  const sx = Math.max(0, Math.round(rect.x * canvas.width));
  const sy = Math.max(0, Math.round(rect.y * canvas.height));
  const sw = Math.min(canvas.width - sx, Math.round(rect.w * canvas.width));
  const sh = Math.min(canvas.height - sy, Math.round(rect.h * canvas.height));
  if (sw < 8 || sh < 8) return null;                     // recorte degenerado: no sirve
  // Al recortar se puede AMPLIAR hasta maxPx: un recorte pequeño reescalado hacia arriba le
  // da al modelo más píxeles útiles de la figura que la misma zona dentro de la página.
  const scale = Math.min(2, maxPx / Math.max(sw, sh));
  const off = document.createElement('canvas');
  off.width = Math.max(1, Math.round(sw * scale));
  off.height = Math.max(1, Math.round(sh * scale));
  off.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, off.width, off.height);
  return off.toDataURL('image/jpeg', 0.85);
}

// Deja una región VISIBLE por encima del sheet del agente (que en móvil ocupa la mitad
// inferior): centra el rect en la franja libre. Sin esto, adjuntar una zona y que el panel
// la tape deja al usuario preguntando por algo que no ve.
export function revealRegion(page, rect, reservedBottomPx = 0) {
  const wrapper = document.querySelector(`#pdf-container .pdf-page[data-page="${page}"]`);
  const container = document.getElementById('pdf-container');
  if (!wrapper || !container || !rect) return;
  const cr = container.getBoundingClientRect();
  const wr = wrapper.getBoundingClientRect();
  const visibleH = Math.max(80, cr.height - reservedBottomPx);
  const centerInPage = (rect.y + rect.h / 2) * wr.height;
  const target = (wr.top - cr.top) + container.scrollTop + centerInPage - visibleH / 2;
  container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
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

// Índice cacheado en plano (label + página), para resolver el capítulo de la burbuja
// de arrastre sin volver a pedirle el outline a pdf.js en cada movimiento del dedo.
let flatOutline = null;

export async function primeOutlineCache() {
  try {
    const items = await getOutlineItems();
    const flat = [];
    for (const it of items) {
      if (it.page != null) flat.push({ label: it.label, page: it.page });
      for (const sub of it.subitems || []) {
        if (sub.page != null) flat.push({ label: sub.label, page: sub.page });
      }
    }
    flatOutline = flat.sort((a, b) => a.page - b.page);
  } catch {
    flatOutline = [];
  }
}

// Qué hay en la fracción [0..1] de la barra, SIN navegar (ver getSeekPreview del
// EPUB). En PDF la página es exacta; el capítulo sale del outline si lo hay.
export function getSeekPreview(f) {
  if (!totalPages) return null;
  const page = Math.min(totalPages, Math.max(1, Math.round(f * totalPages)));
  let chapter = '';
  if (flatOutline?.length) {
    for (const it of flatOutline) {
      if (it.page <= page) chapter = it.label;
      else break;
    }
  }
  return { page, total: totalPages, chapter };
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
