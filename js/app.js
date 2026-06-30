import * as Settings from './settings.js';
import * as Bookmarks from './bookmarks.js';
import * as Highlights from './highlights.js';
import * as EpubReader from './epub-reader.js';
import * as PdfReader from './pdf-reader.js';
import * as Storage from './storage.js';
import * as AiPanel from './ai/panel.js';
import * as AiDB from './ai/db.js';
import { hydrateIcons, icon } from './ui/icons.js';
import * as Library from './library/view.js';
import * as LibStore from './library/store.js';

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
  Library.init({ onOpenBook: openLibraryBook, onAddBook: () => document.getElementById('file-input').click() });
  document.getElementById('library-btn')?.addEventListener('click', goToLibrary);
  // Pantalla inicial: biblioteca si ya hay libros guardados, si no el landing.
  Library.hasBooks().then(has => { if (has) { Library.render(); Library.show(); } });
}

async function goToLibrary() {
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
function setImmersive(on) {
  document.body.classList.toggle('immersive', on);
  // La cabecera y el pie salen del flujo en inmersivo, así que el área de
  // lectura crece: re-paginar para usar toda la altura (tras aplicar el layout).
  requestAnimationFrame(() => { if (EpubReader.isLoaded()) EpubReader.resize(); });
}

function initImmersive() {
  document.getElementById('immersive-toggle')?.addEventListener('click', () => setImmersive(true));

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
      updateProgressDetail(pct);
      saveProgress(pct);
    });

    EpubReader.onChapter((label) => {
      updateBookmarkButton();
      updateProgressDetail();
    });

    // Reveal the footer BEFORE rendering so the epub container is measured at
    // its final height — otherwise epub.js bakes in the taller (footer-hidden)
    // height and the last lines are cut off on the first book.
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
      updateProgressDetail();
    } catch (locErr) {
      console.warn('Could not generate locations:', locErr);
      totalWords = countBookWords();
    }

    // Setup highlights with rendition
    setupHighlights();

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

  // Progress detail toggle
  const progressContainer = document.querySelector('.progress-container');
  const progressDetail = document.getElementById('progress-detail');
  progressContainer.addEventListener('click', (e) => {
    if (progressDetail.style.display === 'none') {
      updateProgressDetail();
      progressDetail.style.display = 'block';
    } else {
      progressDetail.style.display = 'none';
    }
  });

  // Close detail on click outside
  document.addEventListener('click', (e) => {
    if (progressDetail.style.display !== 'none' &&
        !progressDetail.contains(e.target) &&
        !progressContainer.contains(e.target)) {
      progressDetail.style.display = 'none';
    }
  });

  // Keyboard navigation
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'ArrowLeft') {
      if (EpubReader.isLoaded()) EpubReader.prev();
      else if (PdfReader.isLoaded()) PdfReader.prev();
    } else if (e.key === 'ArrowRight') {
      if (EpubReader.isLoaded()) EpubReader.next();
      else if (PdfReader.isLoaded()) PdfReader.next();
    }
  });
}

// ============ BOOKMARKS ============
function initBookmarkButton() {
  document.getElementById('bookmark-toggle').addEventListener('click', () => {
    if (!EpubReader.isLoaded()) return;

    const cfi = EpubReader.getCurrentCfi();
    if (!cfi) return;

    const chapter = EpubReader.getCurrentChapterLabel();
    const title = document.getElementById('reader-title').textContent;

    Bookmarks.toggle(cfi, title, chapter);
    updateBookmarkButton();
  });

  Bookmarks.setOnChange(() => renderBookmarks());
}

function updateBookmarkButton() {
  if (!EpubReader.isLoaded()) return;

  const btn = document.getElementById('bookmark-toggle');
  const cfi = EpubReader.getCurrentCfi();
  if (!cfi) return;

  const isBookmarked = Bookmarks.has(cfi);
  btn.innerHTML = icon('bookmark', { filled: isBookmarked });
  btn.classList.toggle('is-active', isBookmarked);
  btn.title = isBookmarked ? 'Quitar marcador' : 'Marcar página';
}

