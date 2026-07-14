// P14 · Mapa mental. El agente organiza el capítulo o el libro en una jerarquía radial
// (tema central → ramas → puntos), con las hojas citando su pasaje [[aN]] (clic → salta
// al libro). Es el artefacto compartible por excelencia (la gente postea mapas mentales):
// export a PNG para redes y a SVG. Reutiliza el troceado y el map de summary/flashcards.
import * as LLM from './llm.js';
import * as Retrieval from './retrieval.js';
import * as Jobs from './jobs.js';
import { estimateTokens } from './context.js';
import { buildChunks } from './flashcards.js';
import { icon } from '../ui/icons.js';
import { escapeHtml } from '../ui/escape.js';

const KIND = 'mindmap';
const BOOK_TOKENS = 36000;
const SVG_NS = 'http://www.w3.org/2000/svg';
// Paleta de ramas (una por rama, tono suave de marca).
const PALETTE = ['#22c55e', '#3b82f6', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#ef4444', '#0ea5e9'];

let ctx = null;
let overlay = null, scopeValue = '', runUnsub = null;
let lastTree = null, lastSvg = null, lastDims = { width: 1200, height: 1000 };

export function open(context) {
  ctx = context;
  closeModal();
  overlay = document.createElement('div');
  overlay.id = 'ai-mindmap';
  overlay.className = 'ai-onboarding';
  overlay.innerHTML = `
    <div class="ai-ob-card mm-card" role="dialog" aria-modal="true" aria-label="Mapa mental">
      <button class="ai-ob-close" title="Cerrar" aria-label="Cerrar">${icon('xmark', { size: 18 })}</button>
      <div class="ai-ob-body"></div>
    </div>`;
  document.body.appendChild(overlay);
  // Cerrar NO cancela: suelta el modal (el trabajo sigue). Cancelar es explícito.
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

// Al abrir: mapa en curso → vista "en curso"; mapa ya generado en caché → muéstralo directo
// (reabrir instantáneo); si no → setup.
function route() {
  const a = Jobs.activeJob();
  if (a && a.kind === KIND && a.bookId === ctx.bookId && a.status === 'running') { renderRunning(a); return; }
  const c = Jobs.cached(ctx.bookId, KIND);
  if (c) { renderResult(c.result, c.params.scopeName); return; }
  renderSetup();
}

function renderSetup() {
  const b = body();
  if (!b) return;
  ctx.ensureIndex();
  const chapters = (ctx.tocLabels || []).filter(c => c && Retrieval.passagesByChapter(c).length);
  scopeValue = chapters.includes(ctx.currentChapter) ? ctx.currentChapter : '';
  b.innerHTML = `
    <h2>Mapa mental</h2>
    <p class="ai-ob-sub">El agente organiza el contenido en un mapa radial; cada punto cita su pasaje. Clic en una cita para saltar al libro.</p>
    <label class="fc-label">Contenido</label>
    <select id="mm-scope" class="fc-select">
      <option value="">Libro entero</option>
      ${chapters.map(c => `<option value="${escapeHtml(c)}"${c === scopeValue ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('')}
    </select>
    <button id="mm-generate" class="primary-btn ai-ob-start">${icon('sparkles', { size: 16 })} Generar mapa</button>
    <div id="mm-error" class="fc-error" style="display:none"></div>`;
  b.querySelector('#mm-scope').addEventListener('change', (e) => { scopeValue = e.target.value; });
  b.querySelector('#mm-generate').addEventListener('click', onGenerate);
}

function gatherScope(label) {
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

// Muestreo uniforme para no pasar de `max` viñetas al reduce (conserva el orden de lectura).
function capBullets(bullets, max) {
  if (bullets.length <= max) return bullets;
  const step = bullets.length / max, out = [];
  for (let i = 0; i < max; i++) out.push(bullets[Math.floor(i * step)]);
  return out;
}

// Extrae el primer objeto JSON balanceado (tolerante a prosa/``` y a TRUNCACIÓN: si el
// modelo corta el JSON a media —el fallo típico de "Ideas N"— lo repara para rescatar las
// ramas completas en vez de descartarlo entero).
function extractJson(raw) {
  const s = String(raw || '').replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { if (--depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } } }
  }
  return repairJson(s.slice(start));   // llegó al final con estructuras abiertas → truncado
}

// Cierra un JSON truncado (cadena/objeto/array abiertos) para recuperar lo parseable.
function repairJson(s) {
  let inStr = false, esc = false; const stack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') stack.pop();
  }
  let out = s;
  if (inStr) out += '"';                         // cadena a medias → ciérrala
  out = out.replace(/,\s*$/, '').replace(/:\s*$/, '');   // coma o dos-puntos colgando
  out = out.replace(/,\s*"[^"]*"\s*$/, '');       // clave sin valor al final
  while (stack.length) out += stack.pop();        // cierra objetos/arrays abiertos
  try { return JSON.parse(out); } catch { return null; }
}

