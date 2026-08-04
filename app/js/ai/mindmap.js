// P14 · Mapa mental. El agente organiza el capítulo o el libro en una jerarquía radial
// (tema central → ramas → puntos), con las hojas citando su pasaje [[aN]]. Es el artefacto
// compartible por excelencia (la gente postea mapas mentales): export a PNG para redes y a
// SVG. Reutiliza el troceado y el map de summary/flashcards.
//
// F3-F6 (2026-08-03) — el mapa dejó de ser una imagen y pasó a ser una herramienta:
//   F3 el export se ve como la pantalla (fuente embebida) y lleva procedencia y marca;
//   F4 medida real del texto, ramas curvas con grosor decreciente, anticolisión por anillo;
//   F5 zoom/pan, plegado de ramas y popover táctil con la cita (los <title> nativos no
//      existen en móvil, y esto es una PWA);
//   F6 "Expandir" una hoja con una llamada acotada → tercer nivel bajo demanda, en vez de
//      pagar por adelantado un mapa gigante que nadie lee.
// La geometría vive en `mindmap-render.js` (pura, sin red ni IDB).
import { t } from '../i18n.js';
import * as LLM from './llm.js';
import * as Retrieval from './retrieval.js';
import * as Jobs from './jobs.js';
import { estimateTokens } from './context.js';
import { buildChunks } from './flashcards.js';
import { icon } from '../ui/icons.js';
import { escapeHtml } from '../ui/escape.js';
import { interFaceCss } from '../ui/svg-fonts.js';
import * as Render from './mindmap-render.js';

const KIND = 'mindmap';
const BOOK_TOKENS = 30000;
// P14 F2 · Tope de llamadas del map: en libros grandes, 4+ llamadas de ~90s con modelo
// reasoning superaban el presupuesto de paciencia (el eval lo cazó: DNF a los 7 min en
// Pro Git). Trozos más grandes, menos llamadas: ≤3 de map + 1 de reduce.
const MAX_MAP_CALLS = 3;
let ctx = null;
let overlay = null, scopeValue = '', runUnsub = null;
let lastTree = null, lastSvg = null, lastLayout = null, lastScope = '';
let forceSetup = false;      // abrir directo en el setup aunque haya caché (Regenerar desde Studio)
// Estado de VISTA (no de contenido): plegado y zoom/pan viven en memoria, por sesión. No se
// persisten a propósito — guardar en IndexedDB en cada rueda del ratón sería absurdo, y al
// reabrir el mapa se quiere verlo entero.
let collapsed = new Set();
let view = { k: 1, tx: 0, ty: 0 };

