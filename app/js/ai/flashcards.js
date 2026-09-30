// Flashcards para Anki (feature estrella del plan de lanzamiento): el agente genera
// tarjetas de estudio desde el libro (capítulo o libro entero, básicas o cloze), el
// usuario las revisa/edita en un modal y las exporta a .apkg (paquete nativo de Anki)
// o .txt (import de texto). Los mazos generados persisten en IndexedDB (store `decks`)
// para re-exportarlos sin regenerar (sin re-gastar tokens).
//
// El panel abre el modal con `open(ctx)`; este módulo no guarda estado del libro entre
// aperturas: todo llega en ctx (bookId, título, objetivo, TOC, ensureIndex del panel).
import { t } from '../i18n.js';
import * as LLM from './llm.js';
import * as DB from './db.js';
import * as Retrieval from './retrieval.js';
import { estimateTokens } from './context.js';
import { icon } from '../ui/icons.js';
import { escapeHtml } from '../ui/escape.js';
import { confirmBox } from '../ui/dialog.js';
import { buildApkg, buildAnkiTxt } from './anki-export.js';
import { downloadText } from '../backup.js';
import * as Srs from './srs.js';
import * as Study from './study.js';
import * as Jobs from './jobs.js';
import { balancedObjects } from './query-expand.js';
import { getBook } from '../library/store.js';
import { ensureBookFigures } from './visual-figures.js';
import { buildVisualCards, VISUAL_TYPES } from './visual-deck.js';
import { chapterList, suggestPlan, MAX_PLAN_CHAPTERS } from './card-plan.js';
import { normalizeDomain, parseDomainSuggestions, groupCardsByDomain, domainTagMessages } from './domain-tags.js';
import { toast } from './toast.js';
import * as PdfReader from '../pdf-reader.js';

// Generación por TROZOS (map-reduce): el material se divide en trozos de ~CHUNK_TOKENS
// y cada llamada produce SOLO las tarjetas de su trozo (cupo proporcional). Así ninguna
// llamada puede truncarse (entrada y salida acotadas por diseño, clave con modelos
// reasoning cuyo razonamiento consume el mismo cupo de tokens que la salida), hay éxito
// parcial (un trozo fallido no tira el mazo) y el progreso es real.
// - Capítulo: se cubre ENTERO (antes se cortaba a 12k tokens).
// - Libro entero: muestra round-robin por capítulo hasta BOOK_TOKENS (coste acotado y
//   cobertura uniforme; cubrir 100% un libro de 200k tokens para 30 tarjetas es gastar de más).
const CHUNK_TOKENS = 10000;
const BOOK_TOKENS = 40000;
const COUNTS = [10, 15, 20, 30];
const MAX_PREV_FRONTS = 40;   // nº de frentes previos que se pasan al siguiente trozo (anti-duplicados)
// Tipos de TEXTO multi-selección (orden estable: basic siempre primero). El "solo
// visuales" ya no es opción: es el caso implícito de no marcar ningún tipo de texto.
const TEXT_TYPES = ['basic', 'cloze'];
// Nombre del tipo DENTRO de los prompts (contenido para el modelo, no UI: no pasa por t()).
const TYPE_NAMES = { basic: 'Pregunta → Respuesta', cloze: 'Cloze (huecos)' };

let ctx = null;        // { bookId, bookTitle, goal, tocLabels, currentChapter, ensureIndex }
let overlay = null;
let generating = false;   // hay un job de flashcards de ESTE libro en curso (solo para la UI)
let unsubJobs = null;     // suscripción a jobs.js mientras el modal está abierto
let scopeValue = '';   // alcance elegido: '' = libro entero, o la etiqueta del capítulo
let mergeInto = null;  // id del mazo existente al que AÑADIR (P24 F4), o null = mazo nuevo
// WU5 · Plan de tarjetas por capítulo activo: lo produce suggestPlan y lo edita la tabla.
// Es la fuente de verdad de la generación mientras exista (el selector de cantidad se
// ignora); un cambio de alcance lo limpia (un plan de libro entero no sirve para un
// capítulo suelto).
let planState = null;  // { plan: [{ name, cards, reason }], source, adjusted, notes, total }
// Tope de llamadas de las familias visuales por alcance (los caps de buildVisualCards):
// sirve para el coste estimado del plan (las visuales corren UNA vez por corrida).
const VISUAL_CALL_CAPS = { occlusion: 6, diagram: 2, drawing: 1 };
// Umbral a partir del cual el desplegable de alcance muestra buscador (índices largos).
const SCOPE_SEARCH_MIN = 8;

export function open(context) {
  ctx = context;
  closeModal();
  overlay = document.createElement('div');
  overlay.id = 'ai-flashcards';
  overlay.className = 'ai-onboarding';
  overlay.innerHTML = `
    <div class="ai-ob-card fc-card" role="dialog" aria-modal="true" aria-label="${t('Flashcards para Anki')}">
      <button class="ai-ob-close" title="${t('Cerrar')}" aria-label="${t('Cerrar')}">${icon('xmark', { size: 18 })}</button>
      <div class="ai-ob-body"></div>
    </div>`;
  document.body.appendChild(overlay);
  // Cerrar el modal ya NO cancela la generación (F4): el trabajo sigue en segundo plano y
  // el chip de jobs-ui avisa al terminar. Para cancelar de verdad está la × del chip.
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeModal(); });
  overlay.querySelector('.ai-ob-close').addEventListener('click', closeModal);
  document.addEventListener('keydown', onKey);
  planState = null;   // el plan no sobrevive a la apertura: se vuelve a sugerir si hace falta
  renderSetup();
  // Al suscribirse, jobs.js entrega el trabajo activo de inmediato: si se reabre el modal
  // con una generación en curso (o recién terminada) se cae en la rama que toca.
  unsubJobs = Jobs.subscribe(onJobUpdate);
}

function onKey(e) {
  if (Study.isOpen()) return;   // el overlay de estudio va encima: su ESC no cierra este modal
  if (e.key === 'Escape' && overlay) closeModal();
}

function closeModal() {
  document.removeEventListener('keydown', onKey);
  if (overlay) { overlay.remove(); overlay = null; }
  if (unsubJobs) { unsubJobs(); unsubJobs = null; }
  generating = false;
}

const body = () => overlay?.querySelector('.ai-ob-body');

// ---- Vista 1: configurar y generar ------------------------------------------

