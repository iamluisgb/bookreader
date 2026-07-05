// Panel del agente: onboarding (objetivo + plantilla), chat en streaming con citas
// [[aN]] clicables, y libreta estructurada que el agente rellena vía tool-use.
// E1/E2/E3/E5/E6 del backlog. Estado persistido en IndexedDB (E4).
import * as LLM from './llm.js';
import { segmentBook } from './segment.js';
import { segmentPdf } from './segment-pdf.js';
import * as DB from './db.js';
import * as EpubReader from '../epub-reader.js';
import * as PdfReader from '../pdf-reader.js';
import { getTemplate, objectiveTemplates, isValidField, isAgentFillable, agentFields, isCognitionField, ARTESANO_ID, INMERSIVA_ID } from './templates.js';
import { icon } from '../ui/icons.js';
import { escapeHtml } from '../ui/escape.js';
import { confirmBox, promptBox } from '../ui/dialog.js';
import * as AppSettings from '../ui/app-settings.js';
import { renderWithCitations } from './render.js';
import { computeChapterRelevance, applyChapterAttenuation, clearChapterAttenuation } from './attenuation.js';
import { estimateTokens } from './context.js';
import * as Retrieval from './retrieval.js';
import { TEMPLATE, systemPrompt } from './panel-template.js';
import * as Profiles from './profiles.js';
import * as Backup from '../backup.js';

// Icon + label markup for the small inline action buttons.
const act = (name, text, size = 15) => `${icon(name, { size })}<span>${text}</span>`;

// Contexto/historial al LLM (ver DECISIONS.md · ADR-007, ADR-010):
const CTX_BUDGET = 60000;          // tope de tokens de libro por turno normal (lean, barato)
const CTX_BUDGET_CHAPTER = 110000; // techo cuando el usuario NOMBRA un capítulo (que quepa entero)
const HISTORY_MSGS = 6;            // mensajes de historial verbatim que se reenvían (ventana)
const TOKEN_GUARD = 180000;        // por encima de esto, avisar antes de enviar (caso patológico)

let els = {};
let book = null, bookId = null, bookTitle = '';
let convo = null;            // conversación activa { id, bookId, templateId, goal, title }
let template = null;
let annotatedText = '', anchors = new Map();
let bookFormat = 'epub';     // 'epub' | 'pdf' — decide segmentador y tipo de locator de citas
let tocLabels = [];          // etiquetas de capítulo del libro (TOC epub / outline pdf)
let history = [];            // {role, content}
let notes = [];              // {id, fieldKey, content, sourceCfis}
let editingId = null;        // nota en edición
let addingField = null;      // campo donde se añade una nota nueva
let attenuationDone = false;  // atenuación de capítulos aplicada para este libro
let registeredRendition = null; // rendition con el listener de subrayado registrado
let hqaBusy = false;          // generación HQ&A en curso
let busy = false, abortCtrl = null;
let onCite = () => {};
let segReady = false, segBlocks = 0, segCached = false;
let pendingRef = null;             // pasaje seleccionado adjunto a la próxima pregunta
let pendingImage = null;           // { dataUrl, page } captura adjunta (botón "Ver") para visión
let pendingQuoteOnActivate = null; // cola: pasaje a adjuntar tras crear/activar convo
// IA2 · Repaso al terminar capítulo ("Pepito Grillo"). Ver DECISIONS.md · ADR-013.
let ia2LastChapter = null;
let ia2Seen = new Set();

export function init(opts) {
  onCite = opts.onCite || (() => {});
  els.panel = document.getElementById('ai-panel');
  els.panel.innerHTML = TEMPLATE;
  const $ = (s) => els.panel.querySelector(s);
  Object.assign(els, {
    status: $('#ai-status'), tabs: $('#ai-tabs'),
    chatView: $('#ai-view-chat'), noteView: $('#ai-view-notebook'),
    messages: $('#ai-messages'), input: $('#ai-input'), send: $('#ai-send'), see: $('#ai-see'), close: $('#ai-close'),
    convobar: $('#ai-convobar'), convoBtn: $('#ai-convo-btn'), convoLabel: $('#ai-convo-label'), convoNew: $('#ai-convo-new'), convoExport: $('#ai-convo-export'),
    ref: $('#ai-ref'), refText: $('#ai-ref-text'), profileChip: $('#ai-profile-chip'),
    imgref: $('#ai-imgref'), imgrefText: $('#ai-imgref-text'),
  });
  $('#ai-ref-clear').addEventListener('click', clearRef);
  $('#ai-imgref-clear').addEventListener('click', clearImageRef);

  // La config del agente (key/modelo/auto) vive ahora en Ajustes generales.
  $('#ai-edit-cfg').addEventListener('click', () => AppSettings.open('agent'));
  // Al guardarla allí, refrescar el estado del panel (p. ej. tras introducir la key).
  window.addEventListener('appsettings:agent-saved', refreshStatus);
  // Reflejar el perfil activo (chip) cuando se active/edite en Ajustes generales.
  window.addEventListener('appsettings:profile-changed', updateProfileChip);
  // IA2 · Repaso al terminar capítulo (solo con la plantilla HQ&A).
  window.addEventListener('reader:chapter-changed', (e) => onChapterChanged(e.detail?.label));
  updateProfileChip();
  // Abrir Ajustes en la sección Perfiles al tocar el chip.
  els.profileChip.addEventListener('click', () => AppSettings.open('profiles'));
  els.send.addEventListener('click', send);
  els.see.addEventListener('click', explainView);
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  els.close.addEventListener('click', () => setOpen(false));

  els.tabs.addEventListener('click', (e) => {
    const b = e.target.closest('.ai-tab'); if (!b) return;
    showView(b.dataset.view);
  });
  els.messages.addEventListener('click', onMessagesClick);
  els.noteView.addEventListener('click', onNotebookClick);

  // Selector de conversaciones.
  els.convoBtn.addEventListener('click', (e) => { e.stopPropagation(); if (convo) openConvoMenu(els.convoBtn); else openOnboarding(); });
  els.convoNew.addEventListener('click', () => openOnboarding());
  els.convoExport.addEventListener('click', exportConvo);
  document.addEventListener('click', (e) => {
    if (convoMenuEl && !convoMenuEl.contains(e.target) && !e.target.closest('#ai-convo-btn')) closeConvoMenu();
  });

  // Atenuación de capítulos: perezosa, al abrir el índice (el handler de app.js
  // ya alternó la clase 'open' antes de que llegue este listener).
  document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
    if (document.getElementById('sidebar')?.classList.contains('open')) maybeAttenuate();
  });
}

export function setOpen(open) {
  document.body.classList.toggle('ai-open', open);
  if (open) agentUnread = false;          // al abrir se da por leído
  applyAgentBadge();
  if (!open) return;
  if (book && !convo) openOnboarding();   // primer uso del agente con este libro
  else if (convo) focusInput();
}
export function isOpen() { return document.body.classList.contains('ai-open'); }

// En MÓVIL (puntero táctil) NO auto-enfocamos el input: abriría el teclado sin que el
// usuario lo pida. El teclado sale solo cuando toca el campo para escribir.
function focusInput() { if (!EpubReader.isCoarsePointer()) els.input?.focus(); }

// Aviso del agente cuando la respuesta llega con el panel cerrado: un punto en el
// punto de entrada visible (#ai-toggle en escritorio, .ai-fab en móvil). `ai-busy`
// = generando; `ai-unread` = respuesta lista. Solo se pintan con el panel cerrado.
let agentUnread = false;
function applyAgentBadge() {
  const closed = !isOpen();
  document.body.classList.toggle('ai-busy', busy && closed);
  document.body.classList.toggle('ai-unread', agentUnread && closed);
}

// Adjuntar un pasaje seleccionado en el lector como referencia de la próxima
// pregunta (botón "Preguntar al agente" de la barra de selección).
export function quoteSelection(text) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return;
  setOpen(true);
  showView('chat');
  if (!convo) { pendingQuoteOnActivate = clean; return; } // se aplica tras el onboarding
  setRef(clean);
}

