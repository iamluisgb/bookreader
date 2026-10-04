// Diagramas del agente: bloques ```mermaid → SVG, con Mermaid (MIT, vendorizado en `vendor/`).
//
// POR QUÉ. El agente tenía PROHIBIDO dibujar (los diagramas en ASCII se veían crudos) y no
// tenía alternativa: ante «explícamelo con un diagrama» se disculpaba y daba una lista. Igual
// que una tabla es texto Markdown que la app pinta, un diagrama es texto Mermaid que la app
// pinta. Los modelos escriben Mermaid con soltura (también DeepSeek), sin enseñarles nada.
//
// SOLO TRES TIPOS: `sequenceDiagram` (procesos entre actores), `flowchart`/`graph` (flujos,
// decisiones, jerarquías) y `timeline`. Son los que se leen en un móvil; el resto sale ancho
// o enrevesado. Y son los únicos cuyos módulos se vendorizan: Mermaid son 24 MB en npm, pero
// la build ESM baja cada tipo por separado y para estos tres bastan ~1 MB (~300 KB gzip).
// `layout: 'dagre'` es obligatorio: sin él Mermaid 12 baja ELK, otros 1,6 MB.
//
// CARGA PEREZOSA, como las fórmulas (math.js): `mdToHtml` es síncrono y deja un marcador; la
// librería se baja la primera vez que aparece un diagrama de verdad.
//
// DEGRADACIÓN: si Mermaid no carga, el tipo no está permitido o la sintaxis está mal, el
// marcador se queda con el CÓDIGO visible (el bloque de código de siempre). Nunca una
// respuesta rota ni vacía.

import { icon } from '../ui/icons.js';
import { t } from '../i18n.js';
const SRC = '../../vendor/mermaid-12.1.0/mermaid.esm.min.mjs';
export const ALLOWED = /^\s*(sequenceDiagram|flowchart|graph|timeline)\b/;

let loading = null;
let scheduled = false;
let seq = 0;
// SVG ya pintado por (tema + código). En streaming el Markdown se re-renderiza en cada trozo:
// sin caché, el diagrama se volvería a maquetar (y a parpadear) decenas de veces.
const cache = new Map();

function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// El código viaja en HEXADECIMAL y no en claro ni en base64: render.js convierte cualquier
// `aN` suelto del HTML en un chip de cita, y un `a12` dentro del atributo rompería el marcado
// (base64 lleva `+` y `/`, que crean límites de palabra; el hex es una sola «palabra»).
function toHex(s) {
  return [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// El código Mermaid de un diagrama pintado (sin las citas, que van como chips debajo).
export function diagramCode(figure) {
  return fromHex(figure?.dataset?.src || '');
}

function fromHex(h) {
  const bytes = new Uint8Array((h.match(/../g) || []).map((x) => parseInt(x, 16)));
  return new TextDecoder().decode(bytes);
}

// Las citas `[[aN]]` NO pueden ir dentro del diagrama: `A[[texto]]` es sintaxis de Mermaid
// (forma de subrutina) y además un nodo no es un chip clicable. Se sacan del código y se
// pintan como chips debajo, con los mismos nombres que las del texto.
export function splitCites(code) {
  const cites = [];
  const clean = String(code).replace(/\s*\[\[(a\d+)\]\]/g, (m, id) => {
    if (!cites.includes(id)) cites.push(id);
    return '';
  });
  return { clean, cites };
}

// Marcador que deja markdown.js. Visible por defecto: el código, que es el fallback.
export function diagramPlaceholder(code) {
  const { clean, cites } = splitCites(code.replace(/\n+$/, ''));
  const chips = cites.length ? `<p class="ai-diagram-cites">${cites.map((id) => `[[${id}]]`).join(' ')}</p>` : '';
  return `<figure class="ai-diagram" data-src="${toHex(clean)}"><pre class="ai-code"><code>${escapeText(clean)}</code></pre></figure>${chips}`;
}

export function scheduleHydrate() {
  if (scheduled || typeof requestAnimationFrame !== 'function') return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; hydrateDiagrams(); });
}

