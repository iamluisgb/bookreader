// P13 · Resumen elegante citado. El agente resume el capítulo o el libro entero en un
// TL;DR + puntos clave, y CADA punto cita su pasaje de origen [[aN]] (clic → salta al
// libro). Es el pitch "entender más rápido" explotando el foso citado: ni Atlas ni
// ChatGPT+PDF pueden llevarte a la frase exacta. Reutiliza el troceado de flashcards, el
// retrieval del agente y el render de citas del chat.
import * as LLM from './llm.js';
import * as Retrieval from './retrieval.js';
import { estimateTokens } from './context.js';
import { buildChunks } from './flashcards.js';
import { renderWithCitations } from './render.js';
import { downloadText } from '../backup.js';
import { icon } from '../ui/icons.js';
import { escapeHtml } from '../ui/escape.js';

const BOOK_TOKENS = 36000;   // techo de cobertura para "libro entero" (coste acotado)

let ctx = null;              // { bookId, bookTitle, goal, tocLabels, currentChapter, ensureIndex, anchors, onCite }
let overlay = null;
let generating = false, abortCtrl = null;
let scopeValue = '';
let lastMarkdown = '';       // último resumen generado (para exportar/copiar)

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
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && !generating) closeModal(); });
  overlay.querySelector('.ai-ob-close').addEventListener('click', () => { abortCtrl?.abort(); closeModal(); });
  document.addEventListener('keydown', onKey);
  renderSetup();
}

function onKey(e) { if (e.key === 'Escape' && overlay) { abortCtrl?.abort(); closeModal(); } }
function closeModal() {
  document.removeEventListener('keydown', onKey);
  if (overlay) { overlay.remove(); overlay = null; }
  generating = false;
}
const body = () => overlay?.querySelector('.ai-ob-body');

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
    <button id="sum-generate" class="primary-btn ai-ob-start">${icon('sparkles', { size: 16 })} Generar resumen</button>
    <div id="sum-error" class="fc-error" style="display:none"></div>`;
  b.querySelector('#sum-scope').addEventListener('change', (e) => { scopeValue = e.target.value; });
  b.querySelector('#sum-generate').addEventListener('click', onGenerate);
}

// Pasajes del ámbito. Capítulo: enteros. Libro: muestreo round-robin por capítulo
// hasta BOOK_TOKENS (cobertura uniforme y coste acotado, igual que flashcards).
function gatherScope(label) {
  ctx.ensureIndex();
  if (label) return Retrieval.passagesByChapter(label);
  const byChapter = new Map();
  for (const p of Retrieval.allPassages()) {
    const k = p.chapter || '';
    if (!byChapter.has(k)) byChapter.set(k, []);
    byChapter.get(k).push(p);
  }
  const lists = [...byChapter.values()];
  const picked = []; let used = 0, added = true;
  for (let i = 0; added && used < BOOK_TOKENS; i++) {
    added = false;
    for (const list of lists) {
      const p = list[i];
      if (!p) continue;
      const t = estimateTokens(p.text) + 4;
      if (used + t > BOOK_TOKENS) continue;
      picked.push(p); used += t; added = true;
    }
  }
  return picked.sort((a, b) => Retrieval.anchorNum(a.id) - Retrieval.anchorNum(b.id));
}

// ---- Generación (map-reduce) --------------------------------------------------

function pointsPrompt(goal) {
  return `Eres un lector experto que resume pasajes de un libro en PUNTOS CLAVE.
