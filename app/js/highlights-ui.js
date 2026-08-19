// UI de subrayados y barra de selección del lector EPUB. Extraído de app.js
// (T8, ver CHANGELOG). Gestiona: la selección (táctil vía touch-select / nativa en
// escritorio), la barra de acciones (color, nota, copiar, preguntar al agente) y
// la lista de subrayados de la sidebar. El estado de selección es local a este
// módulo. Público: initHighlights, setupHighlights, renderHighlights,
// hideHighlightTooltip.
import { t } from './i18n.js';
import * as EpubReader from './epub-reader.js';
import * as PdfReader from './pdf-reader.js';
import * as Highlights from './highlights.js';
import { icon } from './ui/icons.js';
import { escapeHtml } from './ui/escape.js';
import { dehyphenate } from './ui/text.js';
import { alertBox } from './ui/dialog.js';
import { shareQuote } from './share-card.js';
import { toast } from './ai/toast.js';
import { whenLabel, fullWhen } from './ui/when.js';

const DEFAULT_COLOR = '#ffd54f';

// Título/autor del libro abierto, para la tarjeta-cita al compartir (P11). Lo fija
// app.js al abrir (biblioteca o archivo); degrada a vacío si no se conoce.
let bookMeta = { title: '', author: '', cover: '' };
export function setBookMeta(m) {
  bookMeta = { title: (m && m.title) || '', author: (m && m.author) || '', cover: (m && m.cover) || '' };
}

// Compartir un pasaje como tarjeta-cita PNG (Web Share o descarga).
async function shareHighlight(text) {
  try {
    await shareQuote({ quote: dehyphenate(text), title: bookMeta.title, author: bookMeta.author, cover: bookMeta.cover });
  } catch (e) {
    console.warn('No se pudo compartir la cita:', e);
    try { alertBox('No se pudo generar la imagen para compartir.'); } catch (_) {}
  }
}

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
let pdfPending = null;   // selección de PDF VIVA (se refresca con selectionchange; ver setupPdfSelection)

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

// Acciones de agente de la barra de selección (idénticas en EPUB y PDF): preguntar con el
// fragmento adjunto, o una de las acciones rápidas, que mandan una petición ya formulada.
// `getText` es una FUNCIÓN, no una cadena: en PDF el texto puede cambiar entre que se abre la
// barra y se pulsa la acción (asas de selección), así que se lee al pulsar.
function wireAgentActions(getText) {
  const on = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.onclick = () => { fn(getText()); hideHighlightTooltip(); };
  };
  // El panel del agente se carga con `import()` (no pesa en el arranque, ver app.js);
  // el módulo se espera DENTRO del handler, no al importar este fichero.
  const conPanel = (fn) => async (txt) => fn(await import('./ai/panel.js'), txt);
  on('sel-ask', conPanel((AiPanel, txt) => AiPanel.quoteSelection(txt)));
  on('sel-numeric', conPanel((AiPanel, txt) => AiPanel.quickAction('numeric', txt)));
  on('sel-explain', conPanel((AiPanel, txt) => AiPanel.quickAction('explain', txt)));
  on('sel-why', conPanel((AiPanel, txt) => AiPanel.quickAction('why', txt)));
}

// ---- Núcleo de la barra ---------------------------------------------------
// Los tres usos de la barra (selección en EPUB, selección en PDF, subrayado ya hecho) se
// diferencian solo en QUIÉN recibe lo editado. Eso es este `editor`: color, nota y —solo
// en el modo edición— borrado. Lo fija cada show*(); hideHighlightTooltip lo vacía.
//   commit({ color, note })  color/note ausentes = "no lo toques"
//   getNote()                lo que ya hay escrito (prellena el campo)
//   remove()                 null si el pasaje aún no es un subrayado
let editor = null;
// Valor de la nota al abrir el campo: si no ha cambiado, cerrar la barra no guarda nada.
let noteBaseline = null;
let outsideTimer = 0;   // arme pendiente del cierre "al pulsar fuera" (ver wireToolbar)

function noteInput() {
  return document.getElementById('sel-note-input');
}

function openNoteBox() {
  const box = document.getElementById('sel-note-box');
  const input = noteInput();
  if (!box || !input) return;
  input.value = editor ? editor.getNote() : '';
  noteBaseline = input.value;
  box.hidden = false;
  input.focus();
}