export function open(context) {
  ctx = context;
  forceSetup = context && context.mode === 'setup';
  closeModal();
  overlay = document.createElement('div');
  overlay.id = 'ai-mindmap';
  overlay.className = 'ai-onboarding';
  overlay.innerHTML = `
    <div class="ai-ob-card mm-card" role="dialog" aria-modal="true" aria-label="${t('Mapa mental')}">
      <button class="ai-ob-close" title="${t('Cerrar')}" aria-label="${t('Cerrar')}">${icon('xmark', { size: 18 })}</button>
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
// La tarjeta se ensancha SOLO para el resultado (el SVG grande); en setup/en curso queda
// cómoda como la del resumen.
const setWide = (on) => overlay?.querySelector('.mm-card')?.classList.toggle('mm-card--wide', on);

// Al abrir: mapa en curso → vista "en curso"; mapa ya generado en caché → muéstralo directo
// (reabrir instantáneo); si no → setup.
function route() {
  const a = Jobs.activeJob();
  if (a && a.kind === KIND && a.bookId === ctx.bookId && a.status === 'running') { renderRunning(a); return; }
  if (forceSetup) { forceSetup = false; renderSetup(); return; }
  if (ctx.viewArtifact) { renderResult(ctx.viewArtifact.result, ctx.viewArtifact.params?.scopeName); return; }
  const c = Jobs.cached(ctx.bookId, KIND);
  if (c) { renderResult(c.result, c.params.scopeName); return; }
  renderSetup();
}

function renderSetup() {
  const b = body();
  if (!b) return;
  setWide(false);
  ctx.ensureIndex();
  const chapters = (ctx.tocLabels || []).filter(c => c && Retrieval.passagesByChapter(c).length);
  scopeValue = chapters.includes(ctx.currentChapter) ? ctx.currentChapter : '';
  b.innerHTML = `
    <h2>${t('Mapa mental')}</h2>
    <p class="ai-ob-sub">${t('El agente organiza el contenido en un mapa radial; cada punto cita su pasaje. Clic en una cita para saltar al libro.')}</p>
    <label class="fc-label">${t('Contenido')}</label>
    <select id="mm-scope" class="fc-select">
      <option value="">${t('Libro entero')}</option>
      ${chapters.map(c => `<option value="${escapeHtml(c)}"${c === scopeValue ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('')}
    </select>
    <button id="mm-generate" class="primary-btn ai-ob-start">${icon('sparkles', { size: 16 })} ${t('Generar mapa')}</button>
    <div id="mm-error" class="fc-error" style="display:none"></div>`;
  b.querySelector('#mm-scope').addEventListener('change', (e) => { scopeValue = e.target.value; });
  b.querySelector('#mm-generate').addEventListener('click', onGenerate);
}

function gatherScope(label) {
  ctx.ensureIndex();
  if (label) return Retrieval.passagesByChapter(label);
  const byChapter = new Map();
  for (const p of Retrieval.allPassages()) {
    if (Retrieval.isBoilerplate(p.chapter)) continue;   // fuera cubierta/índice/prólogo/licencias…
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

// Cap de viñetas para el reduce, JUSTO por capítulo (P14 F2): el muestreo uniforme podía
// dejar capítulos enteros sin representación (cobertura 2/5 en el eval). Round-robin por
// capítulo del ancla [[aN]] hasta `max`, conservando el orden dentro de cada capítulo.
// Pura y testeable: `chapterOf(id)` se inyecta.
export function capBulletsFair(bullets, max, chapterOf) {
  if (bullets.length <= max) return bullets;
  const order = [], groups = new Map();
  for (const b of bullets) {
    const src = (b.match(/\[\[(a\d+)\]\]/) || [])[1] || '';
    const ch = chapterOf(src) || 'General';
    if (!groups.has(ch)) { groups.set(ch, []); order.push(ch); }
    groups.get(ch).push(b);
  }
  const out = [];
  for (let i = 0; out.length < max; i++) {
    let added = false;
    for (const ch of order) {
      const b = groups.get(ch)[i];
      if (!b) continue;
      out.push(b); added = true;
      if (out.length >= max) break;
    }
    if (!added) break;
  }
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

function treePrompt(title, goal, chapterHints = []) {
  // P14 F2 · Esqueleto desde el TOC: anclar las ramas en la estructura real del libro
  // sube jerarquía y cobertura (el modelo tiende a inventarse taxonomías propias).
  const skeleton = chapterHints.length ? `
- RAMAS DE PARTIDA (capítulos reales del libro): ${chapterHints.join(' · ')}. Úsalas como
  base de las ramas; puedes fusionar dos afines o renombrar, pero no ignores la estructura.` : '';
  return `Organiza estos puntos de un libro en un MAPA MENTAL jerárquico.
Devuelve SOLO un objeto JSON válido con esta forma:
{"title": "tema central (2-4 palabras)", "branches": [{"label": "rama (1-3 palabras)", "children": [{"label": "concepto (2-5 palabras)", "src": "aN"}]}]}
REGLAS:
- 3 a 6 ramas; 2 a 5 hijos por rama.${skeleton}
- Las etiquetas son de MAPA MENTAL: rótulos CORTOS de concepto (2-5 palabras), sintagmas
  nominales, NUNCA frases ni oraciones. Ej.: "Desambiguación de entidades", NO "La
  desambiguación de entidades requiere un contexto rico".
- "src" = el id [[aN]] del punto de origen (solo "aN", sin corchetes) para ampliar el detalle; si no lo sabes, "".
- Mismo idioma que los puntos.${goal ? `\n- Enfoca el mapa en: «${goal}».` : ''}
- Título tentativo: «${title}».`;
}

function onGenerate() {
  if (!LLM.hasKey()) { showError(t('Configura tu API key en Ajustes → Agente para generar el mapa.')); return; }
  const passages = gatherScope(scopeValue);
  if (!passages.length) { showError(t('Ese contenido no tiene texto indexado; prueba con otro capítulo o el libro entero.')); return; }
  const totalTokens = passages.reduce((n, p) => n + estimateTokens(p.text) + 4, 0);
  const chunks = buildChunks(passages, Math.max(10000, Math.ceil(totalTokens / MAX_MAP_CALLS)));
  const scopeName = scopeValue || ctx.bookTitle || 'Libro';
  const goal = ctx.goal;
  // Esqueleto para el árbol: los capítulos reales del ámbito (≤8, sin accesorios) anclan
  // la jerarquía en la estructura del libro (cobertura/jerarquía medían 2/5 sin esto).
  const chapterHints = scopeValue ? [] : [...new Set(passages.map(p => tidyChapter(p.chapter)).filter(Boolean))].slice(0, 8);

  const act = Jobs.activeJob();
  if (act && act.status === 'running' && !(act.kind === KIND && act.bookId === ctx.bookId)) {
    if (!window.confirm(t('Ya se está generando {label}. ¿Cancelarlo y empezar el mapa?', { label: act.label }))) return;
  }
  showError('');
  Jobs.start({
    bookId: ctx.bookId, kind: KIND, label: t('el mapa mental'),
    params: { scopeName },
    run: ({ signal, progress, background }) => runMindmap({ chunks, goal, scopeName, chapterHints, signal, progress, background }),
  });
  renderRunning(Jobs.activeJob());
}

// Map (conceptos citados por trozo) + reduce (árbol JSON), desacoplado del modal.
async function runMindmap({ chunks, goal, scopeName, chapterHints = [], signal, progress, background = false }) {
  const bullets = [];
  for (let i = 0; i < chunks.length; i++) {
    const raw = await LLM.chatStream({
      messages: [
        { role: 'system', content: mapPrompt(goal) },
        { role: 'user', content: 'PASAJES DEL LIBRO:\n\n' + chunks[i].text },
      ],
      maxTokens: 1500, signal, background,   // holgura para modelos de razonamiento
    });
    for (const line of String(raw || '').split('\n')) {
      const t = line.trim();
      if (t.startsWith('- ') || t.startsWith('* ')) bullets.push(t.slice(2).trim());
    }
    progress(i + 1, chunks.length, 'map');
  }
  if (!bullets.length) throw new Error(t('El modelo no devolvió contenido. Vuelve a intentarlo.'));
  // Un buen mapa es conciso: acota las viñetas (muestreo uniforme) para que el JSON del reduce
  // quepa holgado —no se trunca ni cae al fallback— y el mapa no se sature de hojas.
  const p2ch = new Map(Retrieval.allPassages().map(p => [p.id, (p.chapter || '').trim()]));
  const capped = capBulletsFair(bullets, 24, (id) => p2ch.get(id));

  progress(chunks.length, chunks.length, 'reduce');
  let tree = null;
  try {
    const raw = await LLM.chatStream({
      messages: [
        { role: 'system', content: treePrompt(scopeName, goal, chapterHints) },
        { role: 'user', content: capped.join('\n') },
      ],
      // Alto a propósito: los modelos de razonamiento gastan miles de tokens "pensando" antes
      // del JSON; con poco cupo emitían JSON vacío/truncado → el mapa temático caía al fallback.
      maxTokens: 5000, signal, background,
    });
    tree = extractJson(raw);
  } catch (e) { if (e.name === 'AbortError') throw e; }
  return normalizeTree(tree, capped, scopeName);
}

// Vista "en curso": progreso + "Seguir leyendo" / "Cancelar", suscrita a Jobs.
function renderRunning(job) {
  const b = body();
  if (!b || !job) { renderSetup(); return; }
  setWide(false);
  b.innerHTML = `
    <h2>${t('Generando mapa mental…')}</h2>
    <p class="ai-run-status" id="mm-run-status" role="status"></p>
    <div class="ai-run-actions">
      <button id="mm-keep" class="primary-btn">${icon('book', { size: 16 })} ${t('Seguir leyendo')}</button>
      <button id="mm-cancel" class="ai-ob-back fc-txt-btn">${t('Cancelar')}</button>
    </div>
    <p class="sum-depth-hint">${t('Puedes cerrar esta ventana y seguir leyendo: te avisaremos cuando el mapa esté listo.')}</p>`;
  const status = b.querySelector('#mm-run-status');
  const paint = (j) => {
    if (!overlay) return;
    if (!j || j.status === 'cancelled') { if (runUnsub) { runUnsub(); runUnsub = null; } renderSetup(); return; }
    if (j.kind !== KIND) return;
    if (j.status === 'running') {
      status.textContent = j.progress.phase === 'reduce'
        ? t('Organizando el mapa…')
        : `Trazando el mapa… ${j.progress.i}/${j.progress.n || '·'}`;
    } else if (j.status === 'done') {
      if (runUnsub) { runUnsub(); runUnsub = null; }
      const c = Jobs.cached(ctx.bookId, KIND);
      renderResult(c ? c.result : j.result, c ? c.params.scopeName : (j.params?.scopeName || 'Libro'));
    } else if (j.status === 'error') {
      if (runUnsub) { runUnsub(); runUnsub = null; }
      renderSetup();
      showError(j.error?.message || t('No se pudo generar el mapa.'));
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
  // Cada hoja guarda una etiqueta CORTA visible + el texto completo (`full`) para el detalle.
  // RECURSIVA desde F6: un mapa expandido tiene nietos, y al reabrirlo desde IndexedDB pasa
  // otra vez por aquí — sin recursión, expandir se perdía al cerrar el modal.
  const asLeaf = (raw, depth = 0) => {
    const full = String(raw.label ?? raw).replace(/\s*\[\[a\d+\]\]\s*$/, '').trim();
    const leaf = { label: clampWords(full, 42), src: cleanSrc(raw.src), full };
    const kids = depth < 2 && Array.isArray(raw.children) ? raw.children : [];
    if (kids.length) leaf.children = kids.slice(0, 6).map(k => asLeaf(k, depth + 1)).filter(c => c.label);
    return leaf;
  };
  if (tree && Array.isArray(tree.branches) && tree.branches.length) {
    const branches = tree.branches.slice(0, 8).map((br, i) => {
      const label = String(br.label || t('Rama {n}', { n: i + 1 })).trim();
      return {
        label: clampWords(label, 32), full: label,
        children: (Array.isArray(br.children) ? br.children : []).slice(0, 6).map(asLeaf).filter(c => c.label),
      };
    }).filter(br => br.children.length);
    // P14 F2 · Un árbol de UNA rama no es un mapa (el eval lo cazó en el PDF): mejor el
    // fallback por capítulos, que garantiza estructura fiel al libro.
    if (branches.length >= 2) return { title: String(tree.title || scopeName).slice(0, 44), branches };
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

// ---- Tema del lienzo -----------------------------------------------------------

// En pantalla el mapa sigue al tema (antes el fondo `#faf8f3` y la tinta `#2b2b2b` estaban
// clavados: en oscuro el modal mostraba un parche crema). En claro y sepia se conserva el
// papel de marca, que es el mismo de la tarjeta-cita.
function screenTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fb) => ((cs.getPropertyValue(name) || '').trim() || fb);
  const isDark = Render.contrastInk(v('--surface-0', '#ffffff')) === '#ffffff';
  if (!isDark) return Render.POSTER;
  return {
    bg: v('--surface-1', '#1a1f24'), ink: v('--text', '#f2f3f5'),
    muted: v('--text-soft', '#a8b0b8'), leaf: v('--surface-2', '#232a31'),
    line: v('--border', '#30363d'),
  };
}

// Las métricas de texto solo son correctas con Inter YA cargada; si se mide con la fuente de
// sistema, las píldoras salen con el ancho equivocado. `document.fonts.ready` es barato
// (resuelto de inmediato salvo en la primerísima visita).
async function fontsReady() {
  try { await document.fonts.ready; } catch { /* sin API de fuentes: métricas del sistema */ }
  Render.clearMeasureCache();
}

// ---- Pintado y vista (zoom / pan / plegado) --------------------------------------

const clampK = (k) => Math.min(6, Math.max(0.4, k));

function applyView() {
  lastSvg?.querySelector('.mm-viewport')
    ?.setAttribute('transform', `translate(${view.tx} ${view.ty}) scale(${view.k})`);
}

// Punto del ratón/dedo en coordenadas del viewBox (antes del transform del viewport), que es
// donde vive la geometría del mapa.
function toUserSpace(evt) {
  if (!lastSvg) return { x: 0, y: 0 };
  const ctm = lastSvg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const p = lastSvg.createSVGPoint();
  p.x = evt.clientX; p.y = evt.clientY;
  const q = p.matrixTransform(ctm.inverse());
  return { x: q.x, y: q.y };
}

// Zoom conservando el punto bajo el cursor (si no, acercarse "huye" del sitio que miras).
function zoomAt(px, py, factor) {
  const k = clampK(view.k * factor);
  if (k === view.k) return;
  view.tx = px - (px - view.tx) * (k / view.k);
  view.ty = py - (py - view.ty) * (k / view.k);
  view.k = k;
  applyView();
}

function zoomCenter(factor) {
  if (!lastLayout) return;
  zoomAt(lastLayout.width / 2, lastLayout.height / 2, factor);
}

function resetView() { view = { k: 1, tx: 0, ty: 0 }; applyView(); }

function paintMap() {
  const holder = body()?.querySelector('#mm-canvas');
  if (!holder || !lastTree) return;
  const theme = screenTheme();
  lastLayout = Render.layout(lastTree, { collapsed });
  const built = Render.renderSvg(lastLayout, {
    theme, interactive: true,
    title: t('Mapa mental de {scope}', { scope: lastScope || '' }),
  });
  lastSvg = built.svg;
  holder.style.background = theme.bg;
  holder.replaceChildren(lastSvg);
  applyView();
  wireCanvas(holder);
}

// Puntero unificado (ratón, dedo y lápiz): arrastrar = pan, dos dedos = pinza, rueda = zoom.
// Un gesto que se mueve menos de 4 px se considera clic, no arrastre.
function wireCanvas(holder) {
  const pointers = new Map();
  let moved = 0, pinchDist = 0, captured = 0;

  holder.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = toUserSpace(e);
    zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  holder.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = 0;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
    // OJO: aquí NO se captura el puntero. Con la captura puesta desde `pointerdown`, el
    // `click` posterior se re-dirige al contenedor y `e.target` deja de ser el nodo del SVG
    // — o sea, ningún clic abriría nunca el detalle. Se captura solo cuando el arrastre
    // empieza de verdad (ver `pointermove`), que es cuando hace falta.
  });

  holder.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved += Math.hypot(dx, dy);
    if (moved > 4 && !captured) { captured = e.pointerId; holder.setPointerCapture?.(e.pointerId); }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0 && d > 0) {
        const mid = toUserSpace({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
        zoomAt(mid.x, mid.y, d / pinchDist);
      }
      pinchDist = d;
      return;
    }
    // Pan: el desplazamiento va en píxeles de pantalla; hay que pasarlo a unidades del
    // viewBox, que es donde se aplica el transform.
    const scale = lastLayout && holder.clientWidth ? lastLayout.width / holder.clientWidth : 1;
    view.tx += dx * scale; view.ty += dy * scale;
    applyView();
  });

  const release = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (captured === e.pointerId) { holder.releasePointerCapture?.(e.pointerId); captured = 0; }
  };
  holder.addEventListener('pointerup', release);
  holder.addEventListener('pointercancel', release);

  holder.addEventListener('click', (e) => {
    if (moved > 4) return;                                   // fue un arrastre, no un clic
    const g = e.target.closest('.mm-node');
    if (g) openNodePopover(g.dataset.id);
    else closePopover();
  });

  // Teclado: los nodos son focusables (role="button"); Enter/Espacio abren su detalle.
  holder.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const g = e.target.closest?.('.mm-node');
    if (!g) return;
    e.preventDefault();
    openNodePopover(g.dataset.id);
  });
}

