import * as Settings from './settings.js';
import * as Bookmarks from './bookmarks.js';
import * as Highlights from './highlights.js';
import * as EpubReader from './epub-reader.js';
import * as PdfReader from './pdf-reader.js';
import * as Storage from './storage.js';
import * as AiPanel from './ai/panel.js';
import * as AiDB from './ai/db.js';
import { hydrateIcons, icon } from './ui/icons.js';
import { escapeHtml } from './ui/escape.js';
import { countBookWords, updateProgressDetail } from './progress.js';
import { initHighlights, setupHighlights, renderHighlights, hideHighlightTooltip } from './highlights-ui.js';
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
      updateProgressDetail(pct, totalWords);
      saveProgress(pct);
    });

    EpubReader.onChapter((label) => {
      updateBookmarkButton();
      updateProgressDetail(undefined, totalWords);
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
      updateProgressDetail(undefined, totalWords);
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
      updateProgressDetail(undefined, totalWords);
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
