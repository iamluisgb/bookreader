// P13 · Resumen elegante citado. El agente resume el capítulo o el libro entero en un
// TL;DR + puntos clave, y CADA punto cita su pasaje de origen [[aN]] (clic → salta al
// libro). Es el pitch "entender más rápido" explotando el foso citado: ni Atlas ni
// ChatGPT+PDF pueden llevarte a la frase exacta. Reutiliza el troceado de flashcards, el
// retrieval del agente y el render de citas del chat.
import * as LLM from './llm.js';
import * as Retrieval from './retrieval.js';
import * as Jobs from './jobs.js';
import { estimateTokens } from './context.js';
import { buildChunks } from './flashcards.js';
import { renderWithCitations } from './render.js';
import { downloadText } from '../backup.js';
import { icon } from '../ui/icons.js';
import { escapeHtml } from '../ui/escape.js';

const KIND = 'summary';

const BOOK_TOKENS = 36000;   // techo por defecto de cobertura para "libro entero"

// Profundidad del resumen: cuánto cubrir (tokens) y cuánto detallar. Es un dial
// coste-vs-riqueza —más cobertura = más trozos = más llamadas al modelo—, elegible en la
// UI. `prose` activa el formato estructurado (portada + secciones por capítulo + cierre);
// sin `prose` es una lista plana breve. `perCap` acota viñetas por sección.
const DEPTH = {
  breve:     { label: 'Breve',     coverage: 24000, bullets: 'entre 2 y 3', perCap: 3, prose: false },
  estandar:  { label: 'Estándar',  coverage: 48000, bullets: 'entre 3 y 5', perCap: 4, prose: true },
  detallado: { label: 'Detallado', coverage: 80000, bullets: 'entre 5 y 7', perCap: 6, prose: true },
};

let ctx = null;              // { bookId, bookTitle, goal, tocLabels, currentChapter, ensureIndex, anchors, onCite }
let overlay = null;
let scopeValue = '';
let depthValue = 'estandar'; // profundidad por defecto
let lastMarkdown = '';       // último resumen mostrado (para exportar/copiar)
let runUnsub = null;         // baja de la suscripción a Jobs mientras se muestra "en curso"

export function open(context) {
  ctx = context;
  closeModal();
  overlay = document.createElement('div');
  overlay.id = 'ai-summary';
  overlay.className = 'ai-onboarding';
  overlay.innerHTML = `
    <div class="ai-ob-card sum-card" role="dialog" aria-modal="true" aria-label="Resumen del libro">
      <button class="ai-ob-close" title="Cerrar" aria-label="Cerrar">${icon('xmark', { size: 18 })}</button>
      <div class="ai-ob-body"></div>
    </div>`;
  document.body.appendChild(overlay);
  // Cerrar NO cancela: solo suelta el modal (el trabajo sigue en segundo plano). Cancelar es
  // explícito (botón en la vista "en curso").
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeModal(); });
  overlay.querySelector('.ai-ob-close').addEventListener('click', () => closeModal());
  document.addEventListener('keydown', onKey);
  route();
}

function onKey(e) { if (e.key === 'Escape' && overlay) closeModal(); }
function closeModal() {
  document.removeEventListener('keydown', onKey);
  if (runUnsub) { runUnsub(); runUnsub = null; }
  if (overlay) { overlay.remove(); overlay = null; }
}
const body = () => overlay?.querySelector('.ai-ob-body');

// Al abrir: si hay un resumen en curso para este libro → vista "en curso"; si hay uno ya
// generado en caché → muéstralo directo (reabrir instantáneo, sin re-generar); si no → setup.
function route() {
  const a = Jobs.activeJob();
  if (a && a.kind === KIND && a.bookId === ctx.bookId && a.status === 'running') { renderRunning(a); return; }
  const c = Jobs.cached(ctx.bookId, KIND);
  if (c) { renderResult(c.result, c.params.scopeName); return; }
  renderSetup();
}

// ---- Vista 1: elegir ámbito ---------------------------------------------------