function mapPrompt(goal) {
  return `De estos pasajes de un libro, extrae 3-6 CONCEPTOS o ideas clave como ETIQUETAS CORTAS para un mapa mental.
REGLAS:
- Cada etiqueta es un sintagma nominal de 2 a 6 palabras. NUNCA una frase u oración completa.
  Ej.: "- Desambiguación de entidades [[a12]]", NO "- La desambiguación de entidades requiere un contexto rico [[a12]]".
- Formato: viñeta Markdown "- ..." TERMINADA con el marcador de su pasaje [[aN]].
- Mismo idioma que los pasajes.${goal ? `\n- Prioriza lo relevante para: «${goal}».` : ''}
Responde solo las viñetas.`;
}

function treePrompt(title, goal) {
  return `Organiza estos puntos de un libro en un MAPA MENTAL jerárquico.
Devuelve SOLO un objeto JSON válido con esta forma:
{"title": "tema central (2-4 palabras)", "branches": [{"label": "rama (1-3 palabras)", "children": [{"label": "concepto (2-5 palabras)", "src": "aN"}]}]}
REGLAS:
- 3 a 6 ramas; 2 a 5 hijos por rama.
- Las etiquetas son de MAPA MENTAL: rótulos CORTOS de concepto (2-5 palabras), sintagmas
  nominales, NUNCA frases ni oraciones. Ej.: "Desambiguación de entidades", NO "La
  desambiguación de entidades requiere un contexto rico".
- "src" = el id [[aN]] del punto de origen (solo "aN", sin corchetes) para ampliar el detalle; si no lo sabes, "".
- Mismo idioma que los puntos.${goal ? `\n- Enfoca el mapa en: «${goal}».` : ''}
- Título tentativo: «${title}».`;
}

function onGenerate() {
  if (!LLM.hasKey()) { showError('Configura tu API key en Ajustes → Agente para generar el mapa.'); return; }
  const passages = gatherScope(scopeValue);
  if (!passages.length) { showError('Ese contenido no tiene texto indexado; prueba con otro capítulo o el libro entero.'); return; }
  const chunks = buildChunks(passages);
  const scopeName = scopeValue || ctx.bookTitle || 'Libro';
  const goal = ctx.goal;

  const act = Jobs.activeJob();
  if (act && act.status === 'running' && !(act.kind === KIND && act.bookId === ctx.bookId)) {
    if (!window.confirm(`Ya se está generando ${act.label}. ¿Cancelarlo y empezar el mapa?`)) return;
  }
  showError('');
  Jobs.start({
    bookId: ctx.bookId, kind: KIND, label: 'el mapa mental',
    params: { scopeName },
    run: ({ signal, progress }) => runMindmap({ chunks, goal, scopeName, signal, progress }),
  });
  renderRunning(Jobs.activeJob());
}

