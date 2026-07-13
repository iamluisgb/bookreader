import * as Settings from './settings.js';
import * as Bookmarks from './bookmarks.js';
import * as Highlights from './highlights.js';
import * as EpubReader from './epub-reader.js';
import * as PdfReader from './pdf-reader.js';
import * as Storage from './storage.js';
import * as AiPanel from './ai/panel.js';
import * as AiDB from './ai/db.js';
import { hydrateIcons } from './ui/icons.js';
import { countBookWords, updateProgressDetail } from './progress.js';
import { initHighlights, setupHighlights, setupPdfSelection, drawPdfHighlights, renderHighlights, applyStoredHighlights, hideHighlightTooltip, pdfFractionalRects, setBookMeta } from './highlights-ui.js';
import { initBookmarkButton, updateBookmarkButton, renderBookmarks } from './bookmarks-ui.js';
import * as Library from './library/view.js';
import * as LibStore from './library/store.js';
import * as AppSettings from './ui/app-settings.js';
import * as Search from './search.js';
import { escapeHtml } from './ui/escape.js';
import { openImageZoom } from './image-zoom.js';
import { alertBox } from './ui/dialog.js';
import { rangeForText } from './pdf-locate.js';
import { migrateSchema, purgeExpiredTombstones } from './sync/schema.js';
import * as SyncEngine from './sync/engine.js';

// ============ INIT ============
document.addEventListener('DOMContentLoaded', () => {
  // Fase 0 sync: backfill de uid/updatedAt en datos previos + purga de
  // tombstones caducados. Asíncrono y no bloqueante; idempotente.
  migrateSchema()
    .then(() => purgeExpiredTombstones())
    .catch(e => console.warn('sync schema migration:', e));
  initSyncEngine();
  hydrateIcons();
  Settings.init();
  EpubReader.init();
  initSidebar();
  initSearch();
  initFileHandling();
  initNavigation();
  initBookmarkButton();
  initHighlights();
  initDragDrop();
  initAiPanel();
  initImmersive();
  initReaderReflow();
  initPanelResize();
  initLibrary();
  initRouter();
  registerServiceWorker();
});

// Sync Fase 2: motor automático (pull→merge→push) + badge de estado + re-render
// en sitio cuando llega un merge remoto (sin location.reload — el error de arete).
function initSyncEngine() {
  const badge = document.createElement('div');
  badge.id = 'sync-badge';
  badge.hidden = true;
  document.body.appendChild(badge);

  window.addEventListener('bookreader:sync-status', (e) => {
    const s = e.detail;
    const labels = { syncing: 'Sincronizando…', error: 'Sync: error', reconnect: 'Reconectar Drive' };
    badge.dataset.state = s;
    badge.textContent = labels[s] || '';
    badge.hidden = !(s in labels);
  });
  // Token revocado: el badge lleva directo a Ajustes → Datos para reconectar.
  badge.addEventListener('click', () => {
    if (badge.dataset.state === 'reconnect') AppSettings.open('data');
  });

  // Un merge remoto cambió datos: refrescar las listas de la sidebar en sitio.
  window.addEventListener('bookreader:remote-applied', () => {
    try {
      renderHighlights();
      renderBookmarks();
    } catch (e) { console.warn('sync re-render:', e); }
  });

  SyncEngine.start();
}

// PWA offline: registra el Service Worker (precache + stale-while-revalidate, ver sw.js).
// Sin este registro el navegador nunca instala sw.js y la app no funciona offline. Se hace
// tras el arranque (no bloquea el primer render) y falla en silencio donde no esté disponible
// (p. ej. contexto no seguro): la app sigue funcionando online igual.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => {
      console.warn('No se pudo registrar el Service Worker (offline no disponible):', e);
    });
  });
}

// ============ ROUTER · deep-links tipo Play Books ============
// La URL refleja qué libro y en qué posición: `#book=<id>&loc=<cfi|página>`. Recargar o
// relanzar la PWA reabre el libro donde ibas; el enlace sirve de marcador. Los libros
// viven en IndexedDB (local), así que el deep-link funciona en ESTE navegador: si el id
// no está en la biblioteca, se avisa y se abre la biblioteca. Historial: abrir un libro
// entra como una parada (atrás → biblioteca); la posición se actualiza con replaceState.
let routeTimer = null;
let applyingRoute = false;

function currentLoc() {
  if (!currentBook) return '';
  if (currentBook.format === 'pdf') return String(PdfReader.getCurrentPage() || 1);
  return EpubReader.getCurrentCfi() || '';
}