function closeNoteBox() {
  const box = document.getElementById('sel-note-box');
  if (box) box.hidden = true;
  noteBaseline = null;   // sin línea base no hay nada pendiente de volcar
}

// Vuelca la nota si el campo está abierto Y ha cambiado. Lo llaman tanto el cierre de la
// barra como cualquier acción que guarde antes (elegir color), para no guardar dos veces.
function flushNote() {
  const input = noteInput();
  if (noteBaseline === null || !input) return undefined;
  const value = input.value.trim();
  const changed = value !== noteBaseline.trim();
  noteBaseline = null;
  return changed ? value : undefined;
}

// Ata los botones comunes al `editor` activo. `getText` es una función: en PDF el texto
// cambia mientras se arrastran las asas de selección (ver setupPdfSelection).
function wireToolbar(ed, getText) {
  editor = ed;
  const tooltip = document.getElementById('highlight-tooltip');

  tooltip.querySelectorAll('.highlight-color').forEach(btn => {
    // En modo edición, el color que ya tiene el subrayado va marcado.
    btn.classList.toggle('is-current', !!ed.color && btn.dataset.color === ed.color);
    btn.onclick = () => {
      ed.commit({ color: btn.dataset.color, note: flushNote() });
      hideHighlightTooltip();
    };
  });

  const noteBtn = document.getElementById('sel-note');
  noteBtn.onclick = () => {
    const box = document.getElementById('sel-note-box');
    if (box.hidden) openNoteBox();
    else { ed.commit({ note: flushNote() }); closeNoteBox(); }
  };

  const delBtn = document.getElementById('sel-delete');
  delBtn.hidden = !ed.remove;
  delBtn.onclick = () => {
    noteBaseline = null;        // se borra el subrayado: la nota a medias ya no aplica
    ed.remove();
    hideHighlightTooltip();
  };

  wireAgentActions(getText);

  document.getElementById('sel-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(getText()); } catch (e) { /* sin clipboard */ }
    hideHighlightTooltip();
  };

  document.getElementById('sel-share').onclick = () => {
    const txt = getText();
    hideHighlightTooltip();
    shareHighlight(txt);
  };

  // Cerrar al hacer clic fuera. El retardo evita que el propio clic que abre la barra
  // (o el que suelta la selección) la cierre en el mismo tick. El temporizador se GUARDA:
  // si la barra se cierra antes de que dispare, armar el listener después dejaba un cierre
  // huérfano que se comía el siguiente clic —elegir color y tocar enseguida el subrayado
  // recién hecho abría la barra y la cerraba en el acto—.
  clearTimeout(outsideTimer);
  outsideTimer = setTimeout(() => {
    document.addEventListener('click', hideHighlightTooltipOnOutside);
  }, 100);
}

function showHighlightTooltip(cfiRange, text, rect) {
  const tooltip = document.getElementById('highlight-tooltip');

  // Ya hemos borrado la selección nativa (finalizeSelection), así que no hay
  // menús del SO con los que chocar: colocamos la barra junto a la selección.
  positionTooltip(tooltip, rect);

  wireToolbar({
    getNote: () => '',
    // Escribir una nota sin elegir color subraya igual: la nota vive EN un subrayado.
    commit: ({ color, note }) => {
      removeTempSelection();   // quitar el temporal antes de pintar el definitivo
      const c = color || DEFAULT_COLOR;
      Highlights.add(cfiRange, text, c, EpubReader.getCurrentChapterLabel(), note || '');
      applyHighlightToRendition(cfiRange, c);
      renderHighlights();
    },
    remove: null,
  }, () => text);
}

export function hideHighlightTooltip() {
  // Guardar lo escrito ANTES de soltar el editor: cerrar la barra es el gesto de guardar.
  const pending = flushNote();
  if (pending !== undefined && editor) editor.commit({ note: pending });
  editor = null;
  closeNoteBox();
  document.getElementById('highlight-tooltip').style.display = 'none';
  clearTimeout(outsideTimer);
  document.removeEventListener('click', hideHighlightTooltipOnOutside);
  removeTempSelection();
  try { EpubReader.clearSelection(); } catch (e) {}   // overlay táctil, si lo hay
  try { lastSelWin && lastSelWin.getSelection().removeAllRanges(); } catch (e) {}  // selección nativa (escritorio)
  try { window.getSelection().removeAllRanges(); } catch (e) {}  // selección nativa del PDF (documento padre)
  lastSelWin = null;
  pdfPending = null;   // cerrada la barra, la captura viva deja de valer
}