async function renderSetup() {
  const b = body();
  if (!b) return;
  // El plan no sobrevive a un re-render del setup («Volver» desde la revisión): la tabla
  // se pintaría vacía con el estado activo. Se vuelve a sugerir si hace falta.
  planState = null;
  // Solo capítulos con texto indexado (fuera cubierta, copyright…); el actual se
  // preselecciona solo si tiene contenido — si no, "Libro entero".
  ctx.ensureIndex();
  const chapters = (ctx.tocLabels || []).filter(c => c && Retrieval.passagesByChapter(c).length);
  // Alcance por defecto: el capítulo que se lee (si tiene contenido), si no el libro entero.
  scopeValue = chapters.includes(ctx.currentChapter) ? ctx.currentChapter : '';
  // IA8 · En libros grandes (el muestreo cubre <50% del texto), 15 tarjetas dejan fuera
  // conceptos centrales (medido: cobertura 1/8 en Pro Git). Sugerimos 30 por defecto.
  const totalTokens = Retrieval.allPassages().reduce((n, p) => n + estimateTokens(p.text), 0);
  const defaultCount = totalTokens > BOOK_TOKENS * 2 ? 30 : 15;
  const options = [{ value: '', label: t('Libro entero') }, ...chapters.map(c => ({ value: c, label: c }))];  b.innerHTML = `
    <h2>${t('Flashcards para Anki')}</h2>
    <p class="ai-ob-sub">${t('El agente crea tarjetas de estudio desde el libro; revísalas y expórtalas a Anki.')}</p>
    <label class="fc-label" id="fc-scope-label">${t('Contenido')}</label>
    <div id="fc-scope"></div>
    <label class="fc-label">${t('Tipo de tarjeta')}</label>
    <p class="fc-sublabel">${t('Tarjetas de texto')} · <span class="fc-sublabel-note">${t('la cantidad se reparte entre los tipos que marques')}</span></p>
    <div class="fc-types">
      <label class="fc-type"><input type="checkbox" name="fc-type" value="basic" checked>
        <span><b>${t('Pregunta → Respuesta')}</b><small>${t('Conceptos y definiciones.')}</small></span></label>
      <label class="fc-type"><input type="checkbox" name="fc-type" value="cloze">
        <span><b>${t('Cloze (huecos)')}</b><small>${t('Una frase con el dato clave oculto.')}</small></span></label>
    </div>
    <p class="fc-sublabel">${t('Tarjetas visuales')} · <span class="fc-sublabel-note">${t('se suman aparte')}</span></p>
    <div class="fc-types fc-vtypes">
      <label class="fc-type"><input type="checkbox" name="fc-vtype" value="occlusion">
        <span><b>${t('Oclusión de figuras')}</b><small>${t('Tapamos una parte de un diagrama del libro.')}</small></span></label>
      <label class="fc-type"><input type="checkbox" name="fc-vtype" value="diagram">
        <span><b>${t('Diagrama')}</b><small>${t('El agente dibuja el esquema y falta un paso.')}</small></span></label>
      <label class="fc-type"><input type="checkbox" name="fc-vtype" value="drawing">
        <span><b>${t('Dibujo de memoria')}</b><small>${t('Dibujas el proceso y el agente revisa tu boceto.')}</small></span></label>
    </div>
    <p class="ai-ob-sub" id="fc-vhint" hidden>${t('Las figuras se extraen del libro en la primera generación: la primera vez tarda más.')}</p>
    <label class="fc-label" for="fc-count">${t('Cantidad')}</label>
    <div class="fc-count-row">
      <select id="fc-count" class="fc-select">${COUNTS.map(n => `<option ${n === defaultCount ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <button id="fc-plan-btn" type="button" class="fc-plan-btn" hidden>${icon('sparkles', { size: 14 })} ${t('Sugerir cantidades')}</button>
    </div>
    <p class="ai-ob-sub fc-plan-note" id="fc-plan-note" hidden>${t('El plan manda: se ignora la cantidad de arriba.')}</p>
    <div id="fc-plan"></div>
    <p class="ai-ob-sub" id="fc-split" hidden></p>
    <div id="fc-dup"></div>
    <button id="fc-generate" class="primary-btn ai-ob-start">${icon('sparkles', { size: 16 })} ${t('Generar tarjetas')}</button>
    <div id="fc-error" class="fc-error" style="display:none"></div>
    <div id="fc-decks"></div>`;
  mountScopeCombo(b.querySelector('#fc-scope'), options, scopeValue, (v) => {
    scopeValue = v;
    clearPlan();        // un plan de libro entero no sirve para otro alcance (WU5)
    refreshDupNote();
  });
  b.querySelector('#fc-generate').addEventListener('click', onGenerate);
  b.querySelector('#fc-plan-btn').addEventListener('click', onSuggestPlan);
  b.querySelectorAll('input[name="fc-type"], input[name="fc-vtype"]').forEach(el =>
    el.addEventListener('change', () => { refreshGenerateState(); refreshSplitHint(); refreshDupNote(); refreshPlanFooter(); }));
  b.querySelector('#fc-count').addEventListener('change', refreshSplitHint);
  refreshGenerateState();
  refreshSplitHint();
  refreshPlanUI();   // estado inicial del botón/nota del plan (WU5)
  renderDeckList();
  refreshDupNote();
}

// Selección del menú multi-tipo: tipos de TEXTO marcados (en orden estable) y familias
// visuales marcadas. Única fuente de verdad para el tipo efectivo del mazo. Con ambos
// tipos de texto marcados se generan DOS pasadas (una por tipo); sin ninguno, solo
// visuales (el antiguo radio "none", ahora implícito).
function selectedTypes() {
  const b = body();
  const text = TEXT_TYPES.filter(tp => b?.querySelector(`input[name="fc-type"][value="${tp}"]`)?.checked);
  const visual = [...(b?.querySelectorAll('input[name="fc-vtype"]:checked') || [])]
    .map(el => el.value).filter(v => VISUAL_TYPES.includes(v));
  return { text, visual };
}

// Tipo con el que se etiqueta el mazo: "mixed" cuando se combina más de una cosa (dos
// tipos de texto, o texto con visuales); si no, el único tipo elegido. Sin nada (botón
// deshabilitado) cae a "basic" para no propagar un array vacío.
function effectiveDeckType(sel) {
  const picked = sel.text.length + sel.visual.length;
  if (picked >= 2) return 'mixed';
  return sel.text[0] || sel.visual[0] || 'basic';
}

// Reparte el total ENTRE los tipos de texto elegidos: el total es la SUMA y las partes
// son iguales, con el resto para los primeros del orden estable (20 → 10/10;
// 15 → 8/7; 10 → 5/5). Pura, testeable.
export function splitQuota(total, types) {
  const n = Math.max(1, types);
  const base = Math.floor(total / n);
  const rem = total % n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}

// El botón de generar solo se habilita con ALGO elegido: ningún tipo de texto ni familia
// visual no produciría tarjetas. El hint de figuras se muestra en cuanto hay una familia
// visual; el hint de reparto, solo con DOS tipos de texto (la cantidad se divide).
function refreshGenerateState() {
  const b = body();
  const btn = b?.querySelector('#fc-generate');
  const hint = b?.querySelector('#fc-vhint');
  const sel = selectedTypes();
  if (btn) btn.disabled = !sel.text.length && !sel.visual.length;
  if (hint) hint.hidden = !sel.visual.length;
}

// Con dos tipos de texto el total se divide entre pasadas: se lo decimos ANTES de
// generar (15 → 8 P→R + 7 Cloze) y avisamos de que las visuales añaden las suyas aparte.
function refreshSplitHint() {
  const b = body();
  const el = b?.querySelector('#fc-split');
  if (!el) return;
  const sel = selectedTypes();
  if (sel.text.length < 2) { el.hidden = true; return; }
  const count = parseInt(b.querySelector('#fc-count').value, 10);
  const [a, r] = splitQuota(count, sel.text.length);
  el.textContent = t('{n} en total · {a} P→R + {b} Cloze', { n: count, a, b: r })
    + (sel.visual.length ? ' ' + t('Las tarjetas visuales se suman aparte.') : '');
  el.hidden = false;
}

// WU5 · Plan editable por capítulo ------------------------------------------------

// Quita el plan activo y vuelve al flujo normal (el selector de cantidad vuelve a mandar).
// Se dispara con «Quitar plan» y con CUALQUIER cambio de alcance: un plan de libro
// entero no significa nada para un capítulo suelto.
function clearPlan() {
  planState = null;
  renderPlanTable();
  refreshPlanUI();
}

async function onSuggestPlan() {
  const b = body();
  const btn = b?.querySelector('#fc-plan-btn');
  if (!b || !btn) return;
  const chapters = chapterList(Retrieval.allPassages());
  if (!chapters.length) { showError(t('Ese libro no tiene capítulos con contenido para planificar.')); return; }
  const total = parseInt(b.querySelector('#fc-count').value, 10);
  btn.disabled = true;
  btn.classList.add('is-busy');
  try {
    const res = await suggestPlan({ bookTitle: ctx.bookTitle, goal: ctx.goal, chapters, total });
    planState = { ...res, total };
    renderPlanTable();
    refreshPlanUI();
  } catch (e) {
    if (e.name === 'AbortError') return;   // cancelar es del usuario: sin aviso
    showError(t('No se pudo sugerir el plan: {msg}', { msg: e.message }));
  } finally {
    if (btn.isConnected) { btn.disabled = false; btn.classList.remove('is-busy'); }
  }
}

// Visibilidad del plan: el botón SOLO tiene sentido con el libro entero (un capítulo
// suelto no tiene nada que repartir) y sin plan activo (para eso está «Quitar plan»). La
// nota de "el plan manda" solo con plan activo.
function refreshPlanUI() {
  const b = body();
  if (!b) return;
  const btn = b.querySelector('#fc-plan-btn');
  if (btn) btn.hidden = !!scopeValue || !!planState;
  const note = b.querySelector('#fc-plan-note');
  if (note) note.hidden = !planState;
}

// Tabla editable: nombre + motivo del agente por fila, número editable, total vivo y
// coste estimado honesto (capítulos con tarjetas × tipos de texto + los topes propios de
// las familias visuales, que corren UNA vez por corrida). El marcador de fallback es la
// parte honesta: si el agente no dio un plan usable, se dice.
function renderPlanTable() {
  const host = body()?.querySelector('#fc-plan');
  if (!host) return;
  if (!planState) { host.innerHTML = ''; return; }
  const rows = planState.plan.map((row, i) => `
    <tr class="fc-plan-row" data-i="${i}">
      <td class="fc-plan-name">${escapeHtml(row.name)}${row.reason ? `<small class="fc-plan-reason">${escapeHtml(row.reason)}</small>` : ''}</td>
      <td class="fc-plan-count"><input type="number" class="fc-plan-num" min="0" max="999" step="1" value="${row.cards}" data-i="${i}" aria-label="${t('Tarjetas para este capítulo')}"></td>
    </tr>`).join('');
  host.innerHTML = `
    ${planState.source !== 'agent' ? `<p class="fc-plan-src">${t('reparto automático (el agente no dio un plan usable)')}</p>` : ''}
    <table class="fc-plan-table"><tbody>${rows}</tbody></table>
    <div class="fc-plan-foot">
      <span class="fc-plan-total"></span>
      <span class="fc-plan-cost"></span>
      <button id="fc-plan-clear" type="button" class="fc-txt-btn">${t('Quitar plan')}</button>
    </div>`;
  host.querySelector('#fc-plan-clear').addEventListener('click', clearPlan);
  host.oninput = (e) => {
    const inp = e.target.closest('.fc-plan-num');
    if (!inp) return;
    const i = parseInt(inp.dataset.i, 10);
    planState.plan[i].cards = Math.max(0, Math.floor(Number(inp.value) || 0));
    refreshPlanFooter();
  };
  refreshPlanFooter();
}

// Total vivo y coste estimado del plan activo; se recalcula al editar números y al
// cambiar la selección de tipos (el coste depende de ambas cosas).
function refreshPlanFooter() {
  const b = body();
  if (!b || !planState) return;
  const total = b.querySelector('.fc-plan-total');
  if (!total) return;
  const sum = planState.plan.reduce((s, r) => s + r.cards, 0);
  total.textContent = t('{n} en total', { n: sum });
  const sel = selectedTypes();
  let calls = planState.plan.filter(r => r.cards > 0).length * sel.text.length;
  for (const v of sel.visual) calls += VISUAL_CALL_CAPS[v] || 0;
  const cost = b.querySelector('.fc-plan-cost');
  if (cost) cost.textContent = t('≈ {n} llamadas al modelo', { n: calls });
}

// P24 F4 · Regenerar el mismo alcance creaba un mazo PARALELO: el anti-duplicados
// (`prevFronts`) solo actúa dentro de una generación, así que las dos copias acaban
// compitiendo en la misma cola diaria y el lector repasa dos veces lo mismo sin saber por
// qué. Si ya hay un mazo de este contenido, se ofrece AÑADIRLE lo que salga nuevo — y por
// defecto sí, que es lo que casi siempre se quiere.
async function refreshDupNote() {
  const b = body();
  const host = b?.querySelector('#fc-dup');
  if (!host || !ctx.bookId) { mergeInto = null; return; }
  const type = effectiveDeckType(selectedTypes());
  const decks = await DB.getDecks(ctx.bookId);
  if (!overlay || !b.isConnected) return;             // el modal se cerró mientras leía la BD
  const hit = decks.find(d => (d.scope || '') === scopeValue && d.cardType === type && DB.cardsOf(d).length);
  mergeInto = hit ? hit.id : null;
  host.innerHTML = hit
    ? `<label class="fc-dup"><input type="checkbox" id="fc-merge" checked>
        <span>${t('Ya tienes un mazo de este contenido ({n} tarjetas). Añádele solo lo que salga nuevo en vez de crear otro.', { n: DB.cardsOf(hit).length })}</span>
      </label>`
    : '';
}

// Desplegable propio para el alcance (sustituye al <select> nativo, que ignoraba el tema y
// no permitía buscar). Botón + popover con buscador (si hay muchos capítulos) y lista
// filtrable. Cohesión con el lenguaje visual y usable en índices largos.
function mountScopeCombo(host, options, selected, onChange) {
  const withSearch = options.length > SCOPE_SEARCH_MIN;
  const labelOf = (v) => (options.find(o => o.value === v) || options[0]).label;
  host.className = 'fc-combo';
  host.innerHTML = `
    <button type="button" class="fc-combo-btn" aria-haspopup="listbox" aria-expanded="false">
      <span class="fc-combo-val">${escapeHtml(labelOf(selected))}</span>
      ${icon('chevron-down', { size: 16 })}
    </button>
    <div class="fc-combo-pop" hidden>
      ${withSearch ? `<input class="fc-combo-search" type="text" placeholder="${t('Buscar capítulo…')}" aria-label="${t('Buscar capítulo')}">` : ''}
      <ul class="fc-combo-list" role="listbox"></ul>
    </div>`;
  const btn = host.querySelector('.fc-combo-btn');
  const pop = host.querySelector('.fc-combo-pop');
  const valEl = host.querySelector('.fc-combo-val');
  const list = host.querySelector('.fc-combo-list');
  const search = host.querySelector('.fc-combo-search');
  let cur = selected;

  const renderList = (filter = '') => {
    const f = filter.trim().toLowerCase();
    const items = options.filter(o => !f || o.label.toLowerCase().includes(f));
    list.innerHTML = items.length
      ? items.map(o => `<li role="option" data-value="${escapeHtml(o.value)}" class="${o.value === cur ? 'is-sel' : ''}" aria-selected="${o.value === cur}">${escapeHtml(o.label)}</li>`).join('')
      : `<li class="fc-combo-empty" aria-disabled="true">${t('Sin resultados')}</li>`;
  };
  const close = () => {
    pop.hidden = true; btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onOutside, true);
  };
  const onOutside = (e) => { if (!host.contains(e.target)) close(); };
  const openPop = () => {
    renderList();
    pop.hidden = false; btn.setAttribute('aria-expanded', 'true');
    if (search) { search.value = ''; search.focus(); }
    document.addEventListener('click', onOutside, true);
  };

  btn.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden ? openPop() : close(); });
  if (search) search.addEventListener('input', () => renderList(search.value));
  list.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-value]');
    if (!li) return;
    cur = li.dataset.value;
    valEl.textContent = labelOf(cur);
    onChange(cur);
    close();
  });
}

// Mazos ya generados de este libro: re-exportar o borrar sin regenerar.
async function renderDeckList() {
  const holder = body()?.querySelector('#fc-decks');
  if (!holder || !ctx.bookId) return;
  const decks = await DB.getDecks(ctx.bookId);
  if (!overlay || !decks.length) { if (holder) holder.innerHTML = ''; return; }
  holder.innerHTML = `
    <div class="fc-label">${t('Mazos generados')}</div>
    ${decks.map(d => {
      const st = Srs.deckStats(d.cards);
      const due = st.due;
      return `
      <div class="fc-deck" data-id="${d.id}">
        <div class="fc-deck-info">
          <span class="fc-deck-name">${escapeHtml(d.scope || t('Libro entero'))}</span>
          <span class="fc-deck-meta">${t('{n} tarjetas', { n: DB.cardsOf(d).length })} · ${d.cardType === 'cloze' ? 'cloze' : 'P→R'} · ${new Date(d.createdAt).toLocaleDateString()}</span>
          <span class="fc-deck-meta">${t('{a} nuevas · {b} aprendiendo · {c} maduras', { a: st.nuevas, b: st.aprendiendo, c: st.maduras })}${st.suspendidas ? ` · ${t('{n} suspendidas', { n: st.suspendidas })}` : ''}</span>
        </div>
        <button class="fc-deck-study" data-act="study" title="${t('Repasar con repetición espaciada')}">
          ${icon('cards', { size: 14 })} ${t('Estudiar')}${due ? ` <span class="fc-deck-due">${due}</span>` : ''}
        </button>
        <button class="icon-btn" data-act="review" title="${t('Revisar y exportar')}">${icon('pencil', { size: 15 })}</button>
        <button class="icon-btn" data-act="delete" title="${t('Borrar mazo')}">${icon('trash', { size: 15 })}</button>
      </div>`;
    }).join('')}`;
  holder.onclick = async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = parseInt(btn.closest('.fc-deck').dataset.id, 10);
    const deck = (await DB.getDecks(ctx.bookId)).find(d => d.id === id);
    if (!deck) return;
    if (btn.dataset.act === 'study') {
      // El overlay de estudio se pinta ENCIMA del modal; al cerrarlo, el badge de
      // vencidas del mazo se refresca. Si el usuario salta a la fuente ("ver en el
      // libro"), este modal también se cierra para dejar ver el lector.
      Study.open({
        decks: [deck], title: deck.name || t('Estudiar'),
        onClose: () => renderDeckList(),
        onNavigate: () => closeModal(),
      });
    }
    if (btn.dataset.act === 'review') renderReview(deck);
    if (btn.dataset.act === 'delete' &&
        await confirmBox('¿Borrar este mazo de flashcards?', { title: 'Borrar mazo', okText: 'Borrar' })) {
      await DB.deleteDeck(id);
      renderDeckList();
    }
  };
}

// ---- Generación con el LLM ---------------------------------------------------

// Pasajes del alcance elegido, en orden de lectura. Capítulo: ENTERO (el troceo permite
// cubrirlo completo). Libro entero: round-robin por capítulo hasta BOOK_TOKENS.
// IA8 · Rotación de muestreo ponderada por relevancia al objetivo: con los scores de la
// atenuación (0..1 por capítulo), los capítulos MUY relevantes (≥0.66) muestrean al DOBLE
// de ritmo (dos turnos por ronda sobre el mismo cursor). Sin scores → round-robin uniforme
// de siempre. Pura y testeable: recibe [{ch, passages}] y devuelve la rotación (entradas
// duplicadas COMPARTEN estado, así el doble turno avanza el mismo cursor).
export function scopeRotation(lists, scores) {
  const states = lists.map(l => ({ ch: l.ch, passages: l.passages, i: 0 }));
  if (!scores) return states;
  const rot = [];
  for (const st of states) {
    rot.push(st);
    const sc = scores[(st.ch || '').trim()];
    if (typeof sc === 'number' && sc >= 0.66) rot.push(st);
  }
  return rot;
}

function gatherScope(scopeLabel) {
  ctx.ensureIndex();
  if (scopeLabel) return Retrieval.passagesByChapter(scopeLabel);
  const byChapter = new Map();
  for (const p of Retrieval.allPassages()) {
    // Libro entero: fuera accesorios (licencias, créditos, "elogios"…). El eval EV1 cazó
    // un mazo ENTERO sobre la licencia de Gutenberg. Un capítulo elegido a mano se respeta.
    if (Retrieval.isBoilerplate(p.chapter)) continue;
    const k = p.chapter || '';
    if (!byChapter.has(k)) byChapter.set(k, []);
    byChapter.get(k).push(p);
  }
  const lists = [...byChapter.entries()].map(([ch, passages]) => ({ ch, passages }));
  const rotation = scopeRotation(lists, ctx.chapterScores || null);
  const picked = []; let used = 0, added = true;
  while (added && used < BOOK_TOKENS) {
    added = false;
    for (const st of rotation) {
      const p = st.passages[st.i];
      if (!p) continue;
      st.i++;
      const t = estimateTokens(p.text) + 4;
      if (used + t > BOOK_TOKENS) continue;
      picked.push(p); used += t; added = true;
    }
  }
  return picked.sort((a, b) => Retrieval.anchorNum(a.id) - Retrieval.anchorNum(b.id));
}

// Trozos de ~chunkTokens con el texto anotado (encabezados ## + marcadores [[aN]], que
// alimentan el "src" de P10 F2). Pura (recibe pasajes) para poder testearla. Un capítulo
// mayor que el trozo se parte; al continuar en el trozo siguiente se repite su encabezado.
// `headings: false` omite los `## Capítulo` que separan los pasajes. Para tarjetas y resumen
// esos encabezados son CONTEXTO útil (el modelo sabe dónde está). Para el mapa mental son
// veneno, y está medido: el modelo los devolvía como si fueran conceptos, y el mapa acababa
// siendo el índice del libro con otro formato (eval p14-sin-esqueleto: 8 de 8 ramas eran
// títulos de capítulo recortados). Los conceptos tienen que salir del TEXTO, no del titular.
export function buildChunks(passages, chunkTokens = CHUNK_TOKENS, { headings = true } = {}) {
  const chunks = [];
  let lines = [], tokens = 0, curCh = undefined;
  const flush = () => {
    if (lines.length) chunks.push({ text: lines.join('\n').trim(), tokens });
    lines = []; tokens = 0; curCh = undefined;
  };
  for (const p of passages || []) {
    const t = estimateTokens(p.text) + 4;
    if (tokens && tokens + t > chunkTokens) flush();
    if (p.chapter !== curCh) {
      if (p.chapter && headings) lines.push(`\n## ${p.chapter}`);
      curCh = p.chapter;
    }
    lines.push(`[[${p.id}]] ${p.text}`);
    tokens += t;
  }
  flush();
  return chunks;
}

// Reparte el total de tarjetas entre trozos, proporcional a su tamaño y con suma EXACTA
// (resto mayor / Hamilton). Si hay más trozos que tarjetas, 1 a los más grandes y 0 al
// resto (los trozos a 0 no generan llamada). Pura, testeable.
export function allocateCounts(chunks, total) {
  const n = (chunks || []).length;
  if (!n || total <= 0) return (chunks || []).map(() => 0);
  if (total < n) {
    const counts = chunks.map(() => 0);
    [...chunks.keys()].sort((a, b) => chunks[b].tokens - chunks[a].tokens)
      .slice(0, total).forEach(i => { counts[i] = 1; });
    return counts;
  }
  const rest = total - n;                                   // mínimo 1 por trozo
  const totalTokens = chunks.reduce((s, c) => s + c.tokens, 0) || 1;
  const quotas = chunks.map(c => rest * c.tokens / totalTokens);
  const counts = quotas.map(q => 1 + Math.floor(q));
  let left = total - counts.reduce((s, x) => s + x, 0);
  const order = quotas.map((q, i) => [q - Math.floor(q), i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) { if (left <= 0) break; counts[i]++; left--; }
  return counts;
}

// Idioma del material (es/en). La instrucción relativa ("el idioma de los pasajes") no
// basta: con el objetivo del lector en español y un libro en inglés, el modelo derivaba al
// español (regresión cazada por EV1) — nombrar el idioma la ancla. La heurística vive en
// retrieval.js desde que también la usa el gate de IA7; se re-exporta por compatibilidad.
export const detectLang = Retrieval.detectLang;

function cardsPrompt(count, type, goal, { viaTool = false, prevFronts = [], lang = '', otherTypes = [] } = {}) {
  const shape = type === 'cloze'
    ? `- "front": una frase con el dato CLAVE oculto en sintaxis cloze de Anki: {{c1::texto oculto}}
  (máximo 2 huecos por tarjeta, {{c1::..}} y {{c2::..}}). Oculta términos/datos importantes, no palabras triviales.
- "back": aclaración o contexto extra, opcional (puede ser "").`
    : `- "front": una pregunta clara y AUTOCONTENIDA (se entiende sin tener el libro delante).
- "back": la respuesta, concisa (1-3 frases).`;
  // Entrega: por herramienta (salida con forma garantizada) o como texto JSON (fallback
  // para proveedores BYOK sin function calling).
  const format = viaTool
    ? `ENTREGA (obligatorio): llama a la herramienta "create_flashcards" con el parámetro "cards".
Cada tarjeta es {"front": "...", "back": "...", "chapter": "...", "src": "..."}:`
    : `FORMATO (obligatorio): responde SOLO con un array JSON válido, sin markdown ni texto alrededor.
Cada tarjeta es {"front": "...", "back": "...", "chapter": "...", "src": "..."}:`;
  // Anti-duplicados entre trozos: los frentes ya generados en trozos anteriores.
  const dedup = prevFronts.length ? `

YA EXISTEN estas tarjetas de otros pasajes del libro (NO repitas su contenido):
${prevFronts.map(f => '- ' + f).join('\n')}` : '';
  // WU3 · Arbitraje de formato por concepto: SOLO cuando hay más de un tipo de texto
  // elegido (cada pasada corre con su propio tipo). El agente decide qué formato le
  // sienta a cada concepto en vez de forzárselo: los conceptos de formato natural ajeno
  // los omite aquí y los cubre la pasada que los nombra. Con un solo tipo la cláusula NO
  // existe: el prompt de una pasada debe ser idéntico byte a byte al de siempre
  // (contrato EV5: el baseline se midió con ese prompt).
  const arbitration = otherTypes.length
    ? `\n- ARBITRAJE DE FORMATO: esta pasada genera SOLO tarjetas ${TYPE_NAMES[type]}. De los conceptos de los pasajes, incluye únicamente los cuyo formato natural es ese; los que funcionen mejor como ${otherTypes.map(o => TYPE_NAMES[o]).join(' / ')}, OMÍTELOS aquí: los cubre la pasada de ${otherTypes.map(o => TYPE_NAMES[o]).join(' / ')}. No fuerces el formato sobre un concepto que no le sienta.`
    : '';
  return `Eres un experto en repetición espaciada creando flashcards de Anki de máxima calidad a partir de pasajes de un libro.

REGLAS DE CALIDAD (obligatorias):
- Atómicas: UNA idea o hecho por tarjeta.
- Autocontenidas: prohibido "según el texto", "en este capítulo" o "el autor" sin nombrarlo.
- Prioriza conceptos, definiciones, relaciones causa-efecto y datos concretos; evita trivialidades.
- FIDELIDAD ESTRICTA (el criterio nº 1): trabaja pasaje → dato → tarjeta, nunca al revés.
  Extrae de un pasaje un dato que ese pasaje AFIRME explícitamente y conviértelo en tarjeta:
  el "back" debe poder SUBRAYARSE en el pasaje "src". Aunque conozcas la obra de memoria, NO
  completes con nombres, lugares, causas o hechos que el pasaje no diga — eso invalida la
  tarjeta aunque sea cierto en la obra.
- REVISIÓN FINAL: antes de entregar, relee cada tarjeta contra su pasaje "src" y elimina o
  corrige toda tarjeta cuyo "back" no se pueda subrayar ahí.${goal ? `
- OBJETIVO DEL LECTOR: «${goal}». Pregunta primero lo que un examen sobre ese objetivo
  preguntaría; descarta lo que no ayude a ese objetivo aunque esté en los pasajes.` : ''}
- Sin tarjetas duplicadas ni casi iguales.${arbitration}
- IDIOMA: TODAS las tarjetas ${lang ? `en ${lang === 'es' ? 'ESPAÑOL' : 'INGLÉS'} (el idioma de los pasajes)` : 'en el idioma de los PASAJES'} —
  no el de estas instrucciones ni el del objetivo del lector. Nunca mezcles idiomas entre tarjetas.
- Material administrativo (licencias, copyright, créditos, índices, promoción) NO da
  tarjetas: si los pasajes son solo eso, devuelve menos tarjetas o ninguna.

${format}
${shape}
- "chapter": el encabezado ## del pasaje de origen, o "" si no lo hay.
- "src": el marcador [[aN]] del pasaje del que sale la tarjeta, solo el id (p. ej. "a42"), o "" si dudas.${dedup}

Genera EXACTAMENTE ${count} tarjetas de los pasajes dados (menos SOLO si el material no da para más).`;
}

// Schema de la herramienta: el modelo entrega las tarjetas como ARGUMENTOS con forma
// garantizada (function calling) en vez de prosa que parsear. nan/DeepSeek emite
// tool_calls fiables sin streaming (spike E5); el razonamiento queda interno.
function cardsTool() {
  return [{
    type: 'function',
    function: {
      name: 'create_flashcards',
      description: 'Entrega las flashcards generadas a partir de los pasajes del libro.',
      parameters: {
        type: 'object',
        properties: {
          cards: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                front: { type: 'string', description: 'Pregunta autocontenida (o frase cloze con {{c1::...}})' },
                back: { type: 'string', description: 'Respuesta concisa (o aclaración extra, en cloze)' },
                chapter: { type: 'string', description: 'Encabezado ## del pasaje de origen, o ""' },
                src: { type: 'string', description: 'Id del marcador [[aN]] del pasaje de origen (p. ej. "a42"), o ""' },
              },
              required: ['front', 'back'],
            },
          },
        },
        required: ['cards'],
      },
    },
  }];
}

