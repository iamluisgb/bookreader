// P18 · Modo Feynman — explicas tú, el libro te contrasta.
//
// Diseño sobre literatura de tutoría (ver BACKLOG · P18). Tres decisiones que separan esto
// de un "corrígeme" ingenuo, y que son la razón de que el módulo tenga la forma que tiene:
//
// 1. LAS EXPECTATIVAS SE CALCULAN ANTES DE QUE HABLES. Es el mecanismo de AutoTutor
//    (expectation & misconception-tailored dialogue): una lista previa de unidades de
//    contenido esperadas + errores anticipados, cada una CON SU CITA. Improvisar el listón
//    mientras se corrige es lo que produce el "has omitido X" injusto cuando X estaba
//    implícito — el riesgo nº1 de esta feature. Precalculado y citado, el criterio es
//    auditable: el usuario ve la expectativa y el pasaje del que sale.
//
// 2. NO SE DA EL VEREDICTO: SE ESCALA. pump → hint → prompt → assert. Preguntar "¿qué más?"
//    antes que dar una pista, la pista antes que pedir la pieza, y afirmarla solo al final.
//    LA ESCALADA LA DECIDE EL CÓDIGO (`moveFor`), no el modelo: el nivel es función de las
//    vueltas dadas sobre la MISMA expectativa. Así es determinista, testeable y no depende
//    de que el modelo se resista a la tentación de ayudar.
//
// 3. POR DEFECTO SOLO PREGUNTA. En Chi et al. (2001), suprimir a los tutores explicar y dar
//    feedback —dejándoles solo preguntar— NO empeoró el aprendizaje. Aquí eso significa una
//    sola llamada por vuelta (barato) y que el diagnóstico completo es una acción explícita
//    de cierre (seguro: si casi nunca emite veredicto, casi nunca puede ser injusto).
//
// Granularidad: UNA expectativa por vuelta. En VanLehn la tutoría step-based rinde 0.76
// (≈ humano) y la sub-step, más fina, 0.40. Corregir frase por frase es peor, no mejor.

import { t, uiLangName } from '../i18n.js';
import * as LLM from './llm.js';
import * as Retrieval from './retrieval.js';
import { balancedObjects } from './query-expand.js';
import { renderWithCitations } from './render.js';
import { icon } from '../ui/icons.js';
import { escapeHtml } from '../ui/escape.js';

// Vueltas sobre la MISMA expectativa antes de subir de escalón. La escalada es por
// expectativa, no por sesión: cambiar de tema reinicia el andamiaje de ese tema.
export const MOVES = ['pump', 'hint', 'prompt', 'assert'];

export function moveFor(attempts) {
  return MOVES[Math.min(Math.max(0, attempts | 0), MOVES.length - 1)];
}

// Qué se le permite hacer al modelo en cada escalón. El texto entra en el prompt.
const MOVE_RULES = {
  pump: `PUMP — invita a seguir sin dar ninguna pista ("¿qué más?", "¿y por qué eso?", "sigue").
NO menciones el contenido que falta. NO des ejemplos. Una sola frase.`,
  hint: `HINT — una pista que apunte a la zona del concepto que falta, SIN nombrar la pieza
("piensa en qué pasa con la escala cuando las dimensiones crecen"). NO la digas.`,
  prompt: `PROMPT — pide EXPLÍCITAMENTE la pieza que falta, en forma de pregunta directa que se
responda con esa pieza ("¿por qué se divide entre la raíz de d_k?"). Sigue sin decirla.`,
  assert: `ASSERT — el usuario ya ha tenido tres oportunidades: AHORA sí dile la pieza que falta,
en una o dos frases, con su cita [[aN]], y pregúntale si la ve encajar.`,
};

const EXPECT_MIN = 3;
const EXPECT_MAX = 7;

// ---- extracción de expectativas ------------------------------------------------