// PDF2/PDF3 · Selección en PDF. La capa de texto del PDF ya es seleccionable (vive en el
// documento padre, sin iframe). Al soltar la selección mostramos la barra: subrayar (con
// ancla {página, rects}), nota, preguntar al agente y copiar.
export function setupPdfSelection() {
  const container = document.getElementById('pdf-container');
  if (!container || container.dataset.selWired) return;
  container.dataset.selWired = '1';   // no re-atar en cada render/página

  const onSelectEnd = () => setTimeout(() => {
    const cap = capturePdfSelection();
    if (!cap) return;
    pdfPending = cap;
    showPdfSelectionTooltip(cap);
  }, 0);

  container.addEventListener('mouseup', onSelectEnd);
  container.addEventListener('touchend', onSelectEnd);

  // Pulsar un subrayado ya hecho abre la barra en modo edición. La capa de subrayados no
  // captura eventos a propósito (la de texto, encima, debe seguir siendo seleccionable),
  // así que en vez de escuchar en el rectángulo se comprueba dónde ha caído el clic contra
  // los rects guardados de esa página. Si hay selección viva, es un gesto de seleccionar.
  container.addEventListener('click', (e) => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const hit = pdfHighlightAt(e.clientX, e.clientY);
    if (!hit) return;
    openHighlightEditor(hit.id ?? hit.cfi, hit.rect);
  });

  // EL BUG DEL MÓVIL: al mantener pulsado, el navegador selecciona UNA PALABRA y ahí llega el
  // `touchend` → capturábamos esa palabra. Después el usuario arrastra las ASAS para extender
  // la selección, pero ese gesto se lo queda el navegador y NO emite más eventos táctiles a la
  // página: al tocar el color se guardaba la palabra del principio y no lo que se veía
  // marcado. De ahí el subrayado "descuadrado" (medido: 82px guardados frente a 322 visibles).
  //
  // `selectionchange` sí se dispara mientras se arrastran las asas, así que la captura se
  // mantiene VIVA mientras la barra está abierta. Se ignoran los colapsos —tocar la barra
  // colapsa la selección en algunos navegadores— para no perder lo último bueno.
  //
  // DOS RITMOS DISTINTOS a propósito: el DATO se actualiza en cada evento (es la corrección:
  // lo que se guarde debe ser lo último marcado), pero la BARRA solo se recoloca cuando la
  // selección se queda quieta. Moviéndola en cada micro-ajuste, perseguiría al dedo justo
  // mientras se arrastra el asa — que es la parte incómoda de seleccionar en un móvil.
  let repositionTimer = 0;
  document.addEventListener('selectionchange', () => {
    if (!pdfPending || !isTooltipVisible()) return;
    const cap = capturePdfSelection();
    if (!cap) return;
    pdfPending = cap;
    clearTimeout(repositionTimer);
    repositionTimer = setTimeout(() => {
      if (pdfPending && isTooltipVisible()) {
        positionTooltip(document.getElementById('highlight-tooltip'), pdfPending.rect);
      }
    }, SELECTION_SETTLE_MS);
  });
}

// Quietud que se exige a la selección antes de mover la barra (arrastrando un asa llegan
// decenas de eventos por segundo).
const SELECTION_SETTLE_MS = 250;

// ¿Hay un subrayado del PDF bajo este punto de pantalla? Devuelve el subrayado con el
// `rect` (coords de pantalla) donde colocar la barra. Lo usa también app.js: el toque
// central que alterna las barras debe ignorar el que cae sobre un subrayado.
export function pdfHighlightAt(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  const wrapper = el && el.closest ? el.closest('#pdf-container .pdf-page') : null;
  if (!wrapper) return null;
  const wr = wrapper.getBoundingClientRect();
  if (!wr.width || !wr.height) return null;
  const x = (clientX - wr.left) / wr.width;
  const y = (clientY - wr.top) / wr.height;
  const page = +wrapper.dataset.page || PdfReader.getCurrentPage();
  for (const hl of Highlights.getByPage(page)) {
    const r = (hl.rects || []).find(r =>
      x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height);
    if (!r) continue;
    return {
      ...hl,
      rect: { left: wr.left + r.left * wr.width, top: wr.top + r.top * wr.height,
              width: r.width * wr.width, height: r.height * wr.height },
    };
  }
  return null;
}