function loadMermaid() {
  if (loading) return loading;
  // Módulo ES de mismo origen: pasa la CSP `script-src 'self'`.
  loading = import(SRC).then((m) => m.default).catch((e) => { loading = null; throw e; });
  return loading;
}

// Colores del TEMA ACTIVO, leídos de los tokens (themes.css). Mermaid necesita colores
// sólidos (los mezcla con khroma): nada de var() ni rgba().
function themeVars() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n, fb) => (cs.getPropertyValue(n) || '').trim() || fb;
  const surface = v('--surface-1', '#ffffff'), card = v('--surface-2', '#ffffff');
  const raised = v('--surface-3', '#f0f0f2'), text = v('--text', '#1d1d1f');
  const soft = v('--text-soft', '#5f5f64'), border = v('--border', '#e5e5ea');
  const font = v('--font-ui', 'system-ui, sans-serif');
  const dark = (cs.getPropertyValue('color-scheme') || '').includes('dark') ||
    document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme && matchMedia?.('(prefers-color-scheme: dark)').matches);
  return {
    key: [surface, card, raised, text, soft, border].join('|'),
    vars: {
      darkMode: !!dark, fontFamily: font, fontSize: '15px',
      background: surface, mainBkg: card, primaryColor: card, primaryTextColor: text,
      primaryBorderColor: border, secondaryColor: raised, tertiaryColor: surface,
      lineColor: soft, textColor: text, nodeTextColor: text, titleColor: text,
      edgeLabelBackground: surface, clusterBkg: raised, clusterBorder: border,
      actorBkg: card, actorBorder: border, actorTextColor: text, actorLineColor: soft,
      signalColor: text, signalTextColor: text, labelBoxBkgColor: raised, labelBoxBorderColor: border,
      labelTextColor: text, loopTextColor: text, noteBkgColor: raised, noteBorderColor: border,
      noteTextColor: text, activationBkgColor: raised, activationBorderColor: border,
      sequenceNumberColor: surface, cScale0: card, cScale1: raised, cScale2: card,
    },
  };
}

let configuredKey = '';
function configure(mermaid, theme) {
  if (configuredKey === theme.key) return;
  configuredKey = theme.key;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',     // sin HTML en etiquetas, sin `click` que ejecute nada
    theme: 'base',
    themeVariables: theme.vars,
    layout: 'dagre',             // ¡no ELK! (ver cabecera)
    fontFamily: theme.vars.fontFamily,
    // Etiquetas como <text> de SVG, no HTML en <foreignObject>: con HTML, `A["<img src=…>"]`
    // dejaba una <img> real (DOMPurify le quita el onerror, no la imagen) y una URL externa
    // se pediría desde el navegador del lector. Además el SVG con texto puro es exportable.
    htmlLabels: false,
    // Compacto: con los márgenes por defecto, un diagrama de secuencia de 4 actores medía
    // ~960 px y en el móvil solo se veían dos. El ancho final lo decide fitWidth().
    flowchart: { useMaxWidth: false, htmlLabels: false, nodeSpacing: 28, rankSpacing: 34, padding: 10, diagramPadding: 6 },
    sequence: {
      useMaxWidth: false, mirrorActors: false, wrap: true,
      width: 104, height: 40, actorMargin: 22, boxMargin: 6, boxTextMargin: 4,
      noteMargin: 8, messageMargin: 26, diagramMarginX: 6, diagramMarginY: 6,
    },
    timeline: { useMaxWidth: false, padding: 6 },
  });
}

