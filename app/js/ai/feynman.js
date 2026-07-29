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
import * as Jobs from './jobs.js';
import { balancedObjects, expandQuery, expansionQuery } from './query-expand.js';
import { renderWithCitations } from './render.js';
import { icon } from '../ui/icons.js';
import { escapeHtml } from '../ui/escape.js';
import * as AppSettings from '../ui/app-settings.js';
import { attachMic, micAvailable } from './mic.js';
import { dictationLang, setDictationLang, recorderSupported } from './dictation-engine.js';

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

// ---- qué concepto explicar: sugerencias ----------------------------------------

// Un TÍTULO DE CAPÍTULO NO ES UN CONCEPTO. "Working with Text Data" no es algo que puedas
// explicar; "byte pair encoding" sí. La pantalla ofrecía capítulos del TOC porque era lo
// único a mano, y dejaba al usuario escribiendo a ciegas. Aquí se ofrecen conceptos de
// verdad, por tres vías y en este orden de preferencia:
//
//   1. Hojas del MAPA MENTAL ya generado de este libro (`jobs`): conceptos destilados por
//      el modelo y con su ancla. Gratis, ya están pagados.
//   2. SUBTÍTULOS del capítulo actual (`retrieval.sectionsByChapter`): la propia estructura
//      del libro a nivel de sección. Gratis, siempre disponible y fiel al texto.
//   3. Extracción con el modelo, DETRÁS DE UN BOTÓN explícito (`suggestWithLLM`): entrar al
//      modo no debe costar una llamada antes de haber escrito nada.

const MAX_CONCEPT_WORDS = 8;
const MAX_SUGGESTIONS = 8;

// Quita el numeral de sección de delante ("3.2 Encoding word positions") y la puntuación
// de cierre. Mismo criterio que `tidyChapter` en mindmap.js.
export function cleanConcept(label) {
  return String(label || '')
    .replace(/^\s*(?:chapter|cap[íi]tulo|secci[óo]n|section|part[e]?|appendix|ap[ée]ndice|anexo)?\s*\d+(?:\.\d+)*\s*[.)\-–—:\s]\s*/i, '')
    .replace(/^\s*(?:chapter|cap[íi]tulo|part[e]?)\s+[ivxlcdm]+\s*[.)\-–—:\s]\s*/i, '')
    .replace(/^\s*[-–—]\s*/, '')
    .replace(/\s+/g, ' ')
    .replace(/[.:;,\s]+$/, '')
    .trim();
}

// ¿Esto se puede explicar? Fuera lo accesorio (índices, bibliografía…), los rótulos de
// aparato ("Exercises", "Summary", "Figure 3.2") y lo que es demasiado largo para ser el
// nombre de un concepto — un encabezado que es una frase entera es una sección, no una idea.
const NON_CONCEPT_RE = /^(exercises?|ejercicios?|summary|resumen|conclusi[óo]n|conclusions?|key ?takeaways?|further reading|lecturas?|notes?|notas?|figure|figura|table|tabla|listing|c[óo]digo|example \d|referencias?)\b/i;

export function looksLikeConcept(label) {
  const s = cleanConcept(label);
  if (s.length < 3 || s.length > 60) return false;
  if (s.split(/\s+/).length > MAX_CONCEPT_WORDS) return false;
  if (NON_CONCEPT_RE.test(s)) return false;
  if (Retrieval.isBoilerplate(s)) return false;
  return true;
}

// Mezcla y ordena las fuentes. PURA (recibe listas ya recolectadas) para poder testearla
// sin índice ni jobs. Las del capítulo que se está leyendo van primero: es lo que el lector
// acaba de ver y lo que puede explicar ahora mismo.
// `exclude`: rótulos que nunca son un concepto DE ESTE libro por más que aparezcan como
// encabezado — su propio título y el del capítulo en curso (explicar "el capítulo 2" no es
// explicar nada).
export function suggestConcepts({ leaves = [], sections = [], currentChapter = '', exclude = [], max = MAX_SUGGESTIONS } = {}) {
  const sameChapter = (ch) => !!currentChapter && norm(ch) === norm(currentChapter);
  const buckets = [
    leaves.filter((l) => sameChapter(l.chapter)),      // concepto destilado + del capítulo
    sections,                                          // ya vienen solo del capítulo actual
    leaves.filter((l) => !sameChapter(l.chapter)),     // relleno de otros capítulos
  ];
  const seen = new Set([currentChapter, ...exclude].map((s) => norm(cleanConcept(s))));
  const out = [];
  for (const bucket of buckets) {
    for (const item of bucket) {
      const label = cleanConcept(item.label);
      const key = norm(label);
      if (!key || seen.has(key) || !looksLikeConcept(label)) continue;
      seen.add(key);
      // Cada sugerencia viaja con TRES cosas: el rótulo que se lee, el término con el que se
      // busca, y —si la fuente lo sabe— el ANCLA del pasaje de origen, que hace innecesario
      // buscar. Las secciones vienen del propio libro (su rótulo ya está en su idioma); las
      // hojas del mapa mental están en el idioma de la interfaz y solo se salvan por el ancla.
      out.push({ label, term: cleanConcept(item.term || '') || label, src: item.src || '' });
      if (out.length >= max) return out;
    }
  }
  return out;
}

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

