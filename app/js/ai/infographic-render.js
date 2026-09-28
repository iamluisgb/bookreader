// P29 · Render de la infografía del libro: póster "de una ojeada" con tesis, ideas clave,
// cadenas de argumento, comparativas y cita final.
//
// POR QUÉ NO ES UNA IMAGEN GENERADA. Un modelo de difusión no sabe escribir: el texto sale
// deforme, inventado y sin poder citar el pasaje. Aquí el modelo solo decide QUÉ se dice (un
// JSON de bloques) y esta plantilla decide DÓNDE va. Es el mismo reparto que el mapa mental
// (`mindmap-render.js`): geometría pura, sin red ni IndexedDB, testeable sola.
//
// POR QUÉ UNA PLANTILLA FIJA. Los dos pósters de referencia (Meadows, Diamond) usan la MISMA
// rejilla: hero con portada + tesis, columna de ideas numeradas a la izquierda, columna de
// paneles a la derecha (flujo → comparativa → "dónde tocar"), dos tarjetas de cierre y banda
// de cita. Esa estabilidad es el producto: el lector reconoce el formato y el generador solo
// rellena huecos. Aquí no hay "layout libre".
//
// ESQUEMA DE ENTRADA (todo opcional salvo `title`):
//   {
//     kicker, title, author, cover, thesis,
//     ideas:  [{ ico, head, body }],                                  // numeradas 1..N
//     panels: [{ kind:'flow'|'cols'|'rows', title, steps|cols|rows }],
//     aside:  [{ ico, label, body }],
//     quote:  { text, attribution },
//     footer,
//   }
//
// FORMATOS (IG2): póster largo (renderSvg), carrusel 4:5 (renderSlides) y story 9:16
// (renderStory), con los mismos componentes. Ver «Diseño v2» más abajo.
//
// ESCALA: el póster se dibuja a 1080 px de ancho (9:16, legible en móvil y en stories). La
// densidad es EL riesgo del artefacto: diez bloques a tamaño póster se convierten en papilla
// a 380 px — el ancho real de un feed. Por eso el póster es un activo de TAMAÑO FIJO (1080 px)
// que se ENCOGE por CSS para previsualizarlo: cambiar el ancho reflowaría la rejilla, y una
// infografía es una composición, no una página responsive. El prototipo enseña la misma
// composición a tamaño de feed antes de dar por buena cualquier densidad.


const SVG_NS = 'http://www.w3.org/2000/svg';

// Medidas base a 1080. El póster se compone SIEMPRE a este ancho: para verlo pequeño se
// escala (CSS o canvas), no se rehace el layout.
const BASE_W = 1080;
const M = 64; // margen
const FONT = 'Inter, system-ui, sans-serif';
const DISPLAY = "'Source Serif 4', Georgia, serif";

// Tokens de marca (los mismos que `mindmap-render.js` y `share-card.js`: lo que se publica
// se ve igual venga de donde venga). `accent` va en su tono 700 — el emerald de la UI
// (#22c55e) no llega a 3:1 sobre papel y aquí se usa para texto pequeño.
export const POSTER = {
  bg: '#ffffff',
  ink: '#1d1d1f',
  soft: '#3a3a3c',
  muted: '#6e6e73',
  line: '#e5e5ea',
  card: '#ffffff',
  accent: '#15803d',
  accentSoft: '#e7f0e9',
};

// ---- Medida de texto -------------------------------------------------------------------
// Inter y Source Serif 4 son PROPORCIONALES: medir por nº de caracteres (el `CHARW = 8` que
// se usó en el mapa) aprieta o desborda según la palabra. Se mide con el canvas real y se
// cachea. Las métricas cambian cuando la fuente ACABA de cargar, así que quien renderice
// debe esperar a `document.fonts.ready` y llamar a `clearMeasureCache()`.

let mctx = null;
const mcache = new Map();

function measure(text, size, weight, family) {
  const key = `${family}|${weight}|${size}|${text}`;
  const hit = mcache.get(key);
  if (hit !== undefined) return hit;
  if (!mctx) mctx = document.createElement('canvas').getContext('2d');
  mctx.font = `${weight} ${size}px ${family}`;
  const w = mctx.measureText(text).width;
  mcache.set(key, w);
  return w;
}

// Carga EXPLÍCITA de las dos familias y pesos antes de medir. `document.fonts.ready` no basta:
// una fuente declarada que aún no se ha usado en la página no se descarga, y el canvas mide con
// la de reserva (más estrecha) — el texto salía medido corto y desbordaba en el PNG.
export async function ensureFonts() {
  if (typeof document === 'undefined' || !document.fonts) return;
  const loads = [];
  for (const w of ['400', '600']) {
    loads.push(document.fonts.load(`${w} 20px Inter`), document.fonts.load(`${w} 20px 'Source Serif 4'`));
  }
  await Promise.all(loads).catch(() => {});
  mcache.clear();
}

export function clearMeasureCache() {
  mcache.clear();
}

// Parte el texto en líneas que quepan en `maxW` PÍXELES. `maxLines` recorta con elipsis: en un
// póster, un bloque desbordado es peor que un bloque recortado (el resto está en la app).
export function wrapText(text, maxW, { size, weight = 400, family = FONT, maxLines = 99 } = {}) {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return [];
  const lines = [];
  let cur = '';
  for (const word of clean.split(' ')) {
    const cand = cur ? `${cur} ${word}` : word;
    if (measure(cand, size, weight, family) <= maxW || !cur) cur = cand;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last.length > 1 && measure(`${last}…`, size, weight, family) > maxW)
    last = last.slice(0, -1);
  kept[maxLines - 1] = `${last.replace(/[\s…]+$/, '')}…`;
  return kept;
}

// Encoge el titular hasta que quepa en `maxLines`. Un título de póster no se recorta: se
// ajusta, porque es lo primero que se lee y decide si el artefacto se comparte.
// Reparte las palabras en DOS líneas EQUILIBRADAS (minimiza la más ancha). Con el corte
// codicioso, «EL PEZ EN EL / AGUA» deja una línea huérfana; el titular de un póster debe
// partirse cerca de la mitad. Devuelve null si no hay ningún corte que quepa.
function balanceTwo(text, maxW, { size, weight, family }) {
  const words = String(text).split(' ').filter(Boolean);
  if (words.length < 2) return null;
  const widthOf = (from, to) => measure(words.slice(from, to).join(' '), size, weight, family);
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = widthOf(0, i);
    const b = widthOf(i, words.length);
    if (a > maxW || b > maxW) continue;
    const score = Math.max(a, b);
    if (!best || score < best.score) {
      best = { score, lines: [words.slice(0, i).join(' '), words.slice(i).join(' ')] };
    }
  }
  return best ? best.lines : null;
}