// Map (conceptos citados por trozo) + reduce (árbol JSON), desacoplado del modal.
async function runMindmap({ chunks, goal, scopeName, signal, progress }) {
  const bullets = [];
  for (let i = 0; i < chunks.length; i++) {
    const raw = await LLM.chatStream({
      messages: [
        { role: 'system', content: mapPrompt(goal) },
        { role: 'user', content: 'PASAJES DEL LIBRO:\n\n' + chunks[i].text },
      ],
      maxTokens: 1500, signal,   // holgura para modelos de razonamiento
    });
    for (const line of String(raw || '').split('\n')) {
      const t = line.trim();
      if (t.startsWith('- ') || t.startsWith('* ')) bullets.push(t.slice(2).trim());
    }
    progress(i + 1, chunks.length, 'map');
  }
  if (!bullets.length) throw new Error('El modelo no devolvió contenido. Vuelve a intentarlo.');
  // Un buen mapa es conciso: acota las viñetas (muestreo uniforme) para que el JSON del reduce
  // quepa holgado —no se trunca ni cae al fallback— y el mapa no se sature de hojas.
  const capped = capBullets(bullets, 20);

  progress(chunks.length, chunks.length, 'reduce');
  let tree = null;
  try {
    const raw = await LLM.chatStream({
      messages: [
        { role: 'system', content: treePrompt(scopeName, goal) },
        { role: 'user', content: capped.join('\n') },
      ],
      // Alto a propósito: los modelos de razonamiento gastan miles de tokens "pensando" antes
      // del JSON; con poco cupo emitían JSON vacío/truncado → el mapa temático caía al fallback.
      maxTokens: 5000, signal,
    });
    tree = extractJson(raw);
  } catch (e) { if (e.name === 'AbortError') throw e; }
  return normalizeTree(tree, capped, scopeName);
}

// Vista "en curso": progreso + "Seguir leyendo" / "Cancelar", suscrita a Jobs.
function renderRunning(job) {
  const b = body();
  if (!b || !job) { renderSetup(); return; }
  b.innerHTML = `
    <h2>Generando mapa mental…</h2>
    <p class="ai-run-status" id="mm-run-status" role="status"></p>
    <div class="ai-run-actions">
      <button id="mm-keep" class="primary-btn">${icon('book', { size: 16 })} Seguir leyendo</button>
      <button id="mm-cancel" class="ai-ob-back fc-txt-btn">Cancelar</button>
    </div>
    <p class="sum-depth-hint">Puedes cerrar esta ventana y seguir leyendo: te avisaremos cuando el mapa esté listo.</p>`;
  const status = b.querySelector('#mm-run-status');
  const paint = (j) => {
    if (!overlay) return;
    if (!j || j.status === 'cancelled') { if (runUnsub) { runUnsub(); runUnsub = null; } renderSetup(); return; }
    if (j.kind !== KIND) return;
    if (j.status === 'running') {
      status.textContent = j.progress.phase === 'reduce'
        ? 'Organizando el mapa…'
        : `Trazando el mapa… ${j.progress.i}/${j.progress.n || '·'}`;
    } else if (j.status === 'done') {
      if (runUnsub) { runUnsub(); runUnsub = null; }
      const c = Jobs.cached(ctx.bookId, KIND);
      renderResult(c ? c.result : j.result, c ? c.params.scopeName : (j.params?.scopeName || 'Libro'));
    } else if (j.status === 'error') {
      if (runUnsub) { runUnsub(); runUnsub = null; }
      renderSetup();
      showError(j.error?.message || 'No se pudo generar el mapa.');
    }
  };
  b.querySelector('#mm-keep').addEventListener('click', () => closeModal());
  b.querySelector('#mm-cancel').addEventListener('click', () => Jobs.cancel());
  if (runUnsub) runUnsub();
  runUnsub = Jobs.subscribe(paint);
}

// Valida/normaliza el árbol temático del modelo; si falta o es inválido, cae a un mapa
// por capítulos (nunca a ramas anónimas "Ideas N", que vacían de sentido el mapa).
// Recorta a `maxChars` por FRONTERA DE PALABRA (sin "…"): garantiza que la etiqueta quepa en
// la píldora sin que wrapLabel la trunque con puntos suspensivos. El texto completo va al tooltip.
function clampWords(s, maxChars) {
  s = String(s || '').trim();
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars);
  const sp = cut.lastIndexOf(' ');
  return (sp > 6 ? cut.slice(0, sp) : cut).trim();
}