// Unidades de contenido que una buena explicación del concepto debería tocar, más los
// errores típicos, TODO con su ancla. Una llamada, cacheable por concepto.
export function buildExpectationsPrompt(concept, bookTitle, passages) {
  const ctx = passages.map((p) => `[[${p.id}]] ${p.text}`).join('\n\n');
  return [
    { role: 'system', content:
`Preparas el material de un tutor socrático para el libro "${bookTitle}". El alumno va a explicar un
concepto con SUS palabras y tú necesitas, DE ANTEMANO, contra qué contrastarlo.

Devuelve SOLO objetos JSON, uno por línea, sin prosa alrededor:
{"kind":"expectation","text":"<una idea que una buena explicación debe contener>","src":"aN"}
{"kind":"misconception","text":"<un error o confusión típica sobre esto>","src":"aN"}

Reglas:
- Entre ${EXPECT_MIN} y ${EXPECT_MAX} expectativas, ordenadas de más central a más accesoria.
- Cada una, UNA idea comprobable, no un resumen. Frase corta, en ${uiLangName()}.
- "src" es el ancla [[aN]] del pasaje que la respalda: OBLIGATORIO y real, de los de abajo.
- Las misconceptions salen del propio libro cuando avisa de una confusión ("a common mistake…",
  "no confundir con…"). Si el texto no menciona ninguna, no inventes: devuelve solo expectativas.
- Nada de contenido que no esté en los pasajes.` },
    { role: 'user', content: `CONCEPTO: ${concept}\n\nPASAJES DEL LIBRO:\n${ctx}` },
  ];
}