function renderSetup() {
  const b = body();
  if (!b) return;
  ctx.ensureIndex();
  const chapters = (ctx.tocLabels || []).filter(c => c && Retrieval.passagesByChapter(c).length);
  scopeValue = chapters.includes(ctx.currentChapter) ? ctx.currentChapter : '';
  b.innerHTML = `
    <h2>Resumen del libro</h2>
    <p class="ai-ob-sub">El agente resume el contenido en puntos clave, cada uno citando su pasaje. Clic en una cita para saltar al libro.</p>
    <label class="fc-label">Contenido</label>
    <select id="sum-scope" class="fc-select">
      <option value="">Libro entero</option>
      ${chapters.map(c => `<option value="${escapeHtml(c)}"${c === scopeValue ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('')}
    </select>
    <label class="fc-label">Profundidad</label>
    <select id="sum-depth" class="fc-select">
      ${Object.entries(DEPTH).map(([k, d]) => `<option value="${k}"${k === depthValue ? ' selected' : ''}>${d.label}</option>`).join('')}
    </select>
    <p class="sum-depth-hint">Estándar y Detallado organizan el resumen por capítulos, con introducción y cierre. Más profundidad = más cobertura y más llamadas al modelo.</p>
    <button id="sum-generate" class="primary-btn ai-ob-start">${icon('sparkles', { size: 16 })} Generar resumen</button>
    <div id="sum-error" class="fc-error" style="display:none"></div>`;
  b.querySelector('#sum-scope').addEventListener('change', (e) => { scopeValue = e.target.value; });
  b.querySelector('#sum-depth').addEventListener('change', (e) => { depthValue = e.target.value; });
  b.querySelector('#sum-generate').addEventListener('click', onGenerate);
}

// Pasajes del ámbito. Capítulo: enteros. Libro: muestreo round-robin por capítulo
// hasta BOOK_TOKENS (cobertura uniforme y coste acotado, igual que flashcards).
function gatherScope(label, budget = BOOK_TOKENS) {
  ctx.ensureIndex();
  if (label) return Retrieval.passagesByChapter(label);
  const byChapter = new Map();
  for (const p of Retrieval.allPassages()) {
    if (Retrieval.isFrontMatter(p.chapter)) continue;   // fuera cubierta/índice/prólogo…
    const k = p.chapter || '';
    if (!byChapter.has(k)) byChapter.set(k, []);
    byChapter.get(k).push(p);
  }
  const lists = [...byChapter.values()];
  const picked = []; let used = 0, added = true;
  for (let i = 0; added && used < budget; i++) {
    added = false;
    for (const list of lists) {
      const p = list[i];
      if (!p) continue;
      const t = estimateTokens(p.text) + 4;
      if (used + t > budget) continue;
      picked.push(p); used += t; added = true;
    }
  }
  return picked.sort((a, b) => Retrieval.anchorNum(a.id) - Retrieval.anchorNum(b.id));
}

// ---- Generación (map-reduce) --------------------------------------------------

// Regla de idioma: se ancla al idioma del OBJETIVO del lector (o español por defecto), NO al
// de los pasajes. Antes decía "mismo idioma que los pasajes" → en libros en inglés colaba
// viñetas en inglés dentro de un resumen en español.
function langRule(goal) {
  return goal
    ? `- Escribe SIEMPRE en el mismo idioma que este objetivo del lector: «${goal}» (aunque los pasajes estén en otro idioma).`
    : `- Escribe SIEMPRE en español (aunque los pasajes estén en otro idioma).`;
}

function pointsPrompt(goal, bulletsRange) {
  return `Eres un lector experto que resume pasajes de un libro en PUNTOS CLAVE.
REGLAS:
- Devuelve ${bulletsRange} viñetas Markdown ("- ..."), una idea por viñeta.
- Cada viñeta TERMINA con el marcador del pasaje del que sale, entre dobles corchetes: [[aN]] (usa el id que precede a cada pasaje).
- Autocontenidas y concretas; nada de "según el texto" ni relleno.
${langRule(goal)}${goal ? `\n- Prioriza lo relevante para: «${goal}».` : ''}
Responde SOLO con las viñetas, sin encabezados ni texto alrededor.`;
}

// "Reduce" único que redacta el MARCO: portada (TL;DR + Ideas principales) y cierre (Qué
// llevarte). Se parsea por sus encabezados literales.
function framingPrompt(goal) {
  return `A partir de estos puntos clave de un libro, redacta el marco de un resumen.
Devuelve EXACTAMENTE, en este orden y con estos encabezados literales:

TL;DR: (2-4 frases de síntesis global, claras y sin jerga)

## Ideas principales
(1-2 párrafos que hilen las ideas centrales del libro)

## Qué llevarte
(3-5 viñetas "- ..." accionables o memorables)

REGLAS:
${langRule(goal)}${goal ? `\n- Enfoca todo en: «${goal}».` : ''}`;
}

function tldrPrompt(goal) {
  return `Resume estos puntos clave de un libro en un TL;DR de 2-4 frases, claro y sin jerga.${goal ? ` Enfócalo en: «${goal}».` : ''}
${langRule(goal)}
Responde solo el párrafo.`;
}

function onGenerate() {
  if (!LLM.hasKey()) { showError('Configura tu API key en Ajustes → Agente para generar el resumen.'); return; }
  const depth = DEPTH[depthValue] || DEPTH.estandar;
  const passages = gatherScope(scopeValue, depth.coverage);
  if (!passages.length) { showError('Ese contenido no tiene texto indexado; prueba con otro capítulo o el libro entero.'); return; }
  const chunks = buildChunks(passages);
  const scopeName = scopeValue || ctx.bookTitle || 'Libro';
  const goal = ctx.goal;

  // Exclusividad: si hay otro trabajo pesado en curso, confirma antes de reemplazarlo.
  const act = Jobs.activeJob();
  if (act && act.status === 'running' && !(act.kind === KIND && act.bookId === ctx.bookId)) {
    if (!window.confirm(`Ya se está generando ${act.label}. ¿Cancelarlo y empezar el resumen?`)) return;
  }
  showError('');
  Jobs.start({
    bookId: ctx.bookId, kind: KIND, label: 'el resumen',
    params: { scopeName },
    run: ({ signal, progress }) => runSummary({ chunks, depth, goal, scopeName, signal, progress }),
  });
  renderRunning(Jobs.activeJob());
}

// El bucle map-reduce, desacoplado del modal: recibe `signal` y `progress(i,n,phase)`.
async function runSummary({ chunks, depth, goal, scopeName, signal, progress }) {
  const bullets = [];
  for (let i = 0; i < chunks.length; i++) {
    const raw = await LLM.chatStream({
      messages: [
        { role: 'system', content: pointsPrompt(goal, depth.bullets) },
        { role: 'user', content: 'PASAJES DEL LIBRO:\n\n' + chunks[i].text },
      ],
      maxTokens: 1500, signal,   // holgura para modelos de razonamiento
    });
    for (const line of String(raw || '').split('\n')) {
      const t = line.trim();
      if (t.startsWith('- ') || t.startsWith('* ')) bullets.push('- ' + t.slice(2).trim());
    }
    progress(i + 1, chunks.length, 'map');
  }
  if (!bullets.length) throw new Error('El modelo no devolvió puntos. Vuelve a intentarlo.');

  progress(chunks.length, chunks.length, 'reduce');
  if (depth.prose) {
    // Estructurado: marco (1 llamada) + secciones por capítulo a partir de los puntos.
    const framing = await runFraming(bullets, goal, signal);
    return assembleStructured(scopeName, framing, bullets, depth.perCap);
  }
  // Breve: TL;DR + lista plana.
  let tldr = '';
  try {
    tldr = (await LLM.chatStream({
      messages: [
        { role: 'system', content: tldrPrompt(goal) },
        { role: 'user', content: bullets.join('\n') },
      ],
      maxTokens: 1500, signal,
    }) || '').trim();
  } catch (e) { if (e.name === 'AbortError') throw e; }
  return `# Resumen — ${scopeName}\n\n${tldr ? `${tldr}\n\n` : ''}## Puntos clave\n\n${bullets.join('\n')}\n`;
}