function renderBookmarks() {
  const list = document.getElementById('bookmarks-list');
  const bookmarks = Bookmarks.getAll();

  if (bookmarks.length === 0) {
    list.innerHTML = '<p class="empty-state">No hay marcadores aún</p>';
    return;
  }

  list.innerHTML = '';
  bookmarks.sort((a, b) => b.timestamp - a.timestamp).forEach(bm => {
    const item = document.createElement('div');
    item.className = 'bookmark-item';
    item.innerHTML = `
      <div class="bookmark-info">
        <div class="bookmark-title">${escapeHtml(bm.title)}</div>
        <div class="bookmark-chapter">${escapeHtml(bm.chapter)}</div>
      </div>
      <button class="bookmark-delete" title="Eliminar">${icon('xmark', { size: 16 })}</button>
    `;

    item.querySelector('.bookmark-info').addEventListener('click', async () => {
      await EpubReader.goTo(bm.cfi);
      document.getElementById('sidebar').classList.remove('open');
    });

    item.querySelector('.bookmark-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      Bookmarks.remove(bm.cfi);
      updateBookmarkButton();
    });

    list.appendChild(item);
  });
}

// ============ HIGHLIGHTS ============
function initHighlights() {
  Highlights.setOnChange(() => renderHighlights());

  // Export button
  document.getElementById('export-highlights-btn')?.addEventListener('click', () => {
    const title = EpubReader.isLoaded() ? EpubReader.getTitle() : 'PDF';
    const result = Highlights.exportJSON(title);
    if (!result) {
      alert('No hay subrayados para exportar');
    }
  });
}

let tempSelCfi = null;
let selFinalizeTimer = null;
let pendingSel = null;
let lastSelWin = null;   // ventana del iframe de la última selección (escritorio)

function setupHighlights() {
  const rendition = EpubReader.getRendition();
  if (!rendition) return;

  // Táctil: la selección la gestiona el módulo touch-select (mantener pulsado +
  // tiradores propios). Al terminar nos entrega cfi/texto/rect ya listos; el
  // propio módulo pinta el resaltado y los tiradores, así que aquí solo
  // mostramos la barra de acciones.
  if (EpubReader.isCoarsePointer && EpubReader.isCoarsePointer()) {
    EpubReader.onSelect(({ cfiRange, text, rect }) => {
      if (!cfiRange || !text) return;
      showHighlightTooltip(cfiRange, text, rect);
    });
    EpubReader.onSelectionDismiss(() => hideHighlightTooltip());
    return;
  }

  // Escritorio: selección nativa del navegador.
  rendition.on('selected', (cfiRange, contents) => {
    if (!cfiRange) return;

    let text = '', rect = null;
    const win = contents.window;
    try {
      const selection = win.getSelection();
      if (selection && !selection.isCollapsed) {
        text = selection.toString().trim();
        if (selection.rangeCount > 0) {
          // Rect de la selección en coords de PANTALLA (sumar offset del iframe).
          const r = selection.getRangeAt(0).getBoundingClientRect();
          const iframe = document.querySelector('#epub-container iframe');
          const io = iframe ? iframe.getBoundingClientRect() : { left: 0, top: 0 };
          rect = { left: io.left + r.left, top: io.top + r.top, width: r.width, height: r.height };
        }
      }
    } catch (e) {
      console.warn('Selection access failed:', e);
    }

    if (!text) return;

    // En escritorio la selección nativa funciona bien y no hay menús del SO que
    // esquivar, así que NO la tocamos: la dejamos viva (el usuario puede
    // extenderla sin límite) y solo mostramos nuestra barra junto a ella. La
    // selección nativa se limpia al cerrar la barra (hideHighlightTooltip).
    lastSelWin = win;
    showHighlightTooltip(cfiRange, text, rect);
    // Cerrar la barra al pulsar en el texto (los clics del iframe no llegan al
    // documento padre). addEventListener deduplica por referencia de función.
    try { win.document.addEventListener('mousedown', hideHighlightTooltip); } catch (e) {}
  });
}

function finalizeSelection(rendition) {
  if (!pendingSel) return;
  const { cfiRange, text, rect, win } = pendingSel;
  pendingSel = null;
  drawTempSelection(rendition, cfiRange);            // resaltado propio visible
  try { win.getSelection().removeAllRanges(); } catch (e) {}  // descarta menús del SO
  showHighlightTooltip(cfiRange, text, rect);
}

function drawTempSelection(rendition, cfiRange) {
  removeTempSelection(rendition);
  tempSelCfi = cfiRange;
  try {
    rendition.annotations.highlight(cfiRange, {}, () => {}, 'sel-temp', {
      'fill': '#64b5f6', 'fill-opacity': '0.4', 'mix-blend-mode': 'multiply'
    });
  } catch (e) {}
}