function parseRoute() {
  const p = new URLSearchParams(location.hash.replace(/^#/, ''));
  return { id: p.get('book'), loc: p.get('loc') };
}

// Escribe la ruta en la barra de direcciones. pushState/replaceState NO disparan
// hashchange/popstate, así que no hay bucle con applyRoute.
function writeRoute(id, loc, { replace = false } = {}) {
  let hash = '';
  if (id) {
    const p = new URLSearchParams();
    p.set('book', id);
    if (loc) p.set('loc', loc);
    hash = '#' + p.toString();
  }
  const url = location.pathname + location.search + hash;
  if (url === location.pathname + location.search + location.hash) return;  // sin cambios
  history[replace ? 'replaceState' : 'pushState']({}, '', url);
}

// Actualiza la posición en la URL con rebote (replaceState, no ensucia el historial).
// El timer re-comprueba currentBook: si el usuario salió a la biblioteca durante el
// rebote, ya no hay libro que reflejar (misma carrera que flushProgress).
function syncRouteSoon() {
  if (!currentBook) return;
  clearTimeout(routeTimer);
  routeTimer = setTimeout(() => {
    if (currentBook) writeRoute(currentBook.id, currentLoc(), { replace: true });
  }, 600);
}

async function seekTo(loc) {
  if (!loc) return;   // `loc` ya viene decodificado por URLSearchParams (no re-decodificar)
  try {
    if (currentBook?.format === 'pdf') await PdfReader.goTo(parseInt(loc, 10));
    else await EpubReader.goTo(loc);
  } catch (e) { /* locator no válido */ }
}

// Reconcilia el estado de la app con la URL (arranque, back/forward, edición manual).
async function applyRoute() {
  if (applyingRoute) return;
  const { id, loc } = parseRoute();

  if (!id) {
    if (currentBook || document.body.classList.contains('reading')) {
      await goToLibrary({ fromRoute: true });          // volver a biblioteca (sin re-empujar)
    } else {
      const has = await Library.hasBooks();            // arranque sin libro: comportamiento normal
      if (has) { await Library.render(); Library.show(); }
    }
    return;
  }

  if (currentBook && currentBook.id === id) { await seekTo(loc); return; }  // mismo libro, otra posición

  applyingRoute = true;
  try {
    const record = await LibStore.getBook(id);
    if (!record) {
      await alertBox('Este libro no está en tu biblioteca en este dispositivo.');
      await goToLibrary({ fromRoute: true });
      return;
    }
    await openBookRecord(record, { fromRoute: true, loc });
  } finally {
    applyingRoute = false;
  }
}

function initRouter() {
  window.addEventListener('popstate', applyRoute);
  window.addEventListener('hashchange', applyRoute);
  applyRoute();   // resolver la URL inicial (abre el libro del enlace o muestra biblioteca)
}

// ============ REDIMENSIONADO DE PANELES (solo escritorio) ============
// Ambos paneles empujan el lector con un margen = su anchura (variable CSS). Arrastrar
// el tirador del borde interior actualiza esa variable (y el texto reflowea). Anchura
// persistida como preferencia global de UI. En móvil (drawer/overlay) no aplica.
const PANEL_LIMITS = {
  ai:      { cssVar: '--ai-panel-width', key: 'ui_ai_panel_width', min: 320, maxVw: 0.6, maxPx: 760 },
  sidebar: { cssVar: '--sidebar-width',  key: 'ui_sidebar_width',  min: 240, maxVw: 0.5, maxPx: 560 },
};

function clampPanel(cfg, w) {
  const max = Math.min(cfg.maxPx, Math.round(window.innerWidth * cfg.maxVw));
  return Math.max(cfg.min, Math.min(max, Math.round(w)));
}

function initPanelResize() {
  // Restaurar anchuras guardadas.
  for (const cfg of Object.values(PANEL_LIMITS)) {
    const saved = Storage.get(cfg.key, null);
    if (saved) document.documentElement.style.setProperty(cfg.cssVar, clampPanel(cfg, saved) + 'px');
  }
  addResizer(document.getElementById('ai-panel'), 'ai-resizer', PANEL_LIMITS.ai,
    (e) => window.innerWidth - e.clientX);       // panel derecho: ancho = distancia al borde derecho
  addResizer(document.getElementById('sidebar'), 'sidebar-resizer', PANEL_LIMITS.sidebar,
    (e) => e.clientX);                            // panel izquierdo: ancho = posición del cursor
}

function addResizer(panel, cls, cfg, widthFromEvent) {
  if (!panel) return;
  const handle = document.createElement('div');
  handle.className = 'panel-resizer ' + cls;
  handle.title = 'Arrastra para ajustar el ancho · doble clic: restablecer';
  panel.appendChild(handle);

  let raf = 0;
  const apply = (e) => {
    const w = clampPanel(cfg, widthFromEvent(e));
    document.documentElement.style.setProperty(cfg.cssVar, w + 'px');
    return w;
  };
  const onMove = (e) => {
    apply(e);
    // Reflow del EPUB acompasado a rAF (no en cada pointermove) para que el texto siga
    // al tirador sin saturar. La captura de puntero garantiza eventos aun sobre el iframe.
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (EpubReader.isLoaded()) EpubReader.resize(); });
  };
  const end = (e) => {
    try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
    document.body.classList.remove('resizing-panel');
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    Storage.set(cfg.key, apply(e));
    if (EpubReader.isLoaded()) EpubReader.resize();
  };
  handle.addEventListener('pointerdown', (e) => {
    if (!window.matchMedia('(min-width: 1024px)').matches) return;   // solo escritorio
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch (_) {}
    document.body.classList.add('resizing-panel');
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
  // Doble clic en el tirador: restablecer el ancho por defecto.
  handle.addEventListener('dblclick', () => {
    document.documentElement.style.removeProperty(cfg.cssVar);
    Storage.remove(cfg.key);
    if (EpubReader.isLoaded()) EpubReader.resize();
  });
}

// ============ BIBLIOTECA ============
let currentBook = null;        // { id, fileBaseId, format } del libro abierto
let progressTimer = null;

function initLibrary() {
  Library.init({
    onOpenBook: openLibraryBook,
    onAddBook: () => document.getElementById('file-input').click(),
    onOpenSettings: () => AppSettings.open(),
  });
  document.getElementById('open-app-settings')?.addEventListener('click', () => AppSettings.open('agent'));
  document.getElementById('library-btn')?.addEventListener('click', () => goToLibrary());
  initReadingMode();
  // En móvil, cerrar o cambiar de app congela la PWA sin avisar: volcar el progreso
  // pendiente al ocultarse la pestaña, o el rebote de saveProgress no llega a escribir.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushProgress();
  });
  // La pantalla inicial (biblioteca/landing o el libro del enlace) la resuelve initRouter().
}