function fitDisplay(text, maxW, { sizes, weight = 600, family = DISPLAY, maxLines = 2 } = {}) {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  for (const size of sizes) {
    const lines = wrapText(clean, maxW, { size, weight, family, maxLines: maxLines + 1 });
    if (lines.length <= maxLines) {
      if (maxLines === 2 && lines.length === 2) {
        const balanced = balanceTwo(clean, maxW, { size, weight, family });
        if (balanced) return { size, lines: balanced };
      }
      return { size, lines };
    }
  }
  const size = sizes[sizes.length - 1];
  return { size, lines: wrapText(clean, maxW, { size, weight, family, maxLines }) };
}

// Verde claro para texto sobre la banda oscura, derivado del acento del libro. Se mezcla con
// blanco en vez de fijar un hex: así cualquier acento de la paleta tiene su pareja legible
// sobre el fondo oscuro sin tener que anotarla a mano.
function lighten(hex, t) {
  const c = String(hex).replace('#', '');
  if (c.length < 6) return hex;
  const mix = (i) => {
    const v = parseInt(c.slice(i, i + 2), 16);
    return Math.round(v + (255 - v) * t)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${[0, 2, 4].map(mix).join('')}`;
}

// Paleta de acentos de póster: tonos 700+, TODOS con AA (≥4,5:1) sobre el papel `bg` como texto
// pequeño. El generador elige uno a partir de la cubierta del libro; nunca inventa un color, y
// el tono para la banda oscura se deriva solo. Es la misma idea que la PALETTE de ramas del mapa.
export const ACCENTS = [
  '#15803d', // verde marca
  '#0f766e', // teal
  '#0e7490', // cian
  '#1d4ed8', // azul
  '#4338ca', // índigo
  '#6d28d9', // violeta
  '#9f1239', // granate
  '#b45309', // ámbar
];

// ---- Emisión de SVG (como cadena: los iconos son markup incrustado) ---------------------

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function textEl(
  lines,
  x,
  y0,
  {
    size,
    lineH,
    weight = 400,
    family = FONT,
    fill,
    anchor = 'start',
    spacing = null,
    opacity = null,
  },
) {
  if (!lines || !lines.length) return '';
  const anchorAttr = anchor === 'start' ? '' : ` text-anchor="${anchor}"`;
  const sp = spacing ? ` letter-spacing="${spacing}"` : '';
  const op = opacity !== null ? ` opacity="${opacity}"` : '';
  const spans = lines
    .map((l, i) => `<tspan x="${x}" y="${(y0 + i * lineH).toFixed(2)}">${esc(l)}</tspan>`)
    .join('');
  return `<text font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}"${anchorAttr}${sp}${op}>${spans}</text>`;
}

function rect(x, y, w, h, fill, { rx = 0, stroke = null, sw = 1, opacity = null } = {}) {
  const st = stroke ? ` stroke="${stroke}" stroke-width="${sw}"` : '';
  const op = opacity !== null ? ` opacity="${opacity}"` : '';
  return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${Math.max(0, w).toFixed(2)}" height="${Math.max(0, h).toFixed(2)}" rx="${rx}"${fill ? ` fill="${fill}"` : ' fill="none"'}${st}${op}/>`;
}

function line(x1, y1, x2, y2, stroke, sw = 1, opacity = null) {
  const op = opacity !== null ? ` opacity="${opacity}"` : '';
  return `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke="${stroke}" stroke-width="${sw}"${op}/>`;
}

// ---- Diseño v2 (IG2, 2026-09-28) -------------------------------------------------------
// El v1 se leía como un informe: cuatro bandas negras con tarjetas idénticas, casi sin color y
// con los «diagramas» hechos de texto de 11 px. El v2 conserva la regla de oro (el modelo decide
// QUÉ, la plantilla DÓNDE) y cambia la puesta en escena:
//   - Paleta del LIBRO: el acento (sacado de la portada) tiñe el papel, los números y la banda
//     de la cita. Cada libro tiene su póster.
//   - Secciones editoriales (antetítulo + filete), no bandas negras.
//   - Ideas con NÚMERO grande en serif, sin icono (repetía lo que ya decía el número), y con su
//     página cuando la hay: la prueba de que nada es inventado.
//   - Diagramas de verdad: línea de pasos con círculos, tarjetas comparativas, escala con barras.
//   - Tres formatos con los mismos componentes: póster largo (leer con zoom e imprimir),
//     carrusel 4:5 (1080×1350) y story 9:16 (1080×1920).

// Mezcla con otro color (t=0 → el propio, t=1 → el otro). `lighten` es mezclar con blanco.
function mixHex(hex, other, t) {
  const a = String(hex).replace('#', '');
  const b = String(other).replace('#', '');
  if (a.length < 6 || b.length < 6) return hex;
  const ch = (s, i) => parseInt(s.slice(i, i + 2), 16);
  return `#${[0, 2, 4]
    .map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t).toString(16).padStart(2, '0'))
    .join('')}`;
}

// Tema del póster a partir del acento del libro. El papel es un tinte casi blanco del acento
// (sigue pasando AA para el acento como texto) y la banda de la cita, el acento oscurecido.
export function themeFor(accent, base = POSTER) {
  const a = accent || base.accent;
  return {
    ...base,
    accent: a,
    paper: mixHex(a, '#ffffff', 0.955),
    tint: mixHex(a, '#ffffff', 0.88),
    rule: mixHex(a, '#ffffff', 0.78),
    deep: mixHex(a, '#000000', 0.38),
    accentOnBand: lighten(a, 0.5),
  };
}

