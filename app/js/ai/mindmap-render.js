// P14 F3/F4 · Render del mapa mental: medida REAL del texto, layout radial anticolisión y
// ramas curvas con grosor decreciente. Separado de `mindmap.js` (que orquesta LLM/Jobs/modal)
// porque es geometría pura: sin red, sin IndexedDB, testeable sola.
//
// POR QUÉ SE REESCRIBIÓ EL LAYOUT ANTERIOR:
// - Medía el texto con `CHARW = 8` fijo. Inter es PROPORCIONAL: "WWWW" e "iiii" no ocupan lo
//   mismo, así que las píldoras sobraban o apretaban según la palabra. Ahora se mide con
//   `canvas.measureText`, cacheado.
// - Solo las hojas tenían anticolisión (el apaño par/impar). Las ramas iban a un radio FIJO
//   (210) con el ángulo medio de sus hojas: dos ramas de una hoja quedaban superpuestas. Ahora
//   el radio de CADA anillo se deriva de la cuerda que necesitan sus vecinos reales.
// - Solo admitía 2 niveles. El layout es ahora por profundidad arbitraria (lo necesita F6,
//   "expandir rama", y el plegado: una rama plegada pasa a ser hoja del árbol visible).

const SVG_NS = 'http://www.w3.org/2000/svg';

// Paleta de ramas — tonos 700. Los 500 de antes NO eran legibles con texto blanco
// (#22c55e sobre blanco = 2.2:1, #f59e0b = 2.1:1; el mínimo AA es 4.5:1). Todos estos pasan.
export const PALETTE = ['#047857', '#1d4ed8', '#b45309', '#be185d', '#6d28d9', '#0f766e', '#b91c1c', '#0369a1'];

// Tema "póster" del export: los mismos tokens de marca que la tarjeta-cita (`share-card.js`),
// para que lo que se publica de BookReader se vea siempre igual venga de donde venga.
export const POSTER = { bg: '#faf8f3', ink: '#2b2b2b', muted: '#7a736a', leaf: '#ffffff', line: '#e6e1d8' };

// Métricas de píldora (font-size 14). Anchos MÁXIMOS en píxeles, no en caracteres.
const FS = 14, LINEH = 19, PADX = 22, PADY = 12, MINW = 58;
const MAXW = { 0: 210, 1: 170, default: 190 };
const MAXLINES = 2;
const RING_GAP = 62;      // separación radial mínima entre anillos
const PILL_GAP = 18;      // aire mínimo entre dos píldoras vecinas del mismo anillo
const R_MAX = 1500;       // tope de radio: pasado esto se reparte con `stagger`, no creciendo
const STAGGER = 2 * LINEH + PADY + 8;

// ---- Medida de texto -------------------------------------------------------------------

let mctx = null;
const mcache = new Map();

function measure(text, weight) {
  const key = weight + '|' + text;
  const hit = mcache.get(key);
  if (hit !== undefined) return hit;
  if (!mctx) mctx = document.createElement('canvas').getContext('2d');
  mctx.font = `${weight} ${FS}px Inter, system-ui, sans-serif`;
  const w = mctx.measureText(text).width;
  mcache.set(key, w);
  return w;
}

// Las métricas cambian cuando Inter TERMINA de cargar (hasta entonces mide la fuente de
// sistema). Quien renderice debe esperar a `document.fonts.ready` y vaciar la caché.
export function clearMeasureCache() { mcache.clear(); }

function ellipsize(word, maxW, weight) {
  let s = String(word);
  while (s.length > 1 && measure(s + '…', weight) > maxW) s = s.slice(0, -1);
  return s.length > 1 ? s + '…' : s;
}

// Parte una etiqueta en líneas que QUEPAN en `maxW` píxeles (no en N caracteres).
export function wrapLabel(text, maxW, maxLines = MAXLINES, weight = 400) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [''];
  const lines = [];
  let cur = '';
  for (const raw of clean.split(' ')) {
    const word = measure(raw, weight) > maxW ? ellipsize(raw, maxW, weight) : raw;
    const cand = cur ? cur + ' ' + word : word;
    if (measure(cand, weight) <= maxW || !cur) cur = cand;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last.length > 1 && measure(last + '…', weight) > maxW) last = last.slice(0, -1);
  kept[maxLines - 1] = last.replace(/[\s…]+$/, '') + '…';
  return kept;
}

