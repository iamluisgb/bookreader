// P11 · Tarjeta-cita: renderiza una frase subrayada como imagen PNG para compartir en
// redes. Proporciones alineadas con la skill libro-quote del content-engine —lienzo
// 1080×1080, 2 columnas (portada ~40% / cita ~60%)— y tokens de marca BookReader:
// papel cálido, cita en serif Source Serif 4. La PORTADA sale de la
// biblioteca local (la del libro que se está leyendo, embebida en el EPUB o la 1ª página
// del PDF); no se pide a Open Library como en el content-engine, así no hay llamada
// externa y se respeta la privacidad (todo se genera en el dispositivo).

import { t } from './i18n.js';
const W = 1080, H = 1080;
const PAPER = '#faf8f3';
const INK = '#2b2b2b';
const MUTED = '#7a736a';
const ACCENT = '#22c55e';

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Word-wrap por palabras dentro de maxWidth.
function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const probe = line ? line + ' ' + word : word;
      if (ctx.measureText(probe).width > maxWidth && line) { lines.push(line); line = word; }
      else line = probe;
    }
    lines.push(line);
  }
  return lines;
}

// Acorta un texto con «…» si excede maxWidth.
function ellipsize(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) s = s.slice(0, -1);
  return s.trimEnd() + '…';
}

// Ajusta el tamaño de fuente de la cita para que quepa en el ancho/alto disponibles.
function fitQuote(ctx, text, maxWidth, maxHeight, maxSize) {
  for (let size = maxSize; size >= 28; size -= 2) {
    ctx.font = `600 ${size}px 'Source Serif 4', Georgia, serif`;
    const lh = Math.round(size * 1.32);
    const lines = wrapLines(ctx, text, maxWidth);
    if (lines.length * lh <= maxHeight) return { size, lh, lines };
  }
  ctx.font = `600 28px 'Source Serif 4', Georgia, serif`;
  const lh = 37;
  return { size: 28, lh, lines: wrapLines(ctx, text, maxWidth).slice(0, Math.floor(maxHeight / lh)) };
}

// Carga una imagen (dataURL) para el canvas; null si falla o no hay.
async function loadImage(src) {
  if (!src) return null;
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    return img;
  } catch { return null; }
}

// Dibuja la portada (ya escalada a w×h) en una caja redondeada con sombra editorial.
function drawCover(ctx, img, x, y, w, h) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.22)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 16;
  roundRect(ctx, x, y, w, h, 12);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundRect(ctx, x, y, w, h, 12);
  ctx.clip();
  ctx.drawImage(img, x, y, w, h);
  ctx.restore();
}

// Layout de 2 columnas (portada prominente izquierda, cita serif derecha). Sin portada,
// la cita ocupa todo el ancho. Vertical centrado del bloque de la cita.
export async function buildQuoteCard({ quote, title, author, cover }) {
  try { await document.fonts.ready; } catch { /* sin API de fuentes: se usa la del sistema */ }
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Fondo papel a sangre (regla de marca: fondo del lienzo = fondo de la tarjeta).
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);

  const coverImg = await loadImage(cover);
  const PADX = 80, PADY = 80, GAP = 56;
  const innerH = H - PADY * 2;

  // Columna de la cita (con portada se estrecha a la derecha).
  let quoteX = PADX, quoteW = W - PADX * 2, quoteMax = 60;
  if (coverImg) {
    const colW = Math.round((W - PADX * 2 - GAP) * 0.40);
    const scale = Math.min(colW / coverImg.width, innerH / coverImg.height);
    const cw = coverImg.width * scale, ch = coverImg.height * scale;
    drawCover(ctx, coverImg, PADX + (colW - cw) / 2, PADY + (innerH - ch) / 2, cw, ch);
    quoteX = PADX + colW + GAP;
    quoteW = W - PADX - quoteX;
    quoteMax = 46;
  }

  // Bloque derecho: comilla + cita + atribución, centrado en vertical.
  const markH = coverImg ? 84 : 104;
  // Con portada, el título ya se ve en ella → la atribución muestra solo el autor
  // (evita cortar «Mario Var…»); sin portada, título · autor.
  const attribution = (coverImg ? [author] : [title, author]).filter(Boolean).join('   ·   ');
  const footH = attribution ? 44 : 0;
  const { size, lh, lines } = fitQuote(ctx, quote, quoteW, innerH - markH - footH - 60, quoteMax);
  const blockH = markH + lines.length * lh + 44 + footH;
  let y = PADY + Math.max(0, (innerH - blockH) / 2);

  ctx.textAlign = 'left';
  // Comilla decorativa emerald.
  ctx.fillStyle = ACCENT;
  ctx.font = `700 ${markH + 30}px Georgia, serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('“', quoteX - 6, y + markH);
  y += markH;

  // Cita en serif.
  ctx.fillStyle = INK;
  ctx.font = `600 ${size}px 'Source Serif 4', Georgia, serif`;
  for (const line of lines) { y += lh; ctx.fillText(line, quoteX, y); }
  y += 44;

  // Atribución (— Título · Autor), acortada al ancho de la columna.
  if (attribution) {
    ctx.font = `500 28px 'Inter', sans-serif`;
    ctx.fillStyle = MUTED;
    y += 30;
    ctx.fillText(ellipsize(ctx, '— ' + attribution, quoteW), quoteX, y);
  }

  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error(t('No se pudo generar la imagen')))), 'image/png'));
}

// Genera la tarjeta y la comparte (Web Share con ficheros si el navegador lo soporta;
// si no, descarga el PNG). Devuelve 'shared' | 'downloaded' | 'cancelled'.
export async function shareQuote({ quote, title, author, cover }) {
  const blob = await buildQuoteCard({ quote, title, author, cover });
  const file = new File([blob], 'bookreader-cita.png', { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
      // sigue al fallback de descarga
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'bookreader-cita.png';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return 'downloaded';
}
