// P14 · Render del mapa mental: medida REAL del texto, árbol horizontal a dos lados y estilo
// Apple (P33). Separado de `mindmap.js` (que orquesta LLM/Jobs/modal) porque es geometría
// pura: sin red, sin IndexedDB, testeable sola.
//
// POR QUÉ SE DEJÓ EL LAYOUT RADIAL (P33):
// - La estrella dejaba casi todo el lienzo vacío: ramas a ~100 px del centro y hojas a
//   600–700 px, unidas por radios largos. Encajado en pantalla, el texto quedaba en ~11 px.
// - Las aristas de ramas contiguas se cruzaban cerca del centro, y el ángulo (no el libro)
//   decidía el orden de lectura.
// Ahora las ramas se reparten a izquierda y derecha y sus ideas se apilan en vertical al lado:
// se lee en horizontal, no hay cruces por construcción y el mapa ocupa lo que necesita.
//
// ESTILO APPLE: lienzo blanco, tarjetas blancas con borde fino y sombra suave para el centro y
// las ramas, colores de sistema SOLO en líneas y en el punto de cada rama, ideas como texto
// sobre su línea (sin caja) y la tipografía del sistema (SF en Apple; Inter en el resto).

const SVG_NS = 'http://www.w3.org/2000/svg';

// Colores de sistema de Apple, claro y oscuro (mismo orden). Van SOLO en líneas, puntos y
// aros: ningún texto se pinta en ellos ni sobre ellos (lo vigila un test).
export const PALETTE = ['#007AFF', '#34C759', '#FF9500', '#AF52DE', '#FF2D55', '#30B0C7', '#5856D6', '#A2845E'];
export const PALETTE_DARK = ['#0A84FF', '#30D158', '#FF9F0A', '#BF5AF2', '#FF375F', '#40C8E0', '#5E5CE6', '#AC8E68'];

// Tema claro (pantalla en claro/sepia y export). `leaf` es el relleno de las tarjetas.
export const POSTER = { bg: '#ffffff', ink: '#1d1d1f', muted: '#86868b', leaf: '#ffffff', line: '#e5e5ea' };

// SF en Mac/iPhone; en el resto cae a Inter (self-hosted en la app y embebida en el export).
export const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', Inter, system-ui, sans-serif";

// Métricas (px). Anchos MÁXIMOS en píxeles, no en caracteres.
const FS = 15, FS_SUB = 13.5, FS_ROOT = 20;
const LH = 20, LH_SUB = 18, LH_ROOT = 25;
const MAXW = { 0: 240, 1: 200, 2: 230, default: 190 };
const MAXLINES = 2;
const ROOT_PAD_X = 22, ROOT_PAD_Y = 18;
const CARD_PAD_X = 14, DOT = 10, CARD_H_MIN = 40;
const GAP_ROOT = 60;      // del borde del centro a la tarjeta de rama
const GAP_BRANCH = 46;    // de la rama a sus ideas (deja sitio al círculo de plegado)
const GAP_LEAF = 42;      // de una idea a sus sub-ideas (ídem)
const GAP_Y = { 1: 26, 2: 10, default: 6 };
const FOLD_R = 10, FOLD_OFF = 16;
const BADGE_W = 20, BADGE_H = 16;

// ---- Medida de texto -------------------------------------------------------------------

let mctx = null;
const mcache = new Map();

function measure(text, weight, size = FS) {
  const key = weight + '|' + size + '|' + text;
  const hit = mcache.get(key);
  if (hit !== undefined) return hit;
  if (!mctx) mctx = document.createElement('canvas').getContext('2d');
  mctx.font = `${weight} ${size}px ${FONT}`;
  const w = mctx.measureText(text).width;
  mcache.set(key, w);
  return w;
}

// Las métricas cambian cuando la fuente TERMINA de cargar (hasta entonces mide la de
// sistema). Quien renderice debe esperar a `document.fonts.ready` y vaciar la caché.
export function clearMeasureCache() { mcache.clear(); }

function ellipsize(word, maxW, weight, size) {
  let s = String(word);
  while (s.length > 1 && measure(s + '…', weight, size) > maxW) s = s.slice(0, -1);
  return s.length > 1 ? s + '…' : s;
}