// P8 · Exporta la conversación ACTIVA (libreta + chat) a Markdown, con formato preservado y
// citas resueltas a pág./capítulo. A diferencia del volcado global de Ajustes → Datos, es por
// conversación y desde donde se usa (el panel).
async function exportConvo() {
  if (!convo) { setStatus('Abre o crea una conversación para exportarla.'); return; }
  try {
    const md = await Backup.buildConvoMarkdown(convo.id, { includeChat: true, includeNotebook: true });
    const slug = (s) => (s || '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'conversacion';
    const stamp = new Date().toISOString().slice(0, 10);
    Backup.downloadText(`bookreader-${slug(bookTitle)}-${slug(convo.title || convo.goal)}-${stamp}.md`, md);
    setStatus('Conversación exportada (Markdown).');
    setTimeout(refreshStatus, 2500);
  } catch (e) {
    console.error('Export de conversación falló:', e);
    setStatus('No se pudo exportar: ' + e.message);
  }
}

function setRef(text) {
  pendingRef = text;
  if (els.refText) els.refText.textContent = text;
  if (els.ref) els.ref.style.display = 'flex';
  focusInput();
}

function clearRef() {
  pendingRef = null;
  if (els.ref) els.ref.style.display = 'none';
}

function showView(view) {
  els.tabs.querySelectorAll('.ai-tab').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  els.chatView.classList.toggle('active', view === 'chat');
  els.noteView.classList.toggle('active', view === 'notebook');
  if (view === 'notebook') els.tabs.querySelector('.ai-tab[data-view="notebook"]')?.classList.remove('ai-tab-unread');
}

// ---- Carga de libro --------------------------------------------------------

let bookSeq = 0;   // nº de secuencia de apertura: si otra apertura lo adelanta, esta se cancela
export async function setBook(b, id, title, opts = {}) {
  const mySeq = ++bookSeq;
  // Aborta cualquier turno del agente en vuelo del libro anterior: su respuesta ya no
  // aplica al libro que abrimos. El guard `bookSeq` (abajo) evita además que persista.
  try { abortCtrl?.abort(); } catch (e) { /* sin petición en curso */ }
  busy = false;
  book = b; bookId = id || null; bookTitle = title || 'Libro';
  bookFormat = opts.format || 'epub'; tocLabels = [];
  // "Explicar lo que veo" (visión) solo tiene sentido en PDF (renderizamos su canvas).
  if (els.see) els.see.style.display = bookFormat === 'pdf' ? '' : 'none';
  clearImageRef();
  convo = null; template = null; history = []; notes = [];
  ia2LastChapter = null; ia2Seen = new Set();   // IA2: reinicia el repaso por libro
  editingId = null; addingField = null; attenuationDone = false;
  clearChapterAttenuation();
  annotatedText = ''; anchors = new Map();
  segReady = false; segBlocks = 0; segCached = false;
  els.messages.innerHTML = '';
  els.tabs.style.display = 'none';
  if (els.convobar) els.convobar.style.display = 'none';
  showView('chat');
  if (!book) { setStatus('Abre un EPUB para empezar.'); return; }

  // Migrar conversación antigua (si la hay) y activar la más reciente. Si no hay
  // ninguna, el onboarding se mostrará al abrir el panel (no aquí, para no tapar
  // el lector con un modal en cada carga).
  if (bookId) await DB.migrateBook(bookId);
  if (mySeq !== bookSeq) return;       // otra apertura nos adelantó → abortar
  const convos = bookId ? await DB.getConvos(bookId) : [];
  if (mySeq !== bookSeq) return;
  if (convos.length) {
    convo = convos[0];                 // getConvos viene ordenado por lastUsedAt desc
    template = getTemplate(convo.templateId);
    await activateConvo();
    if (mySeq !== bookSeq) return;
  }

  // Segmentar (o cargar de cache) en segundo plano.
  prepareBook();

  // Escuchar subrayados del lector (para el rol HQ&A).
  registerReaderSelection();
}

// ---- HQ&A al subrayar (E5.2) -----------------------------------------------
// Solo con la plantilla HQ&A: subrayar en el lector genera Pregunta + borrador
// de Respuesta y lo guarda en la libreta, con enlace al pasaje subrayado.

function registerReaderSelection() {
  try {
    const r = EpubReader.getRendition?.();
    if (!r || r === registeredRendition) return;
    registeredRendition = r;
    r.on('selected', onReaderSelection);
  } catch { /* lector no listo */ }
}

async function onReaderSelection(cfiRange, contents) {
  if (hqaBusy || !convo || template?.id !== 'hqa') return;
  let text = '';
  try { text = (contents?.window?.getSelection()?.toString() || '').trim(); } catch { /* sin acceso */ }
  if (text.length < 8) return;
  await generateHQA(text, cfiRange);
}

async function generateHQA(text, cfiRange) {
  hqaBusy = true;
  setStatus('Generando la pregunta del subrayado…');
  try {
    // INFO/COGNICIÓN: la IA genera el Highlight y la Question (recuperación), pero NO la
    // Answer: responderla con tus palabras es lo que fija el aprendizaje (efecto de
    // generación). Guardamos la R vacía para que la escribas tú (editando la nota); luego
    // puedes pedir al agente en el chat que la revise.
    const messages = [
      { role: 'system', content:
`Aplicas el método HQ&A (Highlight–Question–Answer). Dado un FRAGMENTO subrayado y el OBJETIVO
del usuario, genera SOLO una PREGUNTA conceptual que ese fragmento responde, alineada al objetivo.
NO escribas la respuesta: la respuesta la redacta el usuario con sus propias palabras.
Responde EXACTAMENTE en una línea, sin nada más:
P: <pregunta>` },
      { role: 'user', content: `OBJETIVO: ${convo.goal}\n\nFRAGMENTO SUBRAYADO:\n"${text}"` },
    ];
    const out = await LLM.chatStream({ messages });
    const q = (out.match(/P:\s*(.+)/i)?.[1] || '').trim();
    const content = `> ${text}\n\n**P:** ${q || '—'}\n**R:** _(escribe tu respuesta)_`;
    const id = convo ? await DB.addNote(convo.id, 'hqa', content, [cfiRange]) : Date.now();
    notes.push({ id, fieldKey: 'hqa', content, sourceCfis: [cfiRange] });
    renderNotebook();
    markNotebookUnread();
    setStatus('Pregunta añadida — escribe tu respuesta en la libreta');
  } catch (e) {
    console.error('HQ&A falló:', e);
    setStatus('No se pudo generar HQ&A: ' + e.message);
  } finally {
    hqaBusy = false;
    setTimeout(refreshStatus, 2500);
  }
}

async function prepareBook() {
  // Capturamos el libro para el que preparamos. La segmentación es asíncrona (y lenta si
  // no está cacheada), así que el usuario puede cambiar de libro por el medio. Sin este
  // guard, una segmentación tardía del libro ANTERIOR sobrescribía annotatedText/anchors
  // del libro ACTUAL → el agente respondía de otro libro. (Bug real; agravado al forzar
  // re-segmentación con el bump de segVersion.)
  const myBookId = bookId, myBook = book, myFormat = bookFormat, myTitle = bookTitle;
  const stale = () => myBookId !== bookId || myBook !== book;   // ¿cambió el libro?
  try {
    let seg = myBookId ? await DB.loadSegmented(myBookId) : null;
    if (seg) {
      if (stale()) return;
      segCached = true;
    } else {
      const unit = myFormat === 'pdf' ? 'páginas' : 'secciones';
      if (!stale()) setStatus('Leyendo el libro…');
      const segmenter = myFormat === 'pdf' ? segmentPdf : segmentBook;
      seg = await segmenter(myBook, (d, t) => { if (!stale()) setStatus(`Leyendo el libro… ${d}/${t} ${unit}`); });
      if (myBookId) await DB.saveSegmented(myBookId, myTitle, seg);
      if (stale()) return;         // el usuario cambió de libro mientras segmentábamos → descartar
      segCached = false;
    }
    if (stale()) return;
    annotatedText = seg.annotatedText;
    anchors = seg.anchors;

    // Etiquetas de capítulo: en PDF salen del outline (segmenter) o, si la caché no las
    // trae, se derivan de los capítulos ya atribuidos a las anclas (en PDF cada `##` es un
    // capítulo real). En EPUB salen del TOC del propio libro.
    if (myFormat === 'pdf') {
      tocLabels = (seg.tocLabels && seg.tocLabels.length)
        ? seg.tocLabels
        : [...new Set([...anchors.values()].map(a => a.chapter).filter(Boolean))];
    } else {
      tocLabels = (myBook?.navigation?.toc || []).map(t => t.label.trim()).filter(Boolean);
    }

    // PDF escaneado (sin texto seleccionable): el agente no puede leerlo. No dejamos
    // segReady para que el chat no pretenda tener el contenido del libro.
    if (myFormat === 'pdf' && (seg.scanned || seg.blockCount === 0 || !annotatedText)) {
      segReady = false; segBlocks = 0;
      setStatus('Este PDF no tiene texto seleccionable (parece escaneado); el agente no puede leer su contenido.');
      return;
    }

    segReady = true; segBlocks = seg.blockCount;
    refreshStatus();
    if (document.getElementById('sidebar')?.classList.contains('open')) maybeAttenuate();
  } catch (e) {
    console.error('Preparación del agente falló:', e);
    if (!stale()) setStatus('No se pudo preparar el libro: ' + e.message);
  }
}

// Status combinado: estado de segmentación + plantilla activa. Evita que el
// onboarding pise el "Listo" o viceversa según el orden en que terminen.
function refreshStatus() {
  if (!book) { setStatus('Abre un EPUB para empezar.'); return; }
  if (!segReady) { setStatus(template ? `Plantilla: ${template.name} · leyendo…` : 'Leyendo el libro…'); return; }
  const base = `${segCached ? 'Listo (cacheado)' : 'Listo'} · ${segBlocks} pasajes`;
  setStatus(template ? `${base} · ${template.name}` : base);
  renderConvoBar();
}

// Chip del perfil de agente activo (P1): muestra su nombre y abre Ajustes → Perfiles.
// Oculto si no hay perfil activo.
function updateProfileChip() {
  if (!els.profileChip) return;
  const p = Profiles.getActive();
  if (p) {
    els.profileChip.innerHTML = `${icon('user', { size: 13 })}<span>${escapeHtml(p.name)}</span>`;
    els.profileChip.style.display = 'flex';
  } else {
    els.profileChip.style.display = 'none';
  }
}

async function activateConvo() {
  els.tabs.style.display = 'flex';
  renderConvoBar();
  clearRef();
  notes = convo ? await DB.getNotes(convo.id) : [];
  renderNotebook();
  await restoreChat();
  refreshStatus();
  if (pendingQuoteOnActivate) { setRef(pendingQuoteOnActivate); pendingQuoteOnActivate = null; }
}

// Cambiar a otra conversación del mismo libro.
async function switchConvo(id) {
  if (convo && convo.id === id) return;
  const c = await DB.getConvo(id);
  if (!c) return;
  convo = c; template = getTemplate(c.templateId);
  history = [];
  attenuationDone = false; clearChapterAttenuation();
  await DB.touchConvo(id);
  await activateConvo();
  showView('chat');
}

// Barra con la conversación activa + selector + nueva. Si no hay conversación
// pero sí libro, muestra una entrada para elegir objetivo (reabrir onboarding).
function renderConvoBar() {
  if (!els.convobar) return;
  if (!book) { els.convobar.style.display = 'none'; return; }
  els.convobar.style.display = 'flex';
  els.convobar.classList.toggle('no-convo', !convo);
  els.convoNew.style.display = convo ? '' : 'none';
  els.convoLabel.textContent = convo
    ? (convo.title || template?.name || 'Conversación')
    : 'Elegir objetivo de lectura';
}

async function openConvoMenu(anchor) {
  closeConvoMenu();
  const convos = bookId ? await DB.getConvos(bookId) : [];
  const menu = document.createElement('div');
  menu.className = 'ai-convo-menu lib-menu';
  menu.innerHTML = `
    ${convos.map(c => {
      const t = getTemplate(c.templateId);
      const active = convo && c.id === convo.id;
      return `<button class="lib-menu-item ai-convo-item" data-id="${c.id}">
        <span class="lib-menu-check">${active ? icon('check', { size: 16 }) : ''}</span>
        <span class="ai-convo-item-text"><span class="ai-convo-item-name">${escapeHtml(c.title || t?.name || 'Conversación')}</span><span class="ai-convo-item-goal">${escapeHtml(c.goal || '')}</span></span>
        <span class="ai-convo-rename" data-rename="${c.id}" title="Renombrar">${icon('pencil', { size: 15 })}</span>
        <span class="ai-convo-del" data-del="${c.id}" title="Eliminar">${icon('trash', { size: 15 })}</span>
      </button>`;
    }).join('')}
    <div class="lib-menu-sep"></div>
    <button class="lib-menu-item" data-act="new">${icon('plus', { size: 16 })}<span>Nueva conversación…</span></button>
  `;
  document.body.appendChild(menu);
  convoMenuEl = menu;
  const r = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.display = 'block';
  menu.style.left = Math.max(8, r.left) + 'px';
  menu.style.top = (r.bottom + 6) + 'px';
  menu.style.minWidth = Math.max(240, r.width) + 'px';

  menu.addEventListener('click', async (ev) => {
    const ren = ev.target.closest('.ai-convo-rename');
    if (ren) {
      ev.stopPropagation();
      const id = ren.dataset.rename;
      const c = convos.find(x => x.id === id);
      const cur = c?.title || getTemplate(c?.templateId)?.name || '';
      const name = (await promptBox('Nombre de la conversación:', { title: 'Renombrar conversación', value: cur }) || '').trim();
      closeConvoMenu();
      if (name) {
        await DB.updateConvo(id, { title: name });
        if (convo && convo.id === id) convo.title = name;
        renderConvoBar();
      }
      return;
    }
    const del = ev.target.closest('.ai-convo-del');
    if (del) {
      ev.stopPropagation();
      const id = del.dataset.del;
      const c = convos.find(x => x.id === id);
      if (await confirmBox(`¿Eliminar la conversación "${getTemplate(c?.templateId)?.name || ''}"? Se borran su chat y su libreta.`,
          { title: 'Eliminar conversación', okText: 'Eliminar', danger: true })) {
        await DB.deleteConvo(id);
        closeConvoMenu();
        const rest = await DB.getConvos(bookId);
        if (convo && convo.id === id) {
          if (rest.length) await switchConvo(rest[0].id);
          else { convo = null; template = null; notes = []; history = []; els.messages.innerHTML = ''; renderNotebook(); els.tabs.style.display = 'none'; els.convobar.style.display = 'none'; openOnboarding(); }
        } else { renderConvoBar(); }
      }
      return;
    }
    const item = ev.target.closest('.ai-convo-item');
    if (item) { closeConvoMenu(); await switchConvo(item.dataset.id); return; }
    if (ev.target.closest('[data-act="new"]')) { closeConvoMenu(); openOnboarding(); return; }
  });
}

let convoMenuEl = null;
function closeConvoMenu() { if (convoMenuEl) { convoMenuEl.remove(); convoMenuEl = null; } }

// ---- Atenuación de capítulos en el índice (E6.4) ---------------------------
// Puntúa cada capítulo del TOC por relevancia al objetivo y atenúa los flojos.
// Decora el #toc-list que renderiza app.js (sin tocar su código), emparejando
// por etiqueta. Resultados cacheados por libro+objetivo.

async function maybeAttenuate() {
  if (attenuationDone || !convo || !template || !segReady || !book) return;
  if (!LLM.hasKey()) return;
  const toc = book.navigation?.toc;
  if (!toc || !toc.length) return;
  attenuationDone = true;

  try {
    let cached = convo ? await DB.getRatings(convo.id) : null;
    let scores = (cached && cached.goal === convo.goal) ? cached.scores : null;
    if (!scores) {
      scores = await computeChapterRelevance(toc, annotatedText, convo.goal);
      if (scores && convo) await DB.saveRatings(convo.id, convo.goal, scores);
    }
    if (scores) applyChapterAttenuation(scores);
  } catch (e) {
    console.warn('Atenuación de capítulos falló:', e);
    attenuationDone = false; // permitir reintento en otra carga
  }
}

async function restoreChat() {
  els.messages.innerHTML = '';
  const msgs = convo ? await DB.getMessages(convo.id) : [];
  for (const m of msgs) {
    history.push({ role: m.role, content: m.content });
    appendBubble(m.role, m.content, m.role === 'assistant');
  }
  scrollDown();
}

// ---- Onboarding ------------------------------------------------------------

function openOnboarding() {
  let overlay = document.getElementById('ai-onboarding');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'ai-onboarding';
  overlay.className = 'ai-onboarding';
  overlay.innerHTML = `
    <div class="ai-ob-card" role="dialog" aria-modal="true" aria-label="Elegir objetivo de lectura">
      <button class="ai-ob-close" title="Cerrar" aria-label="Cerrar">${icon('xmark', { size: 18 })}</button>
      <div class="ai-ob-body"></div>
    </div>`;
  document.body.appendChild(overlay);
  const body = overlay.querySelector('.ai-ob-body');
  const card = overlay.querySelector('.ai-ob-card');
  const prevFocus = document.activeElement;   // para restaurar el foco al cerrar

  const dismiss = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    try { prevFocus?.focus?.(); } catch (e) { /* elemento ya no existe */ }
  };
  // Escape cierra; Tab queda ATRAPADO dentro de la tarjeta (diálogo modal accesible).
  const onKey = (e) => {
    if (e.key === 'Escape') { dismiss(); return; }
    if (e.key !== 'Tab') return;
    const focusables = card.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    const visible = [...focusables].filter(el => el.offsetParent !== null || el === document.activeElement);
    if (!visible.length) return;
    const first = visible[0], last = visible[visible.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) dismiss(); }); // clic fuera de la tarjeta
  overlay.querySelector('.ai-ob-close').addEventListener('click', dismiss);

  let chosenTemplate = null;

  // Una sola pregunta: elige el OBJETIVO. Las 5 plantillas por objetivo + las propias.
  const renderObjectives = () => {
    const list = objectiveTemplates();
    body.innerHTML = `
      <h2>¿Qué quieres conseguir con este libro?</h2>
      <p class="ai-ob-sub">Elige un objetivo de lectura.</p>
      <div class="ai-ob-templates">
        ${list.map(t => `
          <button class="ai-ob-tpl" data-tpl="${t.id}">
            <span class="ai-ob-tpl-name">${t.objective || t.name}</span>
            <span class="ai-ob-tpl-ideal">${t.name}${t.ideal ? ' · ' + t.ideal : ''}</span>
          </button>`).join('')}
      </div>`;
    body.querySelectorAll('.ai-ob-tpl').forEach(btn =>
      btn.addEventListener('click', () => { chosenTemplate = getTemplate(btn.dataset.tpl); renderGoal(); }));
  };

  const renderGoal = () => {
    // Opt-in Artesano: solo en la Lectura Inmersiva (leer ficción como escritor).
    const artesanoOptIn = chosenTemplate.id === INMERSIVA_ID
      ? `<label class="ai-ob-check"><input type="checkbox" id="ai-ob-artesano" /> Leo para aprender a escribir (modo Artesano)</label>`
      : '';
    body.innerHTML = `
      <button class="ai-ob-back">${icon('chevron-left', { size: 16 })}<span>Volver</span></button>
      <h2>${chosenTemplate.name}</h2>
      <p class="ai-ob-sub">${chosenTemplate.goalPrompt}</p>
      <textarea id="ai-ob-goal" class="ai-ob-goal" rows="3" placeholder="Tu objetivo..."></textarea>
      ${artesanoOptIn}
      <button id="ai-ob-start" class="primary-btn ai-ob-start">Empezar a leer con objetivo</button>`;
    body.querySelector('.ai-ob-back').addEventListener('click', renderObjectives);
    const goalEl = body.querySelector('#ai-ob-goal');
    if (!EpubReader.isCoarsePointer()) goalEl.focus();   // móvil: sin teclado hasta que toque
    body.querySelector('#ai-ob-start').addEventListener('click', async () => {
      const goal = goalEl.value.trim();
      // T5 (placer) no exige objetivo; el resto sí (es el ancla de la relevancia y la libreta).
      if (!goal && chosenTemplate.id !== INMERSIVA_ID) { goalEl.focus(); return; }
      // Si marcó el opt-in, la plantilla real pasa a ser el Artesano.
      const artesano = body.querySelector('#ai-ob-artesano')?.checked;
      const finalTemplate = artesano ? getTemplate(ARTESANO_ID) : chosenTemplate;
      template = finalTemplate;
      convo = bookId
        ? await DB.createConvo(bookId, finalTemplate.id, goal)
        : { id: 'tmp', bookId: null, templateId: finalTemplate.id, goal };
      history = []; notes = []; attenuationDone = false; clearChapterAttenuation();
      dismiss();
      await activateConvo();
      setOpen(true);
    });
  };

  renderObjectives();
}