// Hojas del último mapa mental de este libro, con el capítulo de su ancla. Si no hay mapa
// generado, no pasa nada: es una fuente oportunista, no un requisito.
export function mindmapConcepts(bookId) {
  const tree = Jobs.latest(bookId, 'mindmap')?.result;
  if (!tree || !Array.isArray(tree.branches)) return [];
  const chapterOf = new Map(Retrieval.allPassages().map((p) => [p.id, p.chapter || '']));
  const out = [];
  for (const br of tree.branches) {
    for (const leaf of br.children || []) {
      const label = (leaf.full || leaf.label || '').trim();
      // `src` es el ancla del pasaje del que salió la hoja: con ella NO hay que buscar nada.
      // Importa porque el mapa se redacta en el idioma de la interfaz, así que sus hojas no
      // sirven como consulta léxica contra un libro en otro idioma — pero su ancla sí.
      if (label) out.push({ label, src: leaf.src || '', chapter: chapterOf.get(leaf.src) || '' });
    }
  }
  return out;
}

// ---- extracción de conceptos con el modelo (acción explícita) --------------------

export function buildConceptsPrompt(scopeLabel, bookTitle, passages) {
  const ctxText = passages.map((p) => p.text).join('\n\n');
  return [
    { role: 'system', content:
`Preparas una lista de conceptos del libro "${bookTitle}" para que un alumno elija cuál va a
EXPLICAR con sus palabras.

Devuelve SOLO objetos JSON, uno por línea, sin prosa alrededor:
{"concept":"<nombre del concepto>","term":"<cómo lo llama el texto de abajo>"}

Reglas:
- Entre 4 y ${MAX_SUGGESTIONS} conceptos, del más central al más accesorio.
- El NOMBRE de una idea (2-5 palabras), en ${uiLangName()}: "atención causal", "byte pair
  encoding". NO títulos de sección, NO preguntas, NO frases enteras.
- "term" es ese mismo concepto CON LAS PALABRAS EXACTAS DEL TEXTO DE ABAJO, en su idioma y sin
  traducir ("tokenizing text", "causal attention"). Es OBLIGATORIO: con él se localiza el
  concepto en el libro. Si el texto está en el mismo idioma, repite el nombre.
- Algo que se pueda explicar y en lo que quepa equivocarse. Nada de datos sueltos ni de
  nombres propios sin sustancia.
- Solo conceptos que el texto de abajo desarrolle de verdad.` },
    { role: 'user', content: `${scopeLabel ? `SECCIÓN DEL LIBRO: ${scopeLabel}\n\n` : ''}TEXTO:\n${ctxText}` },
  ];
}