function normalizeTree(tree, bullets, scopeName) {
  const cleanSrc = (s) => (typeof s === 'string' && (s.match(/a\d+/) || [])[0]) || '';
  // Cada hoja guarda una etiqueta CORTA visible + el texto completo (`full`) para el tooltip.
  const asLeaf = (raw) => {
    const full = String(raw.label ?? raw).replace(/\s*\[\[a\d+\]\]\s*$/, '').trim();
    return { label: clampWords(full, 42), src: cleanSrc(raw.src), full };
  };
  if (tree && Array.isArray(tree.branches) && tree.branches.length) {
    const branches = tree.branches.slice(0, 8).map((br, i) => {
      const label = String(br.label || `Rama ${i + 1}`).trim();
      return {
        label: clampWords(label, 32), full: label,
        children: (Array.isArray(br.children) ? br.children : []).slice(0, 6).map(asLeaf).filter(c => c.label),
      };
    }).filter(br => br.children.length);
    if (branches.length) return { title: String(tree.title || scopeName).slice(0, 44), branches };
  }
  return chapterFallback(bullets, scopeName);
}

// Acorta un título de capítulo para usarlo como rótulo de rama: quita el numeral inicial
// ("1 ", "9. ", "III. "), corta subtítulos tras ":" y limita a ~5 palabras, conservando
// mayúsculas. "1 Knowledge graphs and LLMs: A kind of…" → "Knowledge graphs and LLMs".
function tidyChapter(label) {
  let s = String(label || '').replace(/^\s*(chapter|cap[íi]tulo|part[e]?|appendix|ap[ée]ndice|anexo)?\s*[\divxlcdm]+[.)\-:\s]+/i, '');
  s = s.split(':')[0].trim();
  const words = s.split(/\s+/).filter(Boolean);
  return words.slice(0, 5).join(' ') || String(label || '').trim();
}

// Fallback fiel al libro: agrupa cada viñeta bajo el CAPÍTULO de su ancla [[aN]]. La rama
// muestra el capítulo acortado (tooltip con el título completo); cada hoja, su texto corto.
function chapterFallback(bullets, scopeName) {
  const p2ch = new Map(Retrieval.allPassages().map(p => [p.id, (p.chapter || '').trim()]));
  const order = [], groups = new Map();
  for (const t of bullets) {
    const src = (t.match(/\[\[(a\d+)\]\]/) || [])[1] || '';
    const ch = p2ch.get(src) || 'General';
    if (!groups.has(ch)) { groups.set(ch, []); order.push(ch); }
    const full = t.replace(/\s*\[\[a\d+\]\]\s*$/, '').trim();
    groups.get(ch).push({ label: clampWords(full, 42), src, full });
  }
  const branches = order.slice(0, 8).map(ch => ({
    label: clampWords(tidyChapter(ch), 32), full: ch, children: groups.get(ch).slice(0, 6),
  }));
  return { title: scopeName.slice(0, 44), branches };
}

function showError(msg) {
  const el = body()?.querySelector('#mm-error');
  if (!el) return;
  el.style.display = msg ? '' : 'none';
  el.textContent = msg;
}

// ---- Render radial en SVG -----------------------------------------------------

const CHARW = 8, PILL_PADX = 22, LINEH = 19, PILL_PADY = 12;   // métricas de píldora (font 14)
const LEAF_MAXCH = 22, LEAF_MAXLINES = 2;                       // hojas: hasta ~44 car. legibles

