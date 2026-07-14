// P14 · Mapa mental. El agente organiza el capítulo o el libro en una jerarquía radial
// (tema central → ramas → puntos), con las hojas citando su pasaje [[aN]] (clic → salta
// al libro). Es el artefacto compartible por excelencia (la gente postea mapas mentales):
// export a PNG para redes y a SVG. Reutiliza el troceado y el map de summary/flashcards.
import * as LLM from './llm.js';
import * as Retrieval from './retrieval.js';
import { estimateTokens } from './context.js';
import { buildChunks } from './flashcards.js';
import { icon } from '../ui/icons.js';
import { escapeHtml } from '../ui/escape.js';

const BOOK_TOKENS = 36000;
const SVG_NS = 'http://www.w3.org/2000/svg';
// Paleta de ramas (una por rama, tono suave de marca).
const PALETTE = ['#22c55e', '#3b82f6', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#ef4444', '#0ea5e9'];

let ctx = null;
let overlay = null, generating = false, abortCtrl = null, scopeValue = '';
let lastTree = null, lastSvg = null;

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

// Extrae el primer objeto JSON balanceado de un texto (tolerante a prosa/```).
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
  return null;
}

function mapPrompt(goal) {
  return `Resume estos pasajes de un libro en 3-6 viñetas Markdown ("- ..."), una idea por viñeta,
cada una TERMINANDO con el marcador de su pasaje [[aN]].${goal ? ` Prioriza lo relevante para: «${goal}».` : ''}
Responde solo las viñetas.`;
}

function treePrompt(title, goal) {
  return `Organiza estos puntos de un libro en un MAPA MENTAL jerárquico.
Devuelve SOLO un objeto JSON válido con esta forma:
{"title": "tema central (2-4 palabras)", "branches": [{"label": "rama (1-3 palabras)", "children": [{"label": "idea concisa", "src": "aN"}]}]}
REGLAS:
- 3 a 6 ramas; 2 a 5 hijos por rama.
- "src" = el id [[aN]] del punto original (solo "aN", sin corchetes); si no lo sabes, "".
- Etiquetas BREVES (el mapa es visual). Mismo idioma que los puntos.${goal ? `\n- Enfoca el mapa en: «${goal}».` : ''}
- Título tentativo: «${title}».`;
}

async function onGenerate() {
  if (generating) return;
  const b = body();
  if (!LLM.hasKey()) { showError('Configura tu API key en Ajustes → Agente para generar el mapa.'); return; }
  const passages = gatherScope(scopeValue);
  if (!passages.length) { showError('Ese contenido no tiene texto indexado; prueba con otro capítulo o el libro entero.'); return; }
  const chunks = buildChunks(passages);

  generating = true; abortCtrl = new AbortController();
  const btn = b.querySelector('#mm-generate');
  btn.disabled = true;
  btn.innerHTML = `<span class="ai-typing">Trazando el mapa…</span>`;
  showError('');
  try {
    // Map: puntos citados por trozo.
    const bullets = [];
    for (let i = 0; i < chunks.length; i++) {
      const raw = await LLM.chatStream({
        messages: [
          { role: 'system', content: mapPrompt(ctx.goal) },
          { role: 'user', content: 'PASAJES DEL LIBRO:\n\n' + chunks[i].text },
        ],
        maxTokens: 900, signal: abortCtrl.signal,
      });
      for (const line of String(raw || '').split('\n')) {
        const t = line.trim();
        if (t.startsWith('- ') || t.startsWith('* ')) bullets.push(t.slice(2).trim());
      }
      if (!overlay) return;
      btn.innerHTML = `<span class="ai-typing">Trazando el mapa… ${i + 1}/${chunks.length}</span>`;
    }
    if (!bullets.length) throw new Error('El modelo no devolvió contenido. Vuelve a intentarlo.');

    // Reduce: jerarquía JSON. Fallback a un mapa plano si el JSON no parsea.
    const scopeName = scopeValue || ctx.bookTitle || 'Libro';
    let tree = null;
    try {
      const raw = await LLM.chatStream({
        messages: [
          { role: 'system', content: treePrompt(scopeName, ctx.goal) },
          { role: 'user', content: bullets.join('\n') },
        ],
        maxTokens: 1400, signal: abortCtrl.signal,
      });
      tree = extractJson(raw);
    } catch (e) { if (e.name === 'AbortError') throw e; }
    tree = normalizeTree(tree, bullets, scopeName);
    lastTree = tree;
    renderResult(tree, scopeName);
  } catch (e) {
    if (e.name !== 'AbortError') { console.error('Mapa mental falló:', e); showError(e.message); }
  } finally {
    generating = false; abortCtrl = null;
    const b2 = body()?.querySelector('#mm-generate');
    if (b2) { b2.disabled = false; b2.innerHTML = `${icon('sparkles', { size: 16 })} Generar mapa`; }
  }
}

// Valida/normaliza el árbol; si falta o es inválido, arma uno plano con las viñetas.
function normalizeTree(tree, bullets, scopeName) {
  const cleanSrc = (s) => (typeof s === 'string' && (s.match(/a\d+/) || [])[0]) || '';
  const asLeaf = (raw) => ({ label: String(raw.label || raw).replace(/\s*\[\[a\d+\]\]\s*$/, '').trim().slice(0, 60), src: cleanSrc(raw.src) });
  if (tree && Array.isArray(tree.branches) && tree.branches.length) {
    return {
      title: String(tree.title || scopeName).slice(0, 40),
      branches: tree.branches.slice(0, 8).map((br, i) => ({
        label: String(br.label || `Rama ${i + 1}`).slice(0, 28),
        children: (Array.isArray(br.children) ? br.children : []).slice(0, 6).map(asLeaf).filter(c => c.label),
      })).filter(br => br.children.length),
    };
  }
  // Fallback: agrupar las viñetas de 5 en 5 como ramas anónimas.
  const branches = [];
  for (let i = 0; i < bullets.length && branches.length < 6; i += 5) {
    branches.push({
      label: 'Ideas ' + (branches.length + 1),
      children: bullets.slice(i, i + 5).map(t => ({
        label: t.replace(/\s*\[\[a\d+\]\]\s*$/, '').trim().slice(0, 60),
        src: (t.match(/\[\[(a\d+)\]\]/) || [])[1] || '',
      })),
    });
  }
  return { title: scopeName.slice(0, 40), branches };
}