// ---- Chat ------------------------------------------------------------------

async function send() {
  if (busy) return;
  const q = els.input.value.trim();
  if (!q && !pendingImage) return;
  if (!convo) { setStatus('Elige un objetivo de lectura primero.'); openOnboarding(); return; }
  if (!LLM.hasKey()) { AppSettings.open('agent'); setStatus('Introduce tu API key primero.'); return; }

  // VISIÓN · si hay una captura de página adjunta (botón "Ver"), este turno va con imagen al
  // modelo de visión, con el texto del usuario como petición.
  if (pendingImage) {
    const image = pendingImage;
    els.input.value = '';
    clearImageRef();
    clearRef();
    await deliverVision(q, image);
    return;
  }

  if (!annotatedText) { setStatus('El libro aún no está listo.'); return; }

  // Si hay un pasaje adjunto (referencia del lector), se incluye en el mensaje.
  const ref = pendingRef;
  const aug = ref ? `Sobre este fragmento del libro:\n«${ref}»\n\n${q}` : q;

  els.input.value = '';
  clearRef();
  await deliver(aug, q, { showUser: true });
}

// VISIÓN · Botón "Ver": ADJUNTA la captura de la página actual al composer (no envía). Así el
// usuario escribe/personaliza su pregunta y, al enviar, ese turno va con imagen al modelo de
// visión (ADR-018). Fallback honesto: sin modelo de visión, guiamos a configurarlo.
async function explainView() {
  if (busy) return;
  if (bookFormat !== 'pdf' || !PdfReader.isLoaded()) { setStatus('Disponible al leer un PDF.'); return; }
  if (!convo) { setStatus('Elige un objetivo de lectura primero.'); openOnboarding(); return; }
  if (!LLM.hasKey()) { AppSettings.open('agent'); setStatus('Introduce tu API key primero.'); return; }
  if (!LLM.hasVision()) {
    setStatus('Configura un modelo con visión en Ajustes para explicar figuras.');
    AppSettings.open('agent');
    return;
  }
  const page = PdfReader.getCurrentPage();
  const dataUrl = PdfReader.capturePageImage(1024);
  if (!dataUrl) { setStatus('Espera a que la página termine de renderizarse.'); return; }
  pendingImage = { dataUrl, page };
  if (els.imgref) { els.imgref.style.display = 'flex'; els.imgrefText.textContent = `Página ${page}`; }
  setOpen(true); showView('chat');
  focusInput();
  setStatus('Imagen de la página adjunta — escribe tu pregunta y pulsa Enviar.');
}