function svgEl(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// Parte una etiqueta en líneas por palabras (máx maxLines; … si se pasa). Reemplaza al
// truncado a 21 car., que dejaba las hojas ilegibles.
function wrapLabel(text, maxChars, maxLines) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [''];
  const lines = []; let cur = '';
  for (const raw of clean.split(' ')) {
    const w = raw.length > maxChars ? raw.slice(0, maxChars - 1) + '…' : raw;
    const cand = cur ? cur + ' ' + w : w;
    if (cand.length <= maxChars) cur = cand;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = kept[maxLines - 1].slice(0, maxChars - 1).replace(/[\s…]+$/, '') + '…';
  return kept;
}

function pillSize(lines) {
  const maxLen = Math.max(...lines.map(l => l.length));
  return { w: Math.max(58, maxLen * CHARW + PILL_PADX), h: lines.length * LINEH + PILL_PADY };
}

function pill(parent, x, y, lines, { fill, stroke, color, id, bold, tooltip }) {
  const { w, h } = pillSize(lines);
  const g = svgEl('g', id ? { class: 'mm-cite', 'data-id': id, style: 'cursor:pointer' } : {});
  // <title> = tooltip nativo al pasar el ratón: el texto completo / la cita real del libro.
  if (tooltip) { const ti = svgEl('title'); ti.textContent = tooltip; g.appendChild(ti); }
  g.appendChild(svgEl('rect', { x: x - w / 2, y: y - h / 2, width: w, height: h, rx: Math.min(16, h / 2), fill, stroke: stroke || 'none', 'stroke-width': 1.5 }));
  const t = svgEl('text', { x, 'text-anchor': 'middle', 'font-size': 14, 'font-family': 'Inter, system-ui, sans-serif', 'font-weight': bold ? 600 : 400, fill: color });
  const y0 = y - (lines.length - 1) * LINEH / 2 + 5;
  lines.forEach((ln, i) => {
    const ts = svgEl('tspan', { x, y: y0 + i * LINEH });
    ts.textContent = ln;
    t.appendChild(ts);
  });
  g.appendChild(t);
  parent.appendChild(g);
}

// Layout radial que reparte TODO el círculo proporcionalmente al nº de hojas (densidad
// angular constante ⇒ una rama con muchas hojas no las amontona). Auto-ajusta el lienzo al
// contenido real de las píldoras, así nada se recorta ni se solapa.
function buildSvg(tree) {
  const branches = tree.branches;
  // Texto real de cada pasaje (por ancla) para el tooltip de las hojas: al pasar el ratón se
  // ve la CITA del libro, no una paráfrasis recortada (lección de NotebookLM).
  const p2text = new Map(Retrieval.allPassages().map(p => [p.id, p.text]));
  const leaves = [];
  branches.forEach((br, bi) => br.children.forEach(ch => leaves.push({ ch, bi })));
  const M = Math.max(1, leaves.length);
  const step = 360 / M;                                   // grados por hoja
  const stepRad = step * Math.PI / 180;
  const R1 = 210;
  // Anticolisión: alterno el radio de las hojas contiguas (par/impar). Así las del MISMO
  // radio distan 2 pasos angulares —cuerda holgada frente al ANCHO de la píldora, no solo el
  // alto, que era el fallo cerca del eje vertical— y las contiguas se separan radialmente por
  // `stagger` (≥ alto de píldora). El lienzo se auto-ajusta, así que crecer el radio no recorta.
  const WEST = 150;                                       // ancho típico de píldora de hoja
  const stagger = 2 * LINEH + PILL_PADY + 6;              // ~56 px
  let R2 = M <= 1 ? 360 : Math.min(860, Math.max(360, WEST / (2 * Math.sin(stepRad))));

  const start = -90;
  leaves.forEach((lf, k) => {
    lf.ang = (start + (k + 0.5) * step) * Math.PI / 180;
    lf.r = R2 + (k % 2) * stagger;
  });
  const branchAng = branches.map((_, bi) => {
    const own = leaves.filter(l => l.bi === bi);
    return own.reduce((s, l) => s + l.ang, 0) / (own.length || 1);
  });

  const nodes = [], edges = [];
  branchAng.forEach((ang, bi) => {
    const col = PALETTE[bi % PALETTE.length];
    const bx = R1 * Math.cos(ang), by = R1 * Math.sin(ang);
    edges.push({ x1: 0, y1: 0, x2: bx, y2: by, col, w: 3, op: 0.5 });
    nodes.push({ x: bx, y: by, lines: wrapLabel(branches[bi].label, 18, 2), style: { fill: col, color: '#fff', bold: true, tooltip: branches[bi].full || branches[bi].label } });
  });
  leaves.forEach((lf) => {
    const col = PALETTE[lf.bi % PALETTE.length];
    const bx = R1 * Math.cos(branchAng[lf.bi]), by = R1 * Math.sin(branchAng[lf.bi]);
    const lx = lf.r * Math.cos(lf.ang), ly = lf.r * Math.sin(lf.ang);
    edges.push({ x1: bx, y1: by, x2: lx, y2: ly, col, w: 1.5, op: 0.38 });
    const id = (lf.ch.src && ctx.anchors?.has(lf.ch.src)) ? lf.ch.src : null;
    const tip = ((lf.ch.src && p2text.get(lf.ch.src)) || lf.ch.full || lf.ch.label || '').trim().slice(0, 500);
    nodes.push({ x: lx, y: ly, lines: wrapLabel(lf.ch.label, LEAF_MAXCH, LEAF_MAXLINES), style: { fill: '#fff', stroke: col, color: '#2b2b2b', id, tooltip: tip } });
  });
  nodes.push({ x: 0, y: 0, lines: wrapLabel(tree.title, 20, 2), style: { fill: '#2b2b2b', color: '#fff', bold: true, tooltip: tree.title } });

  // Bounding box de todas las píldoras → viewBox ajustado.
  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  nodes.forEach(nd => {
    const { w, h } = pillSize(nd.lines);
    minX = Math.min(minX, nd.x - w / 2); maxX = Math.max(maxX, nd.x + w / 2);
    minY = Math.min(minY, nd.y - h / 2); maxY = Math.max(maxY, nd.y + h / 2);
  });
  const pad = 40;
  const width = Math.round(maxX - minX + pad * 2), height = Math.round(maxY - minY + pad * 2);
  const ox = -minX + pad, oy = -minY + pad;

  const svg = svgEl('svg', { xmlns: SVG_NS, viewBox: `0 0 ${width} ${height}`, width, height, style: 'max-width:100%;height:auto;display:block;margin:0 auto' });
  svg.appendChild(svgEl('rect', { x: 0, y: 0, width, height, fill: '#faf8f3' }));
  const root = svgEl('g', { transform: `translate(${ox} ${oy})` });
  svg.appendChild(root);
  edges.forEach(e => root.appendChild(svgEl('path', {
    d: `M ${e.x1} ${e.y1} L ${e.x2} ${e.y2}`, fill: 'none', stroke: e.col, 'stroke-width': e.w, opacity: e.op,
  })));
  nodes.forEach(nd => pill(root, nd.x, nd.y, nd.lines, nd.style));
  return { svg, width, height };
}

function renderResult(tree, scopeName) {
  const b = body();
  if (!b) return;
  lastTree = tree;
  Jobs.clearActive();          // el usuario está viendo el resultado → retira chip/aviso
  b.innerHTML = `
    <div class="sum-resulthead">
      <button class="ai-ob-back">${icon('chevron-left', { size: 16 })}<span>Volver</span></button>
      <button id="mm-regen" class="fc-txt-btn">${icon('sparkles', { size: 14 })} Regenerar</button>
    </div>
    <h2>Mapa mental — ${escapeHtml(scopeName)}</h2>
    <div class="mm-canvas" id="mm-canvas"></div>
    <div class="fc-export">
      <button id="mm-png" class="primary-btn">${icon('download', { size: 16 })} Descargar PNG</button>
      <button id="mm-svg" class="ai-ob-back fc-txt-btn">SVG</button>
    </div>`;
  b.querySelector('.ai-ob-back').addEventListener('click', renderSetup);
  b.querySelector('#mm-regen').addEventListener('click', renderSetup);
  const holder = b.querySelector('#mm-canvas');
  const built = buildSvg(tree);
  lastSvg = built.svg; lastDims = { width: built.width, height: built.height };
  holder.appendChild(lastSvg);

  // Clic en una hoja citada → navegar en el libro.
  holder.addEventListener('click', (e) => {
    const g = e.target.closest('.mm-cite');
    if (g && ctx.onCite) { ctx.onCite(g.dataset.id); closeModal(); }
  });

  const slug = (s) => (s || 'mapa').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  b.querySelector('#mm-svg').addEventListener('click', () => download(`bookreader-mapa-${slug(scopeName)}.svg`, serializeSvg(lastSvg), 'image/svg+xml'));
  b.querySelector('#mm-png').addEventListener('click', async () => {
    try { download(`bookreader-mapa-${slug(scopeName)}.png`, await svgToPngBlob(lastSvg, lastDims), 'image/png'); }
    catch (err) { console.warn('PNG del mapa falló:', err); }
  });
}

function serializeSvg(svg) {
  return new XMLSerializer().serializeToString(svg);
}

async function svgToPngBlob(svg, dims) {
  const url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(serializeSvg(svg))));
  const img = new Image();
  img.src = url;
  await img.decode();
  const scale = 2;   // 2× para una imagen nítida al compartir en redes
  const canvas = document.createElement('canvas');
  canvas.width = dims.width * scale; canvas.height = dims.height * scale;
  canvas.getContext('2d').drawImage(img, 0, 0, dims.width * scale, dims.height * scale);
  return new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob null')), 'image/png'));
}

function download(filename, data, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