export function pillSize(lines, weight) {
  const w = Math.max(MINW, Math.max(...lines.map(l => measure(l, weight))) + PADX);
  return { w, h: lines.length * LINEH + PADY };
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
// Un nodo plegado se emite SIN hijos → pasa a ser hoja del árbol visible, y el reparto
// angular lo trata como tal (por eso plegar reordena y despeja el mapa de verdad).
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

function norm(a) { const x = a % (Math.PI * 2); return x < 0 ? x + Math.PI * 2 : x; }

// Radio mínimo para que dos píldoras vecinas de un anillo no se toquen: su separación es una
// CUERDA, no un arco — por eso el fallo antiguo aparecía cerca del eje vertical, donde el
// ancho de la píldora (no su alto) es lo que colisiona.
function ringRadius(sorted, floor, staggered) {
  let need = floor;
  const n = sorted.length;
  for (let i = 0; i < n && n > 1; i++) {
    if (n === 2 && i === 1) break;              // con dos nodos, el par envolvente es el mismo
    const a = sorted[i], b = sorted[(i + 1) % n];
    // Con `stagger`, los contiguos se separan RADIALMENTE: quien colisiona en el mismo radio
    // es el vecino de dos pasos, así que el ángulo disponible se dobla.
    const d = norm(b.ang - a.ang) * (staggered ? 2 : 1);
    if (d <= 0.0001 || d >= Math.PI) continue;
    const chord = (a.size.w + b.size.w) / 2 + PILL_GAP;
    need = Math.max(need, chord / (2 * Math.sin(d / 2)));
  }
  return Math.min(R_MAX, need);
}

// Layout radial: el ángulo se reparte entre las HOJAS DEL ÁRBOL VISIBLE (densidad angular
// constante ⇒ una rama con muchas hojas no las amontona) y cada nodo interno se sitúa en el
// ángulo medio de su descendencia. El radio de cada anillo sale de la colisión real.
export function layout(tree, { collapsed = new Set(), palette = PALETTE } = {}) {
  const list = flatten(tree, collapsed);
  const byId = new Map(list.map(n => [n.id, n]));

  for (const n of list) {
    const maxW = MAXW[n.depth] ?? MAXW.default;
    const weight = n.depth <= 1 ? 600 : 400;
    n.lines = wrapLabel(n.label, maxW, MAXLINES, weight);
    n.weight = weight;
    n.size = pillSize(n.lines, weight);
    n.color = n.depth === 0 ? null : palette[(n.branch >= 0 ? n.branch : 0) % palette.length];
  }

  const leaves = list.filter(n => n.kids.length === 0 && n.depth > 0);
  const M = Math.max(1, leaves.length);
  const step = (Math.PI * 2) / M;
  const start = -Math.PI / 2;              // arranca arriba
  leaves.forEach((lf, k) => { lf.ang = start + (k + 0.5) * step; lf.slot = k; });

  // Ángulo de los internos: media de su descendencia. `list` es preorden, así que recorrerla
  // al revés garantiza que los hijos ya tienen ángulo cuando se resuelve el padre.
  for (let i = list.length - 1; i >= 0; i--) {
    const n = list[i];
    if (n.kids.length === 0) continue;
    const kids = n.kids.map(id => byId.get(id));
    n.ang = kids.reduce((s, k) => s + k.ang, 0) / kids.length;
  }

  const maxDepth = list.reduce((m, n) => Math.max(m, n.depth), 0);
  const radii = [0];
  for (let d = 1; d <= maxDepth; d++) {
    // Ordenado por ángulo: la alternancia del `stagger` tiene que ir por VECINDAD REAL en el
    // anillo, no por el índice global de hoja (hay hojas en anillos interiores).
    const ring = list.filter(n => n.depth === d).sort((a, b) => a.ang - b.ang);
    // El `stagger` solo se aplica al anillo más externo y con suficientes nodos: alternar el
    // radio en un anillo interno rompería la lectura de la jerarquía.
    const staggered = d === maxDepth && ring.length > 6;
    radii[d] = ringRadius(ring, radii[d - 1] + RING_GAP + (d === 1 ? 140 : 0), staggered);
    ring.forEach((n, i) => { n.staggered = staggered && i % 2 === 1; });
  }

  for (const n of list) {
    const r = n.depth === 0 ? 0 : radii[n.depth] + (n.staggered ? STAGGER : 0);
    n.x = n.depth === 0 ? 0 : r * Math.cos(n.ang);
    n.y = n.depth === 0 ? 0 : r * Math.sin(n.ang);
  }

  const edges = [];
  for (const n of list) {
    if (!n.parent) continue;
    const p = byId.get(n.parent);
    edges.push({ from: p, to: n, color: n.color, depth: n.depth });
  }

  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  for (const n of list) {
    minX = Math.min(minX, n.x - n.size.w / 2); maxX = Math.max(maxX, n.x + n.size.w / 2);
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

// Rama curva con GROSOR DECRECIENTE (la regla de Buzan que separa un mapa mental de un grafo).
// Es un polígono cerrado, no un trazo: un `stroke-width` constante no puede afinar. La curva
// es la radial clásica (control en el ángulo del padre y en el del hijo, a radio intermedio).
function branchPath(x0, y0, x1, y1, w0, w1) {
  const mx0 = x0 + (x1 - x0) * 0.45, my0 = y0 + (y1 - y0) * 0.45;
  const mx1 = x0 + (x1 - x0) * 0.55, my1 = y0 + (y1 - y0) * 0.55;
  const c0x = (x0 + mx0) / 2, c0y = (y0 + my0) / 2;
  const c1x = (x1 + mx1) / 2, c1y = (y1 + my1) / 2;
  const perp = (ax, ay, bx, by, w) => {
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    return [(-dy / len) * w / 2, (dx / len) * w / 2];
  };
  const [n0x, n0y] = perp(x0, y0, c0x, c0y, w0);
  const [n1x, n1y] = perp(c1x, c1y, x1, y1, w1);
  return [
    `M ${x0 + n0x} ${y0 + n0y}`,
    `C ${c0x + n0x} ${c0y + n0y}, ${c1x + n1x} ${c1y + n1y}, ${x1 + n1x} ${y1 + n1y}`,
    `L ${x1 - n1x} ${y1 - n1y}`,
    `C ${c1x - n1x} ${c1y - n1y}, ${c0x - n0x} ${c0y - n0y}, ${x0 - n0x} ${y0 - n0y}`,
    'Z',
  ].join(' ');
}

const strokeWidth = (depth) => (depth === 1 ? 9 : depth === 2 ? 4.5 : 2.5);

function drawPill(parent, node, opts) {
  const { theme, interactive, tooltip } = opts;
  const branchLike = node.depth <= 1;
  const fill = node.depth === 0 ? theme.ink : branchLike ? node.color : theme.leaf;
  const ink = node.depth === 0 ? theme.bg : branchLike ? contrastInk(node.color) : theme.ink;
  const { w, h } = node.size;

  const g = el('g', {
    class: 'mm-node' + (node.src ? ' mm-cite' : ''),
    'data-id': node.id,
    'data-src': node.src || null,
  });
  if (interactive) {
    // Foco y activación por teclado: antes eran <g> con `cursor:pointer`, invisibles para
    // el tabulador y para un lector de pantalla.
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', node.full || node.label);
    g.setAttribute('style', 'cursor:pointer');
  }
  // <title> nativo: sigue siendo el nombre accesible del nodo (y el tooltip en escritorio).
  // El detalle real se ve en el popover, que sí funciona en táctil.
  if (tooltip) { const ti = el('title'); ti.textContent = tooltip; g.appendChild(ti); }

  g.appendChild(el('rect', {
    x: node.x - w / 2, y: node.y - h / 2, width: w, height: h,
    rx: Math.min(16, h / 2),
    fill,
    stroke: branchLike ? 'none' : node.color,
    'stroke-width': branchLike ? null : 1.5,
  }));
  const text = el('text', {
    x: node.x, 'text-anchor': 'middle', 'font-size': FS,
    'font-family': 'Inter, system-ui, sans-serif',
    'font-weight': node.weight, fill: ink,
  });
  const y0 = node.y - (node.lines.length - 1) * LINEH / 2 + 5;
  node.lines.forEach((line, i) => {
    const ts = el('tspan', { x: node.x, y: y0 + i * LINEH });
    ts.textContent = line;
    text.appendChild(ts);
  });
  g.appendChild(text);

  // Indicador de rama plegada: el nº de hijos ocultos. Sin esto, plegar equivale a perder
  // contenido sin dejar rastro.
  if (node.collapsed) {
    const bx = node.x + w / 2 - 2, by = node.y - h / 2 + 2;
    g.appendChild(el('circle', { cx: bx, cy: by, r: 10, fill: theme.bg, stroke: node.color || theme.ink, 'stroke-width': 1.5 }));
    const cnt = el('text', {
      x: bx, y: by + 4, 'text-anchor': 'middle', 'font-size': 11,
      'font-family': 'Inter, system-ui, sans-serif', 'font-weight': 600,
      fill: node.color || theme.ink,
    });
    cnt.textContent = String(node.childCount);
    g.appendChild(cnt);
  }
  parent.appendChild(g);
}

// Banda de pie del export: título, autor y marca. Un mapa publicado sin procedencia no
// devuelve a nadie — y P14 existe justamente como artefacto de marketing.
function drawFooter(svg, { width, height, bandH, footer, theme }) {
  const y = height - bandH;
  svg.appendChild(el('line', { x1: 40, y1: y, x2: width - 40, y2: y, stroke: theme.line, 'stroke-width': 1 }));
  const label = el('text', {
    x: 40, y: y + bandH / 2 + 6, 'font-size': 17,
    'font-family': 'Inter, system-ui, sans-serif', 'font-weight': 600, fill: theme.ink,
  });
  label.textContent = [footer.title, footer.author].filter(Boolean).join('  ·  ');
  svg.appendChild(label);
  const mark = el('text', {
    x: width - 40, y: y + bandH / 2 + 6, 'text-anchor': 'end', 'font-size': 15,
    'font-family': 'Inter, system-ui, sans-serif', 'font-weight': 500, fill: theme.muted,
  });
  mark.textContent = footer.mark || 'BookReader';
  svg.appendChild(mark);
}

// Construye el SVG. `interactive` añade foco/roles y el grupo de viewport (zoom/pan);
// `footer` y `fontCss` son cosa del export.
export function renderSvg(lay, {
  theme = POSTER, footer = null, interactive = false, fontCss = '', title = '',
} = {}) {
  const bandH = footer ? 64 : 0;
  const width = lay.width, height = lay.height + bandH;
  const svg = el('svg', {
    xmlns: SVG_NS, viewBox: `0 0 ${width} ${height}`, width, height,
    role: 'img', 'aria-label': title || 'Mapa mental',
    style: 'display:block;max-width:100%;height:auto',
  });
  if (fontCss) {
    const defs = el('defs');
    const style = el('style');
    style.textContent = fontCss;
    defs.appendChild(style);
    svg.appendChild(defs);
  }
  svg.appendChild(el('rect', { x: 0, y: 0, width, height, fill: theme.bg }));

  // Viewport: todo el contenido cuelga de un <g> propio para que zoom/pan sea un solo
  // `transform` (y el fondo no se mueva con él).
  const viewport = el('g', { class: 'mm-viewport' });
  svg.appendChild(viewport);
  const root = el('g', { transform: `translate(${lay.ox} ${lay.oy})` });
  viewport.appendChild(root);

  for (const e of lay.edges) {
    const w0 = strokeWidth(e.depth), w1 = strokeWidth(e.depth + 1);
    root.appendChild(el('path', {
      d: branchPath(e.from.x, e.from.y, e.to.x, e.to.y, w0, w1),
      fill: e.color, opacity: e.depth === 1 ? 0.55 : 0.4, stroke: 'none',
    }));
  }
  // Las hojas primero y el centro al final: si algo se solapa, manda la jerarquía.
  const ordered = [...lay.nodes].sort((a, b) => b.depth - a.depth);
  for (const n of ordered) {
    drawPill(root, n, { theme, interactive, tooltip: n.tooltip || n.full || n.label });
  }

  if (footer) drawFooter(svg, { width, height, bandH, footer, theme });
  return { svg, width, height };
}