function clearImageRef() {
  pendingImage = null;
  if (els.imgref) els.imgref.style.display = 'none';
}

// Texto ya extraído de una página (para dar contexto textual al turno de visión).
function pageText(page) {
  const out = [];
  for (const line of (annotatedText || '').split('\n')) {
    const m = /^\[\[(a\d+)\]\]\s*(.*)$/.exec(line);
    if (m && anchors.get(m[1])?.page === page) out.push(m[2]);
  }
  return out.join(' ').slice(0, 4000);
}

async function deliverVision(userText, image) {
  if (busy || !image) return;
  const mySeq = bookSeq;   // guard: no persistir si el usuario cambia de libro mid-turno
  const page = image.page;
  const img = image.dataUrl;

  const instruction = userText ||
    'Explícame el contenido de esta página, en especial las figuras, diagramas o tablas que aparezcan.';
  const userLabel = `📷 Página ${page} · ${instruction}`;

  appendBubble('user', userLabel, false);
  history.push({ role: 'user', content: userLabel });
  if (convo) DB.addMessage(convo.id, 'user', userLabel);

  const bubble = appendBubble('assistant', '', false);
  const textNode = bubble.querySelector('.ai-bubble-text');
  textNode.innerHTML = '<span class="ai-typing">mirando la página…</span>';
  busy = true; els.send.disabled = true; abortCtrl = new AbortController();
  agentUnread = false; applyAgentBadge();

  try {
    const goalLine = convo?.goal ? `OBJETIVO DE LECTURA: ${convo.goal}\n\n` : '';
    const ctxText = pageText(page);
    const textBlock = ctxText ? `TEXTO EXTRAÍDO DE LA PÁGINA ${page} (para contexto):\n${ctxText}\n\n` : '';
    const messages = [
      { role: 'system', content:
`Eres un tutor de lectura. Te doy la IMAGEN de la PÁGINA ${page} del libro "${bookTitle}" y su texto
extraído. Explica su contenido —sobre todo las figuras, diagramas o tablas— con claridad y en el idioma
del usuario, conectándolo con su objetivo de lectura. Describe lo que REALMENTE se ve en la imagen; no
inventes ni cambies el número de página.` },
      { role: 'user', content: [
        { type: 'text', text: `${goalLine}${textBlock}(Es la página ${page}.) PETICIÓN: ${instruction}` },
        { type: 'image_url', image_url: { url: img } },
      ] },
    ];

    const raw = await LLM.chatVision({ messages, signal: abortCtrl.signal, maxTokens: 2048 });
    if (mySeq !== bookSeq) return;   // cambió de libro → no persistir en el convo equivocado
    const finalText = raw || '(sin respuesta del modelo de visión)';
    textNode.innerHTML = renderWithCitations(finalText, anchors);
    addMessageActions(bubble, finalText, instruction, { autoRun: false });
    history.push({ role: 'assistant', content: finalText });
    if (convo) DB.addMessage(convo.id, 'assistant', finalText);
  } catch (e) {
    if (e.name === 'AbortError') textNode.textContent += ' [cancelado]';
    else { console.error(e); textNode.innerHTML = `<span class="ai-error">${escapeHtml(e.message)}</span>`; }
  } finally {
    busy = false; els.send.disabled = false; abortCtrl = null; scrollDown();
    if (!isOpen()) agentUnread = true;
    applyAgentBadge();
  }
}

