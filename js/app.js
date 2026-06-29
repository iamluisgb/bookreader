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

// ============ MODO LECTURA INMERSIVO ============
function initImmersive() {
  document.getElementById('immersive-toggle')?.addEventListener('click', () => {
    document.body.classList.add('immersive');
  });
  // Zonas táctiles activas solo en inmersivo: pasar página o salir.
  document.getElementById('reader-taps')?.addEventListener('click', (e) => {
    const zone = e.target.closest('.tap-zone')?.dataset.tap;
    if (zone === 'prev') { EpubReader.isLoaded() ? EpubReader.prev() : PdfReader.prev(); }
    else if (zone === 'next') { EpubReader.isLoaded() ? EpubReader.next() : PdfReader.next(); }
    else if (zone === 'center') { document.body.classList.remove('immersive'); }
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

function setupHighlights() {
  const rendition = EpubReader.getRendition();
  if (!rendition) return;

  // Listen for text selection
  rendition.on('selected', (cfiRange, contents) => {
    if (!cfiRange) return;

    let text = '';
    let selection = null;
    try {
      selection = contents.window.getSelection();
      if (selection && !selection.isCollapsed) {
        text = selection.toString().trim();
      }
    } catch(e) {
      console.warn('Selection access failed:', e);
    }

    if (!text) return;

    showHighlightTooltip(cfiRange, text, selection);
  });
}

let activeSelection = null;

function showHighlightTooltip(cfiRange, text, selection) {
  const tooltip = document.getElementById('highlight-tooltip');

  // Try to position relative to selection
  let left = window.innerWidth / 2 - 80;
  let top = 100;

  if (selection && selection.rangeCount > 0) {
    try {
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      left = rect.left + (rect.width / 2) - 80;
      top = rect.top - 50;
    } catch(e) {}
  }

  // Keep tooltip in viewport
  left = Math.max(10, Math.min(left, window.innerWidth - 170));
  top = Math.max(10, top);

  tooltip.style.display = 'flex';
  tooltip.style.left = left + 'px';
  tooltip.style.top = top + 'px';

  activeSelection = { cfiRange, text };

  // Color buttons
  tooltip.querySelectorAll('.highlight-color').forEach(btn => {
    btn.onclick = () => {
      const color = btn.dataset.color;
      const chapter = EpubReader.getCurrentChapterLabel();
      Highlights.add(cfiRange, text, color, chapter);

      // Apply highlight to rendition
      applyHighlightToRendition(cfiRange, color);

      hideHighlightTooltip();
      renderHighlights();
    };
  });

  // Remove button
  document.getElementById('highlight-remove').onclick = () => {
    hideHighlightTooltip();
  };

  // Close on click outside
  setTimeout(() => {
    document.addEventListener('click', hideHighlightTooltipOnOutside);
  }, 100);
}

function hideHighlightTooltip() {
  document.getElementById('highlight-tooltip').style.display = 'none';
  document.removeEventListener('click', hideHighlightTooltipOnOutside);
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
  if (!book?.spine) return 80000;

  let totalChars = 0;
  const len = book.spine.length || 0;
  for (let i = 0; i < len; i++) {
    try {
      const section = book.spine.get(i);
      if (section?.document?.body) {
        totalChars += section.document.body.textContent.length;
      }
    } catch { /* section not loaded */ }
  }

  if (totalChars > 0) return Math.round(totalChars / 5);

  // Fallback: a typical novel is ~80,000 words
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