// Toggle Páginas/Scroll (Ajustes de lectura). El modo se recuerda por libro en
// EpubReader; aquí solo cableamos los botones y reflejamos el activo.
function initReadingMode() {
  const btns = [...document.querySelectorAll('.reading-mode-btn')];
  if (!btns.length) return;
  btns.forEach(btn => btn.addEventListener('click', async () => {
    if (PdfReader.isLoaded()) { await PdfReader.setReadingMode(btn.dataset.mode); updateReadingModeToggle(); return; }
    if (!EpubReader.isLoaded()) return;
    EpubReader.setReadingMode(btn.dataset.mode);
    updateReadingModeToggle();
  }));
  // Al cambiar el flujo (o al recrearse el rendition) los subrayados pueden quedar sin
  // dibujar: los repintamos. Idempotente.
  window.addEventListener('reader:flow-changed', () => { renderHighlights(); });
  // PDF: cada vez que una página se (re)pinta, redibujar sus subrayados encima.
  window.addEventListener('reader:pdf-page-rendered', (e) => { drawPdfHighlights(e.detail?.page); });
}

function updateReadingModeToggle() {
  const mode = PdfReader.isLoaded() ? PdfReader.getReadingMode()
    : EpubReader.isLoaded() ? EpubReader.getReadingMode() : 'paginated';
  document.querySelectorAll('.reading-mode-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.mode === mode));
}

async function goToLibrary({ fromRoute = false } = {}) {
  if (!fromRoute) writeRoute(null, null);   // entra en el historial: atrás vuelve aquí
  await flushProgress();                    // progreso pendiente antes de soltar el libro
  currentBook = null;                       // ya no hay libro abierto (para el router)
  document.body.classList.remove('reading', 'immersive', 'fs', 'scroll-mode');   // salir del modo lectura
  // Cerrar las sidebars de la vista de libro (índice + agente): no deben verse sobre
  // la biblioteca (van en z-index alto, por encima de la vista de estantería).
  document.getElementById('sidebar')?.classList.remove('open');
  AiPanel.setOpen(false);
  EpubReader.updateReaderScale();   // quita la escala del viewport (vuelve a 1)
  // Salir de pantalla completa nativa si estábamos en ella (inmersivo móvil).
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    }
  } catch (e) { /* Fullscreen API no soportada */ }
  document.getElementById('library-btn').style.display = 'none';
  document.getElementById('reader-title').textContent = 'BookReader';
  await Library.render();
  Library.show();
}

// Abrir un libro ya guardado en la biblioteca (reconstruye el archivo).
// Apertura iniciada por el usuario desde la biblioteca → entra en el historial (pushState).
function openLibraryBook(record) {
  return openBookRecord(record, { fromRoute: false });
}

// Abre un libro de la biblioteca. `fromRoute`: la apertura viene de resolver la URL, así
// que NO se re-escribe la ruta. `loc`: posición de la URL (tiene prioridad sobre lastCfi).
async function openBookRecord(record, { fromRoute = false, loc = null } = {}) {
  try {
    Library.hide();
    const buffer = record.file instanceof ArrayBuffer ? record.file.slice(0) : await record.file.arrayBuffer();
    Bookmarks.setBook(record.fileBaseId || record.id);
    Highlights.setBook(record.fileBaseId || record.id);
    setBookMeta({ title: record.title, author: record.author, cover: record.cover });
    currentBook = { id: record.id, fileBaseId: record.fileBaseId || record.id, format: record.format };
    if (record.format === 'pdf') {
      const ok = await loadPdf(buffer, record.fileBaseId || record.id, record.id);
      if (!ok) { currentBook = null; await goToLibrary({ fromRoute: true }); return; }
      // Backfill de portada para PDFs guardados antes de tenerla (imagen genérica → página 1).
      if (!record.cover) {
        const cover = await PdfReader.renderCoverDataUrl();
        if (cover) { await LibStore.updateBook(record.id, { cover }); Library.render(); }
      }
      if (loc) await seekTo(loc);
    } else {
      const ok = await loadEpub(buffer, record.fileBaseId || record.id, record.id);
      if (!ok) { currentBook = null; await goToLibrary({ fromRoute: true }); return; }
      // La posición de la URL manda; si no, la lastPosition_ que el lector ya restauró
      // (se guarda en síncrono en cada relocated → siempre fresca). El lastCfi de la
      // biblioteca va con rebote y puede estar rancio: solo como fallback.
      if (loc) await seekTo(loc);
      else if (!EpubReader.restoredSavedPosition() && record.lastCfi) {
        try { await EpubReader.goTo(record.lastCfi); } catch (e) { /* posición no válida */ }
      }
    }
    await LibStore.updateBook(record.id, { lastOpenedAt: Date.now() });
    document.getElementById('library-btn').style.display = '';
    if (!fromRoute) writeRoute(record.id, currentLoc());   // pushState: atrás → biblioteca
  } catch (e) {
    console.error('No se pudo abrir el libro de la biblioteca:', e);
    await alertBox('No se pudo abrir el libro guardado.');
    currentBook = null;
  }
}

// Guardar/actualizar un libro recién abierto desde un archivo (con portada).
async function persistToLibrary(id, buffer, format, fileName, fileBaseId) {
  try {
    const existing = await LibStore.getBook(id);
    const title = format === 'pdf' ? (fileName.replace(/\.[^.]+$/, '')) : EpubReader.getTitle();
    const author = format === 'pdf' ? '' : EpubReader.getAuthor();
    // Portada: EPUB de sus metadatos; PDF renderizando su página 1 (ya está cargado).
    const cover = (format === 'pdf') ? await PdfReader.renderCoverDataUrl() : await EpubReader.getCoverDataUrl();
    setBookMeta({ title, author, cover });   // para la tarjeta-cita al compartir (P11)
    const base = existing || { id, addedAt: Date.now(), progress: 0, lastCfi: null, status: 'unread', shelfIds: [] };
    await LibStore.putBook({
      ...base, id, title, author, cover: cover || base.cover || '',
      format, fileName, fileBaseId, file: buffer.slice(0), size: buffer.byteLength,
      lastOpenedAt: Date.now(),
    });
  } catch (e) {
    console.warn('No se pudo guardar en la biblioteca (¿espacio?):', e);
  }
}