// Parte una etiqueta en líneas que QUEPAN en `maxW` píxeles (no en N caracteres).
export function wrapLabel(text, maxW, maxLines = MAXLINES, weight = 400, size = FS) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [''];
  const lines = [];
  let cur = '';
  for (const raw of clean.split(' ')) {
    const word = measure(raw, weight, size) > maxW ? ellipsize(raw, maxW, weight, size) : raw;
    const cand = cur ? cur + ' ' + word : word;
    if (measure(cand, weight, size) <= maxW || !cur) cur = cand;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last.length > 1 && measure(last + '…', weight, size) > maxW) last = last.slice(0, -1);
  kept[maxLines - 1] = last.replace(/[\s…]+$/, '') + '…';
  return kept;
}

// Blanco o tinta oscura según la luminancia del fondo (WCAG). Red de seguridad: si alguien
// toca `PALETTE` y mete un tono claro, el texto se corrige solo en vez de volverse ilegible.
export function contrastInk(hex, dark = '#1f2328', light = '#ffffff') {
  const c = String(hex || '').replace('#', '');
  if (c.length < 6) return dark;
  const lin = [0, 2, 4].map(i => {
    const u = parseInt(c.slice(i, i + 2), 16) / 255;
    return u <= 0.03928 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);
  });
  const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return (1.05 / (L + 0.05)) >= ((L + 0.05) / 0.05) ? light : dark;
}

// ---- Layout ----------------------------------------------------------------------------

// Aplana el árbol en nodos con RUTA ESTABLE ("r", "r.0", "r.0.2"). La ruta es la identidad
// que usan el plegado (`collapsed`) y las acciones del popover: sobrevive a un re-render.
// Un nodo plegado se emite SIN hijos → pasa a ser hoja del árbol visible.
export function flatten(tree, collapsed = new Set()) {
  const list = [];
  const walk = (raw, depth, parentId, id, branch) => {
    const kids = Array.isArray(raw.children) ? raw.children : [];
    const folded = kids.length > 0 && collapsed.has(id);
    const node = {
      id, depth, parent: parentId, branch,
      label: String(raw.label ?? raw.title ?? '').trim(),
      full: String(raw.full || raw.label || raw.title || '').trim(),
      src: typeof raw.src === 'string' ? raw.src : '',
      childCount: kids.length,
      collapsed: folded,
      kids: [],
    };
    list.push(node);
    if (!folded) {
      kids.forEach((k, i) => {
        const kid = `${id}.${i}`;
        node.kids.push(kid);
        walk(k, depth + 1, id, kid, depth === 0 ? i : branch);
      });
    }
    return node;
  };
  walk({ label: tree.title, children: tree.branches || [] }, 0, null, 'r', -1);
  return list;
}

// Caja de cada nodo. `size` es la caja COMPLETA que ocupa (texto + indicador de cita), la que
// usa la anticolisión; `textW` es solo el texto, donde termina el subrayado.
function measureNode(n) {
  if (n.depth === 0) {
    n.lines = wrapLabel(n.label, MAXW[0], 3, 700, FS_ROOT);
    const w = Math.max(...n.lines.map(l => measure(l, 700, FS_ROOT)));
    n.size = { w: Math.max(120, w + ROOT_PAD_X * 2), h: n.lines.length * LH_ROOT + ROOT_PAD_Y * 2 };
    n.weight = 700;
    return;
  }
  if (n.depth === 1) {
    n.lines = wrapLabel(n.label, MAXW[1], MAXLINES, 600, FS);
    const w = Math.max(...n.lines.map(l => measure(l, 600, FS)));
    n.size = { w: w + CARD_PAD_X * 2 + DOT + 8, h: Math.max(CARD_H_MIN, n.lines.length * LH + 18) };
    n.weight = 600;
    return;
  }
  const size = n.depth === 2 ? FS : FS_SUB, lh = n.depth === 2 ? LH : LH_SUB;
  n.fs = size; n.lh = lh; n.weight = 400;
  n.lines = wrapLabel(n.label, MAXW[n.depth] ?? MAXW.default, MAXLINES, 400, size);
  n.widths = n.lines.map(l => measure(l, 400, size));
  const lastW = n.widths[n.widths.length - 1];
  const badge = n.src ? 6 + BADGE_W : 0;
  n.textW = Math.max(...n.widths);
  n.size = { w: Math.max(n.textW, lastW + badge) + 4, h: n.lines.length * lh + 12 };
}