// IA5 · Índice de pasajes (BM25) del libro para retrieval por pregunta. Se construye
// una vez por libro (barato) sobre las anclas ya segmentadas; se reconstruye al cambiar.
function ensureIndex() {
  const key = bookId || bookTitle || 'mem';
  if (!Retrieval.hasIndex(key)) {
    // tocLabels es clave: sin él, los subtítulos (H2/H3) romperían la atribución de
    // capítulo de cada pasaje (ver parsePassages). Se calcula al segmentar (TOC/outline).
    Retrieval.buildIndex(key, Retrieval.parsePassages(annotatedText, anchors, tocLabels));
  }
}

// IA5 · Contexto por PREGUNTA a nivel de pasaje. Prioridad de relleno hasta el
// presupuesto: (1) capítulos que la pregunta NOMBRA explícitamente (router — intención
// directa, p. ej. "flashcards del capítulo 9"), (2) los mejores pasajes BM25 de TODO el
// libro, (3) el capítulo donde está el lector. Luego se reordena en orden de lectura
// para que el modelo lo lea coherente. Devuelve también las etiquetas del TOC (mapa del
// libro) para el system prompt.
function buildContext(question) {
  ensureIndex();
  const routed = Retrieval.matchChapters(question, tocLabels);     // capítulos nombrados
  // ADR-007 · Presupuesto adaptativo: turnos normales van lean (60k, baratos); si el
  // usuario NOMBRA un capítulo (intención de leerlo entero) se amplía el margen para que
  // quepa completo, sin encarecer cada pregunta.
  const budget = routed.length ? CTX_BUDGET_CHAPTER : CTX_BUDGET;
  const chosen = new Map();     // id -> pasaje (dedup, preserva)
  let used = 0;
  const tryAdd = (p) => {
    if (!p || chosen.has(p.id)) return;
    const t = estimateTokens(p.text) + 4;
    if (used + t > budget) return;
    chosen.set(p.id, p); used += t;
  };
  for (const ch of routed) {                                      // (1) capítulos nombrados
    for (const p of Retrieval.passagesByChapter(ch)) tryAdd(p);
    // (1b) además, BM25 por el TÍTULO del capítulo: recupera su contenido por tema aunque
    // la atribución por etiqueta fallara ("capítulo 9" no tiene palabras de contenido).
    const core = Retrieval.chapterCore(ch);
    if (core) for (const p of Retrieval.search(core, 40)) tryAdd(p);
  }
  const bm25 = Retrieval.search(question, 60);
  // (2) BM25 de todo el libro, con sentence-window: cada acierto arrastra sus vecinos
  // inmediatos (mismo capítulo) para dar coherencia. Ver DECISIONS.md · ADR-011.
  for (const p of Retrieval.withNeighbors(bm25, 1)) tryAdd(p);
  const cur = EpubReader.getCurrentChapterLabel?.() || '';         // (3) capítulo del lector
  for (const p of Retrieval.passagesByChapter(cur)) tryAdd(p);

  const picked = [...chosen.values()];
  // Fallback de seguridad: si no se pudo parsear/indexar (libro atípico), usar el
  // anotado recortado, como hacía IA1 — cero regresión.
  if (!picked.length) {
    return { text: annotatedText.slice(0, budget * 4), tocLabels, passages: 0, chapters: [], routed, bm25Count: 0, picked: [] };
  }
  const chapters = [...new Set(picked.map(p => p.chapter).filter(Boolean))];
  // routed = capítulos nombrados; bm25Count = fuerza del match léxico de la pregunta.
  // Ambos alimentan la decisión de retrieval agéntico (Fase 1b, ver deliver()).
  return { text: formatPassages(picked), tocLabels, passages: picked.length, chapters, routed, bm25Count: bm25.length, picked };
}

// Ensambla una lista de pasajes en texto para el prompt: cabecera `## capítulo` + `[[aN]]`
// por pasaje, en orden de lectura (para que el modelo lo lea coherente).
function formatPassages(list) {
  const out = [];
  let curCh = null;
  for (const p of [...list].sort((a, b) => Retrieval.anchorNum(a.id) - Retrieval.anchorNum(b.id))) {
    if (p.chapter && p.chapter !== curCh) { out.push(`\n## ${p.chapter}`); curCh = p.chapter; }
    out.push(`[[${p.id}]] ${p.text}`);
  }
  return out.join('\n').trim();
}

// ---- IA5 Fase 1b · Retrieval agéntico (herramientas) -----------------------
// Ver DECISIONS.md · ADR-009. Solo se activa en turnos con retrieval DÉBIL (sin capítulo
// nombrado y pocos aciertos BM25): el agente busca más contexto con estas herramientas y
// luego se streamea la respuesta con el contexto aumentado. Los turnos normales van
// directos a streaming (sin coste ni latencia extra).
const AGENTIC_MIN_HITS = 6;    // menos aciertos BM25 (y sin capítulo nombrado) → débil
const AGENTIC_MAX_ROUNDS = 3;

const RETRIEVAL_TOOLS = [
  { type: 'function', function: {
    name: 'search_book',
    description: 'Busca en TODO el libro y devuelve los pasajes más relevantes (con sus anclas [[aN]]) para una consulta por tema o palabras clave.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Tema o palabras clave a buscar.' } }, required: ['query'] },
  } },
  { type: 'function', function: {
    name: 'read_chapter',
    description: 'Devuelve los pasajes de un capítulo concreto (por número o por título del índice).',
    parameters: { type: 'object', properties: { chapter: { type: 'string', description: 'Número ("9") o título del capítulo tal como aparece en el índice.' } }, required: ['chapter'] },
  } },
];

// Recorta una lista de pasajes a un tope de tokens (para el texto devuelto al modelo).
function capPassages(list, maxTokens) {
  const out = []; let used = 0;
  for (const p of list) { const t = estimateTokens(p.text) + 4; if (used + t > maxTokens) break; out.push(p); used += t; }
  return out;
}