// Sustituye los marcadores por SVG. Idempotente: los ya hechos se marcan y se saltan.
export async function hydrateDiagrams(root = document) {
  const nodes = [...root.querySelectorAll('.ai-diagram:not([data-done])')];
  if (!nodes.length) return;
  const theme = themeVars();
  // Primero lo que ya está en caché, sin esperar a nada (streaming: cero parpadeo).
  const pending = [];
  for (const el of nodes) {
    const code = fromHex(el.dataset.src || '');
    if (!ALLOWED.test(code)) { el.dataset.done = 'skip'; continue; }
    const hit = cache.get(theme.key + '\n' + code);
    if (hit) paint(el, hit);
    else pending.push([el, code]);
  }
  if (!pending.length) return;
  let mermaid;
  try { mermaid = await loadMermaid(); } catch { return; }   // sin librería: se queda el código
  configure(mermaid, theme);
  for (const [el, code] of pending) {
    if (el.dataset.done) continue;
    try {
      const { svg } = await mermaid.render('ai-mmd-' + (++seq), code);
      cache.set(theme.key + '\n' + code, svg);
      paint(el, svg);
    } catch {
      el.dataset.done = 'error';                     // sintaxis rota: se queda el código
      // Mermaid deja un nodo de error suelto en <body> al fallar; fuera.
      document.getElementById('dai-mmd-' + seq)?.remove();
    }
  }
}