// Árbol horizontal a dos lados: las primeras ramas (en su orden) van a la derecha de arriba
// abajo y el resto a la izquierda. Cada subárbol reserva el alto que necesitan sus hijos, así
// que dos cajas no pueden solaparse por construcción.
export function layout(tree, { collapsed = new Set(), palette = PALETTE } = {}) {
  const list = flatten(tree, collapsed);
  const byId = new Map(list.map(n => [n.id, n]));
  for (const n of list) {
    measureNode(n);
    n.ci = n.depth === 0 ? -1 : (n.branch >= 0 ? n.branch : 0) % palette.length;
    n.color = n.depth === 0 ? null : palette[n.ci];
  }

  const gap = (depth) => GAP_Y[depth] ?? GAP_Y.default;
  const subH = new Map();
  for (let i = list.length - 1; i >= 0; i--) {         // preorden al revés: hijos antes
    const n = list[i];
    const kids = n.kids.map(id => subH.get(id));
    const sum = kids.reduce((a, h) => a + h, 0) + gap(n.depth + 1) * Math.max(0, kids.length - 1);
    subH.set(n.id, Math.max(n.size.h, kids.length ? sum : 0));
  }

  // Coloca un subárbol. `xi` es el borde INTERIOR del nodo (el que mira al padre) y el nodo
  // crece hacia fuera según `side` (+1 derecha, −1 izquierda).
  const place = (n, xi, y, side) => {
    n.side = side; n.xi = xi;
    n.x = xi + side * n.size.w / 2; n.y = y;
    if (!n.kids.length) return;
    const kids = n.kids.map(id => byId.get(id));
    const total = kids.reduce((a, k) => a + subH.get(k.id), 0) + gap(n.depth + 1) * (kids.length - 1);
    const reach = n.depth === 1 ? GAP_BRANCH : GAP_LEAF;
    const outer = xi + side * (n.size.w + reach);
    let cy = y - total / 2;
    for (const k of kids) {
      const h = subH.get(k.id);
      place(k, outer, cy + h / 2, side);
      cy += h + gap(n.depth + 1);
    }
  };

  const root = list[0];
  root.x = 0; root.y = 0; root.side = 0;
  const branches = root.kids.map(id => byId.get(id));
  const cut = Math.ceil(branches.length / 2);
  [[branches.slice(0, cut), 1], [branches.slice(cut), -1]].forEach(([col, side]) => {
    if (!col.length) return;
    const total = col.reduce((a, b) => a + subH.get(b.id), 0) + gap(1) * (col.length - 1);
    let y = -total / 2;
    for (const b of col) {
      const h = subH.get(b.id);
      place(b, side * (root.size.w / 2 + GAP_ROOT), y + h / 2, side);
      y += h + gap(1);
    }
  });

  const edges = [];
  for (const n of list) {
    if (!n.parent) continue;
    edges.push({ from: byId.get(n.parent), to: n, color: n.color, ci: n.ci, depth: n.depth });
  }

  // Bounding box, contando el círculo de plegado que asoma por fuera de los nodos con hijos.
  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  for (const n of list) {
    const fold = n.depth >= 1 && n.childCount > 0 ? FOLD_OFF + FOLD_R + 2 : 0;
    const l = n.x - n.size.w / 2 - (n.side < 0 ? fold : 0);
    const r = n.x + n.size.w / 2 + (n.side > 0 ? fold : 0);
    minX = Math.min(minX, l); maxX = Math.max(maxX, r);
    minY = Math.min(minY, n.y - n.size.h / 2); maxY = Math.max(maxY, n.y + n.size.h / 2);
  }
  const pad = 44;
  return {
    nodes: list, byId, edges,
    width: Math.round(maxX - minX + pad * 2),
    height: Math.round(maxY - minY + pad * 2),
    ox: -minX + pad, oy: -minY + pad,
  };
}

// ---- SVG -------------------------------------------------------------------------------

function el(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) node.setAttribute(k, v);
  return node;
}