// Ejecutor de las herramientas: corre el retrieval local y acumula los pasajes hallados en
// `extra` (para fusionarlos luego al contexto final). Devuelve texto citable al modelo.
function makeRetrievalExecutor(extra, tocLabels) {
  return async (name, args) => {
    if (name === 'search_book') {
      const hits = Retrieval.search(String(args?.query || ''), 12);
      for (const p of hits) extra.set(p.id, p);
      return hits.length ? formatPassages(hits) : 'Sin resultados para esa consulta.';
    }
    if (name === 'read_chapter') {
      const ref = String(args?.chapter || '').trim();
      const labels = Retrieval.matchChapters('capítulo ' + ref + ' ' + ref, tocLabels);
      const ps = [];
      for (const l of labels) for (const p of Retrieval.passagesByChapter(l)) ps.push(p);
      const capped = capPassages(ps, CTX_BUDGET_CHAPTER);
      for (const p of capped) extra.set(p.id, p);
      if (!capped.length) return `No encontré el capítulo "${ref}" en el índice.`;
      return formatPassages(capPassages(capped, 6000));   // al modelo, una muestra acotada
    }
    return 'Herramienta desconocida.';
  };
}

// Fase de recolección: deja que el agente pida más contexto y fusiona lo hallado con el
// contexto inicial (dentro del techo de capítulo). Degrada con gracia si algo falla.
async function agenticGather(question, ctx, signal) {
  const extra = new Map();
  const messages = [
    { role: 'system', content:
`Antes de responder, REÚNE el contexto necesario del libro con las herramientas. El extracto inicial
de abajo puede ser insuficiente. Llama a search_book (por tema) o read_chapter (por número/título del
índice) las veces que haga falta. Cuando tengas material suficiente, responde solo "LISTO". NO
respondas aún a la pregunta.
MAPA DEL LIBRO (índice de capítulos):
${ctx.tocLabels.map(t => '- ' + t).join('\n')}` },
    { role: 'user', content: 'EXTRACTO INICIAL:\n\n' + ctx.text },
    { role: 'user', content: 'PREGUNTA DEL USUARIO: ' + question },
  ];
  try {
    await LLM.chatToolsLoop({ messages, tools: RETRIEVAL_TOOLS, execute: makeRetrievalExecutor(extra, ctx.tocLabels), maxRounds: AGENTIC_MAX_ROUNDS, signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    console.warn('Recolección agéntica falló; sigo con el contexto inicial:', e);
    return ctx;
  }
  if (!extra.size) return ctx;
  const merged = new Map(ctx.picked.map(p => [p.id, p]));
  for (const [id, p] of extra) merged.set(id, p);
  const final = capPassages(
    [...merged.values()].sort((a, b) => Retrieval.anchorNum(a.id) - Retrieval.anchorNum(b.id)),
    CTX_BUDGET_CHAPTER,
  );
  return { ...ctx, picked: final, text: formatPassages(final), passages: final.length };
}

// ---- IA2 · Repaso al terminar capítulo ("Pepito Grillo") -------------------
// Ver DECISIONS.md · ADR-013. Al ENTRAR en un capítulo nuevo (no visto), el capítulo
// ANTERIOR se da por terminado: con la plantilla HQ&A, el agente interrumpe con UNA
// pregunta de recuerdo activo sobre él. Solo hacia delante (no al volver atrás) y una vez
// por capítulo.
function onChapterChanged(label) {
  if (!label) return;
  const prev = ia2LastChapter;
  ia2LastChapter = label;
  if (ia2Seen.has(label)) return;       // ya visto (volver atrás): no repasar
  ia2Seen.add(label);
  if (!prev) return;                     // primer capítulo del libro: nada que repasar aún
  if (template?.id !== 'hqa') return;    // IA2 solo con la plantilla de recuerdo activo
  if (!convo || !LLM.hasKey() || busy || !segReady) return;
  quizChapter(prev);
}

async function quizChapter(chapterLabel) {
  if (busy) return;
  const mySeq = bookSeq;   // guard: no persistir el repaso si el usuario cambia de libro
  ensureIndex();
  const passages = capPassages(Retrieval.passagesByChapter(chapterLabel), 12000);
  if (!passages.length) return;
  busy = true; els.send.disabled = true;
  const bubble = appendBubble('assistant', '', false);
  const textNode = bubble.querySelector('.ai-bubble-text');
  textNode.innerHTML = '<span class="ai-typing">repaso del capítulo…</span>';
  try {
    const messages = [
      { role: 'system', content:
`El lector acaba de TERMINAR el capítulo «${chapterLabel}». Eres su tutor de recuerdo activo (método
HQ&A). Formula UNA sola pregunta breve y conceptual que le haga recuperar la idea principal de ese
capítulo, alineada a su OBJETIVO. NO des la respuesta: la escribe él. Empieza el mensaje con
"🔔 Repaso — ". Apóyate en un pasaje citándolo con su ancla [[aN]].
OBJETIVO: ${convo?.goal || '(sin definir)'}` },
      { role: 'user', content: 'PASAJES DEL CAPÍTULO:\n\n' + formatPassages(passages) },
    ];
    let thinking = true;
    const raw = await LLM.chatStream({ messages, onToken: (t) => {
      if (thinking) { thinking = false; textNode.textContent = ''; }
      textNode.textContent += t; scrollDown();
    } });
    if (mySeq !== bookSeq) { bubble.remove(); return; }   // cambió de libro → descartar el repaso
    const finalText = raw || textNode.textContent;
    textNode.innerHTML = renderWithCitations(finalText, anchors);
    history.push({ role: 'assistant', content: finalText });
    if (convo) DB.addMessage(convo.id, 'assistant', finalText);
    if (!isOpen()) { agentUnread = true; applyAgentBadge(); }
  } catch (e) {
    console.warn('IA2 repaso de capítulo falló:', e);
    bubble.remove();
  } finally {
    busy = false; els.send.disabled = false; scrollDown();
  }
}

// Un turno con el LLM: construye el contexto (IA5), lo streamea y pinta la respuesta.
// `showUser` false = continuación (no se pinta ni persiste una burbuja de usuario; el
// mensaje va igualmente al modelo como último turno). Reutilizado por send() y por el
// botón "Continuar" que aparece si el proveedor corta la respuesta por longitud.
async function deliver(aug, question, { showUser = true } = {}) {
  if (busy) return;
  const mySeq = bookSeq;   // guard: si el usuario cambia de libro mid-turno, no persistir aquí

  // IA5 · Retrieval por PREGUNTA a nivel de pasaje (reemplaza al recorte por objetivo
  // de IA1, que era ciego a la query y descartaba capítulos relevantes enteros por
  // presupuesto). Ver DECISIONS.md · ADR-001..007. `let`: la Fase 1b puede aumentarlo.
  let ctx = buildContext(question);

  // IA1 · Ventana de historial: solo se reenvían los últimos N mensajes (el chat
  // completo sigue guardado y visible; solo no se manda entero en cada turno).
  const priorWindow = history.slice(-HISTORY_MSGS);

  // IA1 · Guard de tokens: si el prompt final es enorme (típico: libro grande sin
  // puntuaciones todavía), avisar antes de enviar en vez de fallar de forma opaca.
  const estTokens = estimateTokens(ctx.text)
    + priorWindow.reduce((n, m) => n + estimateTokens(m.content), 0)
    + estimateTokens(aug) + 400;
  if (estTokens > TOKEN_GUARD &&
      !(await confirmBox(`El contexto es grande (~${Math.round(estTokens / 1000)}k tokens): puede ser lento o caro. ¿Enviar igualmente?`,
        { title: 'Contexto grande', okText: 'Enviar igualmente' }))) {
    return;   // se conservan input y referencia adjunta
  }

  if (showUser) {
    appendBubble('user', aug, false);
    history.push({ role: 'user', content: aug });
    if (convo) DB.addMessage(convo.id, 'user', aug);
  }

  const bubble = appendBubble('assistant', '', false);
  const textNode = bubble.querySelector('.ai-bubble-text');
  textNode.innerHTML = '<span class="ai-typing">pensando…</span>';
  busy = true; els.send.disabled = true; abortCtrl = new AbortController();
  agentUnread = false; applyAgentBadge();   // si el panel está cerrado, muestra "generando"
  let thinking = true, raw, truncated = false;

  try {
    // IA5 Fase 1b · Retrieval agéntico SOLO en turnos difíciles (sin capítulo nombrado y
    // pocos aciertos BM25): el agente reúne más contexto con herramientas antes de
    // responder; los turnos normales van directos a streaming. Ver DECISIONS.md · ADR-009.
    // Guard: libro indexado (segReady). Un retrieval DÉBIL —incluido el vacío (0 aciertos)—
    // es justo cuando el agente debe buscar por su cuenta; por eso NO exigimos picked>0.
    if (LLM.hasKey() && segReady && !ctx.routed?.length && ctx.bm25Count < AGENTIC_MIN_HITS) {
      textNode.innerHTML = '<span class="ai-typing">buscando en el libro…</span>';
      ctx = await agenticGather(question, ctx, abortCtrl.signal);
    }

    const messages = [
      { role: 'system', content: systemPrompt(convo?.goal, template, Profiles.getActive(), { tocLabels: ctx.tocLabels }) },
      { role: 'user', content: 'EXTRACTO DEL LIBRO recuperado por relevancia para esta pregunta (cita los pasajes con sus anclas [[aN]]):\n\n' + ctx.text },
      ...priorWindow,
      { role: 'user', content: aug },
    ];

    raw = await LLM.chatStream({
      messages, signal: abortCtrl.signal,
      onToken: (t) => {
        if (thinking) { thinking = false; textNode.textContent = ''; }
        textNode.textContent += t; scrollDown();
      },
      onDone: (info) => { truncated = info.truncated; },
    });
    if (mySeq !== bookSeq) return;   // el usuario cambió de libro → no pintar/persistir en el convo equivocado
    const finalText = raw || textNode.textContent;
    textNode.innerHTML = renderWithCitations(finalText, anchors);
    addMessageActions(bubble, finalText, question, { autoRun: LLM.getAutoExtract(), truncated });
    history.push({ role: 'assistant', content: finalText });
    if (convo) DB.addMessage(convo.id, 'assistant', finalText);
  } catch (e) {
    if (e.name === 'AbortError') textNode.textContent += ' [cancelado]';
    else { console.error(e); textNode.innerHTML = `<span class="ai-error">${escapeHtml(e.message)}</span>`; }
  } finally {
    busy = false; els.send.disabled = false; abortCtrl = null; scrollDown();
    if (!isOpen()) agentUnread = true;      // llegó con el panel cerrado → no-leído
    applyAgentBadge();
  }
}

// Continúa una respuesta que el proveedor cortó por longitud: reusa deliver() con una
// instrucción de continuación, sin pintar/persistir una burbuja de usuario (el modelo
// ya ve su parte previa en el historial). La continuación llega como nueva burbuja.
function continueResponse(question) {
  const prompt = 'Continúa tu respuesta anterior EXACTAMENTE desde donde se cortó, '
    + 'sin repetir nada de lo ya escrito, sin saludar y sin reintroducir. Sigue el hilo.';
  return deliver(prompt, question, { showUser: false });
}

// ---- Extracción a la libreta (tool-use, no-streaming) ----------------------

function addMessageActions(bubble, answerText, question, { autoRun = false, truncated = false } = {}) {
  const bar = document.createElement('div');
  bar.className = 'ai-bubble-actions';

  // El proveedor cortó por longitud: ofrecer continuar (streamea el resto en una
  // nueva burbuja). Se deshabilita al pulsar para no lanzar continuaciones dobles.
  if (truncated) {
    const cont = document.createElement('button');
    cont.className = 'ai-act ai-continue';
    cont.innerHTML = act('arrow-up-right', 'Continuar');
    cont.title = 'La respuesta se cortó por longitud';
    cont.addEventListener('click', () => { cont.disabled = true; continueResponse(question); });
    bar.appendChild(cont);
  }

  const copyBtn = document.createElement('button');
  copyBtn.className = 'ai-act ai-copy';
  copyBtn.innerHTML = act('copy', 'Copiar');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(answerText);
      copyBtn.innerHTML = act('check', 'Copiado');
    } catch {
      // Fallback para contextos sin Clipboard API.
      const ta = document.createElement('textarea');
      ta.value = answerText; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); copyBtn.innerHTML = act('check', 'Copiado'); }
      catch { copyBtn.innerHTML = act('xmark', 'Error'); }
      ta.remove();
    }
    setTimeout(() => { copyBtn.innerHTML = act('copy', 'Copiar'); }, 1500);
  });
  bar.appendChild(copyBtn);

  if (template) {
    if (autoRun) {
      // Auto-extracción: indicador no-interactivo, sin saltar de pestaña.
      const status = document.createElement('span');
      status.className = 'ai-extract-status';
      bar.appendChild(status);
      bubble.querySelector('.ai-bubble').appendChild(bar);
      extractToNotebook(answerText, question, status);
      return;
    }
    const ex = document.createElement('button');
    ex.className = 'ai-act ai-extract';
    ex.innerHTML = act('note', 'A la libreta');
    ex.addEventListener('click', () => extractToNotebook(answerText, question, ex));
    bar.appendChild(ex);
  }

  bubble.querySelector('.ai-bubble').appendChild(bar);
}

