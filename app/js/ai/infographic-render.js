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
// ESCALA: el póster se dibuja a 1080 px de ancho (9:16, legible en móvil y en stories). La
// densidad es EL riesgo del artefacto: diez bloques a tamaño póster se convierten en papilla
// a 380 px — el ancho real de un feed. Por eso el póster es un activo de TAMAÑO FIJO (1080 px)
// que se ENCOGE por CSS para previsualizarlo: cambiar el ancho reflowaría la rejilla, y una
// infografía es una composición, no una página responsive. El prototipo enseña la misma
// composición a tamaño de feed antes de dar por buena cualquier densidad.

import { iconBody } from '../ui/icons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Medidas base a 1080. El póster se compone SIEMPRE a este ancho: para verlo pequeño se
// escala (CSS o canvas), no se rehace el layout.
const BASE_W = 1080;
const M = 56; // margen
const BAND_H = 46; // alto de la franja de título de un panel
const PANEL_PAD = 22;
const FONT = 'Inter, system-ui, sans-serif';
const DISPLAY = "'Source Serif 4', Georgia, serif";

// Tokens de marca (los mismos que `mindmap-render.js` y `share-card.js`: lo que se publica
// se ve igual venga de donde venga). `accent` va en su tono 700 — el emerald de la UI
// (#22c55e) no llega a 3:1 sobre papel y aquí se usa para texto pequeño.
export const POSTER = {
  bg: '#faf8f3',
  ink: '#2b2b2b',
  soft: '#514b42',
  muted: '#7a736a',
  line: '#e6e1d8',
  band: '#26241f',
  bandInk: '#f6f3ec',
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

// Un glifo de `ui/icons.js` dentro de un `<g>` con su propio trazo: en un SVG anidado no hay
// `currentColor` que heredar, así que el color y el grosor se fijan aquí. El `stroke-width`
// se divide por la escala para que el trazo óptico sea constante sea cual sea el tamaño.
function glyph(name, x, y, size, color, stroke = 1.7) {
  const body = iconBody(name);
  if (!body) return '';
  const s = size / 24;
  const sw = (stroke / s).toFixed(3);
  return (
    `<g transform="translate(${x} ${y}) scale(${s})" fill="none" stroke="${color}"` +
    ` stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${body}</g>`
  );
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

// ---- Bloques ---------------------------------------------------------------------------
// Cada bloque devuelve `{ svg, height }`. El alto se CALCULA del texto medido, nunca se
// estima: es lo que permite apilar paneles sin que se pisen.

// Franja oscura de título de panel: el recurso que separa "secciones" en el póster.
// Franja oscura de título de panel: el recurso que separa "secciones" en el póster. El
// titular se ENCOGE si no cabe: el `letter-spacing` (1.6 px aquí) no entra en `measureText`,
// así que un rótulo largo desbordaba la franja por muy centrado que estuviera.
function band(x, y, w, label, theme) {
  let text = String(label).toUpperCase();
  // Encoge hasta 11 px, nunca menos: un rótulo a 9 px canta. Si aun así no cabe, recorta.
  const fits = (t, s) => measure(t, s, 600, FONT) + t.length * 1.6 <= w - 24;
  let size = 13;
  while (size > 11 && !fits(text, size)) size -= 0.5;
  while (text.length > 4 && !fits(text, size)) text = `${text.slice(0, -1).trimEnd()}…`;
  const svg =
    rect(x, y, w, BAND_H, theme.band, { rx: 4 }) +
    `<text x="${x + w / 2}" y="${y + BAND_H / 2 + 5}" text-anchor="middle" font-family="${FONT}"` +
    ` font-size="${size}" font-weight="600" letter-spacing="1.6" fill="${theme.bandInk}">${esc(text)}</text>`;
  return svg;
}

// 1..N ideas clave. Cabecera (icono + número + rótulo) y cuerpo, con filete separador.
function ideasBody(items, x, y, w, theme, { startIndex = 0 } = {}) {
  const NUM_X = 26; // hueco del número tras el icono
  const TEXT_X = 62; // dónde empiezan rótulo y cuerpo
  const bodyW = w - TEXT_X;
  let out = '',
    cy = y;
  items.forEach((it, i) => {
    const headLines = wrapText(it.head, bodyW, { size: 12.5, weight: 600, maxLines: 2 });
    const bodyLines = wrapText(it.body, bodyW, { size: 13, maxLines: 8 });
    const headH = Math.max(22, headLines.length * 16);
    out += glyph(it.ico || 'note', x, cy - 2, 19, theme.accent, 1.6);
    out += textEl([String(startIndex + i + 1)], x + NUM_X, cy + 15, {
      size: 19,
      lineH: 19,
      weight: 600,
      family: DISPLAY,
      fill: theme.accent,
    });
    out += textEl(headLines, x + TEXT_X, cy + 13, {
      size: 12.5,
      lineH: 16,
      weight: 600,
      fill: theme.ink,
      spacing: 0.5,
    });
    out += textEl(bodyLines, x + TEXT_X, cy + headH + 15, {
      size: 13,
      lineH: 19,
      weight: 400,
      fill: theme.muted,
    });
    cy += headH + bodyLines.length * 19 + 8;
    out += line(x, cy, x + w, cy, theme.line);
    cy += 14;
  });
  return { svg: out, height: cy - y - 14 };
}

// Cadena de pasos con flechas. Es el "cómo encadena el argumento" del libro.
function flowBody(steps, x, y, w, theme) {
  const n = steps.length;
  const arrowW = 26;
  const colW = (w - arrowW * (n - 1)) / n;
  let out = '';
  let maxH = 0;
  steps.forEach((st, i) => {
    const cx = x + i * (colW + arrowW);
    const headLines = wrapText(st.head, colW - 6, { size: 12, weight: 600, maxLines: 2 });
    const bodyLines = wrapText(st.body, colW - 6, { size: 11.5, weight: 400, maxLines: 4 });
    // El icono se centra dentro de una caja de alto fijo 30: así todos los rótulos de la
    // fila comparten línea base aunque unos glifos sean más altos que otros.
    out += glyph(st.ico || 'target', cx + colW / 2 - 13, y, 26, theme.ink, 1.5);
    const headY = y + 30 + 12;
    out += textEl(headLines, cx + colW / 2, headY, {
      size: 12,
      lineH: 15,
      weight: 600,
      fill: theme.ink,
      anchor: 'middle',
      spacing: 0.3,
    });
    const bodyY = headY + headLines.length * 15 + 3;
    out += textEl(bodyLines, cx + colW / 2, bodyY, {
      size: 11.5,
      lineH: 16,
      weight: 400,
      fill: theme.muted,
      anchor: 'middle',
    });
    maxH = Math.max(maxH, bodyY + bodyLines.length * 16 - y);
    if (i < n - 1) {
      const ax = cx + colW + 4,
        ay = y + 13,
        ax2 = ax + arrowW - 8;
      out += line(ax, ay, ax2, ay, theme.muted, 1.4);
      out += `<path d="M ${ax2 - 5} ${ay - 4} L ${ax2} ${ay} L ${ax2 - 5} ${ay + 4}" fill="none" stroke="${theme.muted}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
  });
  return { svg: out, height: maxH };
}

// Columnas comparadas (trampas, escenarios, "por qué unos sí y otros no").
function colsBody(cols, x, y, w, theme) {
  const n = cols.length;
  const colW = w / n;
  const pad = 12;
  const innerW = colW - pad * 2;
  let out = '';
  let maxH = 0;
  cols.forEach((c, i) => {
    const cx = x + i * colW;
    const tx0 = cx + pad;
    const headLines = wrapText(c.head, innerW, { size: 11.5, weight: 600, maxLines: 2 });
    const subLines = c.sub ? wrapText(c.sub, innerW, { size: 10.5, weight: 400, maxLines: 2 }) : [];
    const bodyLines = wrapText(c.body, innerW, { size: 11, weight: 400, maxLines: 7 });
    // Alineado a la izquierda, no centrado: un párrafo centrado de varias líneas se barre peor
    // (y estas columnas llegan a 6 líneas).
    out += glyph(c.ico || 'target', tx0, y, 22, theme.ink, 1.4);
    let cy = y + 26 + 12;
    out += textEl(headLines, tx0, cy, {
      size: 11.5,
      lineH: 14.5,
      weight: 600,
      fill: theme.ink,
      spacing: 0.2,
    });
    cy += headLines.length * 14.5 + (subLines.length ? 2 : 0);
    if (subLines.length) {
      out += textEl(subLines, tx0, cy + 2, {
        size: 10.5,
        lineH: 13.5,
        weight: 400,
        fill: theme.accent,
      });
      cy += subLines.length * 13.5 + 4;
    }
    cy += 3;
    out += textEl(bodyLines, tx0, cy + 4, {
      size: 11,
      lineH: 16,
      weight: 400,
      fill: theme.muted,
    });
    maxH = Math.max(maxH, cy + 4 + bodyLines.length * 16 - y);
  });
  // Filetes verticales, ya con el alto real conocido.
  let seps = '';
  for (let i = 1; i < n; i++) {
    const sx = x + i * colW;
    seps += line(sx, y + 2, sx, y + maxH - 2, theme.line);
  }
  return { svg: seps + out, height: maxH };
}

// Filas con etiqueta en pastilla + explicación. "Dónde tocar, de menos a más potente".
function rowsBody(rows, x, y, w, theme, { columns = 1 } = {}) {
  const n = Math.max(1, Math.min(columns, rows.length || 1));
  const gapX = 40;
  const colW = (w - gapX * (n - 1)) / n;
  const per = Math.ceil(rows.length / n);
  let maxH = 0;
  let svg = '';
  for (let c = 0; c < n; c++) {
    const group = rows.slice(c * per, (c + 1) * per);
    const cx = x + c * (colW + gapX);
    let cy = y;
    for (const r of group) {
      const tag = String(r.tag || '').toUpperCase();
      // El ancho de la pastilla suma el `letter-spacing` (0.6 px/glifo), que `measureText` no ve.
      const tagW = Math.max(64, measure(tag, 10.5, 600, FONT) + tag.length * 0.6 + 24);
      const bodyLines = wrapText(r.body, colW - tagW - 14, { size: 12.5, maxLines: 5 });
      svg += rect(cx, cy, tagW, 22, theme.band, { rx: 11 });
      svg += `<text x="${cx + tagW / 2}" y="${cy + 15}" text-anchor="middle" font-family="${FONT}" font-size="10.5" font-weight="600" letter-spacing="0.6" fill="${theme.bandInk}">${esc(tag)}</text>`;
      svg += textEl(bodyLines, cx + tagW + 14, cy + 15, {
        size: 12.5,
        lineH: 18,
        weight: 400,
        fill: theme.soft,
      });
      cy += Math.max(22, bodyLines.length * 18) + 12;
    }
    maxH = Math.max(maxH, cy - y - 12);
  }
  return { svg, height: maxH };
}

const BODIES = { ideas: ideasBody, flow: flowBody, cols: colsBody, rows: rowsBody };

// Panel = franja de título + cuerpo, todo dentro de una tarjeta blanca con borde fino.
function panel(x, y, w, { title, kind, items, steps, cols, rows }, theme) {
  const bodyArgs = { ideas: items, flow: steps, cols, rows }[kind] || items || [];
  const fn = BODIES[kind] || ideasBody;
  const innerX = x + PANEL_PAD;
  const innerW = w - PANEL_PAD * 2;
  // A todo el ancho, una lista de filas en una sola columna daría líneas de ~130 caracteres.
  const opts = kind === 'rows' && innerW > 700 ? { columns: 2 } : {};
  const body = fn(bodyArgs || [], innerX, y + BAND_H + PANEL_PAD, innerW, theme, opts);
  const h = BAND_H + PANEL_PAD + body.height + PANEL_PAD;
  const svg =
    rect(x, y, w, h, theme.card, { rx: 6, stroke: theme.line }) +
    band(x, y, w, title, theme) +
    body.svg;
  return { svg, height: h };
}

// ---- Composición -----------------------------------------------------------------------

function build(data, theme) {
  const width = BASE_W;
  const m = M;
  const content = width - m * 2;

  let out = '';
  let y = m;

  // ---- Hero: portada (si la hay) + titular + tesis ----
  // El marco toma la PROPORCIÓN REAL de la cubierta (`coverAspect`), con 450 px de alto fijo:
  // una tapa de 7:9 no se recorta por meterla a la fuerza en un marco 2:3. Si no llega el
  // dato, se asume 2:3 (el estándar) y `slice` recortaría lo mínimo.
  const coverH = data.cover ? 450 : 0;
  const coverW = data.cover ? Math.round(coverH * (data.coverAspect || 2 / 3)) : 0;
  const tx = m + (coverW ? coverW + 36 : 0);
  const tw = content - (coverW ? coverW + 36 : 0);

  if (data.cover) {
    out += rect(m, y, coverW, coverH, theme.line, { rx: 4 });
    out +=
      `<image href="${esc(data.cover)}" x="${m}" y="${y}" width="${coverW}" height="${coverH}"` +
      ` preserveAspectRatio="xMidYMid slice" clip-path="inset(0 round ${4}px)"/>`;
  }

  let hy = y + 10;
  if (data.kicker) {
    out += textEl([String(data.kicker).toUpperCase()], tx, hy + 11, {
      size: 14,
      lineH: 16,
      weight: 600,
      fill: theme.ink,
      spacing: 2,
    });
    hy += 28;
  }
  const title = fitDisplay(String(data.title || '').toUpperCase(), tw, {
    sizes: [76, 70, 64, 56, 48, 40],
    weight: 600,
    family: DISPLAY,
    maxLines: 2,
  });
  out += textEl(title.lines, tx, hy + title.size, {
    size: title.size,
    lineH: title.size * 1.06,
    weight: 600,
    family: DISPLAY,
    fill: theme.ink,
  });
  hy += title.size * 1.06 * title.lines.length + 10;

  // Filete con rombo: el recurso gráfico que cierra el titular en la referencia.
  const ruleY = hy;
  out += line(tx, ruleY, tx + tw, ruleY, theme.line, 1);
  const d = 8,
    dcx = tx + tw / 2;
  out +=
    `<rect x="${(dcx - d / 2).toFixed(2)}" y="${(ruleY - d / 2).toFixed(2)}" width="${d}" height="${d}"` +
    ` transform="rotate(45 ${dcx.toFixed(2)} ${ruleY.toFixed(2)})" fill="${theme.accent}"/>`;
  hy = ruleY + 30;

  if (data.author) {
    const pillW = measure(String(data.author).toUpperCase(), 13, 600, FONT) + 44;
    out += rect(tx, hy - 20, pillW, 38, theme.band, { rx: 2 });
    out += textEl([String(data.author).toUpperCase()], tx + pillW / 2, hy + 5, {
      size: 13,
      lineH: 16,
      weight: 600,
      fill: theme.bandInk,
      anchor: 'middle',
      spacing: 1,
    });
    hy += 38;
  }
  if (data.thesis) {
    // Tope de medida: sin portada, la tesis se estiraba a ~120 caracteres por línea.
    const thesisW = Math.min(tw, 700);
    const thesisLines = wrapText(data.thesis, thesisW, {
      size: 15.5,
      weight: 400,
      maxLines: coverH ? 10 : 5,
    });
    out += textEl(thesisLines, tx, hy + 26, {
      size: 15.5,
      lineH: 25,
      weight: 400,
      fill: theme.soft,
    });
    hy += 26 + thesisLines.length * 25;
  }
  y = Math.max(y + coverH, hy) + 44;

  // ---- Ideas clave: a TODO el ancho, en dos columnas ----
  // Antes vivía en la mitad izquierda (424 px); con los paneles de 4 columnas también en la
  // mitad, el cuerpo caía a 16-17 caracteres por línea. A todo el ancho todo respira.
  const items = data.ideas || [];
  if (items.length) {
    const ideaGap = 44;
    const per = Math.ceil(items.length / 2);
    const colW = (content - PANEL_PAD * 2 - ideaGap) / 2;
    const bodyTop = y + BAND_H + PANEL_PAD;
    const left = ideasBody(items.slice(0, per), m + PANEL_PAD, bodyTop, colW, theme, {
      startIndex: 0,
    });
    const right = ideasBody(
      items.slice(per),
      m + PANEL_PAD + colW + ideaGap,
      bodyTop,
      colW,
      theme,
      {
        startIndex: per,
      },
    );
    const h = BAND_H + PANEL_PAD + Math.max(left.height, right.height) + PANEL_PAD;
    out +=
      rect(m, y, content, h, theme.card, { rx: 6, stroke: theme.line }) +
      band(m, y, content, data.ideasTitle || 'Ideas clave', theme) +
      left.svg +
      right.svg;
    y += h + 22;
  }

  // ---- Paneles, a TODO el ancho: 4 columnas necesitan la página entera para ser legibles.
  for (const p of data.panels || []) {
    const rp = panel(m, y, content, p, theme);
    out += rp.svg;
    y += rp.height + 22;
  }

  // ---- Cierre: dos tarjetas ----
  const aside = data.aside || [];
  if (aside.length) {
    y += 30;
    const aw = (content - 24) / aside.length;
    let maxH = 0;
    let ax = m;
    let asvg = '';
    aside.forEach((a) => {
      const innerW = aw - 40;
      const head = wrapText(a.label, innerW - 24, { size: 12, weight: 600, maxLines: 1 });
      const body = wrapText(a.body, innerW, { size: 12.5, maxLines: 8 });
      const h = 20 + head.length * 16 + 8 + body.length * 18.5 + 20;
      asvg += rect(ax, y, aw, h, theme.card, { rx: 6, stroke: theme.line });
      asvg += glyph(a.ico || 'note', ax + 20, y + 18, 16, theme.accent, 1.6);
      asvg += textEl(head, ax + 44, y + 32, {
        size: 12,
        lineH: 16,
        weight: 600,
        fill: theme.ink,
        spacing: 0.8,
      });
      asvg += textEl(body, ax + 20, y + 20 + head.length * 16 + 8 + 14, {
        size: 12.5,
        lineH: 18.5,
        weight: 400,
        fill: theme.muted,
      });
      maxH = Math.max(maxH, h);
      ax += aw + 24;
    });
    out += asvg;
    y += maxH;
  }

  // ---- Banda de cita (a sangre) ----
  if (data.quote) {
    y += 30;
    const qx = 70;
    const qw = width - qx * 2;
    const q = fitDisplay(`“${data.quote.text}”`, qw, {
      sizes: [34, 30, 26, 22, 18],
      weight: 600,
      family: DISPLAY,
      maxLines: 4,
    });
    const attr = data.quote.attribution
      ? wrapText(String(data.quote.attribution).toUpperCase(), qw, {
          size: 12.5,
          weight: 600,
          maxLines: 2,
        })
      : [];
    const bandH =
      50 + q.size * 1.18 * q.lines.length + (attr.length ? 30 + attr.length * 18 : 0) + 46;
    out += rect(0, y, width, bandH, theme.band);
    let qy = y + 46 + q.size;
    out += textEl(q.lines, width / 2, qy, {
      size: q.size,
      lineH: q.size * 1.18,
      weight: 600,
      family: DISPLAY,
      fill: theme.bandInk,
      anchor: 'middle',
    });
    if (attr.length) {
      qy += q.size * 1.18 * (q.lines.length - 1) + 28;
      out += textEl(attr, width / 2, qy, {
        size: 12.5,
        lineH: 18,
        weight: 600,
        fill: theme.accentOnBand,
        anchor: 'middle',
        spacing: 1.4,
      });
    }
    // Pie con procedencia: un artefacto que se comparte debe decir de qué libro sale. Acepta
    // una cadena (solo marca, centrada) o `{ title, author, mark }` (libro·autor ↔ marca);
    // si no trae título propios, usa los del libro.
    const ft = data.footer;
    if (ft) {
      const ftObj = typeof ft === 'object' ? ft : null;
      const mark = (ftObj ? ftObj.mark : ft) || 'BookReader';
      const who = ftObj
        ? [ftObj.title || data.title, ftObj.author || data.author].filter(Boolean).join(' · ')
        : '';
      const fy = y + bandH - 20;
      const foot = {
        size: 10.5,
        lineH: 14,
        weight: 500,
        fill: theme.bandInk,
        spacing: 2,
        opacity: 0.6,
      };
      if (who) {
        out += textEl([who.toUpperCase()], m, fy, { ...foot });
        // `url` a la derecha, tras la marca: la procedencia es lo que hace que un póster
        // compartido devuelva a alguien a la app.
        const right = [String(mark).toUpperCase(), ftObj && ftObj.url ? ftObj.url : null]
          .filter(Boolean)
          .join('  ·  ');
        out += textEl([right], width - m, fy, { ...foot, anchor: 'end' });
      } else {
        out += textEl([String(mark).toUpperCase()], width / 2, fy, { ...foot, anchor: 'middle' });
      }
    }
    y += bandH;
  }

  return { body: out, height: Math.round(y) };
}

// Construye el SVG. `fontCss` (de `ui/svg-fonts.js`) embebe las fuentes para que el PNG
// rasterizado —que carga el SVG como `<img>`, un documento aislado— salga igual que la
// pantalla. Devuelve `{ svg, width, height }` como `mindmap-render.js`.
export function renderSvg(data, { theme = POSTER, fontCss = '', title = '' } = {}) {
  const width = BASE_W;
  // Acento por libro: llega en `data.accent` (elegido de una paleta con AA garantizado). El
  // tono para la banda oscura se DERIVA aclarando el mismo acento, así que cualquier color
  // tiene pareja legible sobre el fondo oscuro sin anotarla a mano.
  const accent = data.accent || theme.accent;
  const th = { ...theme, accent, accentOnBand: lighten(accent, 0.5) };
  const built = build(data, th);
  const defs = fontCss ? `<defs><style>${fontCss}</style></defs>` : '';
  const aria = esc(title || data.title || 'Infografía');
  const str =
    `<svg xmlns="${SVG_NS}" viewBox="0 0 ${width} ${built.height}" width="${width}" height="${built.height}"` +
    ` role="img" aria-label="${aria}" style="display:block;max-width:100%;height:auto">` +
    defs +
    `<rect x="0" y="0" width="${width}" height="${built.height}" fill="${th.bg}"/>` +
    built.body +
    '</svg>';
  const doc = new DOMParser().parseFromString(str, 'image/svg+xml');
  return { svg: doc.documentElement, width, height: built.height };
}
