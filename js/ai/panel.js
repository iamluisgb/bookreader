// Panel del agente: onboarding (objetivo + plantilla), chat en streaming con citas
// [[aN]] clicables, y libreta estructurada que el agente rellena vía tool-use.
// E1/E2/E3/E5/E6 del backlog. Estado persistido en IndexedDB (E4).
import * as LLM from './llm.js';
import { segmentBook } from './segment.js';
import * as DB from './db.js';
import * as EpubReader from '../epub-reader.js';
import { BLOCKS, TEMPLATES, getTemplate, templatesByBlock, isValidField } from './templates.js';
import { mdToHtml } from './markdown.js';

let els = {};
let book = null, bookId = null, bookTitle = '';
let session = null;          // { templateId, goal }
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

export function init(opts) {
  onCite = opts.onCite || (() => {});
  els.panel = document.getElementById('ai-panel');
  els.panel.innerHTML = TEMPLATE;
  const $ = (s) => els.panel.querySelector(s);
  Object.assign(els, {
    key: $('#ai-key'), model: $('#ai-model'), saveCfg: $('#ai-save-cfg'),
    status: $('#ai-status'), tabs: $('#ai-tabs'),
    chatView: $('#ai-view-chat'), noteView: $('#ai-view-notebook'),
    messages: $('#ai-messages'), input: $('#ai-input'), send: $('#ai-send'), close: $('#ai-close'),
    auto: $('#ai-auto'),
  });

  els.model.innerHTML = LLM.MODELS.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
  els.key.value = LLM.getKey();
  els.model.value = LLM.getModel();
  els.auto.checked = LLM.getAutoExtract();
  toggleConfig(!LLM.hasKey());

  els.saveCfg.addEventListener('click', () => {
    LLM.setKey(els.key.value.trim());
    LLM.setModel(els.model.value);
    LLM.setAutoExtract(els.auto.checked);
    toggleConfig(false);
  });
  $('#ai-edit-cfg').addEventListener('click', () => toggleConfig(true));
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

  // Atenuación de capítulos: perezosa, al abrir el índice (el handler de app.js
  // ya alternó la clase 'open' antes de que llegue este listener).
  document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
    if (document.getElementById('sidebar')?.classList.contains('open')) maybeAttenuate();
  });
}

const TEMPLATE = `
  <div class="ai-header">
    <span class="ai-title">🤖 Agente</span>
    <button id="ai-edit-cfg" class="icon-btn" title="Configuración">⚙️</button>
    <button id="ai-close" class="icon-btn" title="Cerrar">✕</button>
  </div>
  <div id="ai-config" class="ai-config">
    <label>API key de nan</label>
    <input id="ai-key" type="password" placeholder="sk-..." autocomplete="off" />
    <label>Modelo</label>
    <select id="ai-model"></select>
    <label class="ai-check"><input type="checkbox" id="ai-auto" /> Rellenar la libreta automáticamente</label>
    <button id="ai-save-cfg" class="primary-btn ai-save">Guardar</button>
  </div>
  <div id="ai-status" class="ai-status">Abre un EPUB para empezar.</div>
  <div id="ai-tabs" class="ai-tabs" style="display:none">
    <button class="ai-tab active" data-view="chat">💬 Chat</button>
    <button class="ai-tab" data-view="notebook">📓 Libreta</button>
  </div>
  <div id="ai-view-chat" class="ai-view active">
    <div id="ai-messages" class="ai-messages"></div>
    <div class="ai-composer">
      <textarea id="ai-input" rows="2" placeholder="Pregunta sobre el libro..."></textarea>
      <button id="ai-send" class="primary-btn ai-send">Enviar</button>
    </div>
  </div>
  <div id="ai-view-notebook" class="ai-view"></div>
`;

export function setOpen(open) {
  document.body.classList.toggle('ai-open', open);
  if (!open) return;
  if (book && !session) openOnboarding();   // primer uso del agente con este libro
  else if (session) els.input?.focus();
}
export function isOpen() { return document.body.classList.contains('ai-open'); }

function showView(view) {
  els.tabs.querySelectorAll('.ai-tab').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  els.chatView.classList.toggle('active', view === 'chat');
  els.noteView.classList.toggle('active', view === 'notebook');
  if (view === 'notebook') els.tabs.querySelector('.ai-tab[data-view="notebook"]')?.classList.remove('ai-tab-unread');
}

