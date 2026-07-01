// Panel del agente: onboarding (objetivo + plantilla), chat en streaming con citas
// [[aN]] clicables, y libreta estructurada que el agente rellena vía tool-use.
// E1/E2/E3/E5/E6 del backlog. Estado persistido en IndexedDB (E4).
import * as LLM from './llm.js';
import { segmentBook } from './segment.js';
import * as DB from './db.js';
import * as EpubReader from '../epub-reader.js';
import { BLOCKS, TEMPLATES, getTemplate, templatesByBlock, isValidField } from './templates.js';
import { icon } from '../ui/icons.js';
import { escapeHtml } from '../ui/escape.js';
import * as AppSettings from '../ui/app-settings.js';
import { renderWithCitations } from './render.js';
import { computeChapterRelevance, applyChapterAttenuation, clearChapterAttenuation } from './attenuation.js';
import { selectContext, estimateTokens } from './context.js';
import { TEMPLATE, systemPrompt } from './panel-template.js';
import * as Profiles from './profiles.js';

// Icon + label markup for the small inline action buttons.
const act = (name, text, size = 15) => `${icon(name, { size })}<span>${text}</span>`;

// IA1 — recorte de contexto/historial (ver decisión en el CHANGELOG):
const CTX_BUDGET = 60000;    // tope de tokens de libro por turno (capítulos relevantes)
const HISTORY_MSGS = 6;      // mensajes de historial verbatim que se reenvían (ventana)
const TOKEN_GUARD = 120000;  // por encima de esto, avisar antes de enviar

let els = {};
let book = null, bookId = null, bookTitle = '';
let convo = null;            // conversación activa { id, bookId, templateId, goal, title }
let template = null;
let annotatedText = '', anchors = new Map();
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
let pendingQuoteOnActivate = null; // cola: pasaje a adjuntar tras crear/activar convo

export function init(opts) {
  onCite = opts.onCite || (() => {});
  els.panel = document.getElementById('ai-panel');
  els.panel.innerHTML = TEMPLATE;
  const $ = (s) => els.panel.querySelector(s);
  Object.assign(els, {
    status: $('#ai-status'), tabs: $('#ai-tabs'),
    chatView: $('#ai-view-chat'), noteView: $('#ai-view-notebook'),
    messages: $('#ai-messages'), input: $('#ai-input'), send: $('#ai-send'), close: $('#ai-close'),
    convobar: $('#ai-convobar'), convoBtn: $('#ai-convo-btn'), convoLabel: $('#ai-convo-label'), convoNew: $('#ai-convo-new'),
    ref: $('#ai-ref'), refText: $('#ai-ref-text'), profileChip: $('#ai-profile-chip'),
  });
  $('#ai-ref-clear').addEventListener('click', clearRef);

  // La config del agente (key/modelo/auto) vive ahora en Ajustes generales.
  $('#ai-edit-cfg').addEventListener('click', () => AppSettings.open('agent'));
  // Al guardarla allí, refrescar el estado del panel (p. ej. tras introducir la key).
  window.addEventListener('appsettings:agent-saved', refreshStatus);
  // Reflejar el perfil activo (chip) cuando se active/edite en Ajustes generales.
  window.addEventListener('appsettings:profile-changed', updateProfileChip);
  updateProfileChip();
  // Abrir Ajustes en la sección Perfiles al tocar el chip.
  els.profileChip.addEventListener('click', () => AppSettings.open('profiles'));
  els.send.addEventListener('click', send);
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
  else if (convo) els.input?.focus();
}
export function isOpen() { return document.body.classList.contains('ai-open'); }

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