// Vista "en curso": progreso + "Seguir leyendo" (suelta el modal, el trabajo sigue) y
// "Cancelar". Se suscribe a Jobs para refrescar el progreso y saltar al resultado al terminar.
function renderRunning(job) {
  const b = body();
  if (!b || !job) { renderSetup(); return; }
  b.innerHTML = `
    <h2>Generando resumen…</h2>
    <p class="ai-run-status" id="sum-run-status" role="status"></p>
    <div class="ai-run-actions">
      <button id="sum-keep" class="primary-btn">${icon('book', { size: 16 })} Seguir leyendo</button>
      <button id="sum-cancel" class="ai-ob-back fc-txt-btn">Cancelar</button>
    </div>
    <p class="sum-depth-hint">Puedes cerrar esta ventana y seguir leyendo: te avisaremos cuando el resumen esté listo.</p>`;
  const status = b.querySelector('#sum-run-status');
  const paint = (j) => {
    if (!overlay) return;
    if (!j || j.status === 'cancelled') { if (runUnsub) { runUnsub(); runUnsub = null; } renderSetup(); return; }
    if (j.kind !== KIND) return;
    if (j.status === 'running') {
      status.textContent = j.progress.phase === 'reduce'
        ? 'Redactando el resumen…'
        : `Resumiendo… ${j.progress.i}/${j.progress.n || '·'}`;
    } else if (j.status === 'done') {
      if (runUnsub) { runUnsub(); runUnsub = null; }
      const c = Jobs.cached(ctx.bookId, KIND);
      renderResult(c ? c.result : j.result, c ? c.params.scopeName : (j.params?.scopeName || 'Libro'));
    } else if (j.status === 'error') {
      if (runUnsub) { runUnsub(); runUnsub = null; }
      renderSetup();
      showError(j.error?.message || 'No se pudo generar el resumen.');
    }
  };
  b.querySelector('#sum-keep').addEventListener('click', () => closeModal());
  b.querySelector('#sum-cancel').addEventListener('click', () => Jobs.cancel());
  if (runUnsub) runUnsub();
  runUnsub = Jobs.subscribe(paint);
}