// ---- Carga de libro --------------------------------------------------------

export async function setBook(b, id, title) {
  book = b; bookId = id || null; bookTitle = title || 'Libro';
  session = null; template = null; history = []; notes = [];
  editingId = null; addingField = null; attenuationDone = false;
  clearChapterAttenuation();
  annotatedText = ''; anchors = new Map();
  segReady = false; segBlocks = 0; segCached = false;
  els.messages.innerHTML = '';
  els.tabs.style.display = 'none';
  showView('chat');
  if (!book) { setStatus('Abre un EPUB para empezar.'); return; }

  // Sesión existente: activar. Si no hay, el onboarding se mostrará al abrir el
  // panel (no aquí, para no tapar el lector con un modal en cada carga).
  session = bookId ? await DB.getSession(bookId) : null;
  if (session) {
    template = getTemplate(session.templateId);
    await activateSession();
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
  if (hqaBusy || !session || template?.id !== 'hqa') return;
  let text = '';
  try { text = (contents?.window?.getSelection()?.toString() || '').trim(); } catch { /* sin acceso */ }
  if (text.length < 8) return;
  await generateHQA(text, cfiRange);
}

async function generateHQA(text, cfiRange) {
  hqaBusy = true;
  setStatus('✍️ Generando HQ&A del subrayado…');
  try {
    const messages = [
      { role: 'system', content:
`Aplicas el método HQ&A (Highlight–Question–Answer). Dado un FRAGMENTO subrayado y el OBJETIVO
del usuario, genera: (1) una PREGUNTA conceptual que ese fragmento responde, alineada al objetivo;
(2) una RESPUESTA breve con palabras propias, sin copiar el fragmento.
Responde EXACTAMENTE en dos líneas, sin nada más:
P: <pregunta>
R: <respuesta>` },
      { role: 'user', content: `OBJETIVO: ${session.goal}\n\nFRAGMENTO SUBRAYADO:\n"${text}"` },
    ];
    const out = await LLM.chatStream({ messages });
    const q = (out.match(/P:\s*(.+)/i)?.[1] || '').trim();
    const a = (out.match(/R:\s*([\s\S]+)/i)?.[1] || '').trim();
    const content = `> ${text}\n\n**P:** ${q || '—'}\n**R:** ${a || '—'}`;
    const id = bookId ? await DB.addNote(bookId, 'hqa', content, [cfiRange]) : Date.now();
    notes.push({ id, fieldKey: 'hqa', content, sourceCfis: [cfiRange] });
    renderNotebook();
    markNotebookUnread();
    setStatus('📓 HQ&A añadido a la libreta');
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
}

async function activateSession() {
  els.tabs.style.display = 'flex';
  notes = bookId ? await DB.getNotes(bookId) : [];
  renderNotebook();
  await restoreChat();
  refreshStatus();
}

// ---- Atenuación de capítulos en el índice (E6.4) ---------------------------
// Puntúa cada capítulo del TOC por relevancia al objetivo y atenúa los flojos.
// Decora el #toc-list que renderiza app.js (sin tocar su código), emparejando
// por etiqueta. Resultados cacheados por libro+objetivo.

async function maybeAttenuate() {
  if (attenuationDone || !session || !template || !segReady || !book) return;
  if (!LLM.hasKey()) return;
  const toc = book.navigation?.toc;
  if (!toc || !toc.length) return;
  attenuationDone = true;

  try {
    let cached = bookId ? await DB.getRatings(bookId) : null;
    let scores = (cached && cached.goal === session.goal) ? cached.scores : null;
    if (!scores) {
      scores = await computeChapterRelevance(toc);
      if (scores && bookId) await DB.saveRatings(bookId, session.goal, scores);
    }
    if (scores) applyChapterAttenuation(scores);
  } catch (e) {
    console.warn('Atenuación de capítulos falló:', e);
    attenuationDone = false; // permitir reintento en otra carga
  }
}

async function computeChapterRelevance(toc) {
  const chapters = toc.map(t => t.label.trim()).filter(Boolean);
  const tools = [{
    type: 'function',
    function: {
      name: 'rate_chapters',
      description: 'Puntúa la relevancia de cada capítulo para el objetivo del usuario.',
      parameters: {
        type: 'object',
        properties: {
          ratings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                chapter: { type: 'string', description: 'Título exacto del capítulo.' },
                score: { type: 'number', description: 'Relevancia 0 (irrelevante) a 1 (muy relevante).' },
              },
              required: ['chapter', 'score'],
            },
          },
        },
        required: ['ratings'],
      },
    },
  }];
  const messages = [
    { role: 'system', content:
`Evalúas qué capítulos de un libro sirven al OBJETIVO del usuario. Usa la herramienta
rate_chapters una sola vez, puntuando TODOS los capítulos de la lista de 0 a 1 según su
relevancia para el objetivo (1 = central, 0 = paja/introducción/anécdota).` },
    { role: 'user', content: 'LIBRO ANOTADO:\n\n' + annotatedText },
    { role: 'user', content:
`OBJETIVO: ${session.goal}\n\nCAPÍTULOS A PUNTUAR (usa estos títulos exactos):\n` +
      chapters.map(c => `- ${c}`).join('\n') },
  ];
  const { toolCalls } = await LLM.chatTools({ messages, tools, toolChoice: 'auto' });
  const call = toolCalls.find(t => t.name === 'rate_chapters');
  if (!call || !Array.isArray(call.args.ratings)) return null;
  const scores = {};
  for (const r of call.args.ratings) {
    if (typeof r.chapter === 'string' && typeof r.score === 'number') {
      scores[r.chapter.trim()] = Math.max(0, Math.min(1, r.score));
    }
  }
  return Object.keys(scores).length ? scores : null;
}