// Tamaños por formato. El póster se lee a 1:1 (o impreso); el carrusel y la story, a tamaño
// de móvil, así que su cuerpo mínimo es ~24 px sobre 1080 (≈ 9 px en un feed de 390).
const SZ_POSTER = {
  label: 14, num: 46, head: 19, headLH: 25, body: 16, bodyLH: 25, chip: 12.5,
  stepR: 22, stepHead: 17, stepBody: 15, stepLH: 22,
  colHead: 26, colSub: 12, colBody: 15.5, colLH: 24,
  rowTag: 16, rowBody: 15.5, rowLH: 23, bar: 10,
  asideLabel: 13, asideBody: 17, asideLH: 26,
};
const SZ_SLIDE = {
  label: 22, num: 76, head: 32, headLH: 40, body: 26, bodyLH: 38, chip: 20,
  stepR: 30, stepHead: 30, stepBody: 24, stepLH: 34,
  colHead: 38, colSub: 18, colBody: 23, colLH: 33,
  rowTag: 27, rowBody: 24, rowLH: 34, bar: 16,
  asideLabel: 20, asideBody: 28, asideLH: 40,
};
const scaleSz = (sz, k) => Object.fromEntries(Object.entries(sz).map(([key, v]) => [key, +(v * k).toFixed(2)]));

// Logo de BookReader en SVG (el de la web y la app), para que viaje dentro del PNG.
function logo(x, y, size) {
  const s = size / 512;
  return (
    `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${s.toFixed(5)})">` +
    `<rect width="512" height="512" rx="118" fill="#111418"/>` +
    `<path d="M288 119 Q288 99 308 99 L396 99 Q416 99 416 119 L416 371 L352 323 L288 371 Z" fill="#22c55e"/>` +
    `<path d="M98 90 L222 90 Q256 90 256 124 L256 470 C 249 442 233 424 206 414 C 177 403 140 401 100 401 Q64 401 64 365 L64 124 Q64 90 98 90 Z" fill="#f8fafc"/></g>`
  );
}

// Cabecera de sección: antetítulo en versalitas del acento y un filete a todo el ancho.
function sectionHead(x, y, w, label, sz, theme) {
  const text = String(label || '').toUpperCase();
  let size = sz.label;
  const fits = (s) => measure(text, s, 600, FONT) + text.length * 1.8 <= w;
  while (size > sz.label * 0.7 && !fits(size)) size -= 0.5;
  const svg =
    `<text x="${x}" y="${(y + size).toFixed(2)}" font-family="${FONT}" font-size="${size}" font-weight="600"` +
    ` letter-spacing="1.8" fill="${theme.accent}">${esc(text)}</text>` +
    line(x, y + size + 14, x + w, y + size + 14, theme.rule, 1.2);
  return { svg, height: size + 14 + sz.label * 1.4 };
}

// Página de una idea como pastilla discreta («p. 42»).
function pageChip(x, y, page, sz, theme) {
  if (!page) return { svg: '', w: 0 };
  const label = `p. ${page}`;
  const w = measure(label, sz.chip, 600, FONT) + sz.chip * 1.2;
  const h = sz.chip * 1.6;
  return {
    svg:
      rect(x, y - h * 0.78, w, h, theme.tint, { rx: h / 2 }) +
      `<text x="${(x + w / 2).toFixed(2)}" y="${(y - h * 0.78 + h * 0.7).toFixed(2)}" text-anchor="middle" font-family="${FONT}"` +
      ` font-size="${sz.chip}" font-weight="600" fill="${theme.accent}">${esc(label)}</text>`,
    w,
  };
}

// Una idea: número grande en serif + rótulo + cuerpo + página. Devuelve su alto.
function ideaBlock(it, n, x, y, w, sz, theme) {
  const numW = sz.num * 1.05;
  const tx = x + numW;
  const tw = w - numW;
  const head = wrapText(it.head, tw, { size: sz.head, weight: 600, maxLines: 2 });
  const body = wrapText(it.body, tw, { size: sz.body, maxLines: 5 });
  let out = textEl([String(n)], x, y + sz.num * 0.78, {
    size: sz.num, lineH: sz.num, weight: 600, family: DISPLAY, fill: theme.accent,
  });
  out += textEl(head, tx, y + sz.head, { size: sz.head, lineH: sz.headLH, weight: 600, fill: theme.ink });
  let cy = y + sz.head + (head.length - 1) * sz.headLH + sz.bodyLH * 0.95;
  out += textEl(body, tx, cy, { size: sz.body, lineH: sz.bodyLH, fill: theme.soft });
  cy += (body.length - 1) * sz.bodyLH;
  if (it.page) {
    cy += sz.chip * 2.1;
    out += pageChip(tx, cy, it.page, sz, theme).svg;
  }
  return { svg: out, height: Math.max(sz.num * 0.9, cy - y + sz.body * 0.4) };
}

// Ideas en `cols` columnas, alineadas por filas (una idea larga no descuadra a su vecina).
function ideasGrid(items, x, y, w, sz, theme, { cols = 2, gap = 44, rowGap = 30, start = 0 } = {}) {
  const colW = (w - gap * (cols - 1)) / cols;
  let out = '';
  let cy = y;
  for (let r = 0; r < items.length; r += cols) {
    const row = items.slice(r, r + cols).map((it, i) =>
      ideaBlock(it, start + r + i + 1, x + i * (colW + gap), cy, colW, sz, theme));
    out += row.map((b) => b.svg).join('');
    cy += Math.max(...row.map((b) => b.height)) + rowGap;
  }
  return { svg: out, height: cy - y - rowGap };
}