// Normaliza tarjetas crudas (de los argumentos de la herramienta o del texto parseado):
// descarta lo que no tenga "front", limpia campos y valida la forma del "src" ("a42" o
// "[[a42]]"; su existencia real la comprueba attachSources).
export function sanitizeCards(arr, type) {
  const out = [];
  for (const c of Array.isArray(arr) ? arr : []) {
    if (!c || typeof c.front !== 'string' || !c.front.trim()) continue;
    const src = typeof c.src === 'string' ? (c.src.match(/^\[*\s*(a\d+)\s*\]*$/) || [])[1] || '' : '';
    out.push({
      type,
      front: c.front.trim(),
      back: typeof c.back === 'string' ? c.back.trim() : '',
      chapter: typeof c.chapter === 'string' ? c.chapter.trim() : '',
      src,
    });
  }
  return out;
}

// Extrae las tarjetas de una respuesta de TEXTO (fallback sin function calling). Tolerante
// por diseño (como parseExpansion de IA7): no busca el array con indexOf('[') —frágil con
// los marcadores [[aN]] y con modelos reasoning que envuelven el JSON en prosa o <think>—,
// sino que extrae los OBJETOS balanceados `{...}` con "front". Así ignora las llaves del
// razonamiento y SALVA una respuesta truncada (cada objeto completo cuenta; solo se pierde
// la cola incompleta). Nunca lanza: [] = nada.
export function parseCards(raw, type) {
  const text = String(raw || '')
    .replace(/```(?:json)?/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ');   // descarta el razonamiento inline
  const objs = [];
  for (const chunk of balancedObjects(text)) {
    try { objs.push(JSON.parse(chunk)); } catch { /* objeto incompleto/roto → se ignora */ }
  }
  return sanitizeCards(objs, type);
}

// ¿El pasaje RESPALDA la tarjeta? Solapamiento de términos significativos (≥4 letras o
// números, normalizados sin acentos) entre tarjeta y pasaje. El eval EV1 cazó anclas
// léxicamente plausibles que apuntaban a otra escena: "clic → salta a la fuente" es el
// foso del producto, así que un ancla equivocada es peor que ninguna. Umbral progresivo
// (tarjetas cortas exigen menos) y conservador: sin texto no veta. Pura, testeable.
const sigTerms = (s) => new Set(
  String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .match(/[a-z]{4,}|\d{2,}/g) || []
);
export function anchorSupported(card, passageText) {
  if (!passageText) return true;   // sin texto que juzgar: no vetar (compat/best-effort)
  const want = sigTerms(`${card.front} ${card.back}`);
  if (want.size < 2) return true;  // tarjeta casi sin términos: no hay señal para vetar
  const have = sigTerms(passageText);
  const hitsIn = (set) => { let n = 0; for (const t of set) if (have.has(t)) n++; return n; };
  if (hitsIn(want) >= (want.size >= 8 ? 3 : 2)) return true;
  // Tarjetas cortas ("¿A qué pueblo viaja? → A Comala"): las palabras de la PREGUNTA no
  // suelen estar literales en el texto, pero la RESPUESTA es el dato — si el pasaje
  // contiene todos sus términos, respalda la tarjeta.
  const back = sigTerms(card.back);
  return back.size > 0 && back.size <= 4 && hitsIn(back) === back.size;
}

// P10 F2 — asegura el ancla de origen de cada tarjeta: si el modelo no dio "src" (o dio
// uno que no existe: los LLM inventan ids), se busca el mejor pasaje por BM25 con el
// contenido de la tarjeta, prefiriendo su capítulo declarado. Con `textOf(id)` (opcional)
// se valida además que el pasaje RESPALDE la tarjeta (anchorSupported) — también el src
// que declaró el modelo, que puede existir y aun así ser de otra escena. Best-effort: sin
// acierto, la tarjeta queda sin fuente (el modo Estudiar simplemente no ofrece el salto).
export function attachSources(cards, { validIds, search, textOf }) {
  const ok = (c, id) => !textOf || anchorSupported(c, textOf(id) || '');
  return cards.map(c => {
    if (c.src && validIds.has(c.src) && ok(c, c.src)) return c;
    const hits = (search(`${c.front} ${c.back}`.trim(), 5) || []).filter(h => ok(c, h.id));
    const best = hits.find(h => c.chapter && h.chapter === c.chapter) || hits[0];
    return { ...c, src: best ? best.id : '' };
  });
}

// Genera las tarjetas de UN trozo con una escalera de robustez:
//   1) function calling FORZADO — la salida son argumentos con schema, no prosa que parsear;
//   2) reparación: tools en 'auto' + recordatorio (proveedores que rechazan tool_choice
//      forzado o que respondieron sin llamar a la herramienta);
//   3) fallback a texto + parser tolerante (proveedores BYOK sin function calling).
// Devuelve { cards, mode } con el escalón que funcionó: los trozos siguientes entran
// directos por ahí (no se re-prueba un camino roto en cada trozo).
async function generateChunk({ text, ask, type, goal, prevFronts, otherTypes = [], mode, signal, background = false }) {
  const user = { role: 'user', content: 'PASAJES DEL LIBRO:\n\n' + text };
  const lang = detectLang(text);   // el prompt nombra el idioma del material (ver detectLang)
  // Cupo holgado por trozo: la salida es pequeña (≤ ask tarjetas) pero el razonamiento
  // de un modelo reasoning consume el mismo cupo.
  const maxTokens = Math.min(8192, 1500 + ask * 220);

  // null = el modelo NO llamó a la herramienta (proveedor/camino roto → seguir la escalera);
  // array (incluso vacío) = llamada válida — [] significa "este trozo no da más tarjetas"
  // (p. ej. todo duplicado de trozos previos) y NO es un fallo: el déficit lo compensan
  // los trozos siguientes.
  const attempt = async (toolChoice, extra = []) => {
    const { toolCalls } = await LLM.chatTools({
      messages: [
        { role: 'system', content: cardsPrompt(ask, type, goal, { viaTool: true, prevFronts, lang, otherTypes }) },
        user, ...extra,
      ],
      tools: cardsTool(), toolChoice, maxTokens, signal, background,
    });
    const call = toolCalls.find(t => t.name === 'create_flashcards');
    return call ? sanitizeCards(call.args?.cards, type) : null;
  };

  if (mode !== 'text') {
    if (mode !== 'auto') {
      try {
        const cards = await attempt({ type: 'function', function: { name: 'create_flashcards' } });
        if (cards) return { cards, mode: 'forced' };
      } catch (e) { if (e.name === 'AbortError') throw e; }
    }
    try {
      const cards = await attempt('auto', [{
        role: 'user',
        content: 'Recuerda: entrega las tarjetas llamando a la herramienta "create_flashcards" con el parámetro "cards".',
      }]);
      if (cards) return { cards, mode: 'auto' };
    } catch (e) { if (e.name === 'AbortError') throw e; }
  }
  const raw = await LLM.chatStream({
    messages: [{ role: 'system', content: cardsPrompt(ask, type, goal, { prevFronts, lang, otherTypes }) }, user],
    maxTokens, signal, background,
  });
  return { cards: parseCards(raw, type), mode: 'text' };
}

// Corre las PASADAS DE TEXTO (WU1: una por tipo elegido, orden estable) sobre los trozos
// dados, con el cupo total repartido entre pasadas (splitQuota) y el déficit arrastrado
// DENTRO de cada pasada. Es el motor común del mazo de libro entero y del plan por
// capítulo (WU5): misma escalera de robustez, mismo anti-duplicados. Los frentes
// acumulan ENTRE pasadas en `cards`: el prevFronts de la segunda lleva los de la primera.
// Un trozo/pasada fallido no tira el trabajo del resto (éxito parcial). El progreso y el
// destino de las tarjetas los decide el caller vía onProgress.
async function runTextPasses({ chunks, count, sel, goal, seedFronts = [], mode = 'forced', signal, background, onProgress }) {
  let cards = [], failed = 0;
  const quotas = splitQuota(count, sel.text.length);
  onProgress?.(0, count, 'map');
  for (let ti = 0; ti < sel.text.length; ti++) {
    const textType = sel.text[ti];
    const counts = allocateCounts(chunks, quotas[ti]);
    // Los demás tipos elegidos alimentan la cláusula de arbitraje (WU3): en esta
    // pasada solo van los conceptos de formato natural textType.
    const otherTypes = sel.text.filter(x => x !== textType);
    // Déficit POR PASADA (no entre pasadas): si varios trozos anteriores dieron de
    // menos, sin tope el último trozo absorbía el cupo entero — el eval EV1 cazó un
    // mazo completo salido de un único capítulo. Mejor un mazo corto y repartido
    // ("éxito parcial", ya avisado abajo) que uno completo y monotema.
    let expected = 0, passCards = 0;
    for (let i = 0; i < chunks.length; i++) {
      if (!counts[i]) continue;
      const deficit = Math.min(Math.max(0, expected - passCards), counts[i] + 2);
      expected += counts[i];
      try {
        const res = await generateChunk({
          text: chunks[i].text, ask: counts[i] + deficit, type: textType, goal,
          prevFronts: seedFronts.concat(cards.map(c => c.front)).slice(-MAX_PREV_FRONTS),
          otherTypes, mode, signal, background,
        });
        mode = res.mode;
        const fresh = res.cards.slice(0, counts[i] + deficit);
        cards = cards.concat(fresh);
        passCards += fresh.length;
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        console.warn(`Flashcards: el trozo ${i + 1}/${chunks.length} falló:`, e);
        failed++;
      }
      onProgress?.(Math.min(cards.length, count), count, 'map');
    }
  }
  return { cards, failed, mode };
}

// Familias visuales del alcance entero (resolver figuras del libro + tarjetas de
// oclusión/diagrama/dibujo). Compartido por el camino de mazo único y el de plan por
// capítulo (WU5): las visuales corren UNA vez por corrida, nunca por capítulo — son
// figuras del libro, no del capítulo. Secuenciales, dentro del MISMO job.
async function buildScopeVisuals({ sel, scopeLabel, bookId, signal, progress }) {
  const chapterText = gatherScope(scopeLabel).map(p => p.text).join('\n\n').slice(0, 8000);
  const record = bookId ? await getBook(bookId).catch(() => null) : null;
  const fr = await ensureBookFigures({
    bookId, format: record?.format, record, signal,
    onProgress: ({ done, total }) => progress(done, total, 'figures'),
    deps: {
      getDocument: () => (PdfReader.getBookId() === bookId && PdfReader.isLoaded()
        ? PdfReader.getDocument() : null),
    },
  });
  return buildVisualCards({
    types: sel.visual, chapterText, figures: fr.figures, signal,
    onProgress: ({ phase, done, total }) => progress(done, total, phase),
    bookTitle: record?.title,
  });
}

// F4 · La generación corre en SEGUNDO PLANO (jobs.js), como resumen y mapa mental.
// Antes vivía dentro del modal y moría con él (`if (!overlay) return`), justo en la
// generación MÁS lenta de la app (N llamadas encadenadas): el lector tenía que quedarse
// mirando. El chip de jobs-ui hace visible la promesa de "sigue leyendo".
function onGenerate() {
  const b = body();
  if (!LLM.hasKey()) { showError(t('Configura tu API key en Ajustes → Agente para generar tarjetas.')); return; }
  const scopeLabel = scopeValue;
  const sel = selectedTypes();
  const type = effectiveDeckType(sel);
  const count = parseInt(b.querySelector('#fc-count').value, 10);

  // WU5 · Plan activo: manda el plan (la cantidad de arriba se ignora). Guardas de coste:
  // sin filas con tarjetas no hay nada que generar, y por encima del tope de capítulos
  // por corrida se NIEGA a gastar (más capítulos activos = más llamadas pagas) en vez de
  // recortarlo por su cuenta.
  const planRows = planState ? planState.plan.filter(r => r.cards > 0) : null;
  if (planRows && !planRows.length) {
    showError(t('El plan no tiene ninguna tarjeta: sube algún número antes de generar.'));
    return;
  }
  if (planRows && planRows.length > MAX_PLAN_CHAPTERS) {
    showError(t('El plan supera el tope de {n} capítulos por corrida; quita capítulos o bájales el número.', { n: MAX_PLAN_CHAPTERS }));
    return;
  }

  // Camino de TEXTO: igual que siempre (chunks, map-reduce, attachSources). Los trozos se
  // calculan UNA vez; con varios tipos de texto cada tipo corre SU pasada sobre esos
  // mismos trozos con su cupo (WU1). Sin tipos de texto (solo visuales) no hay trozos que
  // trocear y el índice de texto no se exige. Con plan activo el troceo es POR CAPÍTULO,
  // dentro del job (cada capítulo se calcula cuando le toca).
  const wantsText = sel.text.length > 0;
  let chunks = [];
  if (!planRows && wantsText) {
    chunks = buildChunks(gatherScope(scopeLabel));
    if (!chunks.length) { showError(t('Ese contenido no tiene texto indexado; prueba con otro capítulo o con el libro entero.')); return; }
  }

  // Todo lo que el job necesita se captura AHORA. El trabajo sobrevive al modal y hasta al
  // libro: `ctx` puede haber cambiado cuando termine, y el índice de Retrieval es global
  // —si el lector se va a otro libro, `allPassages()` devolvería los pasajes de ESE otro y
  // las tarjetas acabarían citando fuentes de un libro que no es el suyo.
  const bookId = ctx.bookId;
  const goal = ctx.goal;
  const name = deckName(scopeLabel);
  const byId = new Map(Retrieval.allPassages().map(p => [p.id, p.text]));
  const target = b.querySelector('#fc-merge')?.checked ? mergeInto : null;

  showError('');

  // ---- WU5 · Camino PLAN POR CAPÍTULO: un tramo de job por capítulo con tarjetas ----
  // Cada capítulo corre el MISMO motor de pasadas (runTextPasses) sobre SUS trozos con su
  // cupo, y fusiona/crea el mazo de ESE alcance (etiqueta del capítulo). El mazo de libro
  // entero NO se usa con plan activo. Un capítulo fallido no tira el resto (misma
  // filosofía que un trozo fallido) y queda en el desglose del resumen del trabajo.
  if (planRows) {
    const requested = planRows.reduce((s, r) => s + r.cards, 0);
    Jobs.start({
      bookId, kind: 'flashcards', label: t('Flashcards'),
      params: { scope: scopeLabel, scopeName: t('Plan por capítulo'), type, count: requested },
      persist: false,        // los mazos viven en `decks`; ver Jobs.start
      run: async ({ signal, progress, background }) => {
        const breakdown = [];
        let mode = 'forced';
        let frontsSeen = [];                 // frentes ya generados en capítulos previos
        let done = 0;
        for (const row of planRows) {
          const chChunks = buildChunks(Retrieval.passagesByChapter(row.name));
          let generated = 0, failed, deckId = null;   // failed siempre se asigna abajo
          if (!chChunks.length) {
            failed = 1;                      // el capítulo no tiene texto indexado
          } else {
            try {
              // Fusión por capítulo: el mazo existente de ESE alcance y tipo efectivo
              // recibe lo nuevo; sus frentes entran al prompt como anti-duplicados junto
              // con los de los capítulos ya generados en esta corrida.
              const decks = await DB.getDecks(bookId);
              const existing = decks.find(d => (d.scope || '') === row.name && d.cardType === type && DB.cardsOf(d).length);
              const seedFronts = existing
                ? DB.cardsOf(existing).map(c => c.front).concat(frontsSeen)
                : frontsSeen;
              const res = await runTextPasses({
                chunks: chChunks, count: row.cards, sel, goal, seedFronts, mode, signal, background,
                onProgress: (d, n, ph) => progress(Math.min(done + d, requested), requested, ph),
              });
              mode = res.mode;
              failed = res.failed;
              if (res.cards.length) {
                // Solo las tarjetas de TEXTO llevan ancla (las visuales van aparte).
                const withSrc = attachSources(res.cards.slice(0, row.cards), {
                  validIds: new Set(byId.keys()),
                  search: (q, k) => (Retrieval.hasIndex(bookId) ? Retrieval.search(q, k) : []),
                  textOf: (id) => byId.get(id),
                });
                const seen = new Set(existing ? DB.cardsOf(existing).map(c => normFront(c.front)) : []);
                const fresh = withSrc.filter(c => {
                  const k = normFront(c.front);
                  if (k && seen.has(k)) return false;
                  if (k) seen.add(k);
                  return true;
                });
                generated = fresh.length;    // lo repetido no cuenta como generado
                frontsSeen = frontsSeen.concat(fresh.map(c => c.front)).slice(-MAX_PREV_FRONTS);
                if (fresh.length) {
                  if (existing) {
                    const merged = { ...existing, cards: existing.cards.concat(fresh) };
                    const patch = { cards: merged.cards };
                    if (existing.cardType !== type) patch.cardType = 'mixed';
                    await DB.updateDeck(existing.id, patch);
                    deckId = existing.id;
                  } else {
                    const deck = { bookId, name: deckName(row.name), cardType: type, scope: row.name, cards: fresh, createdAt: Date.now() };
                    if (bookId) deck.id = await DB.addDeck(deck);
                    deckId = deck.id || null;
                  }
                }
              }
            } catch (e) {
              if (e.name === 'AbortError') throw e;
              console.warn(`Flashcards: el capítulo "${row.name}" falló:`, e);
              failed = chChunks.length;      // el capítulo entero se reporta fallido
            }
          }
          done += Math.min(generated, row.cards);
          breakdown.push({ name: row.name, requested: row.cards, generated, failed, deckId });
          progress(Math.min(done, requested), requested, 'map');
        }
        // Familias visuales: UNA vez para el alcance entero, DESPUÉS de las pasadas de
        // texto, a su mazo propio de libro entero (scope ''): son figuras del libro, no
        // de un capítulo.
        let vres = null, visualDeckId = null;
        if (sel.visual.length) {
          vres = await buildScopeVisuals({ sel, scopeLabel, bookId, signal, progress });
          if (vres.cards.length) {
            const vType = sel.visual.length === 1 ? sel.visual[0] : 'mixed';
            const decks = await DB.getDecks(bookId);
            const vExisting = decks.find(d => (d.scope || '') === '' && d.cardType === vType && DB.cardsOf(d).length);
            const seen = new Set(vExisting ? DB.cardsOf(vExisting).map(c => normFront(c.front)) : []);
            const fresh = vres.cards.filter(c => {
              const k = normFront(c.front);
              if (k && seen.has(k)) return false;
              if (k) seen.add(k);
              return true;
            });
            if (vExisting) {
              const patch = { cards: vExisting.cards.concat(fresh) };
              if (vExisting.cardType !== vType) patch.cardType = 'mixed';
              await DB.updateDeck(vExisting.id, patch);
              visualDeckId = vExisting.id;
            } else {
              const deck = { bookId, name: deckName(''), cardType: vType, scope: '', cards: fresh, createdAt: Date.now() };
              if (bookId) deck.id = await DB.addDeck(deck);
              visualDeckId = deck.id || null;
            }
          }
        }
        const generatedTotal = breakdown.reduce((s, c) => s + c.generated, 0);
        const failedChapters = breakdown.filter(c => c.failed).length;
        // Sin tarjetas en NINGÚN capítulo ni visual es un fallo (mismo criterio que el
        // camino de mazo único: no simular éxito con nada).
        if (!generatedTotal && !(vres && vres.cards.length)) {
          if (!sel.text.length && sel.visual.length === 1 && sel.visual[0] === 'occlusion') {
            throw new Error(t('No se encontraron figuras en este libro, así que no hay tarjetas de oclusión que generar.'));
          }
          throw new Error(t('El modelo no devolvió tarjetas válidas. Vuelve a intentarlo.'));
        }
        return { planned: true, chapters: breakdown, visualDeckId,
          generated: generatedTotal, requested, failed: failedChapters,
          ...(vres ? { visual: vres.stats } : {}) };
      },
    });
    return;
  }

  Jobs.start({
    bookId, kind: 'flashcards', label: t('Flashcards'),
    params: { scope: scopeLabel, scopeName: scopeLabel || t('Libro entero'), type, count },
    persist: false,        // el mazo vive en `decks`; ver Jobs.start
    run: async ({ signal, progress, background }) => {
      // Map-reduce sobre los trozos, UNA PASADA por tipo de texto elegido (runTextPasses,
      // el mismo motor que usa el plan por capítulo en WU5). Un trozo/pasada fallido no
      // tira el trabajo del resto (éxito parcial, ya avisado abajo).
      // Fusión (F4): los frentes que YA existen en el mazo destino se le pasan al modelo
      // como "no repitas esto" desde el primer trozo. Es más barato evitar el duplicado
      // que descartarlo después, y de paso el mazo crece con material nuevo de verdad.
      let seedFronts = [];
      if (target) {
        const d = (await DB.getDecks(bookId)).find(x => x.id === target);
        seedFronts = DB.cardsOf(d || {}).map(c => c.front);
      }
      let { cards, failed } = await runTextPasses({
        chunks, count, sel, goal, seedFronts, signal, background,
        onProgress: (d, n, ph) => progress(d, n, ph),
      });
      // Familias visuales (secuenciales, dentro del MISMO job): resolver las figuras del
      // libro (store primero; si no, extracción con el documento del lector — nunca el de
      // OTRO libro) y construir las tarjetas de oclusión/diagrama/dibujo.
      const vres = sel.visual.length
        ? await buildScopeVisuals({ sel, scopeLabel, bookId, signal, progress })
        : null;
      // Solo las tarjetas de TEXTO llevan ancla: las visuales traen src '' y no hay pasaje
      // que las respalde — el validador de anclas las descartaría a todas.
      if (cards.length) {
        cards = attachSources(cards.slice(0, count), {
          validIds: new Set(byId.keys()),
          // La repesca por búsqueda solo vale si el índice sigue siendo el de ESTE libro.
          search: (q, k) => (Retrieval.hasIndex(bookId) ? Retrieval.search(q, k) : []),
          textOf: (id) => byId.get(id),   // valida que el pasaje respalde la tarjeta (EV1)
        });
      }
      // Mazo final: texto + visuales, deduplicadas por frente normalizado.
      const seenFronts = new Set();
      cards = cards.concat(vres ? vres.cards : []).filter(c => {
        const k = normFront(c.front);
        if (k && seenFronts.has(k)) return false;
        if (k) seenFronts.add(k);
        return true;
      });
      // Sin tarjetas es un FALLO cuando se pedía un mazo nuevo, pero no cuando se está
      // ampliando uno: ahí "el modelo no encontró nada que no tuvieras ya" es un final
      // legítimo (y frecuente: sus frentes van en el prompt como "no repitas esto").
      // Con SOLO oclusión pedida y mazo vacío el motivo es otro: sin figuras no hay tarjetas
      // — hay que decirlo, no simular éxito con un mazo vacío.
      const target0 = target ? (await DB.getDecks(bookId)).find(x => x.id === target) : null;
      if (!cards.length && !target0) {
        if (!sel.text.length && sel.visual.length === 1 && sel.visual[0] === 'occlusion') {
          throw new Error(t('No se encontraron figuras en este libro, así que no hay tarjetas de oclusión que generar.'));
        }
        throw new Error(t('El modelo no devolvió tarjetas válidas. Vuelve a intentarlo.'));
      }
      // Fusión: al mazo existente solo entra lo que no esté ya (el modelo repite aun con
      // los frentes delante). Si el mazo se borró mientras se generaba, `target0` es null
      // y se cae al camino normal creando uno nuevo: nunca se tira el trabajo.
      const existing = target0;
      if (existing) {
        const have = new Set(DB.cardsOf(existing).map(c => normFront(c.front)));
        const fresh = cards.filter(c => !have.has(normFront(c.front)));
        const merged = { ...existing, cards: existing.cards.concat(fresh) };
        // Tipos: si lo que entra no es del tipo declarado del mazo, el mazo pasa a mixto.
        const patch = { cards: merged.cards };
        if (existing.cardType !== type) patch.cardType = 'mixed';
        await DB.updateDeck(existing.id, patch);
        return { deckId: existing.id, deck: { ...merged, cardType: patch.cardType || existing.cardType },
          generated: fresh.length, requested: count,
          failed, blocks: chunks.length, merged: true, dropped: cards.length - fresh.length,
          ...(vres ? { visual: vres.stats } : {}) };
      }
      const deck = { bookId, name, cardType: type, scope: scopeLabel, cards, createdAt: Date.now() };
      if (bookId) deck.id = await DB.addDeck(deck);
      return { deckId: deck.id || null, deck, generated: cards.length, requested: count, failed, blocks: chunks.length,
        ...(vres ? { visual: vres.stats } : {}) };
    },
  });
}

// Refleja el trabajo en curso mientras el modal está abierto: progreso en el botón y salto
// automático a la revisión al terminar. Si el modal está cerrado, de esto se encarga el
// chip + toast de jobs-ui, y al reabrir se cae en la misma rama de 'done'.
let shownDeckKey = null;    // evita re-renderizar la revisión en cada emit del job

function onJobUpdate(job) {
  if (!overlay || !ctx) return;
  const btn = body()?.querySelector('#fc-generate');
  if (!job || job.kind !== 'flashcards' || job.bookId !== ctx.bookId) {
    if (btn) { btn.disabled = false; btn.innerHTML = `${icon('sparkles', { size: 16 })} ${t('Generar tarjetas')}`; }
    return;
  }
  generating = job.status === 'running';
  if (job.status === 'running') {
    shownDeckKey = null;
    if (btn) {
      btn.disabled = true;
      const p = job.progress;
      btn.innerHTML = `<span class="ai-typing">${p.i ? t('Generando… {i}/{n}', { i: p.i, n: p.n }) : t('Generando tarjetas…')}</span>`;
    }
    return;
  }
  if (job.status === 'error') {
    if (btn) { btn.disabled = false; btn.innerHTML = `${icon('sparkles', { size: 16 })} ${t('Generar tarjetas')}`; }
    showError(job.error?.message || t('No se pudo generar el mazo.'));
    return;
  }
  if (job.status === 'done' && job.result && shownDeckKey !== job.id) {
    shownDeckKey = job.id;
    // WU5 · Plan por capítulo: no hay UN mazo que abrir en revisión; se refresca la lista
    // de mazos y se muestra el desglose por capítulo (éxito parcial incluido).
    if (job.result.planned) {
      renderDeckList();
      const { chapters, generated, requested, failed } = job.result;
      let msg = t('Plan aplicado: {a} de {b} tarjetas', { a: generated, b: requested });
      if (failed) msg += ` (${t('{n} capítulos fallaron', { n: failed })})`;
      msg += '\n' + chapters.map(c => `${c.name} ${c.generated}/${c.requested}`).join(' · ');
      showError(msg);
      return;
    }
    const { deck, generated, requested, failed, blocks, merged, dropped } = job.result;
    renderReview(deck);
    if (merged) {                             // fusión: "menos de las pedidas" es lo esperado
      showError(generated
        ? t('Añadidas {a} tarjetas nuevas al mazo', { a: generated })
          + (dropped ? ` (${t('{n} descartadas por repetidas', { n: dropped })})` : '') + '.'
        : t('No salió ninguna tarjeta que no tuvieras ya en este mazo.'));
    } else if (generated < requested) {        // éxito parcial: avisa en la revisión, no descarta
      showError(t('Se generaron {a} de {b} tarjetas', { a: generated, b: requested })
        + (failed ? ` (${t('fallaron {a} de {b} bloques', { a: failed, b: blocks })})` : '') + '.');
    }
  }
}

function showError(msg) {
  const el = body()?.querySelector('#fc-error');
  if (!el) return;
  el.style.display = msg ? '' : 'none';
  el.textContent = msg;
}

// Frente normalizado para comparar duplicados entre generaciones: sin acentos, sin signos
// y sin dobles espacios. No pretende cazar paráfrasis (eso lo evita `prevFronts` en el
// prompt), solo la repetición literal, que es la que de verdad se repite.
function normFront(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// Nombre del mazo en Anki: subdeck por libro (— separa el alcance para no crear
// jerarquías :: inesperadas con títulos que lleven dos puntos).
function deckName(scopeLabel) {
  const book = (ctx.bookTitle || t('Libro')).replace(/::/g, ':');
  return scopeLabel ? `${book} — ${scopeLabel.replace(/::/g, ':')}` : book;
}

// ---- Vista 2: revisar, editar y exportar --------------------------------------

function renderReview(deck) {
  const b = body();
  if (!b) return;
  // Una tarjeta suspendida en el repaso (P24 F3) se marca aquí y se puede reactivar: sin
  // esta puerta, suspender sería un viaje de ida.
  // Post-filtro de dominio (odd/tasks/flashcards-dominio.md): una pasada opt-in de
  // etiquetado + chips de dominio con descarte por lote. NUNCA corre tras generar (coste
  // sorpresa) ni toca el prompt de generación: es filtrado por el lector, no del modelo.
  const domGroups = groupCardsByDomain(DB.cardsOf(deck)).filter(g => g.domain);
  // Chip pill con estilos inline a propósito: la fila reutiliza .fc-export (flex con gap)
  // y no hay CSS nuevo para el chip en sí.
  const domainChip = (g) => `
    <span class="fc-dom-chip" style="display:inline-flex;align-items:center;gap:6px;background:var(--btn-bg);color:var(--btn-ink);border-radius:var(--r-pill);padding:3px 10px;font-size:13px;">${escapeHtml(g.domain)} (${g.indices.length})
      <button class="fc-dom-del" data-domain="${escapeHtml(g.domain)}" title="${t('Quitar todas las tarjetas de este dominio')}" aria-label="${t('Quitar todas las tarjetas de este dominio')}"
        style="border:0;background:none;color:inherit;cursor:pointer;display:inline-flex;padding:0 0 0 2px;">${icon('xmark', { size: 11 })}</button>
    </span>`;
  const cardRow = (c, i) => `
    <div class="fc-item${c.suspended ? ' is-suspended' : ''}" data-i="${i}">
      <div class="fc-item-fields">
        <div class="fc-front" contenteditable="true" spellcheck="false">${escapeHtml(c.front)}</div>
        <div class="fc-back" contenteditable="true" spellcheck="false" data-ph="${deck.cardType === 'cloze' ? t('Extra (opcional)') : t('Respuesta')}">${escapeHtml(c.back)}</div>
      </div>
      <button class="icon-btn fc-susp" data-act="susp" title="${c.suspended ? t('Reactivar: vuelve al repaso') : t('Suspender: no volver a mostrarla')}"
        aria-label="${c.suspended ? t('Reactivar: vuelve al repaso') : t('Suspender: no volver a mostrarla')}">${icon(c.suspended ? 'undo' : 'eye-off', { size: 15 })}</button>
      <button class="icon-btn fc-del" title="${t('Quitar tarjeta')}">${icon('xmark', { size: 15 })}</button>
    </div>`;
  b.innerHTML = `
    <button class="ai-ob-back">${icon('chevron-left', { size: 16 })}<span>${t('Volver')}</span></button>
    <h2>${t('{n} tarjetas', { n: DB.cardsOf(deck).length })}</h2>
    <p class="ai-ob-sub">${t('Revisa y edita antes de exportar. Mazo en Anki:')} <b>${escapeHtml(deck.name)}</b></p>
    <div class="fc-export fc-domain-bar">
      <button id="fc-domtag" class="ai-ob-back" title="${t('Etiqueta cada tarjeta con su tema: una llamada barata al modelo')}">${t('Agrupar por dominio')}</button>
      ${domGroups.map(domainChip).join('')}
    </div>
    <div class="fc-list">${deck.cards.map((c, i) => (c.deleted ? '' : cardRow(c, i))).join('')}</div>
    <div class="fc-export">
      ${deck.id ? `<button id="fc-study" class="primary-btn">${icon('cards', { size: 16 })} ${t('Estudiar ahora')}<small></small></button>` : ''}
      <button id="fc-apkg" class="${deck.id ? 'ai-ob-back' : 'primary-btn'}">${icon('download', { size: 16 })} ${t('Exportar .apkg')}</button>
      <button id="fc-txt" class="ai-ob-back fc-txt-btn" title="${t('Formato de texto que Anki importa (Archivo → Importar)')}">.txt para Anki</button>
      ${deck.cards.some(c => VISUAL_TYPES.includes(c.type))
        // Limitación honesta (WU8): el export de Anki es de TEXTO — la pregunta y el dato
        // viajan, pero la figura/diagrama no. Clase global reutilizada (ver main.css).
        ? `<span class="sum-depth-hint">${t('Las tarjetas visuales viajan como texto: la figura o el diagrama no va incluida en el fichero.')}</span>`
        : ''}
    </div>
    <div id="fc-error" class="fc-error" style="display:none"></div>`;
  b.querySelector('.ai-ob-back').addEventListener('click', renderSetup);

  // Ediciones y borrados: se aplican al mazo en memoria y se persisten (re-export fiel).
  // Tras mapear, se renumeran los data-i para que sigan casando con el array nuevo.
  // Quitar una fila la deja FUERA de `next`, y eso es exactamente lo que updateDeck lee
  // como "borrada": guarda su tombstone para que el borrado viaje al otro dispositivo
  // en vez de resucitar en el siguiente sync.
  const syncFromDom = () => {
    const rows = [...b.querySelectorAll('.fc-item')];
    const next = rows.map((r, idx) => {
      const base = deck.cards[parseInt(r.dataset.i, 10)] || { type: deck.cardType, chapter: '' };
      r.dataset.i = idx;
      return { ...base, front: r.querySelector('.fc-front').innerText.trim(), back: r.querySelector('.fc-back').innerText.trim() };
    });
    deck.cards = next;
    if (deck.id) DB.updateDeck(deck.id, { cards: next });
  };
  b.querySelector('.fc-list').addEventListener('click', (e) => {
    const susp = e.target.closest('.fc-susp');
    if (susp) {
      // Se aplican primero las ediciones pendientes del DOM y después el cambio de estado,
      // que no se puede leer del DOM (no es un campo editable).
      syncFromDom();
      const i = parseInt(susp.closest('.fc-item').dataset.i, 10);
      const card = deck.cards[i];
      if (!card) return;
      deck.cards[i] = { ...card, suspended: !card.suspended };
      if (deck.id) DB.updateDeck(deck.id, { cards: deck.cards });
      renderReview(deck);
      return;
    }
    const del = e.target.closest('.fc-del');
    if (!del) return;
    del.closest('.fc-item').remove();
    syncFromDom();
    const h2 = b.querySelector('h2');
    if (h2) h2.textContent = t('{n} tarjetas', { n: deck.cards.length });
  });
  b.querySelector('.fc-list').addEventListener('focusout', syncFromDom);

  // Descarte por lote de un dominio: el espejo del fc-del de a una tarjeta. Se persiste
  // vía updateDeck para que las quitadas queden como tombstones y el borrado viaje por
  // sync en vez de resucitar en el siguiente merge. El h2 y los chips se refrescan con
  // el re-render completo.
  b.querySelector('.fc-domain-bar').addEventListener('click', (e) => {
    const del = e.target.closest('.fc-dom-del');
    if (!del) return;
    syncFromDom();   // las ediciones pendientes del DOM entran antes de tocar el array
    const dom = del.dataset.domain;
    deck.cards = deck.cards.filter(c => normalizeDomain(c.domain) !== dom);
    if (deck.id) DB.updateDeck(deck.id, { cards: deck.cards });
    renderReview(deck);
  });

  // Pasada de etiquetado (opt-in, UNA llamada barata al modelo lite): frentes + capítulos
  // → etiqueta de dominio por tarjeta. Fallo → toast y SIN cambio de estado: un mazo sin
  // etiquetar es exactamente el estado anterior, y el lector puede reintentar.
  b.querySelector('#fc-domtag').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    syncFromDom();   // se etiquetan los frentes tal y como están editados ahora
    const cards = DB.cardsOf(deck);
    if (!cards.length) return;
    const idle = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = t('Agrupando…');
    try {
      const fronts = cards.map(c => c.front);
      const { system, user } = domainTagMessages(
        fronts, cards.map(c => c.chapter || ''), detectLang(fronts.join(' ')));
      // Misma vía que las pasadas de texto (LLM.chatStream) pero al modelo lite, como la
      // expansión de consulta: la salida es un array JSON corto, no hace falta el principal.
      const raw = await LLM.chatStream({
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        model: LLM.getLiteModel(),
        maxTokens: Math.min(4096, 600 + fronts.length * 40),
      });
      const labels = parseDomainSuggestions(raw, fronts.length);
      if (!labels.length) throw new Error('respuesta sin etiquetas utilizables');
      // Etiquetas en orden sobre las tarjetas visibles; las que falten quedan sin dominio.
      cards.forEach((c, i) => { c.domain = normalizeDomain(labels[i] || ''); });
      if (deck.id) await DB.updateDeck(deck.id, { cards: deck.cards });
      renderReview(deck);
    } catch (err) {
      console.warn('Etiquetado de dominio falló:', err);
      toast({ message: t('No se pudieron agrupar las tarjetas') });
      btn.disabled = false;
      btn.innerHTML = idle;
    }
  });

  // F1 · Estudiar sin salir. El mazo YA está en IndexedDB, así que la pantalla de "listo"
  // era la única superficie que no ofrecía repasarlo: empujaba fuera de la app (exportar a
  // Anki) justo donde P10 quería retener. El botón dice CUÁNTAS tarjetas va a encolar —
  // recién generadas están todas vencidas, y meterse en una sesión de 30 sin avisar es una
  // sorpresa desagradable.
  const studyBtn = b.querySelector('#fc-study');
  if (studyBtn) {
    const due = Srs.dueCount(DB.cardsOf(deck));
    studyBtn.querySelector('small').textContent = due ? ` · ${due}` : '';
    studyBtn.disabled = !due;
    studyBtn.addEventListener('click', () => {
      syncFromDom();                                  // las ediciones sin guardar entran al repaso
      Study.open({
        decks: [deck], title: deck.name || t('Estudiar'),
        onClose: () => { if (overlay) renderReview(deck); },
        onNavigate: () => closeModal(),
      });
    });
  }

  const fileBase = () => {
    const slug = (s) => (s || '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'libro';
    return `${slug(ctx.bookTitle)}-flashcards-${new Date().toISOString().slice(0, 10)}`;
  };
  const exporting = async (btn, fn) => {
    syncFromDom();
    deck.cards = deck.cards.filter(c => c.front);
    if (!deck.cards.length) { showError(t('No queda ninguna tarjeta que exportar.')); return; }
    btn.disabled = true;
    try { await fn(); showError(''); }
    catch (e) { console.error('Export de flashcards falló:', e); showError(t('No se pudo exportar: {msg}', { msg: e.message })); }
    finally { btn.disabled = false; }
  };
  b.querySelector('#fc-apkg').addEventListener('click', (e) => exporting(e.currentTarget, async () => {
    const blob = await buildApkg(deck.name, deck.cards.map(withTags(deck)));
    downloadText(`${fileBase()}.apkg`, blob, 'application/octet-stream');
  }));
  b.querySelector('#fc-txt').addEventListener('click', (e) => exporting(e.currentTarget, async () => {
    downloadText(`${fileBase()}.txt`, buildAnkiTxt(deck.name, deck.cards.map(withTags(deck))), 'text/plain');
  }));
}

// Tags de Anki por tarjeta: la app y el capítulo de origen (filtrables en Anki).
function withTags(deck) {
  return (c) => ({ ...c, tags: ['bookreader', c.chapter || deck.scope || ''] });
}