// Devuelve `{ label, term }`. El LABEL es lo que se pinta (idioma de la interfaz) y el TERM es
// con lo que se BUSCA (idioma del libro). Separarlos es el arreglo de un bug real: con la app
// en español y el libro en inglés, el chip decía "Tokenización de texto", el retrieval es BM25
// léxico sobre el texto en inglés, y "tokenizacion"/"texto" no aparecen en ninguna parte →
// "No encuentro ese concepto en el libro" sobre un concepto que la propia app acababa de
// ofrecer. Sobrevivían solo los que se escriben igual en los dos idiomas ("token embeddings").
export function parseConcepts(raw) {
  const text = String(raw || '').replace(/```(?:json)?/gi, '').replace(/<think>[\s\S]*?<\/think>/gi, ' ');
  const out = [];
  const seen = new Set();
  for (const chunk of balancedObjects(text)) {
    let o;
    try { o = JSON.parse(chunk); } catch { continue; }
    const label = cleanConcept(typeof o?.concept === 'string' ? o.concept : '');
    const key = norm(label);
    if (!key || seen.has(key) || !looksLikeConcept(label)) continue;
    seen.add(key);
    // Sin `term` (modelo que ignora el campo, o libro en el mismo idioma) se busca por el label:
    // es exactamente el comportamiento anterior, así que nunca es peor.
    const term = cleanConcept(typeof o?.term === 'string' ? o.term : '') || label;
    out.push({ label, term });
  }
  return out.slice(0, MAX_SUGGESTIONS);
}

// Muestra del capítulo para la extracción: pasajes REPARTIDOS por todo el capítulo (no los
// primeros), acotados en tamaño. Los conceptos de la segunda mitad cuentan igual que los de
// la primera, y el coste queda acotado.
export function sampleForConcepts(passages, maxChars = 24000) {
  const usable = (passages || []).filter((p) => p && p.text);
  const total = usable.reduce((n, p) => n + p.text.length, 0);
  if (total <= maxChars) return usable;
  const step = Math.ceil(total / maxChars);
  const out = [];
  let chars = 0;
  for (let i = 0; i < usable.length && chars < maxChars; i += step) {
    out.push(usable[i]);
    chars += usable[i].text.length;
  }
  return out;
}

// ---- render de apoyo (usado por la UI y testeado aparte) ------------------------

// ---- dictado ------------------------------------------------------------------

// Los MOTORES viven en dictation-engine.js (los comparten el modo Feynman y la barra del
// chat). Se re-exportan aquí porque son parte de la superficie pública histórica de este
// módulo y hay tests que los importan desde él.
export {
  speechSupported, dictationLang, setDictationLang, speechErrorMessage,
  createDictation, recorderSupported, createRecorder,
} from './dictation-engine.js';

// Vocabulario del capítulo para sesgar la transcripción. Sale de lo que la sesión YA tiene
// calculado antes de que el usuario abra la boca: no cuesta ni una llamada.
export function sttPrompt(sess) {
  if (!sess) return '';
  const terms = [sess.concept, ...(sess.expectations || []).map((e) => e.text || '')].filter(Boolean);
  return terms.join('. ').slice(0, 900);
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
let pickedTerm = '';     // término del chip elegido: con lo que se BUSCA en el libro
let pickedSrc = '';      // ancla del chip elegido: mejor que buscar, es el pasaje exacto
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

// Sugerencias en memoria de la sesión del modal, por capítulo: las gratis se recalculan
// solas, pero las que costaron una llamada no se vuelven a pedir al volver de una sesión.
const suggestCache = new Map();   // `${bookId}::${chapter}` → [concepto]

function suggestKey() { return `${ctx?.bookId || ''}::${ctx?.currentChapter || ''}`; }

function freeSuggestions() {
  const currentChapter = ctx.currentChapter || '';
  return suggestConcepts({
    leaves: mindmapConcepts(ctx.bookId),
    sections: Retrieval.sectionsByChapter(currentChapter),
    currentChapter,
    exclude: [ctx.bookTitle || ''],
  });
}

function renderSetup() {
  const b = body();
  if (!b) return;
  ctx.ensureIndex?.();
  const cached = suggestCache.get(suggestKey());
  const concepts = cached || freeSuggestions();
  // Último recurso cuando el libro no da ni subtítulos ni mapa (PDF plano, EPUB sin
  // encabezados internos, como los de Gutenberg): capítulos del TOC, pero solo los que de
  // verdad tienen texto indexado —el filtro que ya usa el mapa mental— y pasados por el
  // mismo cedazo de concepto, que descarta el título del libro repetido como capítulo,
  // la página de créditos de la traducción y demás aparato.
  const chapters = concepts.length ? [] : suggestConcepts({
    leaves: (ctx.tocLabels || [])
      .filter((c) => c && Retrieval.passagesByChapter(c).length)
      .map((c) => ({ label: c, chapter: '' })),
    exclude: [ctx.bookTitle || ''],
    max: 4,
  });
  // El chip lleva lo que se lee (`data-c`), con qué se busca (`data-term`) y, si se conoce,
  // el ancla exacta del pasaje (`data-src`), que evita buscar del todo.
  const chips = (list) => list.map((c) =>
    `<button class="fey-chip" data-c="${escapeHtml(c.label)}" data-term="${escapeHtml(c.term || c.label)}"${
      c.src ? ` data-src="${escapeHtml(c.src)}"` : ''}>${escapeHtml(c.label)}</button>`).join('');
  b.innerHTML = `
    <h2>${t('Explícamelo tú')}</h2>
    <p class="ai-ob-sub">${t('Explica un concepto con tus palabras. No te voy a dar la respuesta: te voy a preguntar hasta que la construyas tú. Al final te digo qué te dejaste.')}</p>
    <label class="fc-label" for="fey-concept">${t('¿Qué concepto vas a explicar?')}</label>
    <input id="fey-concept" class="appset-input" autocomplete="off"
           placeholder="${t('p. ej. la atención causal, el mecanismo de tokenización…')}" />
    <div id="fey-suggest">
      ${concepts.length || chapters.length
        ? `<p class="fey-hint">${concepts.length ? t('Conceptos de lo que estás leyendo:') : t('Del libro:')}</p>
           <div class="fey-chips">${chips(concepts.length ? concepts : chapters)}</div>`
        : ''}
      <button id="fey-more" class="fey-suggest-btn">${icon('sparkles', { size: 14 })} ${
        concepts.length ? t('Sugerir otros conceptos') : t('Sugerir conceptos')}</button>
    </div>
    <button id="fey-start" class="primary-btn ai-ob-start">${icon('sparkles', { size: 16 })} ${t('Empezar')}</button>
    <div id="fey-error" class="fc-error" style="display:none"></div>`;
  b.querySelector('#fey-suggest').addEventListener('click', (e) => {
    const chip = e.target.closest('.fey-chip');
    if (chip) {
      b.querySelector('#fey-concept').value = chip.dataset.c;
      pickedTerm = chip.dataset.term || '';
      pickedSrc = chip.dataset.src || '';
      return;
    }
    if (e.target.closest('#fey-more')) suggestWithLLM();
  });
  b.querySelector('#fey-start').addEventListener('click', startSession);
  const inp = b.querySelector('#fey-concept');
  // Si el usuario reescribe, el término del chip deja de valer: se busca lo que él ha puesto.
  inp.addEventListener('input', () => { pickedTerm = ''; pickedSrc = ''; });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') startSession(); });
}

// Extracción con el modelo: una llamada corta sobre una muestra del capítulo. Va detrás de
// un botón —no al abrir— para que entrar al modo siga costando cero. Se queda en caché para
// que volver a la pantalla no la repita.
async function suggestWithLLM() {
  const b = body();
  const btn = b?.querySelector('#fey-more');
  if (!btn || btn.disabled) return;
  if (!LLM.hasKey()) { showError(t('Configura tu API key en Ajustes → Agente.')); return; }
  ctx.ensureIndex?.();
  const chapter = ctx.currentChapter || '';
  // Si el capítulo en curso no tiene texto indexado —cubierta, portadilla, una etiqueta del
  // TOC que no casa, un PDF sin estructura—, se cae al LIBRO ENTERO en vez de rendirse: el
  // usuario ha pedido conceptos, no un informe de por qué no los hay.
  const chapterPassages = chapter ? Retrieval.passagesByChapter(chapter) : [];
  const scoped = chapterPassages.length ? chapterPassages : Retrieval.allPassages();
  const scopeLabel = chapterPassages.length ? chapter : '';
  const passages = sampleForConcepts(scoped);
  if (!passages.length) { showError(t('No hay texto indexado del que sacar conceptos.')); return; }

  btn.disabled = true;
  btn.innerHTML = `<span class="ai-typing">${t('Buscando conceptos…')}</span>`;
  try {
    // Holgura para modelos de razonamiento: MISMO motivo que en la extracción de expectativas
    // (más abajo). Con un techo bajo el razonamiento se come el presupuesto y el contenido
    // sale VACÍO —no da error, simplemente no hay texto—, que es como se veía este botón
    // "fallando" con un modelo de razonamiento detrás.
    const raw = await LLM.chatStream({
      messages: buildConceptsPrompt(scopeLabel, ctx.bookTitle, passages), maxTokens: 3000,
    });
    const concepts = parseConcepts(raw);
    if (!concepts.length) {
      // Distinguir "no respondió" de "respondió algo que no sirve": son dos arreglos distintos
      // para el usuario (cambiar de modelo vs. reintentar).
      showError(String(raw || '').trim()
        ? t('No he sabido sacar conceptos de aquí. Escribe el que tengas en mente.')
        : t('El modelo no respondió. Si usas un modelo de razonamiento, prueba con otro o inténtalo de nuevo.'));
      return;
    }
    // Los del modelo van DELANTE de los gratuitos: el usuario acaba de pedirlos.
    const merged = suggestConcepts({
      leaves: [...concepts.map((c) => ({ ...c, chapter: ctx.currentChapter || '' })), ...mindmapConcepts(ctx.bookId)],
      sections: Retrieval.sectionsByChapter(ctx.currentChapter || ''),
      currentChapter: ctx.currentChapter || '',
      exclude: [ctx.bookTitle || ''],
    });
    suggestCache.set(suggestKey(), merged);
    if (body()) renderSetup();
  } catch (e) {
    console.error('feynman: sugerir conceptos', e);
    showError(e.message || t('No se pudieron sugerir conceptos.'));
  } finally {
    const again = body()?.querySelector('#fey-more');
    if (again) { again.disabled = false; again.innerHTML = `${icon('sparkles', { size: 14 })} ${t('Sugerir otros conceptos')}`; }
  }
}

function showError(msg) {
  const el = body()?.querySelector('#fey-error');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
}

// Error CON SALIDA. Un mensaje que solo describe el problema deja al usuario parado; si hay
// una acción que lo resuelve, va pegada al mensaje. Se construye con nodos (no innerHTML):
// el texto puede venir de un error del navegador.
function showErrorWithAction(msg, label, run) {
  const el = body()?.querySelector('#fey-error');
  if (!el) return;
  el.textContent = msg + ' ';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fey-err-act';
  btn.textContent = label;
  btn.addEventListener('click', run);
  el.appendChild(btn);
  el.style.display = 'block';
}

// ---- arranque: extraer expectativas -------------------------------------------

// Localiza los pasajes del concepto con hasta TRES intentos, de más barato a más caro:
//  1) el término del chip (idioma del libro) — gratis y el que resuelve el caso habitual;
//  2) lo escrito por el usuario — para conceptos tecleados a mano;
//  3) la expansión de consulta de IA7 — una llamada corta al modelo rápido, que traduce y
//     añade sinónimos. Es la red para quien escribe "tokenización" en un libro en inglés.
// Sin (3), el usuario se queda contra un muro sin forma de salir salvo adivinar el idioma.
async function locatePassages(concept) {
  // 0) ANCLA. Si la sugerencia sabe de qué pasaje salió, no hay nada que buscar: se coge ese
  //    y sus vecinos. Es el caso de las hojas del mapa mental, que se redactan en el idioma
  //    de la INTERFAZ y por tanto nunca casarían por léxico contra un libro en otro idioma.
  if (pickedSrc) {
    const seed = Retrieval.allPassages().find((p) => p.id === pickedSrc);
    if (seed) {
      const hits = Retrieval.withNeighbors([{ id: seed.id, text: seed.text || '' }], 2) || [];
      if (hits.length) return hits.filter((p) => p && p.id && p.text).slice(0, 14);
    }
  }
  for (const q of [pickedTerm, concept]) {
    if (!q) continue;
    const hits = passagesFor(q);
    if (hits.length) return hits;
  }
  if (!LLM.hasKey()) return [];
  const exp = await expandQuery(concept, { tocLabels: ctx.tocLabels || [] }).catch(() => null);
  const q = expansionQuery(exp);
  return q ? passagesFor(q) : [];
}

async function startSession() {
  const input = body()?.querySelector('#fey-concept');
  const concept = (input?.value || '').trim();
  if (!concept) { showError(t('Escribe el concepto que quieres explicar.')); return; }
  if (!LLM.hasKey()) { showError(t('Configura tu API key en Ajustes → Agente.')); return; }

  renderLoading(t('Preparando las preguntas…'));
  try {
    ctx.ensureIndex?.();
    const passages = await locatePassages(concept);
    if (!passages.length) {
      // `renderSetup()` repinta de cero y dejaba el campo VACÍO: había que volver a escribir
      // el concepto para reintentar, justo cuando el mensaje te pide probar otra cosa.
      renderSetup();
      const again = body()?.querySelector('#fey-concept');
      if (again) { again.value = concept; again.focus(); again.select(); }
      showError(t('No encuentro «{c}» en este libro. Si el libro está en otro idioma, prueba con el término tal y como aparece en él.', { c: concept }));
      return;
    }
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

// Siembra la vista de sesión sin pasar por la extracción de expectativas (una llamada al
// modelo). Solo para tests de UI: la lógica se prueba con las funciones puras.
export function __renderSessionForTest(s, say) { session = s; renderSession(say); }

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
      ${micAvailable() ? `<button id="fey-mic" class="appset-tpl-cancel" title="${t('Dictar')}">${icon('mic', { size: 15 })} <span id="fey-mic-label">${t('Dictar')}</span></button>
      <select id="fey-mic-lang" class="fey-mic-lang" title="${t('Idioma del dictado')}" aria-label="${t('Idioma del dictado')}">
        <option value="es"${dictationLang() === 'es' ? ' selected' : ''}>ES</option>
        <option value="en"${dictationLang() === 'en' ? ' selected' : ''}>EN</option>
      </select>` : ''}
      <button id="fey-send" class="primary-btn">${t('Enviar')}</button>
      <button id="fey-finish" class="appset-tpl-cancel">${t('Ya vale, ¿qué me dejé?')}</button>
    </div>
    <div id="fey-error" class="fc-error" style="display:none"></div>`;

  b.querySelector('#fey-send').addEventListener('click', sendExplanation);
  // Sin la lambda, el MouseEvent entra como `complete` y —siendo truthy— el diagnóstico
  // felicitaría por haberlo cubierto todo justo cuando el usuario se rinde a medias.
  b.querySelector('#fey-finish').addEventListener('click', () => renderDiagnosisView(false));
  attachFeynmanMic();
  const micLang = b.querySelector('#fey-mic-lang');
  if (micLang) micLang.addEventListener('change', async () => {
    const grabando = dictation?.recording();
    setDictationLang(micLang.value);
    // Reabrir con el idioma nuevo, pero ESPERANDO a que termine lo anterior: con el motor
    // del proveedor, parar deja una transcripción en vuelo y arrancar otra grabación encima
    // se comería su resultado.
    if (grabando) { await stopDictation(); dictation?.start(); }
  });
  b.querySelector('#fey-input').focus();
}

// Hay micro si el navegador dicta O si hay modelo de transcripción configurado. El motor
// BYOK es OPT-IN: se activa poniendo el modelo en Ajustes, y entonces tiene preferencia
// (acierta bastante más con vocabulario técnico y no se corta solo en móvil).
// La lógica (motores, acumulado, barra de grabación) es la de mic.js, compartida con la barra
// del chat; aquí solo queda lo propio de Feynman: el prompt sale de la sesión y el fallo de red
// del reconocedor ofrece configurar el motor del proveedor en vez de solo describirse.
function attachFeynmanMic() {
  const b = body();
  const input = b?.querySelector('#fey-input');
  const btn = b?.querySelector('#fey-mic');
  if (!input || !btn) return;
  dictation = attachMic({
    input,
    btn,
    getPrompt: () => sttPrompt(session),
    onError: (msg, code) => {
      // El dictado del navegador va contra un servicio externo que puede no estar disponible
      // (sin red, bloqueado por el navegador o por la red del usuario). No es algo que se
      // pueda arreglar desde aquí — pero SÍ tenemos otro motor: el del proveedor BYOK, que
      // solo necesita un modelo en Ajustes. Ofrecerlo es la diferencia entre un mensaje que
      // explica y uno que resuelve.
      const puedeProveedor = recorderSupported() && !LLM.hasStt();
      if ((code === 'network' || code === 'service-not-allowed') && puedeProveedor) {
        showErrorWithAction(
          msg + ' ' + t('Puedes dictar con tu proveedor configurando un modelo de transcripción.'),
          t('Abrir Ajustes'), () => AppSettings.open('agent'));
        return;
      }
      showError(msg);
    },
  });
}

// Devuelve una promesa que resuelve cuando el texto YA está en el textarea. Importa con el
// motor del proveedor: la transcripción llega después de soltar el botón, así que "Enviar"
// mientras grabas tiene que esperarla o mandaría la explicación sin la última parte.
function stopDictation() {
  return dictation?.stop() || Promise.resolve();
}

async function sendExplanation() {
  if (busy || !session) return;
  const input = body()?.querySelector('#fey-input');
  // Parar ANTES de leer: con el motor del proveedor la transcripción llega al soltar, así
  // que leer primero mandaría la explicación sin el último tramo dictado.
  await stopDictation();
  const explanation = (input?.value || '').trim();
  if (!explanation) { showError(t('Escribe o dicta tu explicación primero.')); return; }
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