// ---- Detalle de un nodo (sustituye al tooltip nativo) ----------------------------

// El `<title>` de SVG NO existe en táctil: en el móvil la cita del pasaje era invisible, y
// es lo que da valor al mapa. Este panel además es donde viven "Ir al libro", "Preguntar",
// plegar y expandir — acciones que un tooltip no puede ofrecer.
let popover = null;

function closePopover() {
  popover?.remove();
  popover = null;
}

function passageText(src) {
  if (!src) return '';
  const p = Retrieval.allPassages().find(x => x.id === src);
  return (p?.text || '').trim();
}

function openNodePopover(id) {
  closePopover();
  const node = lastLayout?.byId.get(id);
  // Se ancla al ESCENARIO, no al lienzo: el lienzo recorta (`overflow: hidden`), así que el
  // panel de un nodo pegado al borde quedaba cortado.
  const stage = body()?.querySelector('.mm-stage');
  const holder = body()?.querySelector('#mm-canvas');
  if (!node || !stage || !holder) return;

  const quote = passageText(node.src);
  const canCite = !!(node.src && ctx.anchors?.has(node.src));
  const actions = [];
  if (node.childCount > 0) {
    actions.push(`<button class="mm-pop-act" data-act="fold">${icon(node.collapsed ? 'chevron-down' : 'chevron-up', { size: 14 })} ${node.collapsed ? t('Desplegar') : t('Plegar')}</button>`);
  } else if (node.depth >= 1) {
    actions.push(`<button class="mm-pop-act" data-act="expand">${icon('sparkles', { size: 14 })} ${t('Expandir')}</button>`);
  }
  if (canCite) actions.push(`<button class="mm-pop-act" data-act="cite">${icon('book', { size: 14 })} ${t('Ir al libro')}</button>`);
  if (ctx.onAsk) actions.push(`<button class="mm-pop-act" data-act="ask">${icon('sparkles', { size: 14 })} ${t('Preguntar')}</button>`);

  popover = document.createElement('div');
  popover.className = 'mm-pop';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', node.full || node.label);
  popover.innerHTML = `
    <button class="mm-pop-close" aria-label="${t('Cerrar')}">${icon('xmark', { size: 14 })}</button>
    <h4>${escapeHtml(node.full || node.label)}</h4>
    ${quote ? `<blockquote>${escapeHtml(quote.slice(0, 420))}${quote.length > 420 ? '…' : ''}</blockquote>` : ''}
    <div class="mm-pop-actions">${actions.join('')}</div>
    <div class="mm-pop-status" role="status"></div>`;
  stage.appendChild(popover);

  // Anclado al nodo, pero siempre dentro del escenario (si no, en los nodos del borde el
  // panel se salía y quedaba inalcanzable).
  const box = stage.getBoundingClientRect();
  const ctm = lastSvg.querySelector('.mm-viewport')?.getScreenCTM();
  let left = box.width / 2, top = box.height / 2;
  if (ctm) {
    const p = lastSvg.createSVGPoint();
    p.x = node.x + lastLayout.ox; p.y = node.y + lastLayout.oy;
    const s = p.matrixTransform(ctm);
    left = s.x - box.left + 12;
    top = s.y - box.top + 12;
  }
  popover.style.left = Math.max(8, Math.min(left, box.width - popover.offsetWidth - 8)) + 'px';
  popover.style.top = Math.max(8, Math.min(top, box.height - popover.offsetHeight - 8)) + 'px';

  popover.querySelector('.mm-pop-close').addEventListener('click', closePopover);
  popover.addEventListener('click', (e) => e.stopPropagation());
  popover.querySelectorAll('.mm-pop-act').forEach(btn => {
    btn.addEventListener('click', () => onNodeAction(btn.dataset.act, node, quote));
  });
}