// Tolerante por diseño, igual que parseCards: extrae objetos balanceados y descarta lo roto,
// así una respuesta truncada o envuelta en razonamiento sigue sirviendo.
export function parseExpectations(raw) {
  const text = String(raw || '')
    .replace(/```(?:json)?/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ');
  const expectations = [], misconceptions = [];
  for (const chunk of balancedObjects(text)) {
    let o;
    try { o = JSON.parse(chunk); } catch { continue; }
    const body = typeof o?.text === 'string' ? o.text.trim() : '';
    if (!body) continue;
    const src = typeof o.src === 'string' ? (o.src.match(/a\d+/) || [])[0] || '' : '';
    const item = { text: body, src };
    if (o.kind === 'misconception') misconceptions.push(item);
    else expectations.push(item);
  }
  return {
    expectations: expectations.slice(0, EXPECT_MAX).map((e, i) => ({ id: `e${i + 1}`, ...e, covered: false })),
    misconceptions: misconceptions.slice(0, 4).map((m, i) => ({ id: `m${i + 1}`, ...m, hit: false })),
  };
}

// ---- una vuelta del diálogo ----------------------------------------------------

// El modelo hace DOS cosas: marcar qué expectativas ha cubierto la explicación y redactar el
// siguiente movimiento. Pero el MOVIMIENTO se lo imponemos nosotros (`move`), calculado por
// código a partir de los intentos: si se lo dejáramos elegir, elegiría ayudar.
export function buildTurnPrompt({ concept, bookTitle, expectations, misconceptions, explanation, move, targetId }) {
  const list = expectations.map((e) => `${e.id}: ${e.text}${e.covered ? '  [YA CUBIERTA]' : ''}`).join('\n');
  const wrong = misconceptions.length
    ? `\nERRORES TÍPICOS (marca los que aparezcan en la explicación):\n${misconceptions.map((m) => `${m.id}: ${m.text}`).join('\n')}`
    : '';
  const target = expectations.find((e) => e.id === targetId);
  return [
    { role: 'system', content:
`Eres un tutor socrático. El alumno explica "${concept}" del libro "${bookTitle}" con sus palabras.
Tu trabajo NO es explicar: es que lo construya él.

EXPECTATIVAS (lo que una buena explicación debe contener):
${list}${wrong}

Devuelve SOLO este JSON, sin prosa:
{"covered":["eN",...],"hit":["mN",...],"say":"<tu único mensaje al alumno>"}

- "covered": ids que la explicación SÍ cubre, aunque sea con otras palabras o de forma parcial
  pero correcta. Sé generoso: penalizar por vocabulario distinto es el peor error que puedes
  cometer aquí. Si la idea está, cuenta.
- "hit": ids de errores típicos que el alumno ha cometido de verdad.
- "say": UNA intervención, en ${uiLangName()}, sobre esta expectativa concreta:
  ${target ? `${target.id}: ${target.text}` : '(ya está todo cubierto: felicítale en una frase y para)'}

MOVIMIENTO OBLIGATORIO DE ESTE TURNO: ${move.toUpperCase()}
${MOVE_RULES[move]}

Prohibido: resumir su explicación, corregir estilo, dar la respuesta completa fuera del ASSERT,
o encadenar varias preguntas. Una intervención, breve, y calla.` },
    { role: 'user', content: `EXPLICACIÓN DEL ALUMNO:\n${explanation}` },
  ];
}

export function parseTurn(raw) {
  const text = String(raw || '').replace(/```(?:json)?/gi, '').replace(/<think>[\s\S]*?<\/think>/gi, ' ');
  for (const chunk of balancedObjects(text)) {
    let o;
    try { o = JSON.parse(chunk); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    if (!('covered' in o) && !('say' in o)) continue;
    return {
      covered: Array.isArray(o.covered) ? o.covered.filter((x) => typeof x === 'string') : [],
      hit: Array.isArray(o.hit) ? o.hit.filter((x) => typeof x === 'string') : [],
      say: typeof o.say === 'string' ? o.say.trim() : '',
    };
  }
  return { covered: [], hit: [], say: '' };
}

// ---- estado de sesión (puro) ---------------------------------------------------

export function newSession(concept, { expectations, misconceptions }) {
  return {
    concept,
    expectations: expectations.map((e) => ({ ...e })),
    misconceptions: misconceptions.map((m) => ({ ...m })),
    attempts: {},      // id de expectativa -> vueltas gastadas en ella
    rounds: [],        // { explanation, say, move, targetId, newlyCovered }
    finished: false,
  };
}

// La expectativa objetivo es la PRIMERA sin cubrir: van ordenadas de más central a más
// accesoria, así que se ataca lo importante antes que lo accesorio.
export function nextTarget(session) {
  return session.expectations.find((e) => !e.covered) || null;
}

export function coverage(session) {
  const total = session.expectations.length;
  return { done: session.expectations.filter((e) => e.covered).length, total };
}

// Aplica el resultado de una vuelta. Devuelve la sesión NUEVA (no muta) para que la UI
// pueda comparar y animar, y para poder testearlo sin DOM.
export function applyTurn(session, { covered, hit, say, move, targetId, explanation }) {
  const s = {
    ...session,
    expectations: session.expectations.map((e) => (covered.includes(e.id) ? { ...e, covered: true } : { ...e })),
    misconceptions: session.misconceptions.map((m) => (hit.includes(m.id) ? { ...m, hit: true } : { ...m })),
    attempts: { ...session.attempts },
    rounds: [...session.rounds],
  };
  // Solo se gasta intento si la expectativa objetivo SIGUE sin cubrir: si el alumno la
  // resolvió, el andamiaje no debe haber avanzado (empezaría la siguiente ya con pistas).
  const stillOpen = !covered.includes(targetId);
  if (targetId && stillOpen) s.attempts[targetId] = (s.attempts[targetId] || 0) + 1;
  s.rounds.push({ explanation, say, move, targetId, newlyCovered: covered.filter((id) => {
    const prev = session.expectations.find((e) => e.id === id);
    return prev && !prev.covered;
  }) });
  s.finished = !nextTarget(s);
  return s;
}

// Movimiento que toca para la siguiente vuelta, dado el estado.
export function plan(session) {
  const target = nextTarget(session);
  if (!target) return { targetId: null, move: 'pump' };
  return { targetId: target.id, move: moveFor(session.attempts[target.id] || 0) };
}

// ---- diagnóstico de cierre -----------------------------------------------------

// Lo que el usuario pide explícitamente al terminar ("dime qué me he dejado"). No hay llamada
// al modelo: todo sale del estado y de las citas ya calculadas. Barato, instantáneo y —lo que
// importa— imposible de inventar.
export function diagnosis(session) {
  return {
    concept: session.concept,
    covered: session.expectations.filter((e) => e.covered),
    missing: session.expectations.filter((e) => !e.covered),
    mistakes: session.misconceptions.filter((m) => m.hit),
    rounds: session.rounds.length,
  };
}

// ---- pasajes del concepto ------------------------------------------------------

// Contexto para extraer las expectativas: los mejores pasajes del concepto, con vecinos
// (una definición suele continuar en el pasaje siguiente).
export function passagesFor(concept, k = 8) {
  const hits = Retrieval.search(concept, k) || [];
  const picked = Retrieval.withNeighbors(hits.map((h) => ({ id: h.id, text: h.text || '' })), 1) || [];
  return picked.filter((p) => p && p.id && p.text).slice(0, 14);
}

// ---- render de apoyo (usado por la UI y testeado aparte) ------------------------

// ---- dictado ------------------------------------------------------------------

// Explicar EN VOZ ALTA es el ejercicio de Feynman; teclear un párrafo es otra cosa y casi
// nadie lo hace. `SpeechRecognition` es del navegador (nada sale de la máquina salvo lo que
// el propio navegador haga), pero su soporte es irregular: si no está, no se enseña el botón
// y el textarea es el camino normal, no un consuelo.
export function speechSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function createDictation({ onText, onEnd }) {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = uiLangName() === 'español' ? 'es-ES' : 'en-US';
  let finalText = '';
  rec.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) finalText += r[0].transcript + ' ';
      else interim += r[0].transcript;
    }
    onText?.(finalText + interim, finalText);
  };
  rec.onend = () => onEnd?.(finalText);
  rec.onerror = () => onEnd?.(finalText);
  return {
    start: () => { try { rec.start(); } catch (e) { /* ya arrancado */ } },
    stop: () => { try { rec.stop(); } catch (e) { /* ya parado */ } },
  };
}