function applyChapterAttenuation(scores) {
  const links = document.querySelectorAll('#toc-list a');
  links.forEach(a => {
    const label = a.textContent.trim();
    if (!(label in scores)) return;
    const s = scores[label];
    a.classList.remove('ai-toc-low', 'ai-toc-mid', 'ai-toc-high');
    if (s >= 0.66) a.classList.add('ai-toc-high');
    else if (s >= 0.33) a.classList.add('ai-toc-mid');
    else a.classList.add('ai-toc-low');
    a.title = `Relevancia para tu objetivo: ${Math.round(s * 100)}%`;
  });
}

function clearChapterAttenuation() {
  document.querySelectorAll('#toc-list a').forEach(a => {
    a.classList.remove('ai-toc-low', 'ai-toc-mid', 'ai-toc-high');
    a.removeAttribute('title');
  });
}

async function restoreChat() {
  els.messages.innerHTML = '';
  const msgs = bookId ? await DB.getMessages(bookId) : [];
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
  document.body.appendChild(overlay);

  let chosenBlock = null, chosenTemplate = null;

  const renderBlocks = () => {
    overlay.innerHTML = `
      <div class="ai-ob-card">
        <h2>¿Cuál es tu objetivo con este libro?</h2>
        <p class="ai-ob-sub">Elige un enfoque de lectura.</p>
        <div class="ai-ob-blocks">
          ${Object.values(BLOCKS).map(bl => `
            <button class="ai-ob-block" data-block="${bl.id}">
              <span class="ai-ob-block-label">${bl.label}</span>
              <span class="ai-ob-block-hint">${bl.hint}</span>
            </button>`).join('')}
        </div>
      </div>`;
    overlay.querySelectorAll('.ai-ob-block').forEach(btn =>
      btn.addEventListener('click', () => { chosenBlock = btn.dataset.block; renderTemplates(); }));
  };

  const renderTemplates = () => {
    const list = templatesByBlock(chosenBlock);
    overlay.innerHTML = `
      <div class="ai-ob-card">
        <button class="ai-ob-back">← volver</button>
        <h2>Elige una plantilla</h2>
        <div class="ai-ob-templates">
          ${list.map(t => `
            <button class="ai-ob-tpl" data-tpl="${t.id}">
              <span class="ai-ob-tpl-name">${t.name}</span>
              <span class="ai-ob-tpl-ideal">${t.ideal}</span>
            </button>`).join('')}
        </div>
      </div>`;
    overlay.querySelector('.ai-ob-back').addEventListener('click', renderBlocks);
    overlay.querySelectorAll('.ai-ob-tpl').forEach(btn =>
      btn.addEventListener('click', () => { chosenTemplate = getTemplate(btn.dataset.tpl); renderGoal(); }));
  };

  const renderGoal = () => {
    overlay.innerHTML = `
      <div class="ai-ob-card">
        <button class="ai-ob-back">← volver</button>
        <h2>${chosenTemplate.name}</h2>
        <p class="ai-ob-sub">${chosenTemplate.goalPrompt}</p>
        <textarea id="ai-ob-goal" class="ai-ob-goal" rows="3" placeholder="Tu objetivo..."></textarea>
        <button id="ai-ob-start" class="primary-btn ai-ob-start">Empezar a leer con objetivo</button>
      </div>`;
    overlay.querySelector('.ai-ob-back').addEventListener('click', renderTemplates);
    const goalEl = overlay.querySelector('#ai-ob-goal');
    goalEl.focus();
    overlay.querySelector('#ai-ob-start').addEventListener('click', async () => {
      const goal = goalEl.value.trim();
      if (!goal) { goalEl.focus(); return; }
      session = { templateId: chosenTemplate.id, goal };
      template = chosenTemplate;
      if (bookId) await DB.saveSession(bookId, chosenTemplate.id, goal);
      overlay.remove();
      await activateSession();
      setOpen(true);
    });
  };

  renderBlocks();
}