function isTooltipVisible() {
  const tt = document.getElementById('highlight-tooltip');
  return !!tt && tt.style.display !== 'none';
}

// Foto de la selección actual del PDF: texto, rects fraccionales y página. `null` si no hay
// selección utilizable (colapsada, muy corta o fuera de la capa de texto).
function capturePdfSelection() {
  const sel = window.getSelection();
  const text = sel && !sel.isCollapsed ? dehyphenate(sel.toString().replace(/\s+/g, ' ').trim()) : '';
  if (!text || text.length < 2) return null;
  const node = sel.anchorNode;
  const host = node && (node.nodeType === 1 ? node : node.parentElement);
  if (!host || !host.closest('#pdf-container .textLayer')) return null;
  // La página del subrayado es la del wrapper que contiene la selección (clave en modo
  // scroll, donde hay varias páginas montadas a la vez).
  const wrapper = host.closest('#pdf-container .pdf-page');
  const page = wrapper ? (+wrapper.dataset.page || PdfReader.getCurrentPage()) : PdfReader.getCurrentPage();
  // Sin rango utilizable no hay captura: antes se seguía adelante con rects vacíos y el
  // subrayado se guardaba sin geometría (invisible al repintar).
  let range;
  try { range = sel.getRangeAt(0); } catch (e) { return null; }
  return { text, rect: range.getBoundingClientRect(), rects: pdfFractionalRects(range, wrapper), page };
}