// Segunda red, por si una versión futura de Mermaid vuelve a emitir HTML: fuera todo lo que
// pueda pedir algo de fuera o navegar (imágenes, enlaces, objetos incrustados).
function scrub(root) {
  root.querySelectorAll('img, image, a, iframe, object, embed, script, foreignObject img').forEach((n) => n.remove());
  root.querySelectorAll('*').forEach((n) => {
    for (const at of [...n.attributes]) {
      if (/^on/i.test(at.name) || /^(href|xlink:href|src)$/i.test(at.name) && !/^#/.test(at.value)) n.removeAttribute(at.name);
    }
  });
}

function paint(el, svg) {
  el.dataset.done = '1';
  el.innerHTML = svg;
  scrub(el);
  const s = el.querySelector('svg');
  if (s) { s.setAttribute('role', 'img'); fitWidth(s); }
  // En el chat, cada diagrama lleva sus acciones (las atiende panel.js por delegación). Fuera
  // del chat (resumen, Feynman, la propia libreta) no: ahí no hay a dónde mandarlo.
  // Compartir (imagen y Mermaid) vale en el chat y en la libreta; «A la libreta», solo en el chat.
  const inChat = !!el.closest('#ai-messages');
  if (inChat || el.closest('#ai-view-notebook')) {
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    el.insertAdjacentHTML('beforeend', `<div class="ai-diagram-actions">
      ${inChat ? `<button type="button" class="ai-act" data-dg-act="notebook">${icon('notebook', { size: 'md' })}<span>${t('A la libreta')}</span></button>` : ''}
      <button type="button" class="ai-act" data-dg-act="png">${icon(coarse ? 'share' : 'image', { size: 'md' })}<span>${coarse ? t('Compartir') : t('Copiar imagen')}</span></button>
      <button type="button" class="ai-act" data-dg-act="code">${icon('copy', { size: 'md' })}<span>${t('Copiar Mermaid')}</span></button>
    </div>`);
  }
}

// Encaja al ancho de la caja, pero sin bajar de MIN_SCALE (letra de ~10 px con la base de 15 px): si así no cabe,
// se queda en ese tamaño y la caja se desplaza en horizontal, como una tabla ancha. Solo CSS,
// así que se reajusta solo al girar el móvil o redimensionar el panel.
const MIN_SCALE = 0.66;
function fitWidth(s) {
  const vb = s.viewBox && s.viewBox.baseVal;
  const w = (vb && vb.width) || parseFloat(s.getAttribute('width')) || 0;
  s.removeAttribute('height');
  s.removeAttribute('width');
  if (!w) return;
  s.style.width = '100%';
  s.style.maxWidth = Math.ceil(w) + 'px';
  s.style.minWidth = Math.ceil(w * MIN_SCALE) + 'px';
}

// Cambiar de tema (claro/oscuro/sepia) repinta los diagramas con los nuevos colores.
if (typeof MutationObserver === 'function' && typeof document !== 'undefined') {
  new MutationObserver(() => {
    const done = document.querySelectorAll('.ai-diagram[data-done="1"]');
    if (!done.length) return;
    done.forEach((el) => { delete el.dataset.done; });
    hydrateDiagrams();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

// ---- Compartir un diagrama -------------------------------------------------------------
// «Copiar imagen» (escritorio: PNG al portapapeles, se pega en Notion, Slack, WhatsApp…) o
// «Compartir» (móvil: hoja del sistema), y «Copiar Mermaid» (el código, editable en Notion,
// Obsidian o GitHub, que lo dibujan solos).
//
// La imagen sale SIEMPRE en tema claro, aunque se lea en oscuro o sepia: en redes y en los
// apuntes de otros un diagrama oscuro queda fuera de sitio. A doble resolución, con margen y
// una firma discreta abajo («BookReader · título del libro»), como la tarjeta-cita.
const LIGHT = {
  key: 'share-light',
  vars: {
    darkMode: false, fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif', fontSize: '15px',
    background: '#ffffff', mainBkg: '#ffffff', primaryColor: '#ffffff', primaryTextColor: '#1d1d1f',
    primaryBorderColor: '#c9ccd2', secondaryColor: '#f2f4f7', tertiaryColor: '#ffffff',
    lineColor: '#5f5f64', textColor: '#1d1d1f', nodeTextColor: '#1d1d1f', titleColor: '#1d1d1f',
    edgeLabelBackground: '#ffffff', clusterBkg: '#f2f4f7', clusterBorder: '#c9ccd2',
    actorBkg: '#ffffff', actorBorder: '#c9ccd2', actorTextColor: '#1d1d1f', actorLineColor: '#5f5f64',
    signalColor: '#1d1d1f', signalTextColor: '#1d1d1f', labelBoxBkgColor: '#f2f4f7', labelBoxBorderColor: '#c9ccd2',
    labelTextColor: '#1d1d1f', loopTextColor: '#1d1d1f', noteBkgColor: '#f2f4f7', noteBorderColor: '#c9ccd2',
    noteTextColor: '#1d1d1f', activationBkgColor: '#f2f4f7', activationBorderColor: '#c9ccd2',
    sequenceNumberColor: '#ffffff', cScale0: '#ffffff', cScale1: '#f2f4f7', cScale2: '#ffffff',
  },
};
const SHARE_SCALE = 2;
const PAD = 48;
const FOOT = 56;

let shareTitle = '';
if (typeof window !== 'undefined') {
  window.addEventListener('book:meta', (e) => { shareTitle = e.detail?.title || ''; });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('img'));
    img.src = src;
  });
}

// SVG del diagrama en tema claro, con su tamaño natural.
async function lightSvg(code) {
  const mermaid = await loadMermaid();
  configure(mermaid, LIGHT);
  try {
    const { svg } = await mermaid.render('ai-mmd-share-' + (++seq), code);
    const box = document.createElement('div');
    box.innerHTML = svg;
    scrub(box);
    const s = box.querySelector('svg');
    const vb = s.viewBox.baseVal;
    const w = Math.ceil(vb?.width || parseFloat(s.getAttribute('width')) || 600);
    const h = Math.ceil(vb?.height || parseFloat(s.getAttribute('height')) || 400);
    s.setAttribute('width', w);
    s.setAttribute('height', h);
    s.removeAttribute('style');
    s.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    return { markup: new XMLSerializer().serializeToString(s), w, h };
  } finally {
    configuredKey = '';      // el siguiente diagrama del chat vuelve a los colores del tema
  }
}

const MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="118" fill="#111418"/>'
  + '<path d="M288 119 Q288 99 308 99 L396 99 Q416 99 416 119 L416 371 L352 323 L288 371 Z" fill="#22c55e"/>'
  + '<path d="M98 90 L222 90 Q256 90 256 124 L256 470 C 249 442 233 424 206 414 C 177 403 140 401 100 401 Q64 401 64 365 L64 124 Q64 90 98 90 Z" fill="#f8fafc"/></svg>';
const svgUrl = (markup) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);