function onNodeAction(act, node, quote) {
  if (act === 'fold') {
    if (collapsed.has(node.id)) collapsed.delete(node.id); else collapsed.add(node.id);
    closePopover();
    paintMap();
    return;
  }
  if (act === 'cite') { closeModal(); ctx.onCite?.(node.src); return; }
  if (act === 'ask') {
    closeModal();
    ctx.onAsk?.(t('Explícame «{label}» en el contexto del libro.', { label: node.full || node.label }), quote || '');
    return;
  }
  if (act === 'expand') expandNode(node);
}

// ---- F6 · Expandir una hoja bajo demanda -----------------------------------------

// El mapa nace conciso (24 viñetas) y se profundiza SOLO donde interesa, con una llamada
// acotada al subárbol. Es lo contrario a subir el cupo inicial: no encarece la generación ni
// satura el lienzo, y evita el techo de dos niveles que tenía el esquema del reduce.
function expandPrompt(label, goal) {
  return `Del siguiente fragmento de un libro, extrae 2 a 4 SUBCONCEPTOS que desarrollen «${label}».
Devuelve SOLO un objeto JSON válido: {"children":[{"label":"subconcepto (2-5 palabras)","src":"aN"}]}
REGLAS:
- Etiquetas de MAPA MENTAL: sintagmas nominales CORTOS, nunca frases ni oraciones.
- Deben ser MÁS ESPECÍFICOS que «${label}»: no lo repitas ni lo parafrasees.
- "src" = el marcador [[aN]] del pasaje que sostiene ese subconcepto (solo "aN", sin corchetes).
  Si ningún pasaje lo sostiene, NO lo incluyas: mejor devolver menos que inventar.
- Mismo idioma que el fragmento.${goal ? `\n- Prioriza lo relevante para: «${goal}».` : ''}`;
}

