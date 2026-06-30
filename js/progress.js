// Progreso detallado del lector (panel inferior): % completado y tiempo restante
// estimado. Extraído de app.js (T8, ver CHANGELOG). Las funciones reciben totalWords
// por parámetro en vez de leer estado global del módulo principal.
import * as EpubReader from './epub-reader.js';

const WORDS_PER_MINUTE = 250;
// Debe coincidir con el valor de book.locations.generate() en epub-reader.js.
const CHARS_PER_LOCATION = 1024;

export function updateProgressDetail(pct, totalWords = 0) {
  const detailPct = document.getElementById('progress-detail-pct');
  const detailFill = document.getElementById('progress-detail-fill');
  const detailLabel = document.getElementById('progress-detail-label');
  const detailTime = document.getElementById('progress-detail-time');

  if (pct === undefined) pct = getCurrentPct();
  const pctNum = Math.round(pct);
  const remaining = 100 - pctNum;

  detailPct.textContent = pctNum + '% complete';
  detailFill.style.width = pctNum + '%';

  if (remaining <= 0) {
    detailLabel.textContent = 'Content Progress — finished';
    detailTime.textContent = '';
  } else {
    detailLabel.textContent = `Content Progress — ${pctNum}% completed`;

    const wordsLeft = Math.round(totalWords * (remaining / 100));
    const minutesLeft = Math.max(1, Math.round(wordsLeft / WORDS_PER_MINUTE));

    if (minutesLeft < 60) {
      detailTime.textContent = `Approx. ${minutesLeft} min left`;
    } else {
      const hours = Math.floor(minutesLeft / 60);
      const mins = minutesLeft % 60;
      detailTime.textContent = mins > 0
        ? `Approx. ${hours}h ${mins}m left`
        : `Approx. ${hours}h left`;
    }
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

function getCurrentPct() {
  const bar = document.getElementById('progress-bar');
  if (!bar) return 0;
  return parseFloat(bar.style.width) || 0;
}