// Cadena de pasos. Horizontal (póster): círculos numerados unidos por una línea, texto debajo.
// Vertical (carrusel): la línea baja por la izquierda y el texto va al lado.
function flowBlock(steps, x, y, w, sz, theme, { vertical = false } = {}) {
  const R = sz.stepR;
  let out = '';
  if (!vertical) {
    const n = steps.length;
    const colW = w / n;
    const cy0 = y + R;
    out += line(x + colW / 2, cy0, x + w - colW / 2, cy0, theme.rule, 3);
    let maxH = 0;
    steps.forEach((st, i) => {
      const cx = x + colW * i + colW / 2;
      out += `<circle cx="${cx.toFixed(2)}" cy="${cy0.toFixed(2)}" r="${R}" fill="${theme.accent}"/>`;
      out += textEl([String(i + 1)], cx, cy0 + R * 0.36, { size: R, lineH: R, weight: 600, family: DISPLAY, fill: '#ffffff', anchor: 'middle' });
      const head = wrapText(st.head, colW - 20, { size: sz.stepHead, weight: 600, maxLines: 2 });
      const body = wrapText(st.body, colW - 20, { size: sz.stepBody, maxLines: 4 });
      let ty = cy0 + R + sz.stepHead * 1.9;
      out += textEl(head, cx, ty, { size: sz.stepHead, lineH: sz.stepLH, weight: 600, fill: theme.ink, anchor: 'middle' });
      ty += (head.length - 1) * sz.stepLH + sz.stepLH;
      out += textEl(body, cx, ty, { size: sz.stepBody, lineH: sz.stepLH, fill: theme.muted, anchor: 'middle' });
      maxH = Math.max(maxH, ty + (body.length - 1) * sz.stepLH + sz.stepBody * 0.4 - y);
    });
    return { svg: out, height: maxH };
  }
  const tx = x + R * 2 + 28;
  const tw = w - (tx - x);
  let cy = y;
  const centers = [];
  let body = '';
  steps.forEach((st, i) => {
    const head = wrapText(st.head, tw, { size: sz.stepHead, weight: 600, maxLines: 2 });
    const lines = wrapText(st.body, tw, { size: sz.stepBody, maxLines: 4 });
    centers.push(cy + R);
    body += `<circle cx="${(x + R).toFixed(2)}" cy="${(cy + R).toFixed(2)}" r="${R}" fill="${theme.accent}"/>`;
    body += textEl([String(i + 1)], x + R, cy + R + R * 0.36, { size: R, lineH: R, weight: 600, family: DISPLAY, fill: '#ffffff', anchor: 'middle' });
    body += textEl(head, tx, cy + R * 0.55 + sz.stepHead * 0.5, { size: sz.stepHead, lineH: sz.stepLH, weight: 600, fill: theme.ink });
    let ty = cy + R * 0.55 + sz.stepHead * 0.5 + (head.length - 1) * sz.stepLH + sz.stepLH;
    body += textEl(lines, tx, ty, { size: sz.stepBody, lineH: sz.stepLH, fill: theme.muted });
    ty += (lines.length - 1) * sz.stepLH;
    cy = Math.max(cy + R * 2, ty + sz.stepBody * 0.4) + sz.stepLH * 1.3;
  });
  if (centers.length > 1) out += line(x + R, centers[0], x + R, centers[centers.length - 1], theme.rule, 3);
  return { svg: out + body, height: cy - y - sz.stepLH * 1.3 };
}

// Comparativa en tarjetas: una palabra grande en serif, una etiqueta y una frase.
function colsBlock(cols, x, y, w, sz, theme, { perRow = 2 } = {}) {
  const gap = 20;
  const n = Math.min(perRow, cols.length) || 1;
  const cw = (w - gap * (n - 1)) / n;
  const pad = sz.colBody * 1.3;
  let out = '';
  let cy = y;
  for (let r = 0; r < cols.length; r += n) {
    const row = cols.slice(r, r + n).map((c) => {
      const iw = cw - pad * 2 - 6;
      const head = wrapText(c.head, iw, { size: sz.colHead, weight: 600, family: DISPLAY, maxLines: 2 });
      const sub = c.sub ? wrapText(String(c.sub).toUpperCase(), iw, { size: sz.colSub, weight: 600, maxLines: 1 }) : [];
      const body = wrapText(c.body, iw, { size: sz.colBody, maxLines: 6 });
      const h = pad + head.length * sz.colHead * 1.15 + (sub.length ? sz.colSub * 2 : 0) + sz.colLH * 0.5 + body.length * sz.colLH + pad * 0.6;
      return { c, head, sub, body, h };
    });
    const rh = Math.max(...row.map((b) => b.h));
    row.forEach((b, i) => {
      const cx = x + i * (cw + gap);
      out += rect(cx, cy, cw, rh, theme.card, { rx: 16, stroke: theme.rule });
      let ty = cy + pad + sz.colHead * 0.85;
      out += textEl(b.head, cx + pad, ty, { size: sz.colHead, lineH: sz.colHead * 1.15, weight: 600, family: DISPLAY, fill: theme.ink });
      ty += (b.head.length - 1) * sz.colHead * 1.15;
      if (b.sub.length) {
        ty += sz.colSub * 2;
        out += textEl(b.sub, cx + pad, ty, { size: sz.colSub, lineH: sz.colSub * 1.3, weight: 600, fill: theme.accent, spacing: 1.2 });
      }
      ty += sz.colLH * 1.1;
      out += textEl(b.body, cx + pad, ty, { size: sz.colBody, lineH: sz.colLH, fill: theme.soft });
    });
    cy += rh + gap;
  }
  return { svg: out, height: cy - y - gap };
}

// Escala «de menos a más»: cada fila lleva una barra que crece con su posición. Es lo que
// la lista de pastillas NIVEL 1…5 decía con texto y ahora se ve.
function rowsBlock(rows, x, y, w, sz, theme, { columns = 1 } = {}) {
  if (columns > 1 && rows.length > 2) {
    // Dos columnas: la escala se lee de arriba abajo y luego a la derecha; la barra sigue
    // creciendo con la posición GLOBAL, así que el «de menos a más» se conserva.
    const gap = 44;
    const cw = (w - gap) / 2;
    const half = Math.ceil(rows.length / 2);
    const a = rowsBlock(rows.slice(0, half), x, y, cw, sz, theme, { offset: 0, total: rows.length });
    const b = rowsBlock(rows.slice(half), x + cw + gap, y, cw, sz, theme, { offset: half, total: rows.length });
    return { svg: a.svg + b.svg, height: Math.max(a.height, b.height) };
  }
  return rowsColumn(rows, x, y, w, sz, theme, arguments[6] || {});
}