// Persistir progreso del libro abierto (con rebote). Lo pendiente captura el id del
// libro para que el flush funcione aunque currentBook ya sea null (salida a biblioteca).
let pendingProgress = null;   // { bookId, pct } aún no escrito

function saveProgress(pct) {
  if (!currentBook) return;
  pendingProgress = { bookId: currentBook.id, pct };
  clearTimeout(progressTimer);
  progressTimer = setTimeout(flushProgress, 800);
}

// Escribe YA el progreso pendiente. Además del timer, se llama al salir a la biblioteca
// y al ocultarse la pestaña (en móvil la PWA muere sin avisar y el rebote de 800 ms se
// perdía → lastCfi rancio). El CFI se lee aquí, con el lector aún vivo.
async function flushProgress() {
  clearTimeout(progressTimer);
  const pending = pendingProgress;
  pendingProgress = null;
  if (!pending) return;
  try {
    const cfi = EpubReader.getCurrentCfi();
    const prev = await LibStore.getBook(pending.bookId);
    const status = LibStore.statusFor(pending.pct, prev?.status);
    await LibStore.updateBook(pending.bookId, { progress: pending.pct, lastCfi: cfi || prev?.lastCfi || null, status });
  } catch (e) { /* sin persistencia */ }
}

// ============ RE-PAGINADO AL PLEGAR/DESPLEGAR PANELES ============
// Al abrir/cerrar la barra lateral o el panel del agente, el área de lectura
// cambia de ancho (en escritorio empujan el contenido). Re-paginamos el EPUB al
// terminar la transición de márgenes para que el texto se adapte. Observamos el
// estado real de ambos paneles, así cubrimos cualquier vía de apertura/cierre.
function reflowReaderAfterTransition() {
  const main = document.getElementById('reader-main');
  if (!main) return;
  let fired = false;
  const done = (e) => {
    if (e && (e.target !== main || !/^margin/.test(e.propertyName))) return;
    if (fired) return;
    fired = true;
    main.removeEventListener('transitionend', done);
    clearTimeout(t);
    if (EpubReader.isLoaded()) EpubReader.resize();
  };
  const t = setTimeout(done, 350);   // respaldo si no llega transitionend
  main.addEventListener('transitionend', done);
}