export function renderDiagnosis(d, anchors) {
  const cite = (item) => (item.src ? ` [[${item.src}]]` : '');
  const block = (title, items, cls) => (items.length
    ? `<div class="fey-block ${cls}"><h4>${escapeHtml(title)}</h4><ul>${
      items.map((i) => `<li>${renderWithCitations(escapeHtml(i.text) + cite(i), anchors)}</li>`).join('')
    }</ul></div>`
    : '');
  return [
    block(t('Lo que has explicado bien'), d.covered, 'fey-ok'),
    block(t('Lo que te has dejado'), d.missing, 'fey-missing'),
    block(t('Confusiones a vigilar'), d.mistakes, 'fey-wrong'),
  ].filter(Boolean).join('') || `<p class="empty-state">${t('Aún no has explicado nada.')}</p>`;
}

// ================= UI =================
// Modal propio (no una vista del chat): el valor está en el CICLO, y un rol de chat pierde
// el estado en dos turnos y vuelve a explicarte las cosas — justo lo contrario del ejercicio.

let ctx = null;          // { bookId, bookTitle, tocLabels, currentChapter, ensureIndex, anchors, onCite }
let overlay = null;
let session = null;
let dictation = null;
let busy = false;

export function open(context) {
  ctx = context;
  session = null;
  closeModal();
  overlay = document.createElement('div');
  overlay.id = 'ai-feynman';
  overlay.className = 'ai-onboarding';
  overlay.innerHTML = `
    <div class="ai-ob-card fey-card" role="dialog" aria-modal="true" aria-label="${t('Explícamelo tú')}">
      <button class="ai-ob-close" title="${t('Cerrar')}" aria-label="${t('Cerrar')}">${icon('xmark', { size: 18 })}</button>
      <div class="ai-ob-body"></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeModal(); });
  overlay.querySelector('.ai-ob-close').addEventListener('click', () => closeModal());
  overlay.addEventListener('click', onCiteClick);
  document.addEventListener('keydown', onKey);
  renderSetup();
}

function onKey(e) { if (e.key === 'Escape' && overlay) closeModal(); }

function onCiteClick(e) {
  const chip = e.target.closest?.('.ai-cite');
  if (!chip || !ctx?.onCite) return;
  ctx.onCite(chip.dataset.id);
  closeModal();
}

function closeModal() {
  document.removeEventListener('keydown', onKey);
  stopDictation();
  if (overlay) { overlay.remove(); overlay = null; }
}

const body = () => overlay?.querySelector('.ai-ob-body');

// ---- Vista 1: elegir concepto --------------------------------------------------

// Solo para tests: inyecta una sesión y pinta su vista. La alternativa era exponer el
// estado interno o conducir dos llamadas reales al modelo para llegar a la vista.
export function __setSessionForTest(s) {
  session = s;
  renderSession('');
}

function renderSetup() {
  const b = body();
  if (!b) return;
  ctx.ensureIndex?.();
  const chapters = (ctx.tocLabels || []).filter((c) => c && !Retrieval.isBoilerplate(c));
  b.innerHTML = `
    <h2>${t('Explícamelo tú')}</h2>
    <p class="ai-ob-sub">${t('Explica un concepto con tus palabras. No te voy a dar la respuesta: te voy a preguntar hasta que la construyas tú. Al final te digo qué te dejaste.')}</p>
    <label class="fc-label" for="fey-concept">${t('¿Qué concepto vas a explicar?')}</label>
    <input id="fey-concept" class="appset-input" autocomplete="off"
           placeholder="${t('p. ej. la atención causal, el mecanismo de tokenización…')}" />
    ${chapters.length ? `<p class="fey-hint">${t('Del capítulo actual:')} ${
      chapters.filter((c) => c === ctx.currentChapter).map((c) => `<button class="fey-chip" data-c="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('') ||
      chapters.slice(0, 3).map((c) => `<button class="fey-chip" data-c="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('')
    }</p>` : ''}
    <button id="fey-start" class="primary-btn ai-ob-start">${icon('sparkles', { size: 16 })} ${t('Empezar')}</button>
    <div id="fey-error" class="fc-error" style="display:none"></div>`;
  b.querySelectorAll('.fey-chip').forEach((chip) => {
    chip.addEventListener('click', () => { b.querySelector('#fey-concept').value = chip.dataset.c; });
  });
  b.querySelector('#fey-start').addEventListener('click', startSession);
  b.querySelector('#fey-concept').addEventListener('keydown', (e) => { if (e.key === 'Enter') startSession(); });
}

function showError(msg) {
  const el = body()?.querySelector('#fey-error');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
}

// ---- arranque: extraer expectativas -------------------------------------------

async function startSession() {
  const input = body()?.querySelector('#fey-concept');
  const concept = (input?.value || '').trim();
  if (!concept) { showError(t('Escribe el concepto que quieres explicar.')); return; }
  if (!LLM.hasKey()) { showError(t('Configura tu API key en Ajustes → Agente.')); return; }

  renderLoading(t('Preparando las preguntas…'));
  try {
    ctx.ensureIndex?.();
    const passages = passagesFor(concept);
    if (!passages.length) { renderSetup(); showError(t('No encuentro ese concepto en el libro. Prueba con otras palabras.')); return; }
    // Holgura para modelos de razonamiento: con un techo bajo, el razonamiento se come el
    // presupuesto y el contenido sale VACÍO (no da error, simplemente no hay texto).
    const raw = await LLM.chatStream({ messages: buildExpectationsPrompt(concept, ctx.bookTitle, passages), maxTokens: 3000 });
    const parsed = parseExpectations(raw);
    if (!parsed.expectations.length) {
      renderSetup();
      showError(String(raw || '').trim()
        ? t('No he sabido preparar este concepto. Prueba a acotarlo más.')
        : t('El modelo no respondió. Si usas un modelo de razonamiento, prueba con otro o inténtalo de nuevo.'));
      return;
    }
    session = newSession(concept, parsed);
    renderSession(t('Adelante: explícamelo con tus palabras, como si yo no supiera nada del tema.'));
  } catch (e) {
    console.error('feynman:', e);
    renderSetup();
    showError(e.message || t('No se pudo preparar la sesión.'));
  }
}

function renderLoading(msg) {
  const b = body();
  if (!b) return;
  b.innerHTML = `<h2>${t('Explícamelo tú')}</h2><p class="ai-ob-sub"><span class="ai-typing">${escapeHtml(msg)}</span></p>`;
}

// ---- Vista 2: la sesión --------------------------------------------------------

function renderSession(say) {
  const b = body();
  if (!b || !session) return;
  const { done, total } = coverage(session);
  b.innerHTML = `
    <h2 class="fey-h2">${escapeHtml(session.concept)}</h2>
    <div class="fey-progress" aria-label="${t('Ideas cubiertas')}">
      <div class="fey-progress-bar"><span style="width:${total ? (done / total) * 100 : 0}%"></span></div>
      <span class="fey-progress-n">${t('{done} de {total} ideas', { done, total })}</span>
    </div>
    <div id="fey-say" class="fey-say">${renderWithCitations(say || '', ctx.anchors || new Map())}</div>
    <textarea id="fey-input" class="fey-input" rows="5"
      placeholder="${t('Explícalo con tus palabras…')}"></textarea>
    <div class="fey-actions">
      ${speechSupported() ? `<button id="fey-mic" class="appset-tpl-cancel" title="${t('Dictar')}">${icon('user', { size: 15 })} <span id="fey-mic-label">${t('Dictar')}</span></button>` : ''}
      <button id="fey-send" class="primary-btn">${t('Enviar')}</button>
      <button id="fey-finish" class="appset-tpl-cancel">${t('Ya vale, ¿qué me dejé?')}</button>
    </div>
    <div id="fey-error" class="fc-error" style="display:none"></div>`;

  b.querySelector('#fey-send').addEventListener('click', sendExplanation);
  // Sin la lambda, el MouseEvent entra como `complete` y —siendo truthy— el diagnóstico
  // felicitaría por haberlo cubierto todo justo cuando el usuario se rinde a medias.
  b.querySelector('#fey-finish').addEventListener('click', () => renderDiagnosisView(false));
  const mic = b.querySelector('#fey-mic');
  if (mic) mic.addEventListener('click', toggleDictation);
  b.querySelector('#fey-input').focus();
}

function toggleDictation() {
  const input = body()?.querySelector('#fey-input');
  const label = body()?.querySelector('#fey-mic-label');
  if (!input) return;
  if (dictation) { stopDictation(); return; }
  const base = input.value ? input.value + ' ' : '';
  dictation = createDictation({
    onText: (text) => { input.value = base + text; },
    onEnd: () => { dictation = null; if (label) label.textContent = t('Dictar'); body()?.querySelector('#fey-mic')?.classList.remove('fey-mic-on'); },
  });
  if (!dictation) return;
  dictation.start();
  if (label) label.textContent = t('Parar');
  body()?.querySelector('#fey-mic')?.classList.add('fey-mic-on');
}

function stopDictation() {
  if (!dictation) return;
  dictation.stop();
  dictation = null;
}

async function sendExplanation() {
  if (busy || !session) return;
  const input = body()?.querySelector('#fey-input');
  const explanation = (input?.value || '').trim();
  if (!explanation) { showError(t('Escribe o dicta tu explicación primero.')); return; }
  stopDictation();
  busy = true;
  const sayEl = body()?.querySelector('#fey-say');
  if (sayEl) sayEl.innerHTML = `<span class="ai-typing">${t('escuchando…')}</span>`;

  const { targetId, move } = plan(session);
  try {
    const raw = await LLM.chatStream({
      messages: buildTurnPrompt({
        concept: session.concept,
        bookTitle: ctx.bookTitle,
        expectations: session.expectations,
        misconceptions: session.misconceptions,
        explanation, move, targetId,
      }),
      maxTokens: 1500,   // igual que resumen/mapa: hueco para el razonamiento + el JSON
    });
    const turn = parseTurn(raw);
    session = applyTurn(session, { ...turn, move, targetId, explanation });
    if (session.finished) renderDiagnosisView(true);
    else renderSession(turn.say || t('¿Qué más?'));
  } catch (e) {
    console.error('feynman:', e);
    renderSession(t('Se me ha ido el hilo. Repítemelo, por favor.'));
    showError(e.message || '');
  } finally {
    busy = false;
  }
}

// ---- Vista 3: el diagnóstico ---------------------------------------------------

function renderDiagnosisView(complete = false) {
  const b = body();
  if (!b || !session) return;
  stopDictation();
  const d = diagnosis(session);
  const { done, total } = coverage(session);
  b.innerHTML = `
    <h2 class="fey-h2">${escapeHtml(session.concept)}</h2>
    <p class="ai-ob-sub">${complete
      ? t('Lo has cubierto entero. Esto es lo que has construido:')
      : t('{done} de {total} ideas cubiertas en {n} vueltas.', { done, total, n: d.rounds })}</p>
    <div class="fey-diag">${renderDiagnosis(d, ctx.anchors || new Map())}</div>
    <div class="fey-actions">
      <button id="fey-again" class="primary-btn">${t('Otro concepto')}</button>
      <button id="fey-close" class="appset-tpl-cancel">${t('Cerrar')}</button>
    </div>`;
  b.querySelector('#fey-again').addEventListener('click', () => { session = null; renderSetup(); });
  b.querySelector('#fey-close').addEventListener('click', closeModal);
}