// ---- Chat ------------------------------------------------------------------

function systemPrompt() {
  const fields = template ? template.fields.map(f => `- ${f.key}: ${f.label}`).join('\n') : '';
  return `Eres un lector experto que ayuda a sacar provecho de un libro según un OBJETIVO concreto.
Respondes en español, conciso y sin paja, basándote ÚNICAMENTE en el libro entregado.

OBJETIVO DEL USUARIO: ${session?.goal || '(sin definir)'}
PLANTILLA: ${template?.name || '—'} — ${template?.agentRole || ''}
Filtra el contenido hacia ese objetivo: ignora lo anecdótico, resalta lo aplicable.

CITAS (obligatorio): el libro viene troceado en pasajes precedidos por anclas [[aN]].
Cada afirmación basada en el libro debe llevar su cita [[aN]] usando identificadores reales del texto.
Incluye al menos una cita por respuesta sobre el contenido. No inventes anclas.

La libreta del usuario tiene estos campos (no los rellenas tú aquí, solo respondes):
${fields}`;
}

async function send() {
  if (busy) return;
  const q = els.input.value.trim();
  if (!q) return;
  if (!LLM.hasKey()) { toggleConfig(true); setStatus('Introduce tu API key primero.'); return; }
  if (!annotatedText) { setStatus('El libro aún no está listo.'); return; }

  els.input.value = '';
  appendBubble('user', q, false);
  history.push({ role: 'user', content: q });
  if (bookId) DB.addMessage(bookId, 'user', q);

  const bubble = appendBubble('assistant', '', false);
  const textNode = bubble.querySelector('.ai-bubble-text');
  textNode.innerHTML = '<span class="ai-typing">pensando…</span>';
  busy = true; els.send.disabled = true; abortCtrl = new AbortController();
  let thinking = true, raw = '';

  const messages = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: 'LIBRO ANOTADO (cita los pasajes con sus anclas [[aN]]):\n\n' + annotatedText },
    ...history.slice(0, -1),
    { role: 'user', content: q },
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
    textNode.innerHTML = renderWithCitations(finalText);
    addMessageActions(bubble, finalText, q, { autoRun: LLM.getAutoExtract() });
    history.push({ role: 'assistant', content: finalText });
    if (bookId) DB.addMessage(bookId, 'assistant', finalText);
  } catch (e) {
    if (e.name === 'AbortError') textNode.textContent += ' [cancelado]';
    else { console.error(e); textNode.innerHTML = `<span class="ai-error">${escapeHtml(e.message)}</span>`; }
  } finally {
    busy = false; els.send.disabled = false; abortCtrl = null; scrollDown();
  }
}

// ---- Extracción a la libreta (tool-use, no-streaming) ----------------------