// Curva horizontal con GROSOR DECRECIENTE: tangentes horizontales en los dos extremos (se
// lee como un árbol, no como un grafo). Es un polígono cerrado, no un trazo: un
// `stroke-width` constante no puede afinar.
function taperPath(x0, y0, x1, y1, w0, w1) {
  const dx = x1 - x0, c0 = x0 + dx * 0.55, c1 = x1 - dx * 0.55;
  return [
    `M ${x0} ${y0 - w0 / 2}`,
    `C ${c0} ${y0 - w0 / 2}, ${c1} ${y1 - w1 / 2}, ${x1} ${y1 - w1 / 2}`,
    `L ${x1} ${y1 + w1 / 2}`,
    `C ${c1} ${y1 + w1 / 2}, ${c0} ${y0 + w0 / 2}, ${x0} ${y0 + w0 / 2}`,
    'Z',
  ].join(' ');
}

const isDarkTheme = (theme) => contrastInk(theme.bg) === '#ffffff';

// Dónde recibe un nodo a sus hijos: el borde exterior de la tarjeta (ramas) o el final de su
// línea (ideas). La línea de una idea recorre toda su caja, cita incluida: el indicador se
// apoya en ella y el círculo de plegado queda después, sin pisarlo.
function outPoint(n) {
  if (n.depth === 0) return null;
  if (n.depth === 1) return { x: n.xi + n.side * n.size.w, y: n.y };
  return { x: n.xi + n.side * (n.size.w - 2), y: underlineY(n) };
}
const underlineY = (n) => n.y + n.size.h / 2 - 3;
const firstBaseline = (n) => n.y - n.size.h / 2 + (n.lh || LH) - 1;

function text(x, y, str, { size, weight = 400, fill, anchor = 'start' }) {
  const t = el('text', { x, y, 'font-family': FONT, 'font-size': size, 'font-weight': weight, fill, 'text-anchor': anchor });
  t.textContent = str;
  return t;
}

function a11y(g, node, interactive, tooltip) {
  if (interactive) {
    // Foco y activación por teclado: sin esto los nodos eran invisibles para el tabulador y
    // para un lector de pantalla.
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', node.full || node.label);
    g.setAttribute('style', 'cursor:pointer');
  }
  // <title> nativo: sigue siendo el nombre accesible del nodo (y el tooltip en escritorio).
  if (tooltip) { const ti = el('title'); ti.textContent = tooltip; g.appendChild(ti); }
}

function drawRoot(parent, n, { theme, interactive, tooltip }) {
  const g = el('g', { class: 'mm-node mm-root', 'data-id': n.id });
  a11y(g, n, interactive, tooltip);
  const { w, h } = n.size;
  g.appendChild(el('rect', {
    class: 'mm-hit', x: -w / 2, y: -h / 2, width: w, height: h, rx: 18,
    fill: theme.leaf, stroke: theme.line, 'stroke-width': 1, filter: 'url(#mm-shadow)',
  }));
  const y0 = -((n.lines.length - 1) * LH_ROOT) / 2 + 7;
  n.lines.forEach((l, i) => g.appendChild(text(0, y0 + i * LH_ROOT, l, { size: FS_ROOT, weight: 700, fill: theme.ink, anchor: 'middle' })));
  parent.appendChild(g);
}

function drawBranch(parent, n, color, { theme, interactive, tooltip }) {
  const g = el('g', { class: 'mm-node mm-branch' + (n.src ? ' mm-cite' : ''), 'data-id': n.id, 'data-src': n.src || null });
  a11y(g, n, interactive, tooltip);
  const { w, h } = n.size;
  const left = n.x - w / 2;
  g.appendChild(el('rect', {
    class: 'mm-hit', x: left, y: n.y - h / 2, width: w, height: h, rx: 12,
    fill: theme.leaf, stroke: theme.line, 'stroke-width': 1, filter: 'url(#mm-shadow)',
  }));
  g.appendChild(el('circle', { cx: left + CARD_PAD_X + DOT / 2, cy: n.y, r: DOT / 2, fill: color }));
  const tx = left + CARD_PAD_X + DOT + 8;
  const y0 = n.y - ((n.lines.length - 1) * LH) / 2 + 5;
  n.lines.forEach((l, i) => g.appendChild(text(tx, y0 + i * LH, l, { size: FS, weight: 600, fill: theme.ink })));
  parent.appendChild(g);
}

