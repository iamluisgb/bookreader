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
import { initHighlights, setupHighlights, renderHighlights, applyStoredHighlights, hideHighlightTooltip } from './highlights-ui.js';
import { initBookmarkButton, updateBookmarkButton, renderBookmarks } from './bookmarks-ui.js';
import * as Library from './library/view.js';
import * as LibStore from './library/store.js';
import * as AppSettings from './ui/app-settings.js';
import { openImageZoom } from './image-zoom.js';

// ============ INIT ============
document.addEventListener('DOMContentLoaded', () => {
  hydrateIcons();
  Settings.init();
  EpubReader.init();
  initSidebar();
  initFileHandling();
  initNavigation();
  initBookmarkButton();
  initHighlights();
  initDragDrop();
  initAiPanel();
  initImmersive();
  initReaderReflow();
  initLibrary();
});

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
  document.getElementById('library-btn')?.addEventListener('click', goToLibrary);
  // Pantalla inicial: biblioteca si ya hay libros guardados, si no el landing.
  Library.hasBooks().then(has => { if (has) { Library.render(); Library.show(); } });
}

async function goToLibrary() {
  document.body.classList.remove('reading', 'immersive', 'fs');   // salir del modo lectura
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
async function openLibraryBook(record) {
  try {
    Library.hide();
    const buffer = record.file instanceof ArrayBuffer ? record.file.slice(0) : await record.file.arrayBuffer();
    Bookmarks.setBook(record.fileBaseId || record.id);
    Highlights.setBook(record.fileBaseId || record.id);
    currentBook = { id: record.id, fileBaseId: record.fileBaseId || record.id, format: record.format };
    if (record.format === 'pdf') {
      await loadPdf(buffer, record.fileBaseId || record.id);
    } else {
      await loadEpub(buffer, record.fileBaseId || record.id, record.id);
      if (record.lastCfi) { try { await EpubReader.goTo(record.lastCfi); } catch (e) { /* posición no válida */ } }
    }
    await LibStore.updateBook(record.id, { lastOpenedAt: Date.now() });
    document.getElementById('library-btn').style.display = '';
  } catch (e) {
    console.error('No se pudo abrir el libro de la biblioteca:', e);
    alert('No se pudo abrir el libro guardado.');
  }
}

// Guardar/actualizar un libro recién abierto desde un archivo (con portada).
async function persistToLibrary(id, buffer, format, fileName, fileBaseId) {
  try {
    const existing = await LibStore.getBook(id);
    const title = format === 'pdf' ? (fileName.replace(/\.[^.]+$/, '')) : EpubReader.getTitle();
    const author = format === 'pdf' ? '' : EpubReader.getAuthor();
    const cover = (format === 'pdf') ? '' : await EpubReader.getCoverDataUrl();
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

// Persistir progreso del libro abierto (con rebote).
function saveProgress(pct) {
  if (!currentBook) return;
  clearTimeout(progressTimer);
  progressTimer = setTimeout(async () => {
    try {
      const cfi = EpubReader.getCurrentCfi();
      const prev = await LibStore.getBook(currentBook.id);
      const status = LibStore.statusFor(pct, prev?.status);
      await LibStore.updateBook(currentBook.id, { progress: pct, lastCfi: cfi || prev?.lastCfi || null, status });
    } catch (e) { /* sin persistencia */ }
  }, 800);
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
}

// ============ AI PANEL ============
function initAiPanel() {
  AiPanel.init({
    onCite: async (cfi) => {
      await EpubReader.goTo(cfi);
      try {
        const rendition = EpubReader.getRendition();
        rendition?.annotations.highlight(cfi, {}, () => {}, 'ai-cite-hl', {
          'fill': 'var(--accent)', 'fill-opacity': '0.25', 'mix-blend-mode': 'multiply'
        });
      } catch (e) { /* cita sin highlight */ }
    },
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
    alert('Formato no soportado. Usa archivos .epub o .pdf');
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

  if (ext === 'epub') {
    await loadEpub(buffer, fileBaseId, id);
  } else {
    await loadPdf(buffer, fileBaseId);
  }

  // Guardar en la biblioteca (con portada/metadatos ya disponibles) y mostrar
  // el acceso a la biblioteca en la cabecera.
  await persistToLibrary(id, buffer, ext, file.name, fileBaseId);
  document.getElementById('library-btn').style.display = '';
  Library.render();
}

let totalWords = 0;

async function loadEpub(buffer, bookId, aiBookId) {
  try {
    console.log('Loading EPUB, buffer size:', buffer.byteLength);

    // Hash estable del fichero (id canónico). Se reutiliza si ya viene calculado.
    if (!aiBookId) aiBookId = await AiDB.hashBuffer(buffer.slice(0));

    // Setup callbacks BEFORE load so we don't miss first events
    EpubReader.onProgress((pct) => {
      updateBookmarkButton();
      updateProgressDetail(pct, totalWords);
      saveProgress(pct);
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
  } catch (err) {
    console.error('Error loading EPUB:', err);
    alert('Error al cargar el archivo EPUB: ' + err.message);
  }
}

async function loadPdf(buffer, bookId) {
  try {
    // Setup callback BEFORE load
    PdfReader.onPage((page, total) => {
      document.getElementById('reader-title').textContent = `PDF - Página ${page} de ${total}`;
    });

    await PdfReader.load(buffer);

    document.getElementById('reader-title').textContent = 'PDF';
    document.body.classList.add('reading');
    document.getElementById('reader-footer').style.display = 'flex';
    document.getElementById('bookmark-toggle').disabled = true;
  } catch (err) {
    console.error('Error loading PDF:', err);
    alert('Error al cargar el archivo PDF');
  }
}

// ============ TOC ============
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