function notebookTool() {
  // Solo campos INFO (fill:'agent'). Los de cognición los genera el usuario: la IA no
  // puede dirigirse a ellos (ni siquiera aparecen como enum válido en la herramienta).
  const keys = agentFields(template).map(f => f.key);
  return [{
    type: 'function',
    function: {
      name: 'upsert_note',
      description: 'Guarda una nota en un campo de la libreta del usuario.',
      parameters: {
        type: 'object',
        properties: {
          fieldKey: { type: 'string', enum: keys, description: 'Campo de la plantilla.' },
          content: { type: 'string', description: 'Nota concisa en español, con cita [[aN]] si procede.' },
          sourceCfis: { type: 'array', items: { type: 'string' }, description: 'Anclas [[aN]] de origen.' },
        },
        required: ['fieldKey', 'content'],
      },
    },
  }];
}

async function extractToNotebook(answerText, question, el) {
  if (!template) return;
  const isBtn = el.tagName === 'BUTTON';
  if (isBtn) el.disabled = true;
  el.innerHTML = act('note', 'Apuntando…');
  // Solo campos INFO: los de cognición (fill:'user') los genera el usuario, no la IA.
  const fillable = agentFields(template);
  if (!fillable.length) {                       // plantilla 100% cognición (p. ej. HQ&A)
    el.innerHTML = act('note', 'Nada que guardar');
    if (isBtn) setTimeout(() => { el.disabled = false; el.innerHTML = act('note', 'A la libreta'); }, 2500);
    return;
  }
  const fieldList = fillable.map(f => `- ${f.key}: ${f.label}`).join('\n');
  const messages = [
    { role: 'system', content:
`Eres un extractor de notas para la plantilla "${template.name}".
A partir de la respuesta del agente y el objetivo del usuario, guarda en la libreta SOLO lo que aporte
valor real. Llama a upsert_note una vez por nota. fieldKey debe ser uno de estos:
${fieldList}
Escribe content en español, conciso, conservando las citas [[aN]] que aparezcan. Si no hay nada que
merezca guardarse, no llames a ninguna herramienta.` },
    { role: 'user', content:
`OBJETIVO: ${convo.goal}\n\nPREGUNTA: ${question}\n\nRESPUESTA DEL AGENTE:\n${answerText}` },
  ];
  try {
    const { toolCalls } = await LLM.chatTools({ messages, tools: notebookTool(), toolChoice: 'auto' });
    let added = 0;
    for (const tc of toolCalls) {
      if (tc.name !== 'upsert_note') continue;
      const { fieldKey, content, sourceCfis } = tc.args || {};
      // isAgentFillable: existe Y es INFO. Blinda contra que el modelo intente escribir
      // en un campo de cognición aunque no esté en el enum de la herramienta.
      if (!fieldKey || !content || !isAgentFillable(template.id, fieldKey)) continue;
      const cites = extractCites(content, sourceCfis);
      const id = convo ? await DB.addNote(convo.id, fieldKey, content, cites) : Date.now();
      notes.push({ id, fieldKey, content, sourceCfis: cites });
      added++;
    }
    renderNotebook();
    el.innerHTML = added ? act('check', `${added} a la libreta`) : act('note', 'Nada que guardar');
    if (added) {
      if (isBtn) showView('notebook');         // manual: el usuario lo pidió → mostrar
      else markNotebookUnread();               // auto: avisar sin interrumpir el chat
    }
  } catch (e) {
    console.error('Extracción falló:', e);
    el.innerHTML = act('xmark', 'Error al apuntar');
  } finally {
    // Solo el botón se restaura para poder reintentar; el indicador auto se queda.
    if (isBtn) setTimeout(() => { el.disabled = false; el.innerHTML = act('note', 'A la libreta'); }, 2500);
  }
}