function rowsColumn(rows, x, y, w, sz, theme, { offset = 0, total = rows.length } = {}) {
  const n = total;
  let out = '';
  let cy = y;
  rows.forEach((r, i) => {
    const tag = wrapText(r.tag, w * 0.6, { size: sz.rowTag, weight: 600, maxLines: 1 });
    out += textEl(tag, x, cy + sz.rowTag, { size: sz.rowTag, lineH: sz.rowTag, weight: 600, fill: theme.ink });
    const by = cy + sz.rowTag * 1.55;
    const frac = (offset + i + 1) / n;
    out += rect(x, by, w, sz.bar, theme.tint, { rx: sz.bar / 2 });
    out += rect(x, by, w * frac, sz.bar, theme.accent, { rx: sz.bar / 2, opacity: (0.45 + 0.55 * frac).toFixed(2) });
    const body = wrapText(r.body, w, { size: sz.rowBody, maxLines: 3 });
    const ty = by + sz.bar + sz.rowLH;
    out += textEl(body, x, ty, { size: sz.rowBody, lineH: sz.rowLH, fill: theme.soft });
    cy = ty + (body.length - 1) * sz.rowLH + sz.rowLH * 1.2;
  });
  return { svg: out, height: cy - y - sz.rowLH * 1.2 + sz.rowBody * 0.4 };
}

// Las dos notas de cierre (aviso del libro e idea final), en tarjetas tintadas.
function asideBlock(items, x, y, w, sz, theme, { stacked = false } = {}) {
  const gap = 20;
  const n = stacked ? 1 : items.length || 1;
  const cw = (w - gap * (n - 1)) / n;
  const pad = sz.asideBody * 1.2;
  const blocks = items.map((a) => {
    const body = wrapText(a.body, cw - pad * 2 - 6, { size: sz.asideBody, maxLines: 6 });
    return { a, body, h: pad + sz.asideLabel * 1.3 + sz.asideLH * 0.6 + body.length * sz.asideLH + pad * 0.5 };
  });
  let out = '';
  let cy = y;
  if (stacked) {
    blocks.forEach((b) => { out += aside1(b, x, cy, cw, b.h); cy += b.h + gap; });
    return { svg: out, height: cy - y - gap };
  }
  const rh = Math.max(0, ...blocks.map((b) => b.h));
  blocks.forEach((b, i) => { out += aside1(b, x + i * (cw + gap), y, cw, rh); });
  return { svg: out, height: rh };

  function aside1(b, bx, by, bw, bh) {
    let s = rect(bx, by, bw, bh, theme.tint, { rx: 16 });
    s += textEl([String(b.a.label || '').toUpperCase()], bx + pad, by + pad + sz.asideLabel * 0.4, {
      size: sz.asideLabel, lineH: sz.asideLabel, weight: 600, fill: theme.accent, spacing: 1.4,
    });
    s += textEl(b.body, bx + pad, by + pad + sz.asideLabel * 1.3 + sz.asideLH * 0.6, {
      size: sz.asideBody, lineH: sz.asideLH, fill: theme.ink,
    });
    return s;
  }
}

// Pie con procedencia: libro · autor a la izquierda; logo + marca + url a la derecha.
function footerRow(data, x, y, w, color, size, { onDark = false } = {}) {
  const ft = data.footer;
  if (!ft) return '';
  const ftObj = typeof ft === 'object' ? ft : null;
  const mark = String((ftObj ? ftObj.mark : ft) || 'BookReader').toUpperCase();
  const who = [ftObj && ftObj.title ? ftObj.title : data.title, ftObj && ftObj.author ? ftObj.author : data.author]
    .filter(Boolean).join(' · ').toUpperCase();
  const url = ftObj && ftObj.url ? ftObj.url : '';
  const foot = { size, lineH: size, weight: 600, fill: color, spacing: 1.4, opacity: onDark ? 0.75 : 0.85 };
  let out = '';
  if (who) out += textEl([who], x, y, foot);
  const right = [mark, url].filter(Boolean).join('  ·  ');
  const rw = measure(right, size, 600, FONT) + right.length * 1.4;
  out += textEl([right], x + w, y, { ...foot, anchor: 'end' });
  const L = size * 1.9;
  out += logo(x + w - rw - L - 12, y - L * 0.78, L);
  return out;
}

// Banda de la cita, a sangre, en el color del libro.
function quoteBand(data, y, width, sz, theme, { sizes, pad = 56, footerSize = 11 } = {}) {
  const qx = 72;
  const qw = width - qx * 2;
  const q = fitDisplay(`“${data.quote.text}”`, qw, { sizes, weight: 600, family: DISPLAY, maxLines: 4 });
  const attr = data.quote.attribution
    ? wrapText(String(data.quote.attribution).toUpperCase(), qw, { size: sz.label * 0.9, weight: 600, maxLines: 2 })
    : [];
  const hasFoot = !!data.footer;
  const h = pad + q.size * 1.18 * q.lines.length + (attr.length ? 24 + attr.length * sz.label * 1.3 : 0) + pad + (hasFoot ? 56 : 0);
  let out = rect(0, y, width, h, theme.deep);
  let qy = y + pad + q.size;
  out += textEl(q.lines, width / 2, qy, { size: q.size, lineH: q.size * 1.18, weight: 600, family: DISPLAY, fill: '#ffffff', anchor: 'middle' });
  if (attr.length) {
    qy += q.size * 1.18 * (q.lines.length - 1) + 24 + sz.label;
    out += textEl(attr, width / 2, qy, { size: sz.label * 0.9, lineH: sz.label * 1.3, weight: 600, fill: theme.accentOnBand, anchor: 'middle', spacing: 1.4 });
  }
  if (hasFoot) out += footerRow(data, M, y + h - 26, width - M * 2, '#ffffff', footerSize, { onDark: true });
  return { svg: out, height: h };
}