function showError(msg) {
  const el = body()?.querySelector('#mm-error');
  if (!el) return;
  el.style.display = msg ? '' : 'none';
  el.textContent = msg;
}

// ---- Render radial en SVG -----------------------------------------------------

const W = 1200, H = 1000, CX = W / 2, CY = H / 2;

function svgEl(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function pill(svg, x, y, text, { fill, stroke, color, id }) {
  const w = Math.max(60, text.length * 8.4 + 22), h = 30;
  const g = svgEl('g', id ? { class: 'mm-cite', 'data-id': id, style: 'cursor:pointer' } : {});
  g.appendChild(svgEl('rect', { x: x - w / 2, y: y - h / 2, width: w, height: h, rx: 15, fill, stroke: stroke || 'none', 'stroke-width': 1.5 }));
  const t = svgEl('text', { x, y: y + 5, 'text-anchor': 'middle', 'font-size': 14, 'font-family': 'Inter, sans-serif', fill: color });
  t.textContent = text;
  g.appendChild(t);
  svg.appendChild(g);
  return { w, h };
}

function buildSvg(tree) {
  const svg = svgEl('svg', { xmlns: SVG_NS, viewBox: `0 0 ${W} ${H}`, width: W, height: H });
  svg.appendChild(svgEl('rect', { x: 0, y: 0, width: W, height: H, fill: '#faf8f3' }));
  const branches = tree.branches;
  const n = branches.length || 1;
  const R1 = 220, R2 = 380;

  branches.forEach((br, i) => {
    const col = PALETTE[i % PALETTE.length];
    const ang = (-90 + i * 360 / n) * Math.PI / 180;
    const bx = CX + R1 * Math.cos(ang), by = CY + R1 * Math.sin(ang);
    // Curva centro → rama.
    svg.appendChild(svgEl('path', { d: `M ${CX} ${CY} Q ${(CX + bx) / 2} ${(CY + by) / 2} ${bx} ${by}`, fill: 'none', stroke: col, 'stroke-width': 3, opacity: 0.55 }));
    // Hijos en abanico alrededor del ángulo de la rama.
    const m = br.children.length;
    const spread = Math.min(46, 300 / n) * Math.PI / 180;
    br.children.forEach((ch, j) => {
      const a = ang + (m > 1 ? (j - (m - 1) / 2) * spread / Math.max(1, m - 1) : 0);
      const cx2 = CX + R2 * Math.cos(a), cy2 = CY + R2 * Math.sin(a);
      svg.appendChild(svgEl('path', { d: `M ${bx} ${by} Q ${(bx + cx2) / 2} ${(by + cy2) / 2} ${cx2} ${cy2}`, fill: 'none', stroke: col, 'stroke-width': 1.5, opacity: 0.4 }));
      pill(svg, cx2, cy2, ch.label.length > 22 ? ch.label.slice(0, 21) + '…' : ch.label,
        { fill: '#fff', stroke: col, color: '#2b2b2b', id: (ch.src && ctx.anchors?.has(ch.src)) ? ch.src : null });
    });
    pill(svg, bx, by, br.label, { fill: col, color: '#fff' });
  });
  // Nodo central.
  pill(svg, CX, CY, tree.title, { fill: '#2b2b2b', color: '#fff' });
  return svg;
}

function renderResult(tree, scopeName) {
  const b = body();
  if (!b) return;
  b.innerHTML = `
    <button class="ai-ob-back">${icon('chevron-left', { size: 16 })}<span>Volver</span></button>
    <h2>Mapa mental — ${escapeHtml(scopeName)}</h2>
    <div class="mm-canvas" id="mm-canvas"></div>
    <div class="fc-export">
      <button id="mm-png" class="primary-btn">${icon('download', { size: 16 })} Descargar PNG</button>
      <button id="mm-svg" class="ai-ob-back fc-txt-btn">SVG</button>
    </div>`;
  b.querySelector('.ai-ob-back').addEventListener('click', renderSetup);
  const holder = b.querySelector('#mm-canvas');
  lastSvg = buildSvg(tree);
  holder.appendChild(lastSvg);

  // Clic en una hoja citada → navegar en el libro.
  holder.addEventListener('click', (e) => {
    const g = e.target.closest('.mm-cite');
    if (g && ctx.onCite) { ctx.onCite(g.dataset.id); closeModal(); }
  });

  const slug = (s) => (s || 'mapa').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  b.querySelector('#mm-svg').addEventListener('click', () => download(`bookreader-mapa-${slug(scopeName)}.svg`, serializeSvg(lastSvg), 'image/svg+xml'));
  b.querySelector('#mm-png').addEventListener('click', async () => {
    try { download(`bookreader-mapa-${slug(scopeName)}.png`, await svgToPngBlob(lastSvg), 'image/png'); }
    catch (err) { console.warn('PNG del mapa falló:', err); }
  });
}

function serializeSvg(svg) {
  return new XMLSerializer().serializeToString(svg);
}

async function svgToPngBlob(svg) {
  const url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(serializeSvg(svg))));
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  canvas.getContext('2d').drawImage(img, 0, 0, W, H);
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