function markNotebookUnread() {
  const tab = els.tabs.querySelector('.ai-tab[data-view="notebook"]');
  if (tab && !tab.classList.contains('active')) tab.classList.add('ai-tab-unread');
}

function extractCites(content, sourceCfis) {
  const ids = new Set();
  (sourceCfis || []).forEach(s => String(s).replace(/a\d+/g, m => ids.add(m)));
  (content.match(/a\d+/g) || []).forEach(m => { if (anchors.has(m)) ids.add(m); });
  return [...ids].filter(id => anchors.has(id));
}

// ---- Libreta (render) ------------------------------------------------------

function editorHtml(attr, value) {
  return `
    <div class="ai-nb-editor" ${attr}>
      <textarea class="ai-nb-input" placeholder="Escribe tu nota...">${escapeHtml(value)}</textarea>
      <div class="ai-nb-editor-actions">
        <button class="ai-nb-save">Guardar</button>
        <button class="ai-nb-cancel">Cancelar</button>
      </div>
    </div>`;
}

function noteHtml(n) {
  if (n.id === editingId) return editorHtml(`data-id="${n.id}"`, n.content);
  const navCfi = (n.sourceCfis || []).find(c => typeof c === 'string' && c.startsWith('epubcfi'));
  const gotoBtn = navCfi
    ? `<button class="ai-nb-goto" data-cfi="${escapeHtml(navCfi)}" title="Ir al subrayado">${icon('arrow-up-right', { size: 15 })}</button>`
    : '';
  return `
    <div class="ai-nb-note" data-id="${n.id}">
      <div class="ai-nb-note-text">${renderWithCitations(n.content, anchors)}</div>
      <div class="ai-nb-note-tools">
        ${gotoBtn}
        <button class="ai-nb-edit" data-id="${n.id}" title="Editar">${icon('pencil', { size: 15 })}</button>
        <button class="ai-nb-del" data-id="${n.id}" title="Eliminar">${icon('trash', { size: 15 })}</button>
      </div>
    </div>`;
}

function renderNotebook() {
  // Conversación huérfana: su plantilla ya no existe (p. ej. tras consolidar a T1–T5).
  // No rompemos: avisamos y ofrecemos elegir un objetivo nuevo.
  if (convo && !template) {
    els.noteView.innerHTML = `
      <div class="ai-nb-orphan">
        <p>Esta conversación usa una plantilla que ya no existe.</p>
        <button id="ai-nb-neworb" class="primary-btn">Elegir un objetivo</button>
      </div>`;
    els.noteView.querySelector('#ai-nb-neworb')?.addEventListener('click', openOnboarding);
    return;
  }
  if (!template) { els.noteView.innerHTML = ''; return; }
  const byField = {};
  for (const n of notes) (byField[n.fieldKey] ||= []).push(n);

  els.noteView.innerHTML = `
    <div class="ai-nb-goal"><span class="ai-nb-goal-label">${icon('target', { size: 15 })} Objetivo</span><span class="ai-nb-goal-value">${escapeHtml(convo.goal)}</span></div>
    <div class="ai-nb-tpl">${template.name}</div>
    ${template.fields.map(f => {
      const list = byField[f.key] || [];
      const notesHtml = list.map(noteHtml).join('');
      const adding = addingField === f.key ? editorHtml(`data-field="${f.key}"`, '') : '';
      const addBtn = addingField === f.key ? '' : `<button class="ai-nb-add" data-field="${f.key}">+ nota</button>`;
      // INFO (IA) vs COGNICIÓN (tú): la etiqueta hace explícito quién rellena cada campo.
      const cog = isCognitionField(f);
      const tag = `<span class="ai-nb-fill ${cog ? 'is-user' : 'is-agent'}">${cog ? 'tú' : 'IA'}</span>`;
      const hint = cog && !list.length && !adding
        ? '<div class="ai-nb-cog-hint">Escríbela tú; luego pide al agente en el chat que la revise.</div>'
        : '';
      return `
      <div class="ai-nb-field${cog ? ' is-cognition' : ''}">
        <div class="ai-nb-field-label">${escapeHtml(f.label)}${tag}</div>
        ${notesHtml || (adding ? '' : '<div class="ai-nb-empty">—</div>')}
        ${hint}
        ${adding}
        ${addBtn}
      </div>`;
    }).join('')}
  `;
}

function focusEditor() {
  setTimeout(() => els.noteView.querySelector('.ai-nb-editor .ai-nb-input')?.focus(), 0);
}

async function onNotebookClick(e) {
  const save = e.target.closest('.ai-nb-save');
  if (save) {
    const editor = save.closest('.ai-nb-editor');
    const val = editor.querySelector('.ai-nb-input').value.trim();
    const id = editor.dataset.id ? Number(editor.dataset.id) : null;
    const field = editor.dataset.field || null;
    if (val && id != null) {
      const cites = extractCites(val, []);
      if (convo) await DB.updateNote(id, { content: val, sourceCfis: cites });
      const note = notes.find(n => n.id === id);
      if (note) { note.content = val; note.sourceCfis = cites; }
    } else if (val && field) {
      const cites = extractCites(val, []);
      const newId = convo ? await DB.addNote(convo.id, field, val, cites) : Date.now();
      notes.push({ id: newId, fieldKey: field, content: val, sourceCfis: cites });
    }
    editingId = null; addingField = null;
    renderNotebook();
    return;
  }
  if (e.target.closest('.ai-nb-cancel')) { editingId = null; addingField = null; renderNotebook(); return; }

  const edit = e.target.closest('.ai-nb-edit');
  if (edit) { editingId = Number(edit.dataset.id); addingField = null; renderNotebook(); focusEditor(); return; }

  const add = e.target.closest('.ai-nb-add');
  if (add) { addingField = add.dataset.field; editingId = null; renderNotebook(); focusEditor(); return; }

  const goto = e.target.closest('.ai-nb-goto');
  if (goto) { onCite(goto.dataset.cfi); return; }

  const del = e.target.closest('.ai-nb-del');
  if (del) {
    const id = Number(del.dataset.id);
    notes = notes.filter(n => n.id !== id);
    if (convo) DB.deleteNote(id);
    renderNotebook();
    return;
  }
  const cite = e.target.closest('.ai-cite');
  if (cite) navigateCite(cite.dataset.id);
}

// ---- Helpers de render -----------------------------------------------------

function onMessagesClick(e) {
  const cite = e.target.closest('.ai-cite');
  if (cite) navigateCite(cite.dataset.id);
}

function navigateCite(id) {
  const a = anchors.get(id);
  // EPUB → CFI (o href del capítulo si el CFI puntual falló); PDF → nº de página.
  if (a) onCite(a.cfi ?? a.href ?? a.page);
}

function appendBubble(role, text, asHtml) {
  const div = document.createElement('div');
  div.className = 'ai-msg ai-msg-' + role;
  div.innerHTML = `<div class="ai-bubble"><div class="ai-bubble-text"></div></div>`;
  const node = div.querySelector('.ai-bubble-text');
  if (asHtml) node.innerHTML = renderWithCitations(text, anchors);
  else node.textContent = text;
  els.messages.appendChild(div);
  if (asHtml && role === 'assistant' && text) addMessageActions(div, text, '');
  scrollDown();
  return div;
}

function setStatus(s) {
  if (!els.status) return;
  els.status.textContent = s;
  // Shimmer mientras el agente trabaja (mensajes que terminan en "…").
  els.status.classList.toggle('ai-status--busy', /…\s*$/.test(s));
}
function scrollDown() { if (els.messages) els.messages.scrollTop = els.messages.scrollHeight; }
