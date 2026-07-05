// UI de subrayados y barra de selección del lector EPUB. Extraído de app.js
// (T8, ver CHANGELOG). Gestiona: la selección (táctil vía touch-select / nativa en
// escritorio), la barra de acciones (color, nota, copiar, preguntar al agente) y
// la lista de subrayados de la sidebar. El estado de selección es local a este
// módulo. Público: initHighlights, setupHighlights, renderHighlights,
// hideHighlightTooltip.
import * as EpubReader from './epub-reader.js';
import * as PdfReader from './pdf-reader.js';
import * as Highlights from './highlights.js';
import * as AiPanel from './ai/panel.js';
import { icon } from './ui/icons.js';
import { escapeHtml } from './ui/escape.js';
import { alertBox, promptBox } from './ui/dialog.js';

export function initHighlights() {
  Highlights.setOnChange(() => renderHighlights());

  // Export button
  document.getElementById('export-highlights-btn')?.addEventListener('click', () => {
    const title = EpubReader.isLoaded() ? EpubReader.getTitle() : 'PDF';
    const result = Highlights.exportJSON(title);
    if (!result) {
      alertBox('No hay subrayados para exportar');
    }
  });
}

let tempSelCfi = null;
let lastSelWin = null;   // ventana del iframe de la última selección (escritorio)