// Marco del resumen estructurado en UNA llamada; devuelve { tldr, ideas, llevar }.
async function runFraming(bullets, goal, signal) {
  try {
    const raw = (await LLM.chatStream({
      messages: [
        { role: 'system', content: framingPrompt(goal) },
        { role: 'user', content: bullets.join('\n') },
      ],
      maxTokens: 1600, signal,
    }) || '').trim();
    return parseFraming(raw);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return { tldr: '', ideas: '', llevar: '' };   // sin marco: el resumen sigue con sus secciones
  }
}

// Separa el marco en TL;DR (portada), "## Ideas principales" y "## Qué llevarte" (cierre).
function parseFraming(fr) {
  const tldr = (fr.match(/TL;DR:\s*([\s\S]*?)(?=\n\s*#|$)/i)?.[1] || '').trim();
  const ideas = (fr.match(/##\s*Ideas principales[\s\S]*?(?=\n\s*##\s*Qu[eé]\s+llevarte|$)/i)?.[0] || '').trim();
  const llevar = (fr.match(/##\s*Qu[eé]\s+llevarte[\s\S]*$/i)?.[0] || '').trim();
  // Si no vino con el formato esperado, todo el texto va como TL;DR (no perder el trabajo).
  if (!tldr && !ideas && !llevar) return { tldr: fr, ideas: '', llevar: '' };
  return { tldr, ideas, llevar };
}

// Agrupa las viñetas por CAPÍTULO real (vía la anchor de su cita) y arma el markdown final:
// portada → secciones por capítulo en orden de lectura → cierre. Descarta viñetas sin cita
// válida (integridad del "foso citado": cada punto debe ser clicable).
function assembleStructured(scopeName, framing, bullets, perCap) {
  const p2ch = new Map(Retrieval.allPassages().map(p => [p.id, (p.chapter || '').trim()]));
  const firstNum = new Map(), groups = new Map();
  let kept = 0;
  for (const bl of bullets) {
    const id = (bl.match(/\[\[(a\d+)\]\]/) || [])[1] || '';
    if (!id || !p2ch.has(id)) continue;              // sin cita válida → fuera
    const ch = p2ch.get(id) || 'General';
    if (!groups.has(ch)) groups.set(ch, []);
    if (groups.get(ch).length >= perCap) continue;   // tope de viñetas por sección
    groups.get(ch).push(bl); kept++;
    const n = Retrieval.anchorNum(id);
    if (!firstNum.has(ch) || n < firstNum.get(ch)) firstNum.set(ch, n);
  }
  // Libro sin capítulos etiquetados (o casi todo filtrado): cae a lista plana.
  let sections;
  if (kept < 3) {
    sections = `## Puntos clave\n\n${bullets.join('\n')}`;
  } else {
    const order = [...groups.keys()].sort((a, b) => (firstNum.get(a) ?? 0) - (firstNum.get(b) ?? 0));
    sections = order.map(ch => `## ${ch || 'General'}\n\n${groups.get(ch).join('\n')}`).join('\n\n');
  }
  const parts = [`# Resumen — ${scopeName}`];
  if (framing.tldr) parts.push(framing.tldr);
  if (framing.ideas) parts.push(framing.ideas);
  parts.push(sections);
  if (framing.llevar) parts.push(framing.llevar);
  return parts.join('\n\n') + '\n';
}

function showError(msg) {
  const el = body()?.querySelector('#sum-error');
  if (!el) return;
  el.style.display = msg ? '' : 'none';
  el.textContent = msg;
}

// ---- Vista 2: resultado citado ------------------------------------------------

function renderResult(md, scopeName) {
  const b = body();
  if (!b) return;
  lastMarkdown = md;
  Jobs.clearActive();          // el usuario está viendo el resultado → retira chip/aviso
  const anchors = ctx.anchors || new Map();
  b.innerHTML = `
    <div class="sum-resulthead">
      <button class="ai-ob-back">${icon('chevron-left', { size: 16 })}<span>Volver</span></button>
      <button id="sum-regen" class="fc-txt-btn">${icon('sparkles', { size: 14 })} Regenerar</button>
    </div>
    <div class="sum-doc">${renderWithCitations(md, anchors)}</div>
    <div class="fc-export">
      <button id="sum-copy" class="primary-btn">${icon('copy', { size: 16 })} Copiar</button>
      <button id="sum-md" class="ai-ob-back fc-txt-btn">${icon('download', { size: 15 })} Markdown</button>
    </div>`;
  b.querySelector('.ai-ob-back').addEventListener('click', renderSetup);
  b.querySelector('#sum-regen').addEventListener('click', renderSetup);

  // Clic en una cita [[aN]] → navegar en el libro (delegado a quien abrió el modal).
  b.addEventListener('click', (e) => {
    const cite = e.target.closest('.ai-cite');
    if (cite && ctx.onCite) { ctx.onCite(cite.dataset.id); closeModal(); }
  });

  const slug = (s) => (s || 'resumen').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  const copyBtn = b.querySelector('#sum-copy');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(lastMarkdown);
      copyBtn.innerHTML = `${icon('check', { size: 16 })} Copiado`;
      setTimeout(() => { copyBtn.innerHTML = `${icon('copy', { size: 16 })} Copiar`; }, 1500);
    } catch (e) { /* sin clipboard */ }
  });
  b.querySelector('#sum-md').addEventListener('click', () => {
    downloadText(`bookreader-resumen-${slug(scopeName)}.md`, lastMarkdown, 'text/markdown');
  });
}