// Rectángulos de la selección en coordenadas FRACCIONALES (0..1) de la página del PDF, para
// re-pintarlos nítidos a cualquier escala/HiDPI (el canvas se re-renderiza al cambiar zoom).
export function pdfFractionalRects(range, wrapper) {
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

// Los manejadores leen `pdfPending` EN EL MOMENTO DE LA ACCIÓN, no lo que hubiera al abrir la
// barra: entre una cosa y otra el usuario ha podido mover las asas de selección (ver el bug
// descrito en setupPdfSelection).
function showPdfSelectionTooltip(cap) {
  const tooltip = document.getElementById('highlight-tooltip');
  positionTooltip(tooltip, cap.rect);
  pdfPending = cap;
  const current = () => pdfPending || cap;

  // El PDF no tiene clave natural: addPdf SIEMPRE inserta. Si la misma barra guarda dos
  // veces (nota y después color), la segunda edita el que creó la primera en vez de
  // duplicar el pasaje.
  let createdId = null;
  wireToolbar({
    getNote: () => (createdId ? (Highlights.getById(createdId)?.note || '') : ''),
    commit: ({ color, note }) => {
      const { page, rects, text } = current();
      if (createdId) Highlights.update(createdId, { color, note });
      else createdId = Highlights.addPdf(page, rects, text, color || DEFAULT_COLOR, t('Pág. {n}', { n: page }), note || '');
      drawPdfHighlights(page);
      renderHighlights();
    },
    remove: null,
  }, () => current().text);
}

// ---- Modo edición: la barra sobre un subrayado que YA existe ---------------
// Mismo componente que al seleccionar (colores, nota, copiar, compartir, agente) más
// Eliminar, y con el color actual marcado. Antes pulsar un subrayado no hacía nada: para
// cambiar color, editar la nota o borrarlo había que ir a la pestaña Subrayados.
function openHighlightEditor(id, rect) {
  const hl = Highlights.getById(id);
  if (!hl) return;
  const tooltip = document.getElementById('highlight-tooltip');
  positionTooltip(tooltip, rect);
  wireToolbar({
    color: hl.color,
    getNote: () => Highlights.getById(id)?.note || '',
    commit: ({ color, note }) => {
      Highlights.update(id, { color, note });
      repaintOne(Highlights.getById(id) || hl);
      renderHighlights();
    },
    remove: () => deleteWithUndo(hl),
  }, () => hl.text);
}

// Borrar es reversible: un aviso con Deshacer cuesta un clic menos que confirmar cada vez
// y salva el borrado accidental, que es el caso que duele. El tombstone conserva los
// campos, así que deshacer devuelve el subrayado entero (ver Highlights.restoreById).
function deleteWithUndo(hl) {
  const id = hl.id ?? hl.cfi;
  Highlights.removeById(id);
  repaintOne(hl);
  renderHighlights();
  toast({
    message: t('Subrayado eliminado'),
    actionLabel: t('Deshacer'),
    timeout: 6000,
    onAction: () => {
      Highlights.restoreById(id);
      repaintOne(hl);
      renderHighlights();
    },
  });
}

// Re-sincroniza UN subrayado con lo que dice el store: sirve para el color nuevo, para el
// borrado y para deshacerlo. En EPUB hay que quitar la anotación y volver a ponerla (epub.js
// no re-tiñe una ya pintada); en PDF basta con redibujar la capa de la página.
function repaintOne(hl) {
  if (hl.page != null) { drawPdfHighlights(hl.page); return; }
  const rendition = EpubReader.getRendition();
  if (!rendition) return;
  try { rendition.annotations.remove(hl.cfi, 'highlight'); } catch (e) { /* no estaba pintada */ }
  const live = Highlights.getById(hl.cfi);
  if (live) applyHighlightToRendition(live.cfi, live.color);
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
  if (tooltip.style.display === 'none') return;   // ya cerrada: este clic no es suyo
  if (!tooltip.contains(e.target)) {
    hideHighlightTooltip();
  }
}

function applyHighlightToRendition(cfiRange, color) {
  const rendition = EpubReader.getRendition();
  if (!rendition) return;

  // Pulsar el resaltado abre la barra en modo edición. El pane de anotaciones de epub.js
  // vive en el documento PADRE (no dentro del iframe), así que el rect del elemento ya
  // está en coordenadas de pantalla y el clic llega a `document` — de ahí que el cierre
  // "al pulsar fuera" se ate con retardo.
  rendition.annotations.highlight(cfiRange, {}, (e) => {
    const el = e && e.target;
    const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    openHighlightEditor(cfiRange, r && r.height ? r : null);
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

// Repintado tras un merge remoto, con anotaciones YA pintadas: primero quita
// cada una (incluidos los tombstones recién llegados, que deben desaparecer) y
// vuelve a poner solo las vivas — applyStoredHighlights a secas las apilaría.
// Las capas de PDF se redibujan enteras desde el store (drawPdfHighlights ya
// limpia la capa antes de pintar).
export function repaintStoredHighlights() {
  const rendition = EpubReader.getRendition();
  if (rendition) {
    for (const hl of Highlights.getAllRaw()) {
      if (hl && hl.cfi) { try { rendition.annotations.remove(hl.cfi, 'highlight'); } catch (e) { /* no estaba pintada */ } }
    }
    for (const hl of Highlights.getAll()) {
      if (hl && hl.cfi) applyHighlightToRendition(hl.cfi, hl.color);
    }
  }
  document.querySelectorAll('#pdf-container .pdf-page[data-page]').forEach(w => {
    drawPdfHighlights(Number(w.dataset.page));
  });
}

export function renderHighlights() {
  const list = document.getElementById('highlights-list');
  const highlights = Highlights.getAll();
  const exportBtn = document.getElementById('export-highlights-btn');

  if (exportBtn) exportBtn.disabled = highlights.length === 0;

  if (highlights.length === 0) {
    list.innerHTML = `<p class="empty-state">${t('No hay subrayados aún')}</p>`;
    return;
  }

  list.innerHTML = '';
  highlights.sort((a, b) => b.timestamp - a.timestamp).forEach(hl => {
    const item = document.createElement('div');
    item.className = 'highlight-item';
    item.style.setProperty('--hl-color', hl.color);   // tiñe la ficha (ver .highlight-item)
    item.innerHTML = `
      <div class="highlight-text">"${escapeHtml(dehyphenate(hl.text))}"</div>
      ${hl.note ? `<div class="highlight-note">${icon('note', { size: 13 })}<span>${escapeHtml(hl.note)}</span></div>` : ''}
      <div class="highlight-meta">
        ${hl.chapter ? `<span>${escapeHtml(hl.chapter)}</span>` : ''}
        ${hl.timestamp ? `<span class="highlight-when" title="${escapeHtml(fullWhen(hl.timestamp))}">${escapeHtml(whenLabel(hl.timestamp))}</span>` : ''}
        <button class="highlight-share" title="Compartir">${icon('share', { size: 15 })}</button>
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

    item.querySelector('.highlight-share').addEventListener('click', (e) => {
      e.stopPropagation();
      shareHighlight(hl.text);
    });

    // Mismo borrado reversible que en el lector: quita el resaltado de la página, refresca
    // la lista (y el botón de exportar) y ofrece Deshacer.
    item.querySelector('.highlight-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteWithUndo(hl);
    });

    list.appendChild(item);
  });
}
