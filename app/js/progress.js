// Progreso detallado del lector (panel inferior): % completado y tiempo restante
// estimado. Extraído de app.js (T8, ver CHANGELOG). Las funciones reciben totalWords
// por parámetro en vez de leer estado global del módulo principal.
import * as EpubReader from './epub-reader.js';
import * as PdfReader from './pdf-reader.js';
import { t } from './i18n.js';

const WORDS_PER_MINUTE = 250;
// Debe coincidir con el valor de book.locations.generate() en epub-reader.js.
const CHARS_PER_LOCATION = 1024;
// Páginas que se muestrean para estimar las palabras de un PDF. Extraer el texto
// del documento entero costaría segundos en libros grandes y aquí solo hace falta
// un orden de magnitud.
const PDF_SAMPLE_PAGES = 12;

// Actualiza el tiempo de lectura restante mostrado en el pie (#progress-time), a
// partir del % de progreso y las palabras totales estimadas. (Antes vivía en un
// popup de detalle; ahora está siempre visible en la barra.)
export function updateProgressDetail(pct, totalWords = 0) {
  const timeEl = document.getElementById('progress-time');
  if (!timeEl) return;

  if (pct === undefined) pct = getCurrentPct();
  const pctNum = Math.round(pct);
  const remaining = 100 - pctNum;

  if (remaining <= 0) {
    timeEl.textContent = t('Terminado');
    return;
  }

  // Sin palabras estimadas no se inventa un tiempo: pasa en PDFs escaneados (sin
  // capa de texto), donde el muestreo no encuentra nada. Mejor vacío que "~1 min".
  if (!totalWords) { timeEl.textContent = ''; return; }

  const wordsLeft = Math.round(totalWords * (remaining / 100));
  const minutesLeft = Math.max(1, Math.round(wordsLeft / WORDS_PER_MINUTE));

  if (minutesLeft < 60) {
    timeEl.textContent = `~${minutesLeft} min`;
  } else {
    const hours = Math.floor(minutesLeft / 60);
    const mins = minutesLeft % 60;
    timeEl.textContent = mins > 0 ? `~${hours} h ${mins} min` : `~${hours} h`;
  }
}

export function countBookWords() {
  const book = EpubReader.getBook();
  if (!book) return 80000;

  // Preferimos las localizaciones de epub.js: generateLocations() divide el
  // libro ENTERO en tramos de ~CHARS_PER_LOCATION caracteres, así que
  // nºtramos × CHARS_PER_LOCATION ≈ caracteres totales, y /5 ≈ palabras. Es
  // fiable porque NO depende de que las secciones estén cargadas (el bug
  // anterior: section.document solo existe para las secciones ya renderizadas,
  // por eso contaba casi 0 palabras → "1 min left").
  try {
    const loc = book.locations;
    const total = loc ? (typeof loc.length === 'function' ? loc.length() : loc.total) : 0;
    if (total > 1) {
      return Math.round((total * CHARS_PER_LOCATION) / 5);
    }
  } catch { /* sin localizaciones */ }

  // Fallback: sumar el texto de las secciones que SÍ estén cargadas.
  let totalChars = 0;
  const len = book.spine?.length || 0;
  for (let i = 0; i < len; i++) {
    try {
      const section = book.spine.get(i);
      if (section?.document?.body) {
        totalChars += section.document.body.textContent.length;
      }
    } catch { /* section not loaded */ }
  }
  if (totalChars > 0) return Math.round(totalChars / 5);

  // Último recurso: una novela típica ronda las 80 000 palabras.
  return 80000;
}

// Equivalente de countBookWords() para PDF. No hay `locations` que dividan el
// documento, así que se muestrean páginas REPARTIDAS por todo el libro (no las
// primeras: portada, créditos e índice no representan al cuerpo) y se extrapola.
// chars/5 ≈ palabras, el mismo criterio que en EPUB. Devuelve 0 si no hay capa de
// texto (PDF escaneado), para que el pie no muestre una estimación inventada.
export async function countPdfWords() {
  const doc = PdfReader.getDocument();
  const total = PdfReader.getTotalPages();
  if (!doc || !total) return 0;

  const n = Math.min(PDF_SAMPLE_PAGES, total);
  let chars = 0;
  let sampled = 0;
  for (let i = 0; i < n; i++) {
    const p = Math.max(1, Math.min(total, Math.round(((i + 0.5) / n) * total)));
    try {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      for (const it of content.items) {
        if (typeof it.str === 'string') chars += it.str.length;
      }
      page.cleanup?.();
      sampled++;
    } catch { /* página ilegible: no cuenta para la media */ }
  }
  if (!sampled || !chars) return 0;
  return Math.round(((chars / sampled) * total) / 5);
}

function getCurrentPct() {
  const bar = document.getElementById('progress-bar');
  if (!bar) return 0;
  return parseFloat(bar.style.width) || 0;
}
