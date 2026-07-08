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

// Presupuesto de pasajes al LLM: un capítulo cabe entero; el libro entero se muestrea
// por capítulos (cobertura uniforme) hasta este tope — coste por generación acotado.
const CHAPTER_TOKENS = 12000;
const BOOK_TOKENS = 40000;
const COUNTS = [10, 15, 20, 30];

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
      const due = Srs.dueCount(d.cards);
      return `
      <div class="fc-deck" data-id="${d.id}">
        <div class="fc-deck-info">
          <span class="fc-deck-name">${escapeHtml(d.scope || 'Libro entero')}</span>
          <span class="fc-deck-meta">${d.cards.length} tarjetas · ${d.cardType === 'cloze' ? 'cloze' : 'P→R'} · ${new Date(d.createdAt).toLocaleDateString()}</span>
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

// Pasajes del alcance elegido, con encabezados de capítulo y su marcador [[aN]]
// delante (P10 F2: la tarjeta guarda su ancla de origen → "ver en el libro" al
// repasar; cuesta ~5% de tokens). Libro entero: round-robin por capítulo para
// cubrirlo uniformemente (no solo el principio) hasta el presupuesto.
function gatherPassages(scopeLabel) {
  ctx.ensureIndex();
  let picked;
  if (scopeLabel) {
    picked = cap(Retrieval.passagesByChapter(scopeLabel), CHAPTER_TOKENS);
  } else {
    const byChapter = new Map();
    for (const p of Retrieval.allPassages()) {
      const k = p.chapter || '';
      if (!byChapter.has(k)) byChapter.set(k, []);
      byChapter.get(k).push(p);
    }
    const lists = [...byChapter.values()];
    picked = []; let used = 0, added = true;
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
    picked.sort((a, b) => Retrieval.anchorNum(a.id) - Retrieval.anchorNum(b.id));
  }
  const out = [];
  let curCh = null;
  for (const p of picked) {
    if (p.chapter && p.chapter !== curCh) { out.push(`\n## ${p.chapter}`); curCh = p.chapter; }
    out.push(`[[${p.id}]] ${p.text}`);
  }
  return out.join('\n').trim();
}

function cap(list, maxTokens) {
  const out = []; let used = 0;
  for (const p of list) { const t = estimateTokens(p.text) + 4; if (used + t > maxTokens) break; out.push(p); used += t; }
  return out;
}

function cardsPrompt(count, type, goal) {
  const shape = type === 'cloze'
    ? `- "front": una frase con el dato CLAVE oculto en sintaxis cloze de Anki: {{c1::texto oculto}}
  (máximo 2 huecos por tarjeta, {{c1::..}} y {{c2::..}}). Oculta términos/datos importantes, no palabras triviales.
- "back": aclaración o contexto extra, opcional (puede ser "").`
    : `- "front": una pregunta clara y AUTOCONTENIDA (se entiende sin tener el libro delante).
- "back": la respuesta, concisa (1-3 frases).`;
  return `Eres un experto en repetición espaciada creando flashcards de Anki de máxima calidad a partir de pasajes de un libro.

REGLAS DE CALIDAD (obligatorias):
- Atómicas: UNA idea o hecho por tarjeta.
- Autocontenidas: prohibido "según el texto", "en este capítulo" o "el autor" sin nombrarlo.
- Prioriza conceptos, definiciones, relaciones causa-efecto y datos concretos; evita trivialidades.
- Sin tarjetas duplicadas ni casi iguales.
- Escribe las tarjetas EN EL MISMO IDIOMA que los pasajes.${goal ? `
- Cuando sea posible, alinéalas al objetivo del lector: «${goal}».` : ''}

FORMATO (obligatorio): responde SOLO con un array JSON válido, sin markdown ni texto alrededor.
Cada tarjeta es {"front": "...", "back": "...", "chapter": "...", "src": "..."}:
${shape}
- "chapter": el encabezado ## del pasaje de origen, o "" si no lo hay.
- "src": el marcador [[aN]] del pasaje del que sale la tarjeta, solo el id (p. ej. "a42"), o "" si dudas.

Genera EXACTAMENTE ${count} tarjetas (menos SOLO si el material no da para más).`;
}

// Extrae el array JSON de la respuesta (tolerante a fences y texto alrededor).
export function parseCards(raw, type) {
  const text = String(raw || '').replace(/```(?:json)?/g, '');
  const start = text.indexOf('['), end = text.lastIndexOf(']');
  if (start === -1 || end <= start) throw new Error('La respuesta no contiene tarjetas (JSON no encontrado)');
  const arr = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error('La respuesta no es una lista de tarjetas');
  return arr
    .filter(c => c && typeof c.front === 'string' && c.front.trim())
    .map(c => {
      // src: acepta "a42" o "[[a42]]"; cualquier otra cosa se descarta (se valida después).
      const src = typeof c.src === 'string' ? (c.src.match(/^\[*\s*(a\d+)\s*\]*$/) || [])[1] || '' : '';
      return {
        type,
        front: c.front.trim(),
        back: typeof c.back === 'string' ? c.back.trim() : '',
        chapter: typeof c.chapter === 'string' ? c.chapter.trim() : '',
        src,
      };
    });
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

async function onGenerate() {
  if (generating) return;
  const b = body();
  if (!LLM.hasKey()) { showError('Configura tu API key en Ajustes → Agente para generar tarjetas.'); return; }
  const scopeLabel = scopeValue;
  const type = b.querySelector('input[name="fc-type"]:checked').value;
  const count = parseInt(b.querySelector('#fc-count').value, 10);

  const passages = gatherPassages(scopeLabel);
  if (!passages) { showError('Ese contenido no tiene texto indexado; prueba con otro capítulo o con el libro entero.'); return; }

  generating = true; abortCtrl = new AbortController();
  const btn = b.querySelector('#fc-generate');
  btn.disabled = true;
  btn.innerHTML = `<span class="ai-typing">Generando tarjetas…</span>`;
  showError('');
  try {
    let acc = '';
    const raw = await LLM.chatStream({
      messages: [
        { role: 'system', content: cardsPrompt(count, type, ctx.goal) },
        { role: 'user', content: 'PASAJES DEL LIBRO:\n\n' + passages },
      ],
      signal: abortCtrl.signal,
      onToken: (t) => {
        acc += t;
        const n = (acc.match(/"front"/g) || []).length;
        if (n && overlay) btn.innerHTML = `<span class="ai-typing">Generando… ${Math.min(n, count)}/${count}</span>`;
      },
    });
    if (!overlay) return;                       // el usuario cerró el modal: no seguir
    let cards = parseCards(raw || acc, type);
    if (!cards.length) throw new Error('El modelo no devolvió tarjetas válidas. Vuelve a intentarlo.');
    cards = attachSources(cards, {
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