REGLAS:
- Devuelve entre 2 y 5 viñetas Markdown ("- ..."), una idea por viñeta.
- Cada viñeta TERMINA con el marcador del pasaje del que sale, entre dobles corchetes: [[aN]] (usa el id que precede a cada pasaje).
- Autocontenidas y concretas; nada de "según el texto" ni relleno.
- Escribe en el MISMO idioma que los pasajes.${goal ? `\n- Prioriza lo relevante para: «${goal}».` : ''}
Responde SOLO con las viñetas, sin encabezados ni texto alrededor.`;
}

function tldrPrompt(goal) {
  return `Resume estos puntos clave de un libro en un TL;DR de 2-3 frases, claro y sin jerga.${goal ? ` Enfócalo en: «${goal}».` : ''} Responde solo el párrafo.`;
}

async function onGenerate() {
  if (generating) return;
  const b = body();
  if (!LLM.hasKey()) { showError('Configura tu API key en Ajustes → Agente para generar el resumen.'); return; }
  const passages = gatherScope(scopeValue);
  if (!passages.length) { showError('Ese contenido no tiene texto indexado; prueba con otro capítulo o el libro entero.'); return; }
  const chunks = buildChunks(passages);

  generating = true; abortCtrl = new AbortController();
  const btn = b.querySelector('#sum-generate');
  btn.disabled = true;
  btn.innerHTML = `<span class="ai-typing">Resumiendo…</span>`;
  showError('');
  try {
    // Map: puntos citados por trozo.
    const bullets = [];
    for (let i = 0; i < chunks.length; i++) {
      const raw = await LLM.chatStream({
        messages: [
          { role: 'system', content: pointsPrompt(ctx.goal) },
          { role: 'user', content: 'PASAJES DEL LIBRO:\n\n' + chunks[i].text },
        ],
        maxTokens: 900, signal: abortCtrl.signal,
      });
      for (const line of String(raw || '').split('\n')) {
        const t = line.trim();
        if (t.startsWith('- ') || t.startsWith('* ')) bullets.push('- ' + t.slice(2).trim());
      }
      if (!overlay) return;
      btn.innerHTML = `<span class="ai-typing">Resumiendo… ${i + 1}/${chunks.length}</span>`;
    }
    if (!bullets.length) throw new Error('El modelo no devolvió puntos. Vuelve a intentarlo.');

    // Reduce: TL;DR a partir de los puntos (sin citas; es la síntesis).
    let tldr = '';
    try {
      tldr = (await LLM.chatStream({
        messages: [
          { role: 'system', content: tldrPrompt(ctx.goal) },
          { role: 'user', content: bullets.join('\n') },
        ],
        maxTokens: 300, signal: abortCtrl.signal,
      }) || '').trim();
    } catch (e) { if (e.name === 'AbortError') throw e; }

    const scopeName = scopeValue || ctx.bookTitle || 'Libro';
    lastMarkdown = `# Resumen — ${scopeName}\n\n${tldr ? `${tldr}\n\n` : ''}## Puntos clave\n\n${bullets.join('\n')}\n`;
    renderResult(tldr, bullets, scopeName);
  } catch (e) {
    if (e.name !== 'AbortError') { console.error('Resumen falló:', e); showError(e.message); }
  } finally {
    generating = false; abortCtrl = null;
    const b2 = body()?.querySelector('#sum-generate');
    if (b2) { b2.disabled = false; b2.innerHTML = `${icon('sparkles', { size: 16 })} Generar resumen`; }
  }
}

function showError(msg) {
  const el = body()?.querySelector('#sum-error');
  if (!el) return;
  el.style.display = msg ? '' : 'none';
  el.textContent = msg;
}

// ---- Vista 2: resultado citado ------------------------------------------------

function renderResult(tldr, bullets, scopeName) {
  const b = body();
  if (!b) return;
  const anchors = ctx.anchors || new Map();
  b.innerHTML = `
    <button class="ai-ob-back">${icon('chevron-left', { size: 16 })}<span>Volver</span></button>
    <h2>Resumen — ${escapeHtml(scopeName)}</h2>
    ${tldr ? `<div class="sum-tldr">${renderWithCitations(tldr, anchors)}</div>` : ''}
    <div class="sum-label">Puntos clave</div>
    <div class="sum-points">${renderWithCitations(bullets.join('\n'), anchors)}</div>
    <div class="fc-export">
      <button id="sum-copy" class="primary-btn">${icon('copy', { size: 16 })} Copiar</button>
      <button id="sum-md" class="ai-ob-back fc-txt-btn">${icon('download', { size: 15 })} Markdown</button>
    </div>`;
  b.querySelector('.ai-ob-back').addEventListener('click', renderSetup);

  // Clic en una cita [[aN]] → navegar en el libro (delegado a quien abrió el modal).
  b.addEventListener('click', (e) => {
    const cite = e.target.closest('.ai-cite');
    if (cite && ctx.onCite) { ctx.onCite(cite.dataset.id); closeModal(); }
  });

  const slug = (s) => (s || 'resumen').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  b.querySelector('#sum-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(lastMarkdown); } catch (e) { /* sin clipboard */ }
  });
  b.querySelector('#sum-md').addEventListener('click', () => {
    downloadText(`bookreader-resumen-${slug(scopeName)}.md`, lastMarkdown, 'text/markdown');
  });
}