// Localiza el nodo CRUDO del árbol a partir de la ruta estable del layout ("r.0.2").
function rawAt(tree, id) {
  const idx = String(id).split('.').slice(1).map(Number);
  if (!idx.length || idx.some(Number.isNaN)) return null;
  let node = (tree.branches || [])[idx[0]];
  for (let i = 1; i < idx.length && node; i++) node = (node.children || [])[idx[i]];
  return node || null;
}

// Pasajes en los que apoyar la expansión: los del propio nodo y su subárbol, con vecinos
// para dar contexto. Si el nodo no cita nada (pasa en el fallback por capítulos), se cae al
// capítulo de la rama, que siempre existe.
function passagesForNode(node) {
  const srcs = new Set();
  const collect = (n) => {
    if (!n) return;
    if (n.src) srcs.add(n.src);
    (n.children || []).forEach(collect);
  };
  collect(rawAt(lastTree, node.id));
  const all = Retrieval.allPassages();
  let seed = all.filter(p => srcs.has(p.id));
  if (!seed.length) {
    // El nodo no cita nada (pasa en el fallback por capítulos y en las ramas): se apoya en lo
    // que citan sus HERMANOS, o sea el subárbol del padre. `collect` acumula en `srcs`, que
    // aquí ya sabemos que está vacío de coincidencias, así que reutilizarlo es correcto —
    // antes se creaba un `psrcs` aparte que `collect` no rellenaba nunca, y el fallback solo
    // veía los hijos directos.
    const parent = lastLayout.byId.get(node.parent);
    collect(parent ? rawAt(lastTree, parent.id) : null);
    seed = all.filter(p => srcs.has(p.id));
  }
  if (!seed.length) return [];
  return Retrieval.withNeighbors(seed, 2);
}