function removeTempSelection(rendition) {
  if (!tempSelCfi) return;
  // epub.js identifica la anotación por (cfi + TIPO); el tipo de highlight() es
  // "highlight" (no la clase CSS).
  try { (rendition || EpubReader.getRendition())?.annotations.remove(tempSelCfi, 'highlight'); } catch (e) {}
  tempSelCfi = null;
}

let activeSelection = null;

function showHighlightTooltip(cfiRange, text, rect) {
  const tooltip = document.getElementById('highlight-tooltip');
  activeSelection = { cfiRange, text };

  // Ya hemos borrado la selección nativa (finalizeSelection), así que no hay
  // menús del SO con los que chocar: colocamos la barra junto a la selección.
  tooltip.style.display = 'flex';
  tooltip.style.visibility = 'hidden';
  requestAnimationFrame(() => {
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    let cx = window.innerWidth / 2, top = 100;
    if (rect) {
      cx = rect.left + rect.width / 2;
      top = rect.top - th - 10;
      if (top < 10) top = rect.top + rect.height + 10;   // debajo si no cabe arriba
    }
    let left = Math.max(10, Math.min(cx - tw / 2, window.innerWidth - tw - 10));
    top = Math.max(10, Math.min(top, window.innerHeight - th - 10));
    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
    tooltip.style.visibility = 'visible';
  });

  // Subrayar con color
  tooltip.querySelectorAll('.highlight-color').forEach(btn => {
    btn.onclick = () => {
      const color = btn.dataset.color;
      removeTempSelection();   // quitar el temporal antes de pintar el definitivo
      Highlights.add(cfiRange, text, color, EpubReader.getCurrentChapterLabel());
      applyHighlightToRendition(cfiRange, color);
      hideHighlightTooltip();
      renderHighlights();
    };
  });

  // Preguntar al agente con el pasaje como referencia
  document.getElementById('sel-ask').onclick = () => {
    AiPanel.quoteSelection(text);
    hideHighlightTooltip();
  };

  // Añadir nota (subraya y guarda la nota)
  document.getElementById('sel-note').onclick = () => {
    const note = prompt('Tu nota sobre este pasaje:');
    if (note === null) return;
    const color = '#ffd54f';
    removeTempSelection();
    Highlights.add(cfiRange, text, color, EpubReader.getCurrentChapterLabel(), note.trim());
    applyHighlightToRendition(cfiRange, color);
    hideHighlightTooltip();
    renderHighlights();
  };

  // Copiar al portapapeles
  document.getElementById('sel-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(text); } catch (e) { /* sin clipboard */ }
    hideHighlightTooltip();
  };

  // Cerrar al hacer clic fuera
  setTimeout(() => {
    document.addEventListener('click', hideHighlightTooltipOnOutside);
  }, 100);
}

function hideHighlightTooltip() {
  clearTimeout(selFinalizeTimer);
  pendingSel = null;
  document.getElementById('highlight-tooltip').style.display = 'none';
  document.removeEventListener('click', hideHighlightTooltipOnOutside);
  removeTempSelection();
  try { EpubReader.clearSelection(); } catch (e) {}   // overlay táctil, si lo hay
  try { lastSelWin && lastSelWin.getSelection().removeAllRanges(); } catch (e) {}  // selección nativa (escritorio)
  lastSelWin = null;
  activeSelection = null;
}

function hideHighlightTooltipOnOutside(e) {
  const tooltip = document.getElementById('highlight-tooltip');
  if (!tooltip.contains(e.target)) {
    hideHighlightTooltip();
  }
}

function applyHighlightToRendition(cfiRange, color) {
  const rendition = EpubReader.getRendition();
  if (!rendition) return;

  rendition.annotations.highlight(cfiRange, {}, (e) => {
    // Click on highlight
  }, 'hl', {
    'fill': color,
    'fill-opacity': '0.3',
    'mix-blend-mode': 'multiply'
  });
}