function initReaderReflow() {
  let last = '';
  const check = () => {
    const s = (document.getElementById('sidebar')?.classList.contains('open') ? 'S' : '') +
              (document.body.classList.contains('ai-open') ? 'A' : '');
    if (s === last) return;
    last = s;
    reflowReaderAfterTransition();
  };
  const sidebar = document.getElementById('sidebar');
  if (sidebar) new MutationObserver(check).observe(sidebar, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(check).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

// ============ MODO LECTURA INMERSIVO ============
// Estilo Play Books: las barras son un overlay sobre un área de lectura de altura
// fija (ver CSS de `body.reading`), así mostrarlas/ocultarlas NO re-pagina el EPUB
// ni mueve el texto. Por eso aquí solo alternamos la clase, sin resize.
// Solo alterna las barras (overlay). La pantalla completa NATIVA del sistema se
// gestiona en initImmersive con el botón ⤢, porque un toque dentro del iframe de
// lectura (origen opaco por el sandbox que protege la key) NO puede iniciar fullscreen.
function setImmersive(on) {
  document.body.classList.toggle('immersive', on);
  EpubReader.updateReaderScale();   // móvil: al mostrar barras, encoge el texto para que quepa
}

function initImmersive() {
  const btn = document.getElementById('immersive-toggle');
  // Fullscreen nativo (con fallback webkit para Safari antiguo).
  const el = document.documentElement;
  const reqFS = el.requestFullscreen || el.webkitRequestFullscreen;
  const exitFS = document.exitFullscreen || document.webkitExitFullscreen;
  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;

  if (!EpubReader.isCoarsePointer() && reqFS && exitFS) {
    // Escritorio. En ventana normal las barras van en el flujo (CSS) y el texto se ve
    // entero. El botón ⤢ va a PANTALLA COMPLETA REAL del navegador (llena el monitor,
    // oculta su chrome y el del SO); como es nativa, se sale con Esc/F11. En ese modo
    // las barras pasan a overlay (clase `fs`) y se AUTO-OCULTAN estilo Play Books:
    // arrancan escondidas para leer la página entera y reaparecen al mover el ratón,
    // volviéndose a esconder tras unos segundos de inactividad.
    btn?.addEventListener('click', () => {
      if (fsElement()) exitFS.call(document);
      else reqFS.call(el).catch(() => {});
    });

    const inFs = () => document.body.classList.contains('fs');
    const showBars = () => document.body.classList.remove('immersive');
    const hideBars = () => document.body.classList.add('immersive');
    const barPx = (name) => parseInt(getComputedStyle(document.documentElement).getPropertyValue(name), 10) || 52;
    // Las barras reaparecen SOLO al llevar el ratón a la franja superior/inferior (no
    // con cualquier movimiento): así seleccionar/subrayar la 1ª o última línea no
    // invoca la barra. El texto reserva esa franja en fullscreen (CSS), de modo que la
    // barra revelada nunca tapa texto.
    const onEdge = (e) => {
      if (!inFs()) return;
      const nearTop = e.clientY <= barPx('--header-height');
      const nearBot = e.clientY >= window.innerHeight - barPx('--footer-height');
      if (nearTop || nearBot) showBars(); else hideBars();
    };
    document.addEventListener('mousemove', onEdge);
    // El ratón sobre el texto vive en el iframe (sus eventos no llegan al document):
    // cualquier actividad ahí = estás leyendo → ocultar las barras.
    EpubReader.onActivity(() => { if (inFs()) hideBars(); });

    // Sincroniza clase/estado/icono con el estado real de fullscreen (clic, Esc, F11).
    const syncFs = () => {
      const on = !!fsElement();
      document.body.classList.toggle('fs', on);
      if (on) hideBars();                              // arranca oculto → página limpia
      else document.body.classList.remove('immersive');
      if (btn) {
        btn.setAttribute('data-icon', on ? 'compress' : 'expand');
        btn.title = on ? 'Salir de pantalla completa' : 'Pantalla completa';
        btn.setAttribute('aria-label', btn.title);
        hydrateIcons(btn.parentElement || document);
      }
    };
    document.addEventListener('fullscreenchange', syncFs);
    document.addEventListener('webkitfullscreenchange', syncFs);
  } else if (reqFS && exitFS) {
    // MÓVIL con Fullscreen API. El botón ⤢ alterna PANTALLA COMPLETA NATIVA del
    // navegador (oculta la barra de estado y la de gestos del sistema y dibuja de
    // borde a borde). Debe dispararse desde ESTE gesto del document padre: un toque
    // dentro del iframe de lectura no puede iniciar fullscreen (sandbox de origen
    // opaco que protege la key). Tocar el centro del texto alterna solo las barras.
    btn?.addEventListener('click', () => {
      if (fsElement()) exitFS.call(document);
      else reqFS.call(el).catch(() => {});
    });
    // En pantalla completa ocultamos las barras (lectura limpia); al salir —incluido
    // el gesto del sistema— vuelven. Sincroniza también el icono ⤢/⤡.
    const onFsChange = () => {
      const on = !!fsElement();
      document.body.classList.toggle('immersive', on);
      EpubReader.updateReaderScale();
      if (btn) {
        btn.setAttribute('data-icon', on ? 'compress' : 'expand');
        hydrateIcons(btn.parentElement || document);
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
  } else {
    // Sin Fullscreen API (p. ej. iOS Safari): overlay de barras como hasta ahora.
    btn?.addEventListener('click', () => setImmersive(true));
  }

  // Toques sobre el contenido del libro (sin capa que bloquee la selección):
  // bordes = pasar página, centro = alternar pantalla completa. Si la barra de
  // selección está abierta, el toque solo la cierra.
  EpubReader.onTap((zone) => {
    const tip = document.getElementById('highlight-tooltip');
    if (tip && tip.style.display !== 'none') { hideHighlightTooltip(); return; }
    if (zone === 'prev') EpubReader.prev();
    else if (zone === 'next') EpubReader.next();
    else if (zone === 'center') setImmersive(!document.body.classList.contains('immersive'));
    // 'click' (escritorio, sin barra abierta) → no hace nada
  });

  // Tocar/clicar una imagen del libro → abrir zoom (lightbox).
  EpubReader.onImageTap((img) => openImageZoom(img));

  initPdfTap();
}

// PDF: tocar el centro alterna las barras (estilo Play Books), como el center-tap del EPUB.
// El pdf-container tiene scroll y selección nativos, así que solo cuenta como "tap" un toque
// de 1 dedo, breve y sin desplazamiento, que no haya seleccionado texto. Un scroll (hay
// movimiento), un pinch (2 dedos) o una selección (no colapsada) NO alternan las barras.
function initPdfTap() {
  const container = document.getElementById('pdf-container');
  if (!container || container.dataset.tapWired) return;
  container.dataset.tapWired = '1';

  let sx = 0, sy = 0, st = 0, valid = false;
  container.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { valid = false; return; }
    valid = true; st = Date.now();
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
  }, { passive: true });
  container.addEventListener('touchmove', (e) => {
    if (!valid) return;
    if (e.touches.length !== 1) { valid = false; return; }
    if (Math.hypot(e.touches[0].clientX - sx, e.touches[0].clientY - sy) > 10) valid = false;
  }, { passive: true });
  container.addEventListener('touchend', () => {
    if (!valid) return;
    valid = false;
    if (Date.now() - st > 300) return;                 // pulsación larga (selección) → no
    const tip = document.getElementById('highlight-tooltip');
    if (tip && tip.style.display !== 'none') { hideHighlightTooltip(); return; }
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;               // se acaba de seleccionar texto → no
    setImmersive(!document.body.classList.contains('immersive'));
  }, { passive: true });
}

// ============ AI PANEL ============
function initAiPanel() {
  AiPanel.init({
    onCite: goToLocator,
  });

  document.getElementById('ai-toggle').addEventListener('click', () => {
    AiPanel.setOpen(!AiPanel.isOpen());
  });

  // FAB (móvil): abre el agente.
  document.getElementById('ai-fab')?.addEventListener('click', () => AiPanel.setOpen(true));

  // Backdrop: cierra cualquier drawer abierto (sidebar o agente).
  document.getElementById('scrim')?.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.remove('open');
    AiPanel.setOpen(false);
  });
}

// Navega a un locator del libro (CFI en EPUB, nº de página en PDF). Compartido por las citas
// del agente (onCite) y la búsqueda (P5).
let lastCiteCfi = null;   // resaltado de cita EPUB en curso (para retirarlo)
async function goToLocator(loc, passageText) {
  if (currentBook?.format === 'pdf') {
    const page = parseInt(loc, 10);
    if (page) {
      await PdfReader.goTo(page);
      // Resaltar el TROZO exacto en la página buscándolo en la capa de texto; si no
      // se localiza (o no tenemos el texto), destellar la página entera como fallback.
      const marked = passageText ? await highlightPdfPassage(page, passageText) : false;
      if (!marked) flashPdfPage(page);
    }
    return;
  }
  await EpubReader.goTo(loc);   // CFI puntual o href de capítulo (fallback sin CFI)
  // Señalar el pasaje citado con un resaltado TRANSITORIO que se retira solo (antes
  // se acumulaban indefinidamente). Solo se marca si es un CFI puntual; un href de
  // capítulo no delimita un rango.
  try {
    const rendition = EpubReader.getRendition();
    if (!rendition) return;
    if (lastCiteCfi) { try { rendition.annotations.remove(lastCiteCfi, 'highlight'); } catch (e) {} }
    lastCiteCfi = null;
    if (typeof loc === 'string' && loc.startsWith('epubcfi(')) {
      const cfi = loc;
      rendition.annotations.highlight(cfi, {}, () => {}, 'ai-cite-hl', {
        'fill': 'var(--accent)', 'fill-opacity': '0.3', 'mix-blend-mode': 'multiply'
      });
      lastCiteCfi = cfi;
      setTimeout(() => {
        try { rendition.annotations.remove(cfi, 'highlight'); } catch (e) {}
        if (lastCiteCfi === cfi) lastCiteCfi = null;
      }, 2800);
    }
  } catch (e) { /* cita sin highlight */ }
}