async function expandNode(node) {
  const status = popover?.querySelector('.mm-pop-status');
  const setStatus = (msg) => { if (status) status.textContent = msg; };
  if (!LLM.hasKey()) { setStatus(t('Configura tu API key en Ajustes → Agente.')); return; }
  const passages = passagesForNode(node);
  if (!passages.length) { setStatus(t('Este punto no tiene pasajes que ampliar.')); return; }

  popover?.querySelectorAll('.mm-pop-act').forEach(b => { b.disabled = true; });
  setStatus(t('Ampliando…'));
  try {
    const text = passages.map(p => `[[${p.id}]] ${p.text}`).join('\n\n').slice(0, 24000);
    const raw = await LLM.chatStream({
      messages: [
        { role: 'system', content: expandPrompt(node.full || node.label, ctx.goal) },
        { role: 'user', content: text },
      ],
      maxTokens: 1200,
    });
    const parsed = extractJson(raw);
    const kids = Array.isArray(parsed?.children) ? parsed.children : [];
    const anchors = new Set(passages.map(p => p.id));
    // Solo se aceptan subconceptos CITADOS y con un ancla que exista de verdad entre los
    // pasajes que se le pasaron. Un nieto sin cita es justo lo que no queremos en un mapa
    // que se publica: parece contenido del libro sin serlo.
    const clean = kids
      .map(k => ({ label: String(k?.label || '').trim(), src: (String(k?.src || '').match(/a\d+/) || [])[0] || '' }))
      .filter(k => k.label && k.src && anchors.has(k.src))
      .slice(0, 4)
      .map(k => ({ label: clampWords(k.label, 42), full: k.label, src: k.src }));
    if (!clean.length) { setStatus(t('No se encontraron subconceptos citables aquí.')); return; }

    const target = rawAt(lastTree, node.id);
    if (!target) { setStatus(t('No se pudo ampliar este punto.')); return; }
    target.children = clean;
    persistTree();
    closePopover();
    paintMap();
  } catch (e) {
    if (e.name === 'AbortError') return;
    setStatus(e?.message || t('No se pudo ampliar este punto.'));
  } finally {
    popover?.querySelectorAll('.mm-pop-act').forEach(b => { b.disabled = false; });
  }
}