// Portada con su proporción real y sombra suave.
function coverImg(data, x, y, h) {
  const w = Math.round(h * (data.coverAspect || 2 / 3));
  return {
    svg:
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="#d9d9de" filter="url(#ig-shadow)"/>` +
      `<image href="${esc(data.cover)}" x="${x}" y="${y}" width="${w}" height="${h}"` +
      ` preserveAspectRatio="xMidYMid slice" clip-path="inset(0 round 6px)"/>`,
    w,
  };
}

const SHADOW_DEFS =
  '<filter id="ig-shadow" x="-20%" y="-20%" width="140%" height="150%">' +
  '<feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#000" flood-opacity="0.12"/>' +
  '<feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000" flood-opacity="0.18"/></filter>';

// ---- Póster largo (leer con zoom, imprimir) ---------------------------------------------

const COVER_H = 450;

function build(data, theme) {
  const width = BASE_W;
  const m = M;
  const content = width - m * 2;
  const sz = SZ_POSTER;
  let out = '';
  let y = m;

  // Hero: portada + antetítulo, titular, autor y la TESIS en grande (es el mensaje central).
  const cover = data.cover ? coverImg(data, m, y, COVER_H) : null;
  if (cover) out += cover.svg;
  const tx = m + (cover ? cover.w + 44 : 0);
  const tw = content - (cover ? cover.w + 44 : 0);
  let hy = y + 6;
  if (data.kicker) {
    const k = wrapText(String(data.kicker).toUpperCase(), tw, { size: 14, weight: 600, maxLines: 2 });
    out += textEl(k, tx, hy + 14, { size: 14, lineH: 20, weight: 600, fill: theme.accent, spacing: 1.8 });
    hy += 14 + k.length * 20 + 6;
  }
  const title = fitDisplay(String(data.title || ''), tw, { sizes: cover ? [60, 54, 48, 42, 36] : [76, 68, 60, 52, 44], weight: 600, family: DISPLAY, maxLines: 3 });
  out += textEl(title.lines, tx, hy + title.size * 0.92, { size: title.size, lineH: title.size * 1.08, weight: 600, family: DISPLAY, fill: theme.ink });
  hy += title.size * 1.08 * title.lines.length + 4;
  if (data.author) {
    out += textEl([data.author], tx, hy + 22, { size: 20, lineH: 24, fill: theme.muted });
    hy += 36;
  }
  // El filete del color del libro cierra siempre el titular (haya tesis o no): es la firma
  // del acento en el hero.
  hy += 22;
  out += line(tx, hy, tx + 48, hy, theme.accent, 3);
  if (data.thesis) {
    const thesisW = Math.min(tw, 760);
    const tl = wrapText(data.thesis, thesisW, { size: 24, family: DISPLAY, maxLines: cover ? 8 : 6 });
    out += textEl(tl, tx, hy + 40, { size: 24, lineH: 35, family: DISPLAY, fill: theme.ink });
    hy += 40 + (tl.length - 1) * 35 + 10;
  }
  y = Math.max(y + (cover ? COVER_H : 0), hy) + 64;

  // Ideas clave, a todo el ancho y en dos columnas alineadas por filas.
  const items = data.ideas || [];
  if (items.length) {
    const h = sectionHead(m, y, content, data.ideasTitle || 'Ideas clave', sz, theme);
    out += h.svg;
    y += h.height + 8;
    const g = ideasGrid(items, m, y, content, sz, theme, { cols: 2, rowGap: 24 });
    out += g.svg;
    y += g.height + 52;
  }

  for (const p of data.panels || []) {
    const h = sectionHead(m, y, content, p.title, sz, theme);
    out += h.svg;
    y += h.height + 16;
    const list = p.steps || p.cols || p.rows || p.items || [];
    const b = p.kind === 'flow' ? flowBlock(list, m, y, content, sz, theme)
      : p.kind === 'cols' ? colsBlock(list, m, y, content, sz, theme, { perRow: list.length === 3 ? 3 : 2 })
        : rowsBlock(list, m, y, content, sz, theme, { columns: 2 });
    out += b.svg;
    y += b.height + 52;
  }

  const aside = data.aside || [];
  if (aside.length) {
    const b = asideBlock(aside, m, y, content, sz, theme);
    out += b.svg;
    y += b.height + 56;
  }

  if (data.quote && data.quote.text) {
    const q = quoteBand(data, y, width, sz, theme, { sizes: [40, 36, 32, 28, 24] });
    out += q.svg;
    y += q.height;
  } else if (data.footer) {
    out += footerRow(data, m, y + 10, content, theme.ink, 11);
    y += 48;
  }
  return { body: out, height: Math.round(y) };
}

function wrapSvg(width, height, body, theme, { fontCss = '', title = '', bg } = {}) {
  const defs = `<defs>${fontCss ? `<style>${fontCss}</style>` : ''}${SHADOW_DEFS}</defs>`;
  const str =
    `<svg xmlns="${SVG_NS}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"` +
    ` role="img" aria-label="${esc(title)}" style="display:block;max-width:100%;height:auto">` +
    defs +
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${bg || theme.paper}"/>` +
    body +
    '</svg>';
  const doc = new DOMParser().parseFromString(str, 'image/svg+xml');
  return { svg: doc.documentElement, width, height };
}

// Construye el SVG del póster largo. `fontCss` (de `ui/svg-fonts.js`) embebe las fuentes para
// que el PNG rasterizado —que carga el SVG como `<img>`— salga igual que la pantalla.
export function renderSvg(data, { theme = POSTER, fontCss = '', title = '' } = {}) {
  const th = themeFor(data.accent || theme.accent, theme);
  const built = build(data, th);
  return wrapSvg(BASE_W, built.height, built.body, th, { fontCss, title: title || data.title || 'Infografía' });
}

// ---- Carrusel 4:5 (1080×1350) ------------------------------------------------------------

export const SLIDE = { w: 1080, h: 1350 };
export const STORY = { w: 1080, h: 1920 };
const SM = 84; // margen de diapositiva

// Marco común: cabecera (libro + nº de diapositiva) y pie (logo + marca + url).
function slideFrame(data, theme, idx, total) {
  const W = SLIDE.w, H = SLIDE.h;
  let out = '';
  const top = String(data.title || '').toUpperCase();
  const tl = wrapText(top, W - SM * 2 - 120, { size: 18, weight: 600, maxLines: 1 });
  out += textEl(tl, SM, 78, { size: 18, lineH: 18, weight: 600, fill: theme.muted, spacing: 1.6 });
  out += textEl([`${idx} / ${total}`], W - SM, 78, { size: 18, lineH: 18, weight: 600, fill: theme.muted, anchor: 'end' });
  const L = 40;
  out += logo(SM, H - 64 - L * 0.8, L);
  out += textEl(['BookReader'], SM + L + 14, H - 64, { size: 22, lineH: 22, weight: 600, fill: theme.ink });
  const url = data.footer && typeof data.footer === 'object' ? data.footer.url : '';
  if (url) out += textEl([url], W - SM, H - 64, { size: 20, lineH: 20, fill: theme.muted, anchor: 'end' });
  return out;
}

// Encaja un bloque en el alto disponible encogiendo la escala de tipos si hace falta: una
// diapositiva no puede desbordar (se cortaría al publicarla).
function fitBlock(draw, avail) {
  // Primero CRECE (una diapositiva con poco texto no debe quedar medio vacía) y luego encoge.
  for (const k of [1.3, 1.2, 1.1, 1, 0.92, 0.85, 0.78, 0.72, 0.66, 0.6]) {
    const b = draw(scaleSz(SZ_SLIDE, k));
    if (b.height <= avail) return b;
  }
  return draw(scaleSz(SZ_SLIDE, 0.55));
}

function contentSlide(data, theme, kicker, title, draw) {
  const W = SLIDE.w;
  let out = '';
  let y = 170;
  out += textEl([String(kicker).toUpperCase()], SM, y, { size: 22, lineH: 22, weight: 600, fill: theme.accent, spacing: 2 });
  y += 26;
  const t = fitDisplay(String(title || ''), W - SM * 2, { sizes: [60, 54, 48, 42], weight: 600, family: DISPLAY, maxLines: 2 });
  out += textEl(t.lines, SM, y + t.size, { size: t.size, lineH: t.size * 1.1, weight: 600, family: DISPLAY, fill: theme.ink });
  y += t.size * 1.1 * t.lines.length + 50;
  const avail = SLIDE.h - 150 - y;
  const b = fitBlock((sz) => draw(SM, y, W - SM * 2, sz), avail);
  return out + b.svg;
}

export function renderSlides(data, { theme = POSTER, fontCss = '', title = '' } = {}) {
  const th = themeFor(data.accent || theme.accent, theme);
  const W = SLIDE.w, H = SLIDE.h;
  const slides = []; // [{ body, bg }]

  // 1 · Portada: fondo del color del libro, la cubierta grande y el título.
  {
    let out = '';
    let y = 150;
    if (data.cover) {
      const ch = 560;
      const cw = Math.round(ch * (data.coverAspect || 2 / 3));
      out += coverImg(data, (W - cw) / 2, y, ch).svg;
      y += ch + 70;
    }
    const t = fitDisplay(String(data.title || ''), W - SM * 2, { sizes: data.cover ? [76, 68, 60, 52, 44] : [96, 86, 76, 66, 56], weight: 600, family: DISPLAY, maxLines: 3 });
    // Sin portada, el título se centra en la diapositiva (arriba dejaba media página vacía).
    if (!data.cover) y = (H - t.size * 1.08 * t.lines.length) / 2 - 60;
    out += textEl(t.lines, W / 2, y + t.size * 0.9, { size: t.size, lineH: t.size * 1.08, weight: 600, family: DISPLAY, fill: '#ffffff', anchor: 'middle' });
    y += t.size * 1.08 * t.lines.length + 10;
    if (data.author) out += textEl([data.author], W / 2, y + 30, { size: 30, lineH: 30, fill: th.accentOnBand, anchor: 'middle' });
    const n = (data.ideas || []).length;
    const hint = n ? `${n} ideas clave  →` : 'Desliza  →';
    out += textEl([hint.toUpperCase()], W / 2, H - 150, { size: 22, lineH: 22, weight: 600, fill: '#ffffff', anchor: 'middle', spacing: 2, opacity: 0.85 });
    const L = 40;
    out += logo(W / 2 - 100, H - 96 - L * 0.8, L);
    out += textEl(['BookReader'], W / 2 - 100 + L + 14, H - 96, { size: 22, lineH: 22, weight: 600, fill: '#ffffff' });
    slides.push({ body: out, bg: th.deep, raw: true });
  }

  // 2 · La tesis, grande.
  if (data.thesis) {
    const body = (() => {
      let out = textEl(['LA TESIS'], SM, 230, { size: 22, lineH: 22, weight: 600, fill: th.accent, spacing: 2 });
      out += line(SM, 262, SM + 64, 262, th.accent, 4);
      const t = fitDisplay(data.thesis, W - SM * 2, { sizes: [56, 50, 46, 42, 38, 34], weight: 400, family: DISPLAY, maxLines: 9 });
      out += textEl(t.lines, SM, 340 + t.size * 0.9, { size: t.size, lineH: t.size * 1.32, family: DISPLAY, fill: th.ink });
      return out;
    })();
    slides.push({ body });
  }

  // 3 · Ideas, de tres en tres.
  const ideas = data.ideas || [];
  const per = 3;
  for (let i = 0; i < ideas.length; i += per) {
    const chunk = ideas.slice(i, i + per);
    const kicker = `${i + 1}–${i + chunk.length} de ${ideas.length}`;
    slides.push({ body: contentSlide(data, th, kicker, data.ideasTitle || 'Ideas clave',
      (x, y, w, sz) => ideasGrid(chunk, x, y, w, sz, th, { cols: 1, rowGap: sz.bodyLH * 1.4, start: i })) });
  }

  // 4 · Un panel por diapositiva.
  for (const p of data.panels || []) {
    const list = p.steps || p.cols || p.rows || p.items || [];
    const kicker = p.kind === 'flow' ? 'Paso a paso' : p.kind === 'cols' ? 'Comparativa' : 'De menos a más';
    slides.push({ body: contentSlide(data, th, kicker, p.title, (x, y, w, sz) =>
      p.kind === 'flow' ? flowBlock(list, x, y, w, sz, th, { vertical: true })
        : p.kind === 'cols' ? colsBlock(list, x, y, w, sz, th, { perRow: 2 })
          : rowsBlock(list, x, y, w, sz, th)) });
  }

  // 5 · Para recordar (las dos notas de cierre).
  const aside = data.aside || [];
  if (aside.length) {
    slides.push({ body: contentSlide(data, th, 'Para recordar', aside.length > 1 ? aside[aside.length - 1].label : aside[0].label,
      (x, y, w, sz) => asideBlock(aside, x, y, w, sz, th, { stacked: true })) });
  }

  // 6 · Cierre: la cita sobre el color del libro y la invitación a la app.
  if (data.quote && data.quote.text) {
    let out = '';
    const q = fitDisplay(`“${data.quote.text}”`, W - SM * 2, { sizes: [64, 58, 52, 46, 40], weight: 600, family: DISPLAY, maxLines: 6 });
    const qh = q.size * 1.2 * q.lines.length;
    let y = (H - qh) / 2 - 60;
    out += textEl(q.lines, W / 2, y + q.size, { size: q.size, lineH: q.size * 1.2, weight: 600, family: DISPLAY, fill: '#ffffff', anchor: 'middle' });
    y += qh + 40;
    if (data.quote.attribution) {
      const a = wrapText(String(data.quote.attribution).toUpperCase(), W - SM * 2, { size: 22, weight: 600, maxLines: 2 });
      out += textEl(a, W / 2, y + 22, { size: 22, lineH: 30, weight: 600, fill: th.accentOnBand, anchor: 'middle', spacing: 1.6 });
    }
    const url = data.footer && typeof data.footer === 'object' ? data.footer.url : '';
    out += textEl(['Lee así cualquier libro'], W / 2, H - 170, { size: 30, lineH: 30, weight: 600, fill: '#ffffff', anchor: 'middle' });
    if (url) out += textEl([url], W / 2, H - 126, { size: 24, lineH: 24, fill: th.accentOnBand, anchor: 'middle' });
    const L = 44;
    out += logo(W / 2 - L / 2, 110, L);
    slides.push({ body: out, bg: th.deep, raw: true });
  }

  const total = slides.length;
  return slides.map((s, i) => {
    const body = s.raw ? s.body : slideFrame(data, th, i + 1, total) + s.body;
    return wrapSvg(W, H, body, th, { fontCss, bg: s.bg, title: `${title || data.title || 'Infografía'} · ${i + 1}/${total}` });
  });
}

// ---- Story 9:16 (1080×1920) --------------------------------------------------------------
// Una sola imagen para stories: portada + título, la tesis, las ideas en rótulo y la cita.
export function renderStory(data, { theme = POSTER, fontCss = '', title = '' } = {}) {
  const th = themeFor(data.accent || theme.accent, theme);
  const W = STORY.w, H = STORY.h;
  const draw = (k) => {
    const sz = scaleSz(SZ_SLIDE, k);
    let out = '';
    let y = 120;
    if (data.cover) {
      const ch = Math.round(360 * k);
      out += coverImg(data, SM, y, ch).svg;
      const cw = Math.round(ch * (data.coverAspect || 2 / 3));
      const tx = SM + cw + 40;
      const t = fitDisplay(String(data.title || ''), W - tx - SM, { sizes: [58, 52, 46, 40, 34].map((v) => v * k), weight: 600, family: DISPLAY, maxLines: 4 });
      out += textEl(t.lines, tx, y + 40 + t.size * 0.9, { size: t.size, lineH: t.size * 1.08, weight: 600, family: DISPLAY, fill: th.ink });
      if (data.author) out += textEl([data.author], tx, y + 40 + t.size * 1.08 * t.lines.length + 30, { size: 28 * k, lineH: 28, fill: th.muted });
      y += ch + 70 * k;
    } else {
      const t = fitDisplay(String(data.title || ''), W - SM * 2, { sizes: [80, 70, 60, 50].map((v) => v * k), weight: 600, family: DISPLAY, maxLines: 3 });
      out += textEl(t.lines, SM, y + t.size, { size: t.size, lineH: t.size * 1.08, weight: 600, family: DISPLAY, fill: th.ink });
      y += t.size * 1.08 * t.lines.length + 50 * k;
    }
    if (data.thesis) {
      out += line(SM, y, SM + 64, y, th.accent, 4);
      const tl = wrapText(data.thesis, W - SM * 2, { size: 36 * k, family: DISPLAY, maxLines: 7 });
      out += textEl(tl, SM, y + 56 * k, { size: 36 * k, lineH: 50 * k, family: DISPLAY, fill: th.ink });
      y += 56 * k + (tl.length - 1) * 50 * k + 70 * k;
    }
    const ideas = (data.ideas || []).slice(0, 5);
    if (ideas.length) {
      const h = sectionHead(SM, y, W - SM * 2, data.ideasTitle || 'Ideas clave', sz, th);
      out += h.svg;
      y += h.height + 10;
      ideas.forEach((it, i) => {
        out += textEl([String(i + 1)], SM, y + sz.num * 0.62, { size: sz.num * 0.72, lineH: sz.num, weight: 600, family: DISPLAY, fill: th.accent });
        const tx = SM + sz.num * 0.9;
        const tw = W - SM - tx;
        const hl = wrapText(it.head, tw, { size: sz.head * 1.05, weight: 600, maxLines: 2 });
        out += textEl(hl, tx, y + sz.head * 1.25, { size: sz.head * 1.05, lineH: sz.headLH * 1.05, weight: 600, fill: th.ink });
        let iy = y + sz.head * 1.25 + (hl.length - 1) * sz.headLH * 1.05;
        // Una línea del cuerpo: en una story se lee el rótulo; el cuerpo solo lo ancla.
        const bl = wrapText(it.body, tw, { size: sz.body * 0.9, maxLines: 2 });
        if (bl.length) {
          iy += sz.bodyLH * 0.95;
          out += textEl(bl, tx, iy, { size: sz.body * 0.9, lineH: sz.bodyLH * 0.9, fill: th.muted });
          iy += (bl.length - 1) * sz.bodyLH * 0.9;
        }
        y = Math.max(y + sz.num * 0.8, iy + sz.body * 0.4) + 30 * k;
      });
      y += 30 * k;
    }
    return { out, y };
  };
  // La cita va abajo, a sangre; primero se mide (a y=0) para saber cuánto alto reserva.
  const hasQuote = !!(data.quote && data.quote.text);
  const qOpts = { sizes: [50, 44, 38, 34, 30], pad: 60, footerSize: 16 };
  const qSz = scaleSz(SZ_SLIDE, 0.8);
  const qh = hasQuote ? quoteBand(data, 0, W, qSz, th, qOpts).height : 120;
  let k = 1.2;
  let r = draw(k);
  // Si el contenido no cabe sobre la cita, se encoge todo (nunca se recorta).
  while (r.y > H - qh - 40 && k > 0.6) { k -= 0.05; r = draw(k); }
  let out = r.out;
  if (hasQuote) {
    out += quoteBand(data, H - qh, W, qSz, th, qOpts).svg;
  } else if (data.footer) {
    out += footerRow(data, SM, H - 80, W - SM * 2, th.ink, 18);
  }
  return wrapSvg(W, H, out, th, { fontCss, title: title || data.title || 'Infografía' });
}