export function setupHighlights() {
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

function removeTempSelection(rendition) {
  if (!tempSelCfi) return;
  // epub.js identifica la anotación por (cfi + TIPO); el tipo de highlight() es
  // "highlight" (no la clase CSS).
  try { (rendition || EpubReader.getRendition())?.annotations.remove(tempSelCfi, 'highlight'); } catch (e) {}
  tempSelCfi = null;
}

// Coloca la barra de selección junto al rect de la selección (coords de pantalla).
// Compartido por EPUB y PDF.
function positionTooltip(tooltip, rect) {
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
}

function showHighlightTooltip(cfiRange, text, rect) {
  const tooltip = document.getElementById('highlight-tooltip');

  // Ya hemos borrado la selección nativa (finalizeSelection), así que no hay
  // menús del SO con los que chocar: colocamos la barra junto a la selección.
  positionTooltip(tooltip, rect);

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
  document.getElementById('sel-note').onclick = async () => {
    const note = await promptBox('Tu nota sobre este pasaje:', { title: 'Nota' });
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

export function hideHighlightTooltip() {
  document.getElementById('highlight-tooltip').style.display = 'none';
  document.removeEventListener('click', hideHighlightTooltipOnOutside);
  removeTempSelection();
  try { EpubReader.clearSelection(); } catch (e) {}   // overlay táctil, si lo hay
  try { lastSelWin && lastSelWin.getSelection().removeAllRanges(); } catch (e) {}  // selección nativa (escritorio)
  try { window.getSelection().removeAllRanges(); } catch (e) {}  // selección nativa del PDF (documento padre)
  lastSelWin = null;
}

// PDF2/PDF3 · Selección en PDF. La capa de texto del PDF ya es seleccionable (vive en el
// documento padre, sin iframe). Al soltar la selección mostramos la barra: subrayar (con
// ancla {página, rects}), nota, preguntar al agente y copiar.
export function setupPdfSelection() {
  const container = document.getElementById('pdf-container');
  if (!container || container.dataset.selWired) return;
  container.dataset.selWired = '1';   // no re-atar en cada render/página

  const onSelectEnd = () => setTimeout(() => {
    const sel = window.getSelection();
    const text = sel && !sel.isCollapsed ? sel.toString().replace(/\s+/g, ' ').trim() : '';
    if (!text || text.length < 2) return;
    // Solo si la selección cae dentro de la capa de texto del PDF.
    const node = sel.anchorNode;
    const host = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!host || !host.closest('#pdf-container .textLayer')) return;
    // La página del subrayado es la del wrapper que contiene la selección (clave en modo
    // scroll, donde hay varias páginas montadas a la vez).
    const wrapper = host.closest('#pdf-container .pdf-page');
    const page = wrapper ? (+wrapper.dataset.page || PdfReader.getCurrentPage()) : PdfReader.getCurrentPage();
    let rect = null, rects = [];
    try {
      const range = sel.getRangeAt(0);
      rect = range.getBoundingClientRect();
      rects = pdfFractionalRects(range, wrapper);
    } catch (e) {}
    showPdfSelectionTooltip(text, rect, rects, page);
  }, 0);

  container.addEventListener('mouseup', onSelectEnd);
  container.addEventListener('touchend', onSelectEnd);
}

// Rectángulos de la selección en coordenadas FRACCIONALES (0..1) de la página del PDF, para
// re-pintarlos nítidos a cualquier escala/HiDPI (el canvas se re-renderiza al cambiar zoom).
function pdfFractionalRects(range, wrapper) {
  wrapper = wrapper || document.querySelector('#pdf-container .pdf-page');
  if (!wrapper) return [];
  const wr = wrapper.getBoundingClientRect();
  if (!wr.width || !wr.height) return [];
  return [...range.getClientRects()]
    .map(r => ({
      left: (r.left - wr.left) / wr.width,
      top: (r.top - wr.top) / wr.height,
      width: r.width / wr.width,
      height: r.height / wr.height,
    }))
    .filter(r => r.width > 0.001 && r.height > 0.001);
}

function showPdfSelectionTooltip(text, rect, rects, page) {
  const tooltip = document.getElementById('highlight-tooltip');
  positionTooltip(tooltip, rect);

  const saveHighlight = (color, note = '') => {
    Highlights.addPdf(page, rects, text, color, `Pág. ${page}`, note);
    drawPdfHighlights(page);
    hideHighlightTooltip();
    renderHighlights();
  };

  tooltip.querySelectorAll('.highlight-color').forEach(btn => {
    btn.onclick = () => saveHighlight(btn.dataset.color);
  });

  document.getElementById('sel-note').onclick = async () => {
    const note = await promptBox('Tu nota sobre este pasaje:', { title: 'Nota' });
    if (note === null) return;
    saveHighlight('#ffd54f', note.trim());
  };

  document.getElementById('sel-ask').onclick = () => {
    AiPanel.quoteSelection(text);
    hideHighlightTooltip();
  };
  document.getElementById('sel-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(text); } catch (e) { /* sin clipboard */ }
    hideHighlightTooltip();
  };

  setTimeout(() => document.addEventListener('click', hideHighlightTooltipOnOutside), 100);
}

// PDF3 · Pinta el overlay de subrayados de una página sobre el canvas. Se llama tras cada
// render de página (onPage) y al crear/borrar un subrayado. Los rects son fraccionales, así
// que se escalan al tamaño actual del wrapper.
export function drawPdfHighlights(page) {
  // El wrapper de esa página (en scroll hay varios; en paginado, el único).
  const wrapper = document.querySelector(`#pdf-container .pdf-page[data-page="${page}"]`)
    || document.querySelector('#pdf-container .pdf-page');
  if (!wrapper) return;
  let layer = wrapper.querySelector('.pdf-hl-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'pdf-hl-layer';
    wrapper.appendChild(layer);
  }
  layer.innerHTML = '';
  // Cada subrayado va en su propio GRUPO, con el blend/opacidad aplicados al grupo (ver CSS):
  // así los rects de líneas contiguas que se solapan no se multiplican dos veces (evita las
  // bandas oscuras). En porcentaje (no px): el overlay escala solo con la caja fit·zoom, sin
  // recalcular al hacer zoom (los rects son fraccionales 0..1).
  for (const hl of Highlights.getByPage(page)) {
    const rects = hl.rects || [];
    if (!rects.length) continue;
    const group = document.createElement('div');
    group.className = 'pdf-hl-group';
    if (hl.note) group.title = hl.note;
    for (const r of rects) {
      const d = document.createElement('div');
      d.className = 'pdf-hl';
      d.style.left = (r.left * 100) + '%';
      d.style.top = (r.top * 100) + '%';
      d.style.width = (r.width * 100) + '%';
      d.style.height = (r.height * 100) + '%';
      d.style.background = hl.color;
      group.appendChild(d);
    }
    layer.appendChild(group);
  }
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

// Re-dibuja en el rendition todos los subrayados guardados de este libro. epub.js
// recrea el rendition al reabrir con el set de anotaciones vacío, así que si no se
// vuelven a añadir no se ven sobre el texto (aunque sigan guardados y en la lista).
// Se llama una vez tras cargar el libro.
export function applyStoredHighlights() {
  if (!EpubReader.getRendition()) return;
  for (const hl of Highlights.getAll()) {
    if (hl && hl.cfi) applyHighlightToRendition(hl.cfi, hl.color);
  }
}

export function renderHighlights() {
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
      if (hl.page != null) {                 // PDF: navegar a la página y re-pintar
        await PdfReader.goTo(hl.page);
        drawPdfHighlights(hl.page);
      } else {
        await EpubReader.goTo(hl.cfi);
      }
      document.getElementById('sidebar').classList.remove('open');
    });

    item.querySelector('.highlight-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      Highlights.removeById(hl.id ?? hl.cfi);
      if (hl.page != null) {
        drawPdfHighlights(hl.page);          // quitar el overlay de la página del PDF
      } else {
        // Quitar el resaltado pintado en la página (tipo 'highlight' de epub.js).
        try { EpubReader.getRendition()?.annotations.remove(hl.cfi, 'highlight'); } catch (err) {}
      }
      renderHighlights();   // refrescar la lista y el estado del botón de exportar
    });

    list.appendChild(item);
  });
}