// El mapa expandido reemplaza al artefacto existente (misma entrada del historial): si cada
// expansión creara uno nuevo, el Studio se llenaría de versiones casi idénticas.
function persistTree() {
  const entry = Jobs.cached(ctx.bookId, KIND);
  if (entry?.key) Jobs.update(entry.key, lastTree);
}

// ---- Resultado y export ----------------------------------------------------------

async function renderResult(tree, scopeName) {
  const b = body();
  if (!b) return;
  setWide(true);
  // IMPRESCINDIBLE: reabrir un mapa ya generado entra por aquí SIN pasar por el setup, que
  // era el único sitio que construía el índice. Tras recargar la página eso dejaba
  // `allPassages()` vacío, y el mapa perdía en silencio lo que le da valor: ni la cita del
  // pasaje en el detalle, ni "Expandir" (que respondía "no tiene pasajes que ampliar" en
  // TODOS los nodos). Es idempotente y barata: si el índice ya está, no hace nada.
  ctx.ensureIndex();
  lastTree = tree;
  lastScope = scopeName;
  collapsed = new Set();
  view = { k: 1, tx: 0, ty: 0 };
  Jobs.clearActive();          // el usuario está viendo el resultado → retira chip/aviso
  b.innerHTML = `
    <div class="sum-resulthead">
      <button class="ai-ob-back">${icon('chevron-left', { size: 16 })}<span>${t('Volver')}</span></button>
      <button id="mm-regen" class="fc-txt-btn">${icon('sparkles', { size: 14 })} ${t('Regenerar')}</button>
    </div>
    <h2>${t('Mapa mental')} — ${escapeHtml(scopeName)}</h2>
    <div class="mm-stage">
      <div class="mm-canvas" id="mm-canvas"></div>
      <div class="mm-zoom" role="group" aria-label="${t('Zoom del mapa')}">
        <button id="mm-zoom-out" aria-label="${t('Alejar')}" title="${t('Alejar')}">−</button>
        <button id="mm-zoom-fit" aria-label="${t('Ajustar')}" title="${t('Ajustar')}">${icon('target', { size: 14 })}</button>
        <button id="mm-zoom-in" aria-label="${t('Acercar')}" title="${t('Acercar')}">+</button>
      </div>
    </div>
    <p class="sum-depth-hint">${t('Clic en un nodo para ver su cita, plegarlo o ampliarlo. Rueda o pinza para el zoom; arrastra para mover.')}</p>
    <div class="fc-export">
      <button id="mm-png" class="primary-btn">${icon('download', { size: 16 })} ${t('Descargar PNG')}</button>
      <button id="mm-share" class="ai-ob-back fc-txt-btn" style="display:none">${icon('share', { size: 14 })} ${t('Compartir')}</button>
      <button id="mm-svg" class="ai-ob-back fc-txt-btn">SVG</button>
    </div>
    <div id="mm-export-error" class="fc-error" style="display:none"></div>`;
  b.querySelector('.ai-ob-back').addEventListener('click', renderSetup);
  b.querySelector('#mm-regen').addEventListener('click', renderSetup);
  b.querySelector('#mm-zoom-in').addEventListener('click', () => zoomCenter(1.25));
  b.querySelector('#mm-zoom-out').addEventListener('click', () => zoomCenter(1 / 1.25));
  b.querySelector('#mm-zoom-fit').addEventListener('click', resetView);

  await fontsReady();
  if (!body()?.querySelector('#mm-canvas')) return;    // el modal se cerró mientras cargaba
  paintMap();

  const slug = (s) => (s || 'mapa').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  const name = (ext) => `bookreader-mapa-${slug(scopeName)}.${ext}`;
  b.querySelector('#mm-svg').addEventListener('click', async () => {
    const { svg } = await buildExport();
    download(name('svg'), new XMLSerializer().serializeToString(svg), 'image/svg+xml');
  });
  b.querySelector('#mm-png').addEventListener('click', async () => {
    try { download(name('png'), await exportPng()); }
    catch (err) {
      console.warn('PNG del mapa falló:', err);
      showExportError(t('No se pudo generar la imagen.'));
    }
  });
  // Compartir nativo (móvil): mismo camino que la tarjeta-cita. Solo se muestra si el
  // navegador acepta compartir ficheros; si no, el PNG ya cubre el caso.
  const shareBtn = b.querySelector('#mm-share');
  if (navigator.canShare?.({ files: [new File([new Blob()], 'x.png', { type: 'image/png' })] })) {
    shareBtn.style.display = '';
    shareBtn.addEventListener('click', async () => {
      try {
        const blob = await exportPng();
        await navigator.share({ files: [new File([blob], name('png'), { type: 'image/png' })] });
      } catch (err) {
        if (err?.name === 'AbortError') return;
        showExportError(t('No se pudo compartir la imagen.'));
      }
    });
  }
}