export async function diagramPng(code, { title = shareTitle } = {}) {
  const { markup, w, h } = await lightSvg(code);
  const [img, mark] = await Promise.all([loadImage(svgUrl(markup)), loadImage(svgUrl(MARK))]);
  const W = Math.max(w + PAD * 2, 520), H = h + PAD * 2 + FOOT;
  const canvas = document.createElement('canvas');
  canvas.width = W * SHARE_SCALE; canvas.height = H * SHARE_SCALE;
  const ctx = canvas.getContext('2d');
  ctx.scale(SHARE_SCALE, SHARE_SCALE);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(img, Math.round((W - w) / 2), PAD, w, h);
  // Firma: logo + «BookReader · título», en gris, sobre una línea fina.
  const y = H - FOOT + 8;
  ctx.fillStyle = '#e6e8eb';
  ctx.fillRect(PAD, y - 8, W - PAD * 2, 1);
  ctx.drawImage(mark, PAD, y + 8, 20, 20);
  ctx.font = '600 14px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#1d1d1f';
  ctx.fillText('BookReader', PAD + 28, y + 18);
  let x = PAD + 28 + ctx.measureText('BookReader').width;
  if (title) {
    ctx.font = '400 14px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.fillStyle = '#6b6f76';
    const max = W - PAD - x - 12;
    let tt = ' · ' + title;
    while (tt.length > 4 && ctx.measureText(tt).width > max) tt = tt.slice(0, -2);
    if (tt !== ' · ' + title) tt = tt.trimEnd() + '…';
    ctx.fillText(tt, x, y + 18);
  }
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png'))), 'image/png'));
}

const touch = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

async function flash(btn, ico, label) {
  const prev = btn.innerHTML;
  btn.innerHTML = `${icon(ico, { size: 'md' })}<span>${label}</span>`;
  setTimeout(() => { if (btn.isConnected) btn.innerHTML = prev; }, 2000);
}

async function onShareClick(e) {
  const btn = e.target.closest('[data-dg-act="png"], [data-dg-act="code"]');
  if (!btn) return;
  const fig = btn.closest('.ai-diagram');
  const code = diagramCode(fig);
  if (!code) return;
  if (btn.dataset.dgAct === 'code') {
    try {
      await navigator.clipboard.writeText('```mermaid\n' + code.trim() + '\n```');
      flash(btn, 'check', t('Copiado'));
    } catch { flash(btn, 'warning', t('No se pudo copiar')); }
    return;
  }
  // Imagen. En móvil, hoja de compartir del sistema; en escritorio, al portapapeles (la
  // promesa va DENTRO del ClipboardItem: Safari exige crearlo en el mismo gesto).
  const png = diagramPng(code);
  if (touch()) {
    try {
      const { sharePng } = await import('../share-card.js');
      const how = await sharePng(await png, 'bookreader-diagrama.png');
      if (how === 'downloaded') flash(btn, 'check', t('Descargado'));
    } catch { flash(btn, 'warning', t('No se pudo generar la imagen')); }
    return;
  }
  try {
    if (!window.ClipboardItem || !navigator.clipboard?.write) throw new Error('sin portapapeles');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    flash(btn, 'check', t('Imagen copiada'));
  } catch {
    try {
      const { sharePng } = await import('../share-card.js');
      await sharePng(await png, 'bookreader-diagrama.png');      // sin portapapeles: descarga
      flash(btn, 'check', t('Descargado'));
    } catch { flash(btn, 'warning', t('No se pudo generar la imagen')); }
  }
}
if (typeof document !== 'undefined') document.addEventListener('click', onShareClick);
