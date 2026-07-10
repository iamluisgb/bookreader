// Flashcards para Anki (feature estrella del plan de lanzamiento): el agente genera
// tarjetas de estudio desde el libro (capítulo o libro entero, básicas o cloze), el
// usuario las revisa/edita en un modal y las exporta a .apkg (paquete nativo de Anki)
// o .txt (import de texto). Los mazos generados persisten en IndexedDB (store `decks`)
// para re-exportarlos sin regenerar (sin re-gastar tokens).
//
// El panel abre el modal con `open(ctx)`; este módulo no guarda estado del libro entre
// aperturas: todo llega en ctx (bookId, título, objetivo, TOC, ensureIndex del panel).
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
import { balancedObjects } from './query-expand.js';

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

let ctx = null;        // { bookId, bookTitle, goal, tocLabels, currentChapter, ensureIndex }
let overlay = null;
let generating = false, abortCtrl = null;
let scopeValue = '';   // alcance elegido: '' = libro entero, o la etiqueta del capítulo
// Umbral a partir del cual el desplegable de alcance muestra buscador (índices largos).
const SCOPE_SEARCH_MIN = 8;

export function open(context) {
  ctx = context;
  closeModal();
  overlay = document.createElement('div');
  overlay.id = 'ai-flashcards';
  overlay.className = 'ai-onboarding';
  overlay.innerHTML = `
    <div class="ai-ob-card fc-card" role="dialog" aria-modal="true" aria-label="Flashcards para Anki">
      <button class="ai-ob-close" title="Cerrar" aria-label="Cerrar">${icon('xmark', { size: 18 })}</button>
      <div class="ai-ob-body"></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && !generating) closeModal(); });
  overlay.querySelector('.ai-ob-close').addEventListener('click', () => { abortCtrl?.abort(); closeModal(); });
  document.addEventListener('keydown', onKey);
  renderSetup();
}

function onKey(e) {
  if (Study.isOpen()) return;   // el overlay de estudio va encima: su ESC no cierra este modal
  if (e.key === 'Escape' && overlay) { abortCtrl?.abort(); closeModal(); }
}

function closeModal() {
  document.removeEventListener('keydown', onKey);
  if (overlay) { overlay.remove(); overlay = null; }
  generating = false;
}

const body = () => overlay?.querySelector('.ai-ob-body');

// ---- Vista 1: configurar y generar ------------------------------------------

async function renderSetup() {
  const b = body();
  if (!b) return;
  // Solo capítulos con texto indexado (fuera cubierta, copyright…); el actual se
  // preselecciona solo si tiene contenido — si no, "Libro entero".
  ctx.ensureIndex();
  const chapters = (ctx.tocLabels || []).filter(c => c && Retrieval.passagesByChapter(c).length);
  // Alcance por defecto: el capítulo que se lee (si tiene contenido), si no el libro entero.
  scopeValue = chapters.includes(ctx.currentChapter) ? ctx.currentChapter : '';
  const options = [{ value: '', label: 'Libro entero' }, ...chapters.map(c => ({ value: c, label: c }))];
  b.innerHTML = `
    <h2>Flashcards para Anki</h2>
    <p class="ai-ob-sub">El agente crea tarjetas de estudio desde el libro; revísalas y expórtalas a Anki.</p>
    <label class="fc-label" id="fc-scope-label">Contenido</label>
    <div id="fc-scope"></div>
    <label class="fc-label">Tipo de tarjeta</label>
    <div class="fc-types">
      <label class="fc-type"><input type="radio" name="fc-type" value="basic" checked>
        <span><b>Pregunta → Respuesta</b><small>Clásicas. Para conceptos y definiciones.</small></span></label>
      <label class="fc-type"><input type="radio" name="fc-type" value="cloze">
        <span><b>Cloze (huecos)</b><small>Frases con el dato clave oculto {{c1::así}}.</small></span></label>
    </div>
    <label class="fc-label" for="fc-count">Cantidad</label>
    <select id="fc-count" class="fc-select">${COUNTS.map(n => `<option ${n === 15 ? 'selected' : ''}>${n}</option>`).join('')}</select>
    <button id="fc-generate" class="primary-btn ai-ob-start">${icon('sparkles', { size: 16 })} Generar tarjetas</button>
    <div id="fc-error" class="fc-error" style="display:none"></div>
    <div id="fc-decks"></div>`;
  mountScopeCombo(b.querySelector('#fc-scope'), options, scopeValue, (v) => { scopeValue = v; });
  b.querySelector('#fc-generate').addEventListener('click', onGenerate);
  renderDeckList();
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
      ${withSearch ? `<input class="fc-combo-search" type="text" placeholder="Buscar capítulo…" aria-label="Buscar capítulo">` : ''}
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
      : `<li class="fc-combo-empty" aria-disabled="true">Sin resultados</li>`;
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
    <div class="fc-label">Mazos generados</div>
    ${decks.map(d => {
      const st = Srs.deckStats(d.cards);
      const due = st.due;
      return `
      <div class="fc-deck" data-id="${d.id}">
        <div class="fc-deck-info">
          <span class="fc-deck-name">${escapeHtml(d.scope || 'Libro entero')}</span>
          <span class="fc-deck-meta">${d.cards.length} tarjetas · ${d.cardType === 'cloze' ? 'cloze' : 'P→R'} · ${new Date(d.createdAt).toLocaleDateString()}</span>
          <span class="fc-deck-meta">${st.nuevas} nuevas · ${st.aprendiendo} aprendiendo · ${st.maduras} maduras</span>
        </div>
        <button class="fc-deck-study" data-act="study" title="Repasar con repetición espaciada">
          ${icon('cards', { size: 14 })} Estudiar${due ? ` <span class="fc-deck-due">${due}</span>` : ''}
        </button>
        <button class="icon-btn" data-act="review" title="Revisar y exportar">${icon('pencil', { size: 15 })}</button>
        <button class="icon-btn" data-act="delete" title="Borrar mazo">${icon('trash', { size: 15 })}</button>
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
        decks: [deck], title: deck.name || 'Estudiar',
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
function gatherScope(scopeLabel) {
  ctx.ensureIndex();
  if (scopeLabel) return Retrieval.passagesByChapter(scopeLabel);
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

// Trozos de ~chunkTokens con el texto anotado (encabezados ## + marcadores [[aN]], que
// alimentan el "src" de P10 F2). Pura (recibe pasajes) para poder testearla. Un capítulo
// mayor que el trozo se parte; al continuar en el trozo siguiente se repite su encabezado.
export function buildChunks(passages, chunkTokens = CHUNK_TOKENS) {
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
      if (p.chapter) lines.push(`\n## ${p.chapter}`);
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

function cardsPrompt(count, type, goal, { viaTool = false, prevFronts = [] } = {}) {
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
  return `Eres un experto en repetición espaciada creando flashcards de Anki de máxima calidad a partir de pasajes de un libro.

REGLAS DE CALIDAD (obligatorias):
- Atómicas: UNA idea o hecho por tarjeta.
- Autocontenidas: prohibido "según el texto", "en este capítulo" o "el autor" sin nombrarlo.
- Prioriza conceptos, definiciones, relaciones causa-efecto y datos concretos; evita trivialidades.
- Sin tarjetas duplicadas ni casi iguales.
- Escribe las tarjetas EN EL MISMO IDIOMA que los pasajes.${goal ? `
- Cuando sea posible, alinéalas al objetivo del lector: «${goal}».` : ''}

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

// P10 F2 — asegura el ancla de origen de cada tarjeta: si el modelo no dio "src" (o dio
// uno que no existe: los LLM inventan ids), se busca el mejor pasaje por BM25 con el
// contenido de la tarjeta, prefiriendo su capítulo declarado. Best-effort: sin acierto,
// la tarjeta queda sin fuente (el modo Estudiar simplemente no ofrece el salto).
export function attachSources(cards, { validIds, search }) {
  return cards.map(c => {
    if (c.src && validIds.has(c.src)) return c;
    const hits = search(`${c.front} ${c.back}`.trim(), 5) || [];
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
async function generateChunk({ text, ask, type, prevFronts, mode, signal }) {
  const user = { role: 'user', content: 'PASAJES DEL LIBRO:\n\n' + text };
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
        { role: 'system', content: cardsPrompt(ask, type, ctx.goal, { viaTool: true, prevFronts }) },
        user, ...extra,
      ],
      tools: cardsTool(), toolChoice, maxTokens, signal,
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
    messages: [{ role: 'system', content: cardsPrompt(ask, type, ctx.goal, { prevFronts }) }, user],
    maxTokens, signal,
  });
  return { cards: parseCards(raw, type), mode: 'text' };
}

async function onGenerate() {
  if (generating) return;
  const b = body();
  if (!LLM.hasKey()) { showError('Configura tu API key en Ajustes → Agente para generar tarjetas.'); return; }
  const scopeLabel = scopeValue;
  const type = b.querySelector('input[name="fc-type"]:checked').value;
  const count = parseInt(b.querySelector('#fc-count').value, 10);

  const chunks = buildChunks(gatherScope(scopeLabel));
  if (!chunks.length) { showError('Ese contenido no tiene texto indexado; prueba con otro capítulo o con el libro entero.'); return; }
  const counts = allocateCounts(chunks, count);

  generating = true; abortCtrl = new AbortController();
  const btn = b.querySelector('#fc-generate');
  btn.disabled = true;
  btn.innerHTML = `<span class="ai-typing">Generando tarjetas…</span>`;
  showError('');
  try {
    // Map-reduce sobre los trozos: cada uno aporta su cupo (+ el déficit arrastrado de
    // trozos anteriores que dieron de menos). Un trozo fallido no tira el mazo.
    let cards = [], expected = 0, failed = 0, mode = 'forced';
    for (let i = 0; i < chunks.length; i++) {
      if (!counts[i]) continue;
      const deficit = Math.max(0, expected - cards.length);
      expected += counts[i];
      try {
        const res = await generateChunk({
          text: chunks[i].text, ask: counts[i] + deficit, type,
          prevFronts: cards.slice(-MAX_PREV_FRONTS).map(c => c.front),
          mode, signal: abortCtrl.signal,
        });
        mode = res.mode;
        cards = cards.concat(res.cards.slice(0, counts[i] + deficit));
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        console.warn(`Flashcards: el trozo ${i + 1}/${chunks.length} falló:`, e);
        failed++;
      }
      if (!overlay) return;                     // el usuario cerró el modal: no seguir
      btn.innerHTML = `<span class="ai-typing">Generando… ${Math.min(cards.length, count)}/${count}</span>`;
    }
    if (!cards.length) throw new Error('El modelo no devolvió tarjetas válidas. Vuelve a intentarlo.');
    cards = attachSources(cards.slice(0, count), {
      validIds: new Set(Retrieval.allPassages().map(p => p.id)),
      search: (q, k) => Retrieval.search(q, k),
    });
    const deck = {
      bookId: ctx.bookId, name: deckName(scopeLabel), cardType: type,
      scope: scopeLabel, cards,
    };
    if (ctx.bookId) deck.id = await DB.addDeck(deck);
    deck.createdAt = deck.createdAt || Date.now();
    renderReview(deck);
    if (cards.length < count) {                 // éxito parcial: avisa en la revisión, no descarta
      showError(`Se generaron ${cards.length} de ${count} tarjetas${failed ? ` (fallaron ${failed} de ${chunks.length} bloques)` : ''}.`);
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error('Generación de flashcards falló:', e);
      showError(e.message);
    }
  } finally {
    generating = false; abortCtrl = null;
    const btn2 = body()?.querySelector('#fc-generate');
    if (btn2) { btn2.disabled = false; btn2.innerHTML = `${icon('sparkles', { size: 16 })} Generar tarjetas`; }
  }
}

function showError(msg) {
  const el = body()?.querySelector('#fc-error');
  if (!el) return;
  el.style.display = msg ? '' : 'none';
  el.textContent = msg;
}

// Nombre del mazo en Anki: subdeck por libro (— separa el alcance para no crear
// jerarquías :: inesperadas con títulos que lleven dos puntos).
function deckName(scopeLabel) {
  const book = (ctx.bookTitle || 'Libro').replace(/::/g, ':');
  return scopeLabel ? `${book} — ${scopeLabel.replace(/::/g, ':')}` : book;
}

// ---- Vista 2: revisar, editar y exportar --------------------------------------

function renderReview(deck) {
  const b = body();
  if (!b) return;
  const cardRow = (c, i) => `
    <div class="fc-item" data-i="${i}">
      <div class="fc-item-fields">
        <div class="fc-front" contenteditable="true" spellcheck="false">${escapeHtml(c.front)}</div>
        <div class="fc-back" contenteditable="true" spellcheck="false" data-ph="${deck.cardType === 'cloze' ? 'Extra (opcional)' : 'Respuesta'}">${escapeHtml(c.back)}</div>
      </div>
      <button class="icon-btn fc-del" title="Quitar tarjeta">${icon('xmark', { size: 15 })}</button>
    </div>`;
  b.innerHTML = `
    <button class="ai-ob-back">${icon('chevron-left', { size: 16 })}<span>Volver</span></button>
    <h2>${deck.cards.length} tarjetas</h2>
    <p class="ai-ob-sub">Revisa y edita antes de exportar. Mazo en Anki: <b>${escapeHtml(deck.name)}</b></p>
    <div class="fc-list">${deck.cards.map(cardRow).join('')}</div>
    <div class="fc-export">
      <button id="fc-apkg" class="primary-btn">${icon('download', { size: 16 })} Exportar .apkg</button>
      <button id="fc-txt" class="ai-ob-back fc-txt-btn" title="Formato de texto que Anki importa (Archivo → Importar)">.txt para Anki</button>
    </div>
    <div id="fc-error" class="fc-error" style="display:none"></div>`;
  b.querySelector('.ai-ob-back').addEventListener('click', renderSetup);

  // Ediciones y borrados: se aplican al mazo en memoria y se persisten (re-export fiel).
  // Tras mapear, se renumeran los data-i para que sigan casando con el array nuevo.
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
    const del = e.target.closest('.fc-del');
    if (!del) return;
    del.closest('.fc-item').remove();
    syncFromDom();
    const h2 = b.querySelector('h2');
    if (h2) h2.textContent = `${deck.cards.length} tarjetas`;
  });
  b.querySelector('.fc-list').addEventListener('focusout', syncFromDom);

  const fileBase = () => {
    const slug = (s) => (s || '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'libro';
    return `${slug(ctx.bookTitle)}-flashcards-${new Date().toISOString().slice(0, 10)}`;
  };
  const exporting = async (btn, fn) => {
    syncFromDom();
    deck.cards = deck.cards.filter(c => c.front);
    if (!deck.cards.length) { showError('No queda ninguna tarjeta que exportar.'); return; }
    btn.disabled = true;
    try { await fn(); showError(''); }
    catch (e) { console.error('Export de flashcards falló:', e); showError('No se pudo exportar: ' + e.message); }
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