function drawIdea(parent, n, color, { theme, interactive, tooltip }) {
  const g = el('g', { class: 'mm-node mm-idea' + (n.src ? ' mm-cite' : ''), 'data-id': n.id, 'data-src': n.src || null });
  a11y(g, n, interactive, tooltip);
  const { w, h } = n.size;
  // Zona de toque invisible: las ideas no tienen caja, pero se tienen que poder pulsar enteras.
  g.appendChild(el('rect', { class: 'mm-hit', x: n.x - w / 2 - 4, y: n.y - h / 2, width: w + 8, height: h, rx: 6, fill: 'transparent' }));
  const anchor = n.side > 0 ? 'start' : 'end';
  const tx = n.side > 0 ? n.xi + 2 : n.xi - 2;
  const b0 = firstBaseline(n);
  const ink = n.depth === 2 ? theme.ink : theme.muted;
  n.lines.forEach((l, i) => g.appendChild(text(tx, b0 + i * n.lh, l, { size: n.fs, fill: ink, anchor })));
  // La cita a la vista: un indicador pequeño al final de la última línea. Tocarlo va al libro.
  if (n.src) {
    const lastW = n.widths[n.widths.length - 1];
    const by = b0 + (n.lines.length - 1) * n.lh - 12;
    const bx = n.side > 0 ? n.xi + 2 + lastW + 6 : n.xi - 2 - lastW - 6 - BADGE_W;
    const dark = isDarkTheme(theme);
    const go = el('g', { class: 'mm-go', 'data-src': n.src });
    go.appendChild(el('rect', { x: bx, y: by, width: BADGE_W, height: BADGE_H, rx: 8, fill: dark ? '#2c2c2e' : '#f2f2f7' }));
    // Libro abierto, el mismo glifo que la cita del chat.
    const s = 0.42, ox = bx + BADGE_W / 2 - 12 * s, oy = by + BADGE_H / 2 - 12 * s;
    go.appendChild(el('path', {
      d: 'M5 4.5h7a2 2 0 0 1 2 2V20a2.5 2.5 0 0 0-2.5-2H5V4.5Z M19 4.5h-3a2 2 0 0 0-2 2V20a2.5 2.5 0 0 1 2.5-2H19V4.5Z',
      transform: `translate(${ox} ${oy}) scale(${s})`, fill: 'none',
      stroke: dark ? '#98989d' : '#6e6e73', 'stroke-width': 2.2, 'stroke-linejoin': 'round',
    }));
    g.appendChild(go);
  }
  parent.appendChild(g);
}

// Círculo al final de las ramas (e ideas) con hijos: pliega/despliega sin abrir el detalle.
// Plegado, anuncia cuántos hijos esconde: plegar no puede equivaler a perder contenido.
function drawFold(parent, n, color, theme, interactive) {
  const o = outPoint(n);
  const cx = o.x + n.side * FOLD_OFF, cy = o.y;
  const g = el('g', { class: 'mm-fold', 'data-id': n.id });
  if (interactive) {
    g.setAttribute('role', 'button'); g.setAttribute('tabindex', '0'); g.setAttribute('style', 'cursor:pointer');
    g.setAttribute('aria-label', (n.collapsed ? 'Desplegar ' : 'Plegar ') + (n.full || n.label));
  }
  g.appendChild(el('circle', { cx, cy, r: FOLD_R, fill: theme.bg, stroke: n.collapsed ? color : theme.line, 'stroke-width': 1.5 }));
  // El número va en tinta, no en el color de la rama: los colores de sistema no aguantan
  // texto encima (verde y naranja sobre blanco no llegan a 3:1). El color va en el aro.
  const t = text(cx, cy + 4, n.collapsed ? String(n.childCount) : '−', {
    size: 11, weight: 600, fill: n.collapsed ? theme.ink : theme.muted, anchor: 'middle',
  });
  g.appendChild(t);
  parent.appendChild(g);
}

// Banda de pie del export: título, autor y marca. Un mapa publicado sin procedencia no
// devuelve a nadie — y P14 existe justamente como artefacto de marketing.
function drawFooter(svg, { width, height, bandH, footer, theme }) {
  const y = height - bandH;
  svg.appendChild(el('line', { x1: 40, y1: y, x2: width - 40, y2: y, stroke: theme.line, 'stroke-width': 1 }));
  svg.appendChild(text(40, y + bandH / 2 + 6, [footer.title, footer.author].filter(Boolean).join('  ·  '), { size: 17, weight: 600, fill: theme.ink }));
  svg.appendChild(text(width - 40, y + bandH / 2 + 6, footer.mark || 'BookReader', { size: 15, weight: 500, fill: theme.muted, anchor: 'end' }));
}