function addMessageActions(bubble, answerText, question, { autoRun = false } = {}) {
  const bar = document.createElement('div');
  bar.className = 'ai-bubble-actions';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'ai-act ai-copy';
  copyBtn.textContent = '⧉ Copiar';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(answerText);
      copyBtn.textContent = '✓ Copiado';
    } catch {
      // Fallback para contextos sin Clipboard API.
      const ta = document.createElement('textarea');
      ta.value = answerText; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); copyBtn.textContent = '✓ Copiado'; }
      catch { copyBtn.textContent = 'error'; }
      ta.remove();
    }
    setTimeout(() => { copyBtn.textContent = '⧉ Copiar'; }, 1500);
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
    ex.textContent = '📓 A la libreta';
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
  el.textContent = '📓 apuntando…';
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
`OBJETIVO: ${session.goal}\n\nPREGUNTA: ${question}\n\nRESPUESTA DEL AGENTE:\n${answerText}` },
  ];
  try {
    const { toolCalls } = await LLM.chatTools({ messages, tools: notebookTool(), toolChoice: 'auto' });
    let added = 0;
    for (const tc of toolCalls) {
      if (tc.name !== 'upsert_note') continue;
      const { fieldKey, content, sourceCfis } = tc.args || {};
      if (!fieldKey || !content || !isValidField(template.id, fieldKey)) continue;
      const cites = extractCites(content, sourceCfis);
      const id = bookId ? await DB.addNote(bookId, fieldKey, content, cites) : Date.now();
      notes.push({ id, fieldKey, content, sourceCfis: cites });
      added++;
    }
    renderNotebook();
    el.textContent = added ? `📓 ${added} a la libreta` : '📓 nada que guardar';
    if (added) {
      if (isBtn) showView('notebook');         // manual: el usuario lo pidió → mostrar
      else markNotebookUnread();               // auto: avisar sin interrumpir el chat
    }
  } catch (e) {
    console.error('Extracción falló:', e);
    el.textContent = '📓 error al apuntar';
  } finally {
    // Solo el botón se restaura para poder reintentar; el indicador auto se queda.
    if (isBtn) setTimeout(() => { el.disabled = false; el.textContent = '📓 A la libreta'; }, 2500);
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
    ? `<button class="ai-nb-goto" data-cfi="${escapeHtml(navCfi)}" title="Ir al subrayado">↗</button>`
    : '';
  return `
    <div class="ai-nb-note" data-id="${n.id}">
      <div class="ai-nb-note-text">${renderWithCitations(n.content)}</div>
      <div class="ai-nb-note-tools">
        ${gotoBtn}
        <button class="ai-nb-edit" data-id="${n.id}" title="Editar">✎</button>
        <button class="ai-nb-del" data-id="${n.id}" title="Eliminar">✕</button>
      </div>
    </div>`;
}

function renderNotebook() {
  if (!template) { els.noteView.innerHTML = ''; return; }
  const byField = {};
  for (const n of notes) (byField[n.fieldKey] ||= []).push(n);

  els.noteView.innerHTML = `
    <div class="ai-nb-goal"><span class="ai-nb-goal-label">🎯 Objetivo</span>${escapeHtml(session.goal)}</div>
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
      if (bookId) await DB.updateNote(id, { content: val, sourceCfis: cites });
      const note = notes.find(n => n.id === id);
      if (note) { note.content = val; note.sourceCfis = cites; }
    } else if (val && field) {
      const cites = extractCites(val, []);
      const newId = bookId ? await DB.addNote(bookId, field, val, cites) : Date.now();
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
    if (bookId) DB.deleteNote(id);
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
  if (asHtml) node.innerHTML = renderWithCitations(text);
  else node.textContent = text;
  els.messages.appendChild(div);
  if (asHtml && role === 'assistant' && text) addMessageActions(div, text, '');
  scrollDown();
  return div;
}

// Markdown -> HTML (seguro) y luego anclas [[aN]]/aN -> chips clicables.
function renderWithCitations(text) {
  return citeReplace(mdToHtml(text));
}

function citeReplace(html) {
  return html.replace(/\[\[(a\d+)\]\]|\b(a\d+)\b/g, (m, p1, p2) => {
    const id = p1 || p2;
    return anchors.has(id)
      ? `<button class="ai-cite" data-id="${id}" title="Ir al pasaje">${id}</button>`
      : m;
  });
}

function setStatus(s) {
  if (!els.status) return;
  els.status.textContent = s;
  // Shimmer mientras el agente trabaja (mensajes que terminan en "…").
  els.status.classList.toggle('ai-status--busy', /…\s*$/.test(s));
}
function scrollDown() { if (els.messages) els.messages.scrollTop = els.messages.scrollHeight; }
function toggleConfig(show) { els.panel.querySelector('#ai-config').style.display = show ? 'block' : 'none'; }
function escapeHtml(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }
