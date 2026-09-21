// P29 · Infografía del libro. El agente recorre el LIBRO ENTERO (mismo troceado y techo de
// llamadas que el mapa mental), extrae ideas con su ancla y las compone en una plantilla FIJA:
// tesis, ideas numeradas, cadena del argumento, comparativa, filas, cierre y cita.
//
// NO es una imagen generada: el modelo solo decide QUÉ dice cada bloque (un JSON que se valida
// y se RECORTA), y la plantilla decide DÓNDE va (`infographic-render.js`, geometría pura). El
// recorte no es cosmético — es lo que impide que el póster deje de ser legible (ver el riesgo
// declarado del contrato en BACKLOG.md § P29).
//
// El artefacto se guarda como cualquier otro (Jobs + IndexedDB) con `kind: 'infographic'`, así
// que el Studio lo lista, lo reabre y lo borra sin saber que existe.

import { t } from '../i18n.js';
import * as LLM from './llm.js';
import * as Jobs from './jobs.js';
import { buildChunks } from './flashcards.js';
import { bookScopePassages } from './summary.js';
import { renderSvg, ACCENTS, POSTER } from './infographic-render.js';
import { posterFaceCss } from '../ui/svg-fonts.js';
import { icon } from '../ui/icons.js';
import { escapeHtml } from '../ui/escape.js';
import { getBook } from '../library/store.js';

const KIND = 'infographic';
const BOOK_TOKENS = 30000; // cobertura de libro entero (igual que el mapa)
const MAX_MAP_CALLS = 3; // techo de llamadas del barrido: la paciencia tiene un límite

// Techos del esquema. Son GATES, no estética: a un modelo al que se le piden «ideas clave» le
// salen veinte, y veinte ideas convierten el póster en un muro.
export const LIMITS = {
  ideas: 8,
  panels: 3,
  panelItems: 4,
  aside: 2,
  thesis: 320,
  head: 60,
  body: 240,
  quote: 170,
  attribution: 90,
};

// Iconos por posición (el modelo no conoce nuestro set). Determinista: misma ranura, mismo
// icono. Evita además el problema de la v1 del prototipo, donde `chart` salía cuatro veces.
const IDEA_ICONS = ['target', 'chart', 'user', 'note', 'undo', 'warning', 'books', 'sparkles'];
const STEP_ICONS = ['sparkles', 'chart', 'columns', 'target', 'books', 'gear', 'check', 'undo'];
const COL_ICONS = ['columns', 'chart', 'books', 'undo', 'target', 'note', 'gear', 'warning'];

let ctx = null; // { bookId, bookTitle, bookAuthor, goal, ensureIndex, anchors, mode, viewArtifact }
let overlay = null;
let runUnsub = null;
let zoom = null; // null = ajustar; 1 = 1:1

// ---- Ciclo de vida del modal -------------------------------------------------

export function open(context) {
  ctx = context || {};
  closeModal();
  overlay = document.createElement('div');
  overlay.id = 'ai-infographic';
  overlay.className = 'ai-onboarding';
  overlay.innerHTML = `
    <div class="ai-ob-card ig-card" role="dialog" aria-modal="true" aria-label="${t('Infografía del libro')}">
      <button class="ai-ob-close" title="${t('Cerrar')}" aria-label="${t('Cerrar')}">${icon('xmark', { size: 18 })}</button>
      <div class="ai-ob-body"></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeModal();
  });
  overlay.querySelector('.ai-ob-close').addEventListener('click', () => closeModal());
  document.addEventListener('keydown', onKey);

  // Abrir desde el historial salta el setup; generar nuevo (o sin artefacto) enseña el setup.
  if (ctx.viewArtifact) renderResult(ctx.viewArtifact.result);
  else route();
}

function onKey(e) {
  if (e.key === 'Escape' && overlay) closeModal();
}

function route() {
  const entry = ctx.mode === 'setup' ? null : Jobs.cached(ctx.bookId, KIND);
  if (entry && !ctx.mode) renderResult(entry.result);
  else renderSetup();
}

function closeModal() {
  if (runUnsub) {
    runUnsub();
    runUnsub = null;
  }
  if (overlay) overlay.remove();
  overlay = null;
}

function body() {
  return overlay?.querySelector('.ai-ob-body');
}

function setWide(on) {
  overlay?.querySelector('.ig-card')?.classList.toggle('ig-card--wide', !!on);
}

// ---- Vista 1: setup ----------------------------------------------------------

function renderSetup() {
  const b = body();
  if (!b) return;
  setWide(false);
  b.innerHTML = `
    <h2>${t('Infografía del libro')}</h2>
    <p class="ai-ob-lead">${t('El agente recorre el libro entero y compone un póster: la tesis, las ideas clave, los bloques que se repiten y una cita para cerrar.')}</p>
    <p class="sum-depth-hint">${icon('info', { size: 14 })} ${t('Se genera en segundo plano; puedes seguir leyendo. El póster se lee con zoom y se descarga en PNG o SVG.')}</p>
    <button id="ig-generate" class="primary-btn ai-ob-start">${icon('sparkles', { size: 16 })} ${t('Generar infografía')}</button>
    <div id="ig-error" class="fc-error" style="display:none"></div>`;
  b.querySelector('#ig-generate').addEventListener('click', onGenerate);
}

function showError(msg) {
  const el = body()?.querySelector('#ig-error');
  if (!el) return;
  el.style.display = msg ? '' : 'none';
  el.textContent = msg;
}

function onGenerate() {
  if (!LLM.hasKey()) {
    showError(t('Configura tu API key en Ajustes → Agente para generar la infografía.'));
    return;
  }
  ctx.ensureIndex?.();
  const passages = bookScopePassages(ctx.ensureIndex, BOOK_TOKENS);
  if (!passages.length) {
    showError(t('El libro no tiene texto indexado todavía.'));
    return;
  }
  // Tope de llamadas: si el muestreo da más trozos que el presupuesto, se reparten los pasajes
  // hacia atrás (el barrido cubre el principio del libro y corta; mejor eso que disparar 8
  // llamadas de 90 s y perder al lector por el camino — lección de P14 F2).
  const chunks = buildChunks(passages).slice(0, MAX_MAP_CALLS);
  const goal = ctx.goal || '';
  const scopeName = ctx.bookTitle || t('Libro');
  showError('');
  Jobs.start({
    bookId: ctx.bookId,
    kind: KIND,
    label: t('la infografía'),
    params: { scopeName },
    run: ({ signal, progress, background }) =>
      runInfographic({ chunks, goal, scopeName, signal, progress, background }),
  });
  renderRunning(Jobs.activeJob());
}

// ---- Vista 2: en curso -------------------------------------------------------

function renderRunning(job) {
  const b = body();
  if (!b || !job) {
    renderSetup();
    return;
  }
  setWide(false);
  b.innerHTML = `
    <h2>${t('Generando la infografía…')}</h2>
    <p class="ai-run-status" id="ig-run-status" role="status"></p>
    <div class="ai-run-actions">
      <button id="ig-keep" class="primary-btn">${icon('book', { size: 16 })} ${t('Seguir leyendo')}</button>
      <button id="ig-cancel" class="ai-ob-back fc-txt-btn">${t('Cancelar')}</button>
    </div>
    <p class="sum-depth-hint">${t('Puedes cerrar esta ventana: te avisaremos cuando el póster esté listo.')}</p>`;
  const status = b.querySelector('#ig-run-status');
  const paint = (j) => {
    if (!overlay) return;
    if (!j || j.status === 'cancelled') {
      if (runUnsub) {
        runUnsub();
        runUnsub = null;
      }
      renderSetup();
      return;
    }
    if (j.kind !== KIND) return;
    if (j.status === 'running') {
      status.textContent =
        j.progress.phase === 'compose'
          ? t('Componiendo el póster…')
          : t('Leyendo el libro… {i}/{n}', { i: j.progress.i, n: j.progress.n || '·' });
    } else if (j.status === 'done') {
      if (runUnsub) {
        runUnsub();
        runUnsub = null;
      }
      const c = Jobs.cached(ctx.bookId, KIND);
      renderResult(c ? c.result : j.result);
    } else if (j.status === 'error') {
      if (runUnsub) {
        runUnsub();
        runUnsub = null;
      }
      renderSetup();
      showError(j.error?.message || t('No se pudo generar la infografía.'));
    }
  };
  b.querySelector('#ig-keep').addEventListener('click', () => closeModal());
  b.querySelector('#ig-cancel').addEventListener('click', () => Jobs.cancel());
  if (runUnsub) runUnsub();
  runUnsub = Jobs.subscribe(paint);
}

// ---- Generación (map-reduce) -------------------------------------------------

// Regla de idioma anclada al OBJETIVO del lector (o al de la UI), no al de los pasajes: en un
// libro en inglés, un póster en español no sirve de nada. Mismo criterio que el resumen.
function langRule(goal) {
  return goal
    ? `- Escribe SIEMPRE en el mismo idioma que este objetivo del lector: «${goal}» (aunque los pasajes estén en otro idioma).`
    : `- Escribe SIEMPRE en el idioma de la interfaz del lector (aunque los pasajes estén en otro idioma).`;
}

function ideasPrompt(goal) {
  return `Eres un lector experto. De estos PASAJES DE UN LIBRO, extrae ideas clave candidatas.
REGLAS:
- Devuelve entre 6 y 12 líneas, cada una con este formato exacto:
  - **Rótulo corto (2-5 palabras)**: una frase concreta de una o dos líneas. [[aN]]
- El marcador [[aN]] es el id que precede al pasaje del que sale la idea (está entre dobles
  corchetes antes de cada pasaje). Debe ser un pasaje que CONTENGA la afirmación.
- Nada de "según el texto" ni relleno. Nada de repetir la misma idea con otras palabras.
${langRule(goal)}${goal ? `\n- Prioriza lo relevante para: «${goal}».` : ''}
Responde SOLO con las líneas.`;
}

function composePrompt(goal, scopeName) {
  return `Eres un diseñador editorial. Con estas IDEAS CLAVE (ya extraídas de «${scopeName}», con su
ancla [[aN]]), compón una INFOGRAFÍA en JSON. Es un póster para leer de un vistazo, no un resumen.

Devuelve SOLO un objeto JSON con esta forma exacta:
{
  "kicker": "una línea de encuadre del libro (máx. 60 caracteres)",
  "thesis": "la tesis del libro en 2-3 frases",
  "ideasTitle": "Ideas clave",
  "ideas": [ { "head": "rótulo de 2-5 palabras", "body": "una o dos frases", "src": "aN" } ],
  "panels": [
    { "kind": "flow", "title": "el argumento paso a paso", "items": [ { "head": "paso", "body": "en una línea" } ] },
    { "kind": "cols", "title": "bloques o tipos que se comparan", "items": [ { "head": "nombre", "sub": "etiqueta corta", "body": "una frase" } ] },
    { "kind": "rows", "title": "consejos o niveles", "items": [ { "tag": "etiqueta", "body": "una frase" } ] }
  ],
  "aside": [ { "label": "Recuerda", "body": "un aviso o límite del libro" }, { "label": "Idea final", "body": "el cierre" } ],
  "quote": { "text": "una sola línea que resuma la tesis", "attribution": "de dónde sale esa frase" }
}

LÍMITES (respétalos; si no caben, prioriza):
- ideas: máximo ${LIMITS.ideas}, cada una con su "src" (el ancla del pasaje). Deduplica.
- panels: exactamente 3, uno de cada kind ("flow" con 3-4 pasos; "cols" con 3-4 columnas; "rows" con 3-5 filas).
- aside: exactamente 2.
- Los rótulos son CORTOS (máx. ${LIMITS.head} caracteres) y los cuerpos de UNA frase: esto se lee
  en un póster, no es un artículo.
NO inventes nada que no esté en las ideas; no repitas la misma idea en dos bloques.
${langRule(goal)}${goal ? `\n- Enfoca el póster en: «${goal}».` : ''}
Responde SOLO el JSON, sin markdown ni texto alrededor.`;
}

async function runInfographic({ chunks, goal, scopeName, signal, progress, background = false }) {
  // 1) Barrido: ideas candidatas con su ancla.
  const candidates = [];
  for (let i = 0; i < chunks.length; i++) {
    const raw = await LLM.chatStream({
      messages: [
        { role: 'system', content: ideasPrompt(goal) },
        { role: 'user', content: `PASAJES:\n\n${chunks[i].text}` },
      ],
      maxTokens: 1400,
      signal,
      background,
    });
    for (const line of String(raw || '').split('\n')) {
      const m = line.trim().match(/^[-*]\s+(.+)/);
      if (m) candidates.push(m[1].trim());
    }
    progress(i + 1, chunks.length, 'map');
  }
  if (!candidates.length) throw new Error(t('El modelo no devolvió ideas. Vuelve a intentarlo.'));

  // 2) Composición: las ideas → el JSON del póster.
  progress(chunks.length, chunks.length, 'compose');
  const raw = await LLM.chatStream({
    messages: [
      { role: 'system', content: composePrompt(goal, scopeName) },
      { role: 'user', content: `IDEAS CLAVE:\n\n${candidates.join('\n')}` },
    ],
    maxTokens: 2600,
    signal,
    background,
  });
  const out = normalize(raw);
  if (!out.ideas.length && !out.panels.length) {
    throw new Error(t('El modelo no devolvió una infografía válida. Vuelve a intentarlo.'));
  }
  out.accent = await pickAccent(ctx.bookId);
  return out;
}

// ---- Normalización (pura, testeable) -----------------------------------------

function str(v) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

function clamp(s, max) {
  s = str(s);
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s.,;:]+$/, '')}…`;
}

// El modelo a veces envuelve el JSON en ```json ... ``` o añade una frase antes. Se busca el
// primer objeto balanceado en vez de fiarse de `JSON.parse` a la primera.
export function parseJson(raw) {
  let s = String(raw || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// Recorta y da forma al JSON del modelo. Devuelve el contenido del póster (sin portada ni
// título: eso lo pone la app, que es quien los tiene). `invalid` cuenta las anclas que no
// existen en el libro — es la señal que mide el contrato de P29, aunque el póster no las pinte.
export function normalize(raw, anchors = null) {
  const o = typeof raw === 'string' ? parseJson(raw) : raw || {};
  const list = (v) => (Array.isArray(v) ? v : []);
  const invalid = { count: 0 };

  const takeSrc = (src) => {
    const s = str(src).replace(/^\[\[|\]\]$/g, '');
    if (!s) return '';
    if (anchors && !anchors.has(s)) {
      invalid.count++;
      return '';
    }
    return s;
  };

  const ideas = list(o.ideas)
    .map((it, i) => ({
      ico: IDEA_ICONS[i % IDEA_ICONS.length],
      head: clamp(it && (it.head || it.title), LIMITS.head),
      body: clamp(it && (it.body || it.text), LIMITS.body),
      src: takeSrc(it && it.src),
    }))
    .filter((it) => it.head && it.body)
    .slice(0, LIMITS.ideas);

  const kindOf = (k) => (['flow', 'cols', 'rows'].includes(k) ? k : null);
  const panels = list(o.panels)
    .map((p) => {
      const kind = kindOf(p && p.kind);
      if (!kind) return null;
      const icons = kind === 'flow' ? STEP_ICONS : kind === 'rows' ? null : COL_ICONS;
      const items = list(p.items)
        .map((it, i) => {
          const base = { src: takeSrc(it && it.src) };
          if (kind === 'rows') return { tag: clamp(it && (it.tag || it.head), 40), body: clamp(it && it.body, LIMITS.body), ...base };
          return {
            ico: icons[i % icons.length],
            head: clamp(it && (it.head || it.title), LIMITS.head),
            sub: clamp(it && it.sub, 40),
            body: clamp(it && it.body, LIMITS.body),
            ...base,
          };
        })
        .filter((it) => (kind === 'rows' ? it.tag && it.body : it.head && it.body))
        .slice(0, LIMITS.panelItems);
      if (!items.length) return null;
      return { kind, title: clamp(p && p.title, LIMITS.head), items };
    })
    .filter(Boolean)
    .slice(0, LIMITS.panels);

  const aside = list(o.aside)
    .map((a, i) => ({
      ico: i === 0 ? 'note' : 'target',
      label: clamp(a && (a.label || a.head), 40),
      body: clamp(a && a.body, LIMITS.body),
    }))
    .filter((a) => a.label && a.body)
    .slice(0, LIMITS.aside);

  const quote = o.quote || {};
  return {
    kicker: clamp(o.kicker, 70),
    thesis: clamp(o.thesis, LIMITS.thesis),
    ideasTitle: clamp(o.ideasTitle, 40) || t('Ideas clave'),
    ideas,
    panels,
    aside,
    quote: {
      text: clamp(quote.text, LIMITS.quote),
      attribution: clamp(quote.attribution, LIMITS.attribution),
    },
    invalid,
  };
}

// ---- Acento y portada --------------------------------------------------------

// El acento sale de la PORTADA del libro (no lo elige el modelo) y se ajusta a la paleta con
// AA garantizado. Sin portada, el verde de marca. Misma idea que las ramas del mapa.
export async function pickAccent(bookId, palette = ACCENTS) {
  const book = await getBook(bookId).catch(() => null);
  const cover = book && book.cover;
  if (!cover) return palette[0];
  try {
    const rgb = await dominantColor(cover);
    if (!rgb) return palette[0];
    let best = palette[0];
    let bestD = Infinity;
    for (const hex of palette) {
      const d = dist2(rgb, hexToRgb(hex));
      if (d < bestD) {
        bestD = d;
        best = hex;
      }
    }
    return best;
  } catch {
    return palette[0];
  }
}

function hexToRgb(hex) {
  const c = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16));
}

function dist2(a, b) {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

// Color dominante de una imagen como [r,g,b]. Descarta grises (portadas en blanco y negro dan
// un póster apagado: mejor caer al verde de marca) y promedia los píxeles con saturación.
function dominantColor(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const n = 24;
      const cv = document.createElement('canvas');
      cv.width = n;
      cv.height = n;
      const g = cv.getContext('2d');
      g.drawImage(img, 0, 0, n, n);
      const d = g.getImageData(0, 0, n, n).data;
      let r = 0,
        gg = 0,
        b = 0,
        k = 0;
      for (let i = 0; i < d.length; i += 4) {
        const mx = Math.max(d[i], d[i + 1], d[i + 2]);
        const mn = Math.min(d[i], d[i + 1], d[i + 2]);
        if (mx === 0) continue;
        const sat = (mx - mn) / mx; // 0 = gris, 1 = saturado
        if (sat < 0.2 || mx < 40) continue;
        r += d[i];
        gg += d[i + 1];
        b += d[i + 2];
        k++;
      }
      resolve(k ? [r / k, gg / k, b / k] : null);
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function imageAspect(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth / img.naturalHeight || 2 / 3);
    img.onerror = () => resolve(2 / 3);
    img.src = src;
  });
}

async function coverFor(bookId, bookTitle, bookAuthor) {
  const book = await getBook(bookId).catch(() => null);
  if (!book || !book.cover) return {};
  return { cover: book.cover, coverAspect: await imageAspect(book.cover) };
}

// ---- Vista 3: resultado ------------------------------------------------------

async function renderResult(data) {
  const b = body();
  if (!b) return;
  Jobs.clearActive();
  setWide(true);
  zoom = null;
  b.innerHTML = `
    <div class="sum-resulthead">
      <button class="ai-ob-back">${icon('chevron-left', { size: 16 })}<span>${t('Volver')}</span></button>
      <button id="ig-regen" class="fc-txt-btn">${icon('sparkles', { size: 14 })} ${t('Regenerar')}</button>
    </div>
    <h2>${t('Infografía')} — ${escapeHtml(ctx.bookTitle || t('Libro'))}</h2>
    <div class="ig-bar" role="group" aria-label="${t('Zoom del póster')}">
      <button id="ig-out" aria-label="${t('Alejar')}" title="${t('Alejar')}">−</button>
      <button id="ig-fit" aria-label="${t('Ajustar')}" title="${t('Ajustar')}">${icon('target', { size: 14 })}</button>
      <button id="ig-100" aria-label="${t('Tamaño real')}" title="${t('Tamaño real')}">1:1</button>
      <button id="ig-in" aria-label="${t('Acercar')}" title="${t('Acercar')}">+</button>
      <span class="ig-hint">${t('Arrastra para mover')}</span>
    </div>
    <div class="ig-stage" id="ig-stage">
      <div class="ig-canvas" id="ig-canvas"></div>
    </div>
    <p class="sum-depth-hint">${t('A tamaño real el texto se lee; a tamaño de feed, no. Es un póster para leer con zoom o imprimir.')}</p>
    <div class="fc-export">
      <button id="ig-png" class="primary-btn">${icon('download', { size: 16 })} ${t('Descargar PNG')}</button>
      <button id="ig-svg" class="ai-ob-back fc-txt-btn">SVG</button>
      <button id="ig-share" class="ai-ob-back fc-txt-btn" style="display:none">${icon('share', { size: 14 })} ${t('Compartir')}</button>
    </div>
    <div id="ig-export-error" class="fc-error" style="display:none"></div>`;
  b.querySelector('.ai-ob-back').addEventListener('click', renderSetup);
  b.querySelector('#ig-regen').addEventListener('click', renderSetup);

  await document.fonts.ready;
  const cover = await coverFor(ctx.bookId, ctx.bookTitle, ctx.bookAuthor);
  const payload = {
    ...data,
    ...cover,
    title: ctx.bookTitle || t('Libro'),
    author: ctx.bookAuthor || '',
    footer: { mark: 'BookReader', url: location.hostname },
    accent: data.accent || POSTER.accent,
  };
  if (!body()?.querySelector('#ig-canvas')) return; // se cerró mientras cargaba

  const fontCss = await posterFaceCss();
  const { svg, width, height } = renderSvg(payload, { fontCss, title: t('Infografía de {scope}', { scope: ctx.bookTitle || '' }) });
  const canvas = body().querySelector('#ig-canvas');
  canvas.replaceChildren(svg);
  paintZoom(width, height);

  body().querySelector('#ig-out').addEventListener('click', () => setZoom(curZoom(width) / 1.3, width));
  body().querySelector('#ig-fit').addEventListener('click', () => setZoom(null, width));
  body().querySelector('#ig-100').addEventListener('click', () => setZoom(1, width));
  body().querySelector('#ig-in').addEventListener('click', () => setZoom(curZoom(width) * 1.3, width));
  wirePan();

  const name = (ext) => `bookreader-infografia-${slug(ctx.bookTitle || 'libro')}.${ext}`;
  body().querySelector('#ig-svg').addEventListener('click', () => {
    download(name('svg'), new XMLSerializer().serializeToString(canvas.querySelector('svg')), 'image/svg+xml');
  });
  body().querySelector('#ig-png').addEventListener('click', async () => {
    try {
      download(name('png'), await rasterize(canvas.querySelector('svg'), width, height));
    } catch (err) {
      console.warn('PNG de la infografía falló:', err);
      exportError(t('No se pudo generar la imagen.'));
    }
  });
  const shareBtn = body().querySelector('#ig-share');
  if (navigator.canShare?.({ files: [new File([new Blob()], 'x.png', { type: 'image/png' })] })) {
    shareBtn.style.display = '';
    shareBtn.addEventListener('click', async () => {
      try {
        await navigator.share({ files: [new File([await rasterize(canvas.querySelector('svg'), width, height)], name('png'), { type: 'image/png' })] });
      } catch (err) {
        if (err?.name === 'AbortError') return;
        exportError(t('No se pudo compartir la imagen.'));
      }
    });
  }
}

// ---- Zoom y arrastre ---------------------------------------------------------

function curZoom(width) {
  const stage = body()?.querySelector('#ig-stage');
  if (!stage) return 1;
  return zoom === null ? (stage.clientWidth - 2) / width : zoom;
}

function setZoom(z, width) {
  zoom = z === null ? null : Math.min(3, Math.max(0.25, z));
  const svg = body()?.querySelector('#ig-canvas svg');
  if (svg) {
    svg.style.maxWidth = 'none'; // el render pone `max-width:100%`; aquí manda el zoom
    svg.style.width = `${Math.round(width * curZoom(width))}px`;
    svg.style.height = 'auto';
  }
}

function paintZoom(width, height) {
  const svg = body()?.querySelector('#ig-canvas svg');
  if (svg) {
    svg.setAttribute('height', height);
    setZoom(zoom, width);
  }
}

function wirePan() {
  const stage = body()?.querySelector('#ig-stage');
  if (!stage) return;
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, l: stage.scrollLeft, t: stage.scrollTop };
    stage.classList.add('dragging');
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    stage.scrollLeft = drag.l - (e.clientX - drag.x);
    stage.scrollTop = drag.t - (e.clientY - drag.y);
  });
  const end = () => {
    drag = null;
    stage.classList.remove('dragging');
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}

function exportError(msg) {
  const el = body()?.querySelector('#ig-export-error');
  if (!el) return;
  el.style.display = msg ? '' : 'none';
  el.textContent = msg;
}

// ---- Export ------------------------------------------------------------------

function slug(s) {
  return (s || 'libro').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 50).toLowerCase();
}

async function rasterize(svg, width, height) {
  const xml = new XMLSerializer().serializeToString(svg);
  const bytes = new TextEncoder().encode(xml);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const img = new Image();
  img.src = `data:image/svg+xml;base64,${btoa(bin)}`;
  await img.decode();
  const scale = Math.min(2, Math.max(1, 4200 / Math.max(width, height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((res, rej) => canvas.toBlob((bl) => (bl ? res(bl) : rej(new Error('toBlob null'))), 'image/png'));
}

function download(filename, data, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