function renderHighlights() {
  const list = document.getElementById('highlights-list');
  const highlights = Highlights.getAll();
  const exportBtn = document.getElementById('export-highlights-btn');

  if (exportBtn) exportBtn.disabled = highlights.length === 0;

  if (highlights.length === 0) {
    list.innerHTML = '<p class="empty-state">No hay subrayados aún</p>';
    return;
  }

  list.innerHTML = '';
  highlights.sort((a, b) => b.timestamp - a.timestamp).forEach(hl => {
    const item = document.createElement('div');
    item.className = 'highlight-item';
    item.style.borderLeftColor = hl.color;
    item.innerHTML = `
      <div class="highlight-text">"${escapeHtml(hl.text)}"</div>
      ${hl.note ? `<div class="highlight-note">${icon('note', { size: 13 })}<span>${escapeHtml(hl.note)}</span></div>` : ''}
      <div class="highlight-meta">
        <span>${escapeHtml(hl.chapter)}</span>
        <button class="highlight-delete" title="Eliminar">${icon('xmark', { size: 16 })}</button>
      </div>
    `;

    item.addEventListener('click', async () => {
      await EpubReader.goTo(hl.cfi);
      document.getElementById('sidebar').classList.remove('open');
    });

    item.querySelector('.highlight-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      Highlights.remove(hl.cfi);
      // Quitar el resaltado pintado en la página (tipo 'highlight' de epub.js).
      try { EpubReader.getRendition()?.annotations.remove(hl.cfi, 'highlight'); } catch (err) {}
      renderHighlights();   // refrescar la lista y el estado del botón de exportar
    });

    list.appendChild(item);
  });
}

// ============ HELPERS ============
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============ PROGRESS DETAIL ============
const WORDS_PER_MINUTE = 250;
// Debe coincidir con el valor de book.locations.generate() en epub-reader.js.
const CHARS_PER_LOCATION = 1024;

function updateProgressDetail(pct) {
  const detailPct = document.getElementById('progress-detail-pct');
  const detailFill = document.getElementById('progress-detail-fill');
  const detailLabel = document.getElementById('progress-detail-label');
  const detailTime = document.getElementById('progress-detail-time');

  if (pct === undefined) pct = getCurrentPct();
  const pctNum = Math.round(pct);
  const remaining = 100 - pctNum;

  detailPct.textContent = pctNum + '% complete';
  detailFill.style.width = pctNum + '%';

  if (remaining <= 0) {
    detailLabel.textContent = 'Content Progress — finished';
    detailTime.textContent = '';
  } else {
    detailLabel.textContent = `Content Progress — ${pctNum}% completed`;

    const wordsLeft = Math.round(totalWords * (remaining / 100));
    const minutesLeft = Math.max(1, Math.round(wordsLeft / WORDS_PER_MINUTE));

    if (minutesLeft < 60) {
      detailTime.textContent = `Approx. ${minutesLeft} min left`;
    } else {
      const hours = Math.floor(minutesLeft / 60);
      const mins = minutesLeft % 60;
      detailTime.textContent = mins > 0
        ? `Approx. ${hours}h ${mins}m left`
        : `Approx. ${hours}h left`;
    }
  }
}

function countBookWords() {
  const book = EpubReader.getBook();
  if (!book) return 80000;

  // Preferimos las localizaciones de epub.js: generateLocations() divide el
  // libro ENTERO en tramos de ~CHARS_PER_LOCATION caracteres, así que
  // nºtramos × CHARS_PER_LOCATION ≈ caracteres totales, y /5 ≈ palabras. Es
  // fiable porque NO depende de que las secciones estén cargadas (el bug
  // anterior: section.document solo existe para las secciones ya renderizadas,
  // por eso contaba casi 0 palabras → "1 min left").
  try {
    const loc = book.locations;
    const total = loc ? (typeof loc.length === 'function' ? loc.length() : loc.total) : 0;
    if (total > 1) {
      return Math.round((total * CHARS_PER_LOCATION) / 5);
    }
  } catch { /* sin localizaciones */ }

  // Fallback: sumar el texto de las secciones que SÍ estén cargadas.
  let totalChars = 0;
  const len = book.spine?.length || 0;
  for (let i = 0; i < len; i++) {
    try {
      const section = book.spine.get(i);
      if (section?.document?.body) {
        totalChars += section.document.body.textContent.length;
      }
    } catch { /* section not loaded */ }
  }
  if (totalChars > 0) return Math.round(totalChars / 5);

  // Último recurso: una novela típica ronda las 80 000 palabras.
  return 80000;
}

function estimateWords() {
  // Fallback: typical novel ~80k words, short book ~40k
  return 80000;
}

function getCurrentPct() {
  const bar = document.getElementById('progress-bar');
  if (!bar) return 0;
  return parseFloat(bar.style.width) || 0;
}