// Resalta el TROZO exacto de un pasaje citado en una página PDF: busca su texto en la
// capa de texto de pdf.js, construye un rango DOM y pinta un overlay transitorio con los
// rects fraccionales (misma técnica que los subrayados). Devuelve false si no lo localiza.
async function highlightPdfPassage(page, passageText) {
  const wrapper = await waitForPdfTextLayer(page);
  const layer = wrapper?.querySelector('.textLayer');
  if (!layer) return false;
  const range = rangeForText(layer, passageText);
  if (!range) return false;
  const rects = pdfFractionalRects(range, wrapper);
  if (!rects.length) return false;
  drawTransientPdfHighlight(wrapper, rects);
  return true;
}

// Espera a que la capa de texto de la página esté renderizada (pdf.js la pinta de forma
// perezosa tras navegar). Sondea hasta ~1.5s; null si no llega.
function waitForPdfTextLayer(page, timeout = 1500) {
  const sel = `#pdf-container .pdf-page[data-page="${page}"]`;
  return new Promise(resolve => {
    const t0 = Date.now();
    const tick = () => {
      const wrapper = document.querySelector(sel);
      const layer = wrapper?.querySelector('.textLayer');
      if (layer && layer.childElementCount > 0) return resolve(wrapper);
      if (Date.now() - t0 > timeout) return resolve(wrapper || null);
      requestAnimationFrame(tick);
    };
    tick();
  });
}

// Overlay transitorio del pasaje citado (se retira solo a los 2.8s).
let citeHlTimer = null;
function drawTransientPdfHighlight(wrapper, rects) {
  let layer = wrapper.querySelector('.pdf-cite-layer');
  if (!layer) { layer = document.createElement('div'); layer.className = 'pdf-cite-layer'; wrapper.appendChild(layer); }
  layer.innerHTML = '';
  for (const r of rects) {
    const d = document.createElement('div');
    d.className = 'pdf-cite-hl';
    d.style.left = (r.left * 100) + '%';
    d.style.top = (r.top * 100) + '%';
    d.style.width = (r.width * 100) + '%';
    d.style.height = (r.height * 100) + '%';
    layer.appendChild(d);
  }
  clearTimeout(citeHlTimer);
  citeHlTimer = setTimeout(() => { if (layer) layer.innerHTML = ''; }, 2800);
}

// Destella la página de destino de una cita en PDF cuando NO se pudo localizar el pasaje
// (fallback): señala la página completa un instante.
function flashPdfPage(page) {
  const el = document.querySelector(`#pdf-container .pdf-page[data-page="${page}"]`);
  if (!el) return;
  el.classList.remove('pdf-cite-flash');
  void el.offsetWidth;                 // reinicia la animación si se repite la misma página
  el.classList.add('pdf-cite-flash');
  setTimeout(() => el.classList.remove('pdf-cite-flash'), 1600);
}

// ============ BÚSQUEDA (P5) ============
// Busca sobre el corpus segmentado del libro (el mismo que usa el agente): pasajes `[[aN]]`
// + anclas. Un solo camino para EPUB (ancla→CFI) y PDF (ancla→página).
let searchCorpus = null;   // { annotatedText, anchors } del libro abierto; se carga al buscar

async function ensureSearchCorpus() {
  if (searchCorpus) return searchCorpus;
  if (!currentBook) return null;
  const seg = await AiDB.loadSegmented(currentBook.id);   // lo produce la segmentación del agente
  if (seg) searchCorpus = { annotatedText: seg.annotatedText, anchors: seg.anchors };
  return searchCorpus;
}

function initSearch() {
  const input = document.getElementById('search-input');
  if (!input) return;
  let t;
  const run = async () => {
    const q = input.value.trim();
    const box = document.getElementById('search-results');
    if (q.length < 2) { box.innerHTML = ''; return; }
    const corpus = await ensureSearchCorpus();
    if (!corpus) { box.innerHTML = '<p class="empty-state">Preparando el libro para búsqueda…</p>'; return; }
    renderSearchResults(Search.searchPassages(corpus.annotatedText, corpus.anchors, q, { limit: 120 }), q);
  };
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 200); });
  // Al abrir la pestaña Buscar, enfocar el campo.
  document.querySelector('.tab-btn[data-tab="search"]')?.addEventListener('click', () => setTimeout(() => input.focus(), 50));
  // Buscador en la cabecera (estilo Play Books): abre la sidebar en la pestaña
  // Buscar y enfoca el campo, reutilizando el handler de la pestaña.
  document.getElementById('header-search')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.add('open');
    document.querySelector('.tab-btn[data-tab="search"]')?.click();
  });
}

function renderSearchResults(results, query) {
  const box = document.getElementById('search-results');
  if (!results.length) { box.innerHTML = `<p class="empty-state">Sin resultados para «${escapeHtml(query)}»</p>`; return; }
  box.innerHTML = `<p class="search-count">${results.length} resultado${results.length === 1 ? '' : 's'}</p>`;
  for (const r of results) {
    const item = document.createElement('button');
    item.className = 'search-hit';
    const meta = [r.chapter, r.page != null ? `pág. ${r.page}` : ''].filter(Boolean).join(' · ');
    item.innerHTML =
      `<span class="search-hit-ctx">${escapeHtml(r.before)}<mark>${escapeHtml(r.match)}</mark>${escapeHtml(r.after)}</span>` +
      (meta ? `<span class="search-hit-meta">${escapeHtml(meta)}</span>` : '');
    item.addEventListener('click', async () => {
      if (r.loc != null) await goToLocator(r.loc);
      document.getElementById('sidebar').classList.remove('open');
    });
    box.appendChild(item);
  }
}