function setRef(text) {
  pendingRef = text;
  if (els.refText) els.refText.textContent = text;
  if (els.ref) els.ref.style.display = 'flex';
  els.input?.focus();
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

export async function setBook(b, id, title) {
  book = b; bookId = id || null; bookTitle = title || 'Libro';
  convo = null; template = null; history = []; notes = [];
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
  const convos = bookId ? await DB.getConvos(bookId) : [];
  if (convos.length) {
    convo = convos[0];                 // getConvos viene ordenado por lastUsedAt desc
    template = getTemplate(convo.templateId);
    await activateConvo();
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
  setStatus('Generando HQ&A del subrayado…');
  try {
    const messages = [
      { role: 'system', content:
`Aplicas el método HQ&A (Highlight–Question–Answer). Dado un FRAGMENTO subrayado y el OBJETIVO
del usuario, genera: (1) una PREGUNTA conceptual que ese fragmento responde, alineada al objetivo;
(2) una RESPUESTA breve con palabras propias, sin copiar el fragmento.
Responde EXACTAMENTE en dos líneas, sin nada más:
P: <pregunta>
R: <respuesta>` },
      { role: 'user', content: `OBJETIVO: ${convo.goal}\n\nFRAGMENTO SUBRAYADO:\n"${text}"` },
    ];
    const out = await LLM.chatStream({ messages });
    const q = (out.match(/P:\s*(.+)/i)?.[1] || '').trim();
    const a = (out.match(/R:\s*([\s\S]+)/i)?.[1] || '').trim();
    const content = `> ${text}\n\n**P:** ${q || '—'}\n**R:** ${a || '—'}`;
    const id = convo ? await DB.addNote(convo.id, 'hqa', content, [cfiRange]) : Date.now();
    notes.push({ id, fieldKey: 'hqa', content, sourceCfis: [cfiRange] });
    renderNotebook();
    markNotebookUnread();
    setStatus('HQ&A añadido a la libreta');
  } catch (e) {
    console.error('HQ&A falló:', e);
    setStatus('No se pudo generar HQ&A: ' + e.message);
  } finally {
    hqaBusy = false;
    setTimeout(refreshStatus, 2500);
  }
}

async function prepareBook() {
  try {
    let seg = bookId ? await DB.loadSegmented(bookId) : null;
    if (seg) {
      segCached = true;
    } else {
      setStatus('Leyendo el libro…');
      seg = await segmentBook(book, (d, t) => setStatus(`Leyendo el libro… ${d}/${t} secciones`));
      if (bookId) await DB.saveSegmented(bookId, bookTitle, seg);
      segCached = false;
    }
    annotatedText = seg.annotatedText;
    anchors = seg.anchors;
    segReady = true; segBlocks = seg.blockCount;
    refreshStatus();
    if (document.getElementById('sidebar')?.classList.contains('open')) maybeAttenuate();
  } catch (e) {
    console.error('Preparación del agente falló:', e);
    setStatus('No se pudo preparar el libro: ' + e.message);
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
      const name = (prompt('Nombre de la conversación:', cur) || '').trim();
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
      if (confirm(`¿Eliminar la conversación "${getTemplate(c?.templateId)?.name || ''}"? Se borran su chat y su libreta.`)) {
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
    <div class="ai-ob-card">
      <button class="ai-ob-close" title="Cerrar" aria-label="Cerrar">${icon('xmark', { size: 18 })}</button>
      <div class="ai-ob-body"></div>
    </div>`;
  document.body.appendChild(overlay);
  const body = overlay.querySelector('.ai-ob-body');

  const dismiss = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') dismiss(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) dismiss(); }); // clic fuera de la tarjeta
  overlay.querySelector('.ai-ob-close').addEventListener('click', dismiss);

  let chosenBlock = null, chosenTemplate = null;

  const renderBlocks = () => {
    body.innerHTML = `
      <h2>¿Cuál es tu objetivo con este libro?</h2>
      <p class="ai-ob-sub">Elige un enfoque de lectura.</p>
      <div class="ai-ob-blocks">
        ${Object.values(BLOCKS).map(bl => `
          <button class="ai-ob-block" data-block="${bl.id}">
            <span class="ai-ob-block-icon">${icon(bl.icon, { size: 24 })}</span>
            <span class="ai-ob-block-label">${bl.label}</span>
            <span class="ai-ob-block-hint">${bl.hint}</span>
          </button>`).join('')}
      </div>`;
    body.querySelectorAll('.ai-ob-block').forEach(btn =>
      btn.addEventListener('click', () => { chosenBlock = btn.dataset.block; renderTemplates(); }));
  };

  const renderTemplates = () => {
    const list = templatesByBlock(chosenBlock);
    body.innerHTML = `
      <button class="ai-ob-back">${icon('chevron-left', { size: 16 })}<span>Volver</span></button>
      <h2>Elige una plantilla</h2>
      <div class="ai-ob-templates">
        ${list.map(t => `
          <button class="ai-ob-tpl" data-tpl="${t.id}">
            <span class="ai-ob-tpl-name">${t.name}</span>
            <span class="ai-ob-tpl-ideal">${t.ideal}</span>
          </button>`).join('')}
      </div>`;
    body.querySelector('.ai-ob-back').addEventListener('click', renderBlocks);
    body.querySelectorAll('.ai-ob-tpl').forEach(btn =>
      btn.addEventListener('click', () => { chosenTemplate = getTemplate(btn.dataset.tpl); renderGoal(); }));
  };

  const renderGoal = () => {
    body.innerHTML = `
      <button class="ai-ob-back">${icon('chevron-left', { size: 16 })}<span>Volver</span></button>
      <h2>${chosenTemplate.name}</h2>
      <p class="ai-ob-sub">${chosenTemplate.goalPrompt}</p>
      <textarea id="ai-ob-goal" class="ai-ob-goal" rows="3" placeholder="Tu objetivo..."></textarea>
      <button id="ai-ob-start" class="primary-btn ai-ob-start">Empezar a leer con objetivo</button>`;
    body.querySelector('.ai-ob-back').addEventListener('click', renderTemplates);
    const goalEl = body.querySelector('#ai-ob-goal');
    goalEl.focus();
    body.querySelector('#ai-ob-start').addEventListener('click', async () => {
      const goal = goalEl.value.trim();
      if (!goal) { goalEl.focus(); return; }
      template = chosenTemplate;
      convo = bookId
        ? await DB.createConvo(bookId, chosenTemplate.id, goal)
        : { id: 'tmp', bookId: null, templateId: chosenTemplate.id, goal };
      history = []; notes = []; attenuationDone = false; clearChapterAttenuation();
      dismiss();
      await activateConvo();
      setOpen(true);
    });
  };

  renderBlocks();
}

// ---- Chat ------------------------------------------------------------------

async function send() {
  if (busy) return;
  const q = els.input.value.trim();
  if (!q) return;
  if (!convo) { setStatus('Elige un objetivo de lectura primero.'); openOnboarding(); return; }
  if (!LLM.hasKey()) { AppSettings.open('agent'); setStatus('Introduce tu API key primero.'); return; }
  if (!annotatedText) { setStatus('El libro aún no está listo.'); return; }

  // Si hay un pasaje adjunto (referencia del lector), se incluye en el mensaje.
  const ref = pendingRef;
  const aug = ref ? `Sobre este fragmento del libro:\n«${ref}»\n\n${q}` : q;

  // IA1 · Recorte de contexto: en vez del libro entero, solo los capítulos
  // relevantes al objetivo (relevancia ya cacheada por conversación). Si aún no
  // hay puntuaciones, selectContext devuelve el libro entero (sin regresión).
  const rated = convo ? await DB.getRatings(convo.id) : null;
  const scores = (rated && rated.goal === convo.goal) ? rated.scores : null;
  const tocLabels = (book?.navigation?.toc || []).map(t => t.label.trim());
  const ctx = selectContext(annotatedText, scores, {
    tocLabels,
    currentChapter: EpubReader.getCurrentChapterLabel(),
    budgetTokens: CTX_BUDGET,
  });

  // IA1 · Ventana de historial: solo se reenvían los últimos N mensajes (el chat
  // completo sigue guardado y visible; solo no se manda entero en cada turno).
  const priorWindow = history.slice(-HISTORY_MSGS);

  // IA1 · Guard de tokens: si el prompt final es enorme (típico: libro grande sin
  // puntuaciones todavía), avisar antes de enviar en vez de fallar de forma opaca.
  const estTokens = estimateTokens(ctx.text)
    + priorWindow.reduce((n, m) => n + estimateTokens(m.content), 0)
    + estimateTokens(aug) + 400;
  if (estTokens > TOKEN_GUARD &&
      !confirm(`El contexto es grande (~${Math.round(estTokens / 1000)}k tokens): puede ser lento o caro. ¿Enviar igualmente?`)) {
    return;   // se conservan input y referencia adjunta
  }

  els.input.value = '';
  clearRef();
  appendBubble('user', aug, false);
  history.push({ role: 'user', content: aug });
  if (convo) DB.addMessage(convo.id, 'user', aug);

  const bubble = appendBubble('assistant', '', false);
  const textNode = bubble.querySelector('.ai-bubble-text');
  textNode.innerHTML = '<span class="ai-typing">pensando…</span>';
  busy = true; els.send.disabled = true; abortCtrl = new AbortController();
  agentUnread = false; applyAgentBadge();   // si el panel está cerrado, muestra "generando"
  let thinking = true, raw;

  const messages = [
    { role: 'system', content: systemPrompt(convo?.goal, template, Profiles.getActive()) },
    { role: 'user', content: 'LIBRO ANOTADO (cita los pasajes con sus anclas [[aN]]):\n\n' + ctx.text },
    ...priorWindow,
    { role: 'user', content: aug },
  ];

  try {
    raw = await LLM.chatStream({
      messages, signal: abortCtrl.signal,
      onToken: (t) => {
        if (thinking) { thinking = false; textNode.textContent = ''; }
        textNode.textContent += t; scrollDown();
      },
    });
    const finalText = raw || textNode.textContent;
    textNode.innerHTML = renderWithCitations(finalText, anchors);
    addMessageActions(bubble, finalText, q, { autoRun: LLM.getAutoExtract() });
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

// ---- Extracción a la libreta (tool-use, no-streaming) ----------------------

function addMessageActions(bubble, answerText, question, { autoRun = false } = {}) {
  const bar = document.createElement('div');
  bar.className = 'ai-bubble-actions';

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
  const keys = template.fields.map(f => f.key);
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
  const fieldList = template.fields.map(f => `- ${f.key}: ${f.label}`).join('\n');
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
      if (!fieldKey || !content || !isValidField(template.id, fieldKey)) continue;
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
  if (!template) { els.noteView.innerHTML = ''; return; }
  const byField = {};
  for (const n of notes) (byField[n.fieldKey] ||= []).push(n);

  els.noteView.innerHTML = `
    <div class="ai-nb-goal"><span class="ai-nb-goal-label">${icon('target', { size: 15 })} Objetivo</span>${escapeHtml(convo.goal)}</div>
    <div class="ai-nb-tpl">${template.name}</div>
    ${template.fields.map(f => {
      const list = byField[f.key] || [];
      const notesHtml = list.map(noteHtml).join('');
      const adding = addingField === f.key ? editorHtml(`data-field="${f.key}"`, '') : '';
      const addBtn = addingField === f.key ? '' : `<button class="ai-nb-add" data-field="${f.key}">+ nota</button>`;
      return `
      <div class="ai-nb-field">
        <div class="ai-nb-field-label">${escapeHtml(f.label)}</div>
        ${notesHtml || (adding ? '' : '<div class="ai-nb-empty">—</div>')}
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
  if (a) onCite(a.cfi);
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
