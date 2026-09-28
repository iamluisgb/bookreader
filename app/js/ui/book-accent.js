// Color y portada de un libro para teñir lo que se le asocia (tarjetas de repaso, IG2/ST2).
// El color sale de la PORTADA (color dominante con saturación) y se ajusta a una paleta con
// contraste AA garantizado, como el acento de la infografía: nunca se inventa un color, y sin
// portada (o con una en blanco y negro) cae al verde de la marca. Cacheado por libro.
import { getBook } from '../library/store.js';

export const BOOK_ACCENTS = ['#15803d', '#0f766e', '#0e7490', '#1d4ed8', '#4338ca', '#6d28d9', '#9f1239', '#b45309'];

const cache = new Map(); // bookId → Promise<{ accent, cover, title }>

export function bookLook(bookId) {
  if (!bookId) return Promise.resolve({ accent: BOOK_ACCENTS[0], cover: '', title: '' });
  if (!cache.has(bookId)) cache.set(bookId, load(bookId));
  return cache.get(bookId);
}

async function load(bookId) {
  const book = await getBook(bookId).catch(() => null);
  const cover = (book && book.cover) || '';
  let accent = BOOK_ACCENTS[0];
  if (cover) {
    const rgb = await dominantColor(cover).catch(() => null);
    if (rgb) accent = nearest(rgb);
  }
  return { accent, cover, title: (book && book.title) || '' };
}

function nearest(rgb) {
  let best = BOOK_ACCENTS[0], bestD = Infinity;
  for (const hex of BOOK_ACCENTS) {
    const c = [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16));
    const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
    if (d < bestD) { bestD = d; best = hex; }
  }
  return best;
}

// Color dominante como [r,g,b], descartando grises y negros (portadas en B/N → sin acento).
function dominantColor(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const n = 24;
      const cv = document.createElement('canvas');
      cv.width = n; cv.height = n;
      const g = cv.getContext('2d');
      g.drawImage(img, 0, 0, n, n);
      let d;
      try { d = g.getImageData(0, 0, n, n).data; } catch { resolve(null); return; }
      let r = 0, gg = 0, b = 0, k = 0;
      for (let i = 0; i < d.length; i += 4) {
        const mx = Math.max(d[i], d[i + 1], d[i + 2]);
        const mn = Math.min(d[i], d[i + 1], d[i + 2]);
        if (mx < 40 || (mx - mn) / mx < 0.2) continue;
        r += d[i]; gg += d[i + 1]; b += d[i + 2]; k++;
      }
      resolve(k ? [r / k, gg / k, b / k] : null);
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