// Reinicia el corpus y limpia la caja al abrir otro libro.
function resetSearch() {
  searchCorpus = null;
  const input = document.getElementById('search-input');
  const box = document.getElementById('search-results');
  if (input) input.value = '';
  if (box) box.innerHTML = '';
}

// ============ SIDEBAR ============
function initSidebar() {
  const sidebar = document.getElementById('sidebar');
  const toggle = document.getElementById('sidebar-toggle');
  const close = document.getElementById('sidebar-close');

  toggle.addEventListener('click', () => sidebar.classList.toggle('open'));
  close.addEventListener('click', () => sidebar.classList.remove('open'));

  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });
}

// ============ FILE HANDLING ============
function initFileHandling() {
  const fileInput = document.getElementById('file-input');
  const openBtn = document.getElementById('open-file-btn');

  openBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    fileInput.value = '';
    await loadFile(file);
  });
}

function initDragDrop() {
  const viewport = document.getElementById('reader-viewport');

  viewport.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    viewport.style.outline = '2px dashed var(--accent)';
  });

  viewport.addEventListener('dragleave', (e) => {
    e.preventDefault();
    viewport.style.outline = 'none';
  });

  viewport.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    viewport.style.outline = 'none';

    const file = e.dataTransfer.files[0];
    if (file) await loadFile(file);
  });
}

async function loadFile(file) {
  const buffer = await file.arrayBuffer();
  const ext = file.name.split('.').pop().toLowerCase();

  if (ext !== 'epub' && ext !== 'pdf') {
    await alertBox('Formato no soportado. Usa archivos .epub o .pdf');
    return;
  }

  // Set book ID for storage (marcadores/subrayados siguen usando el nombre).
  const fileBaseId = file.name.replace(/\.[^.]+$/, '');
  Bookmarks.setBook(fileBaseId);
  Highlights.setBook(fileBaseId);

  // Hash estable del contenido: id canónico para biblioteca + agente.
  const id = await AiDB.hashBuffer(buffer.slice(0));
  currentBook = { id, fileBaseId, format: ext };
  Library.hide();

  const ok = ext === 'epub'
    ? await loadEpub(buffer, fileBaseId, id)
    : await loadPdf(buffer, fileBaseId, id);
  // Si la carga falló (loadEpub/loadPdf ya avisaron), no dejamos currentBook apuntando a un
  // libro no renderizado ni lo persistimos en la biblioteca.
  if (!ok) { currentBook = null; return; }

  // Guardar en la biblioteca (con portada/metadatos ya disponibles) y mostrar
  // el acceso a la biblioteca en la cabecera.
  await persistToLibrary(id, buffer, ext, file.name, fileBaseId);
  document.getElementById('library-btn').style.display = '';
  Library.render();
  writeRoute(id, currentLoc());   // deep-link del libro recién abierto (pushState)
}

let totalWords = 0;

async function loadEpub(buffer, bookId, aiBookId) {
  try {
    resetSearch();
    console.log('Loading EPUB, buffer size:', buffer.byteLength);

    // Hash estable del fichero (id canónico). Se reutiliza si ya viene calculado.
    if (!aiBookId) aiBookId = await AiDB.hashBuffer(buffer.slice(0));

    // Setup callbacks BEFORE load so we don't miss first events
    EpubReader.onProgress((pct) => {
      updateBookmarkButton();
      updateProgressDetail(pct, totalWords);
      saveProgress(pct);
      syncRouteSoon();               // reflejar la posición en la URL (deep-link)
    });

    EpubReader.onChapter((label) => {
      updateBookmarkButton();
      updateProgressDetail(undefined, totalWords);
    });

    // Reading mode: barras como overlay (ver CSS de `body.reading`); el área de
    // lectura ocupa toda la altura, así inmersivo no re-pagina.
    document.body.classList.add('reading');
    // Móvil (estilo Play Books): arrancar SIN barras (texto a pantalla completa). Se
    // muestran tocando el centro, encogiendo el texto para que quepa (updateReaderScale).
    if (EpubReader.isCoarsePointer()) document.body.classList.add('immersive');
    document.getElementById('reader-footer').style.display = 'flex';

    await EpubReader.load(buffer);
    console.log('EPUB loaded successfully');

    // Update UI
    document.getElementById('reader-title').textContent = EpubReader.getTitle();
    document.getElementById('bookmark-toggle').disabled = false;
    document.getElementById('ai-toggle').disabled = false;
    document.getElementById('immersive-toggle').disabled = false;
    document.getElementById('header-search').disabled = false;

    // Feed the book to the AI agent (uses cache if already segmented).
    AiPanel.setBook(EpubReader.getBook(), aiBookId, EpubReader.getTitle());

    // Load TOC
    loadTOC();

    // Generate locations for progress (may fail on some books)
    try {
      await EpubReader.generateLocations();
      totalWords = countBookWords();
      // Las localizaciones se generan tras restaurar la posición, así que el %
      // mostraba 0 hasta moverse: lo refrescamos ya con las localizaciones.
      EpubReader.refreshProgress();
      updateProgressDetail(undefined, totalWords);
    } catch (locErr) {
      console.warn('Could not generate locations:', locErr);
      totalWords = countBookWords();
    }

    // Setup highlights with rendition
    setupHighlights();
    // Re-dibujar los subrayados guardados sobre el texto (el rendition es nuevo).
    applyStoredHighlights();

    // Render bookmark and highlight lists
    renderBookmarks();
    renderHighlights();

    updateBookmarkButton();
    updateReadingModeToggle();   // reflejar el modo (paginado/scroll) guardado del libro
    return true;
  } catch (err) {
    console.error('Error loading EPUB:', err);
    await alertBox('Error al cargar el archivo EPUB: ' + err.message);
    return false;
  }
}