// Construye el SVG. `interactive` añade foco/roles y el grupo de viewport (zoom/pan);
// `footer` y `fontCss` son cosa del export.
export function renderSvg(lay, {
  theme = POSTER, footer = null, interactive = false, fontCss = '', title = '',
} = {}) {
  const bandH = footer ? 64 : 0;
  const width = lay.width, height = lay.height + bandH;
  const dark = isDarkTheme(theme);
  const colors = dark ? PALETTE_DARK : PALETTE;
  const colorOf = (n) => colors[n.ci % colors.length];
  const svg = el('svg', {
    xmlns: SVG_NS, viewBox: `0 0 ${width} ${height}`, width, height,
    role: 'img', 'aria-label': title || 'Mapa mental',
    style: 'display:block;max-width:100%;height:auto',
  });
  const defs = el('defs');
  if (fontCss) {
    const style = el('style');
    style.textContent = fontCss;
    defs.appendChild(style);
  }
  // Sombra de tarjeta: una de contacto y otra difusa, como las de las tarjetas de Apple.
  const shadow = el('filter', { id: 'mm-shadow', x: '-20%', y: '-50%', width: '140%', height: '200%' });
  const o = dark ? 0.45 : 0.07;
  shadow.appendChild(el('feDropShadow', { dx: 0, dy: 1, stdDeviation: 1, 'flood-color': '#000', 'flood-opacity': o }));
  shadow.appendChild(el('feDropShadow', { dx: 0, dy: 6, stdDeviation: 9, 'flood-color': '#000', 'flood-opacity': o }));
  defs.appendChild(shadow);
  svg.appendChild(defs);
  svg.appendChild(el('rect', { x: 0, y: 0, width, height, fill: theme.bg }));

  // Viewport: todo el contenido cuelga de un <g> propio para que zoom/pan sea un solo
  // `transform` (y el fondo no se mueva con él).
  const viewport = el('g', { class: 'mm-viewport' });
  svg.appendChild(viewport);
  const root = el('g', { transform: `translate(${lay.ox} ${lay.oy})` });
  viewport.appendChild(root);

  const rootNode = lay.nodes[0];
  for (const e of lay.edges) {
    const n = e.to, c = colorOf(n);
    if (n.depth === 1) {
      const x0 = n.side * rootNode.size.w / 2;
      root.appendChild(el('path', { d: taperPath(x0, 0, n.xi, n.y, 4, 2.5), fill: c, stroke: 'none' }));
      continue;
    }
    const o = outPoint(e.from), uy = underlineY(n);
    const sw = n.depth === 2 ? 1.5 : 1.2;
    root.appendChild(el('path', { d: taperPath(o.x, o.y, n.xi, uy, n.depth === 2 ? 2.4 : 1.8, sw), fill: c, stroke: 'none' }));
    // El trazo sigue por debajo del texto: la idea se apoya en su línea, sin caja.
    root.appendChild(el('line', {
      x1: n.xi, y1: uy, x2: n.xi + n.side * (n.size.w - 2), y2: uy, stroke: c, 'stroke-width': sw, 'stroke-linecap': 'round',
    }));
  }

  // Las ideas primero y el centro al final: si algo se tocara, manda la jerarquía.
  const ordered = [...lay.nodes].sort((a, b) => b.depth - a.depth);
  for (const n of ordered) {
    const opts = { theme, interactive, tooltip: n.tooltip || n.full || n.label };
    if (n.depth === 0) drawRoot(root, n, opts);
    else if (n.depth === 1) drawBranch(root, n, colorOf(n), opts);
    else drawIdea(root, n, colorOf(n), opts);
    // En el export solo se ve el de las ramas plegadas: anuncia lo que el usuario dejó fuera.
    if (n.depth >= 1 && n.childCount > 0 && (interactive || n.collapsed)) drawFold(root, n, colorOf(n), theme, interactive);
  }

  if (footer) drawFooter(svg, { width, height, bandH, footer, theme });
  return { svg, width, height };
}
