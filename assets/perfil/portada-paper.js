/* global document */
// Portada para un paper (preprint de arXiv u otro repositorio), que no trae portada propia: la
// primera página es texto denso y en miniatura no se lee. Se dibuja en un canvas con los
// metadatos del paper, sin subir ninguna imagen, y sale igual cada vez para el mismo paper.
//
// Estructura, de arriba abajo: cabecera de revista (fuente en su color + identificador y área,
// doble filete), una figura abstracta que depende del identificador (grafo de nodos sobre
// cuadrícula de puntos, con un nodo central en el color de la fuente), el título en serif, el
// subtítulo y la nota, y al pie los autores y la fecha.

const W = 680, H = 880, M = 54;
const INK = '#1d1b17', SOFT = '#3d382f', FAINT = '#6b6458', PAPER = '#f6f3ec', DOT = '#d9d2c3';
const SERIF = "'Source Serif 4', Georgia, serif";
const SANS = "'Inter', -apple-system, 'Segoe UI', sans-serif";

// Generador pseudoaleatorio con semilla (mulberry32) a partir de un texto.
function rng(seedText) {
  let a = 0;
  for (let i = 0; i < seedText.length; i++) a = (a * 31 + seedText.charCodeAt(i)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function wrap(ctx, text, maxW) {
  const words = String(text).split(/\s+/); const lines = []; let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

// Igual que wrap, pero con las líneas equilibradas: estrecha el ancho mientras no aparezca una
// línea más, para que no quede una palabra sola al final.
function balanced(ctx, text, maxW) {
  const n = wrap(ctx, text, maxW).length;
  if (n < 2) return wrap(ctx, text, maxW);
  let lo = maxW / n, hi = maxW;
  while (hi - lo > 2) { const mid = (lo + hi) / 2; if (wrap(ctx, text, mid).length > n) lo = mid; else hi = mid; }
  return wrap(ctx, text, hi);
}

function figure(ctx, x, y, w, h, seed, accent) {
  // Cuadrícula de puntos de fondo.
  ctx.fillStyle = DOT;
  for (let gx = x; gx <= x + w; gx += 17) for (let gy = y; gy <= y + h; gy += 17) {
    ctx.beginPath(); ctx.arc(gx, gy, 1.1, 0, Math.PI * 2); ctx.fill();
  }
  // Nodos repartidos sin amontonarse.
  const r = rng(seed); const nodes = [];
  for (let tries = 0; nodes.length < 17 && tries < 600; tries++) {
    const p = { x: x + 24 + r() * (w - 48), y: y + 22 + r() * (h - 44) };
    if (nodes.every(n => Math.hypot(n.x - p.x, n.y - p.y) > 58)) nodes.push(p);
  }
  // El nodo central es el más cercano al centro de la figura.
  const cx = x + w / 2, cy = y + h / 2;
  const hub = nodes.reduce((best, n) => (Math.hypot(n.x - cx, n.y - cy) < Math.hypot(best.x - cx, best.y - cy) ? n : best), nodes[0]);
  // Aristas: cada nodo con sus dos vecinos más próximos.
  ctx.lineWidth = 1.3; ctx.strokeStyle = 'rgba(29,27,23,.5)';
  const drawn = new Set();
  for (const n of nodes) {
    const near = nodes.filter(m => m !== n).sort((a, b) => Math.hypot(a.x - n.x, a.y - n.y) - Math.hypot(b.x - n.x, b.y - n.y)).slice(0, 2);
    for (const m of near) {
      const k = [nodes.indexOf(n), nodes.indexOf(m)].sort().join('-');
      if (drawn.has(k)) continue; drawn.add(k);
      ctx.beginPath(); ctx.moveTo(n.x, n.y); ctx.lineTo(m.x, m.y); ctx.stroke();
    }
  }
  // Del nodo central salen aristas en el color de la fuente a los cinco más cercanos.
  ctx.strokeStyle = accent; ctx.lineWidth = 2;
  nodes.filter(n => n !== hub).sort((a, b) => Math.hypot(a.x - hub.x, a.y - hub.y) - Math.hypot(b.x - hub.x, b.y - hub.y)).slice(0, 5)
    .forEach(m => { ctx.beginPath(); ctx.moveTo(hub.x, hub.y); ctx.lineTo(m.x, m.y); ctx.stroke(); });
  for (const n of nodes) {
    const big = n === hub;
    ctx.beginPath(); ctx.arc(n.x, n.y, big ? 10 : 4 + r() * 3, 0, Math.PI * 2);
    ctx.fillStyle = big ? accent : PAPER; ctx.fill();
    ctx.lineWidth = big ? 0 : 1.6; ctx.strokeStyle = INK; if (!big) ctx.stroke();
  }
}

/**
 * Dibuja la portada y devuelve un data URL (webp, o png si el navegador no sabe webp).
 * meta: { source, accent, id, area, title, subtitle, note, authors: [], date }
 */
export function paperCover(meta) {
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const accent = meta.accent || '#b31b1b';
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H);

  // Cabecera: fuente, identificador y doble filete.
  ctx.fillStyle = accent; ctx.font = `600 36px ${SERIF}`; ctx.textBaseline = 'alphabetic';
  ctx.fillText(meta.source || 'Preprint', M, 86);
  ctx.fillStyle = FAINT; ctx.font = `500 15px ${SANS}`; ctx.textAlign = 'right';
  ctx.fillText([meta.id, meta.area].filter(Boolean).join('  ·  '), W - M, 84);
  ctx.textAlign = 'left';
  ctx.fillStyle = INK; ctx.fillRect(M, 104, W - 2 * M, 2.5); ctx.fillRect(M, 111, W - 2 * M, 1);

  // Figura.
  figure(ctx, M, 140, W - 2 * M, 300, meta.id || meta.title, accent);

  // Título, subtítulo y nota.
  let y = 520;
  ctx.fillStyle = INK; ctx.font = `600 52px ${SERIF}`;
  for (const l of balanced(ctx, meta.title, W - 2 * M)) { ctx.fillText(l, M, y); y += 58; }
  if (meta.subtitle) {
    y += 2; ctx.fillStyle = SOFT; ctx.font = `400 24px ${SERIF}`;
    for (const l of balanced(ctx, meta.subtitle, W - 2 * M)) { ctx.fillText(l, M, y); y += 32; }
  }
  if (meta.note) {
    y += 10; ctx.fillStyle = accent; ctx.fillRect(M, y - 14, 28, 2);
    ctx.fillStyle = FAINT; ctx.font = `600 13px ${SANS}`;
    ctx.fillText(meta.note.toUpperCase().split('').join(' '), M + 40, y - 9);
  }

  // Pie: autores y fecha.
  ctx.fillStyle = INK; ctx.fillRect(M, H - 108, W - 2 * M, 1);
  ctx.fillStyle = SOFT; ctx.font = `500 16px ${SANS}`;
  const authorLines = wrap(ctx, (meta.authors || []).join(' · '), W - 2 * M).slice(0, 2);
  authorLines.forEach((l, i) => ctx.fillText(l, M, H - 80 + i * 22));
  ctx.fillStyle = FAINT; ctx.font = `400 14px ${SANS}`;
  ctx.fillText(meta.date || '', M, H - 32);

  try { const url = canvas.toDataURL('image/webp', 0.9); if (url.startsWith('data:image/webp')) return url; } catch { /* sin webp */ }
  return canvas.toDataURL('image/png');
}