function showExportError(msg) {
  const el = body()?.querySelector('#mm-export-error');
  if (!el) return;
  el.style.display = msg ? '' : 'none';
  el.textContent = msg;
}

// Versión "póster" para publicar: papel de marca (independiente del tema de la app), pie con
// procedencia y Inter EMBEBIDA. Exporta lo que se ve — si el usuario plegó ramas para dejar
// el mapa limpio, eso es curaduría suya y debe respetarse.
async function buildExport() {
  const fontCss = await interFaceCss();
  const lay = Render.layout(lastTree, { collapsed });
  return Render.renderSvg(lay, {
    theme: Render.POSTER,
    fontCss,
    title: t('Mapa mental de {scope}', { scope: lastScope || '' }),
    footer: {
      title: ctx.bookTitle || lastScope || '',
      author: ctx.bookAuthor || '',
      mark: 'BookReader',
    },
  });
}

async function exportPng() {
  const { svg, width, height } = await buildExport();
  const xml = new XMLSerializer().serializeToString(svg);
  // `unescape` está deprecado; `TextEncoder` + base64 por trozos hace lo mismo sin él y
  // aguanta los mapas grandes.
  const bytes = new TextEncoder().encode(xml);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const img = new Image();
  img.src = 'data:image/svg+xml;base64,' + btoa(bin);
  await img.decode();
  // 2× para que se vea nítido al compartir, con tope: un mapa grande a 2× podía pedir un
  // lienzo que el navegador rechaza en silencio (y devolvía un PNG vacío).
  const scale = Math.min(2, Math.max(1, 4200 / Math.max(width, height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((res, rej) =>
    canvas.toBlob(b => (b ? res(b) : rej(new Error('toBlob null'))), 'image/png'));
}

function download(filename, data, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