async function loadPdf(buffer, bookId, aiBookId) {
  try {
    resetSearch();
    // Hash estable del contenido (id canónico para el agente). Se reutiliza si ya viene dado.
    if (!aiBookId) aiBookId = await AiDB.hashBuffer(buffer.slice(0));

    // Setup callback BEFORE load
    PdfReader.onPage((page, total) => {
      document.getElementById('reader-title').textContent = `PDF - Página ${page} de ${total}`;
      syncRouteSoon();               // reflejar la página en la URL (deep-link)
      drawPdfHighlights(page);       // PDF3: re-pintar los subrayados de la página
      updateBookmarkButton();        // reflejar si la página actual está marcada
    });

    await PdfReader.load(buffer);

    document.getElementById('reader-title').textContent = 'PDF';
    document.body.classList.add('reading');
    // Móvil (estilo Play Books): arrancar SIN barras (PDF a pantalla completa). Se
    // muestran/ocultan tocando el centro o con el botón ⤢. Las barras son overlay.
    if (EpubReader.isCoarsePointer()) document.body.classList.add('immersive');
    document.getElementById('reader-footer').style.display = 'flex';
    // Marcadores por página (id sintético `page:N`).
    document.getElementById('bookmark-toggle').disabled = false;
    // PDF1: el agente puede leer el PDF (texto extraído por página). Habilitar el panel.
    document.getElementById('ai-toggle').disabled = false;
    document.getElementById('immersive-toggle').disabled = false;
    document.getElementById('header-search').disabled = false;
    AiPanel.setBook(PdfReader.getDocument(), aiBookId, bookId || 'PDF', { format: 'pdf' });
    // PDF2/PDF3: seleccionar texto en el PDF → barra (preguntar/subrayar/nota/copiar).
    setupPdfSelection();
    renderHighlights();              // poblar la lista lateral con los subrayados guardados
    renderBookmarks();               // poblar la lista de marcadores del PDF
    updateBookmarkButton();          // estado del botón para la página inicial
    loadPdfTOC();                    // índice del PDF (outline) en el sidebar
    updateReadingModeToggle();       // PDF4: reflejar el modo (paginado/scroll) recordado
    return true;
  } catch (err) {
    console.error('Error loading PDF:', err);
    await alertBox('Error al cargar el archivo PDF');
    return false;
  }
}

// ============ TOC ============
// Índice del PDF: outline (con páginas ya resueltas) en el sidebar. Cada entrada salta a su
// página; las subentradas (p. ej. capítulos dentro de una Parte) van indentadas.
async function loadPdfTOC() {
  const tocList = document.getElementById('toc-list');
  const items = await PdfReader.getOutlineItems();
  if (!items.length) {
    tocList.innerHTML = '<p class="empty-state">Este PDF no tiene índice</p>';
    return;
  }
  tocList.innerHTML = '';
  const addLink = (it, isSub) => {
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = it.label;
    if (isSub) a.classList.add('subitem');
    if (it.page != null) {
      a.addEventListener('click', async (e) => {
        e.preventDefault();
        await PdfReader.goTo(it.page);
        document.getElementById('sidebar').classList.remove('open');
      });
    } else {
      a.style.opacity = '0.6';   // entrada sin destino resoluble
    }
    tocList.appendChild(a);
  };
  items.forEach(it => {
    addLink(it, false);
    (it.subitems || []).forEach(sub => addLink(sub, true));
  });
}

function loadTOC() {
  const nav = EpubReader.getNavigation();
  const tocList = document.getElementById('toc-list');

  if (!nav || !nav.toc || nav.toc.length === 0) {
    tocList.innerHTML = '<p class="empty-state">No hay índice disponible</p>';
    return;
  }

  tocList.innerHTML = '';
  nav.toc.forEach(item => {
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = item.label.trim();
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      await EpubReader.goTo(item.href);
    });
    tocList.appendChild(a);

    // Subitems
    if (item.subitems && item.subitems.length > 0) {
      item.subitems.forEach(sub => {
        const subA = document.createElement('a');
        subA.href = '#';
        subA.textContent = sub.label.trim();
        subA.classList.add('subitem');
        subA.addEventListener('click', async (e) => {
          e.preventDefault();
          await EpubReader.goTo(sub.href);
        });
        tocList.appendChild(subA);
      });
    }
  });
}

// ============ NAVIGATION ============
function initNavigation() {
  document.getElementById('prev-btn').addEventListener('click', () => {
    if (EpubReader.isLoaded()) EpubReader.prev();
    else if (PdfReader.isLoaded()) PdfReader.prev();
  });

  document.getElementById('next-btn').addEventListener('click', () => {
    if (EpubReader.isLoaded()) EpubReader.next();
    else if (PdfReader.isLoaded()) PdfReader.next();
  });

  // Pulsar la barra de progreso = saltar a esa parte del libro (por fracción).
  const progressContainer = document.getElementById('progress-container');
  progressContainer.addEventListener('click', (e) => {
    const rect = progressContainer.getBoundingClientRect();
    if (!rect.width) return;
    const f = (e.clientX - rect.left) / rect.width;
    if (EpubReader.isLoaded()) EpubReader.seekToFraction(f);
    else if (PdfReader.isLoaded()) PdfReader.seekToFraction(f);
  });

  // Keyboard navigation
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (e.key === 'ArrowLeft') {
      if (EpubReader.isLoaded()) EpubReader.prev();
      else if (PdfReader.isLoaded()) PdfReader.prev();
    } else if (e.key === 'ArrowRight') {
      if (EpubReader.isLoaded()) EpubReader.next();
      else if (PdfReader.isLoaded()) PdfReader.next();
    }
  });
}
