// Ampliar el agente (escritorio y tablet). Para leer una respuesta larga, una tabla o
// trabajar la Libreta, el panel ocupa la ventana menos una franja del libro; el chat se
// centra a un ancho de lectura. Recomendación del agente de UX/UI:
//   - Es un modo puntual: NO se recuerda. Al cerrar el agente o cambiar de libro vuelve al
//     ancho del tirador; recordarlo haría que el libro arrancase tapado.
//   - El libro se TAPA, no se encoge: el margen del lector no cambia, así que el EPUB no se
//     repagina y la posición no se mueve.
//   - Una cita devuelve al libro: el panel vuelve a su ancho y luego navega (panel.js).
//   - Se vuelve con el mismo botón, Esc, un clic en la franja del libro o ⌘/Ctrl+Shift+.
// En móvil no existe: la hoja ya tiene su altura completa (initSheetSnap).
import { t } from '../i18n.js';

const MQ = '(min-width: 768px)';
let strip = null;

export function isAiMax() {
  return document.body.classList.contains('ai-max');
}

function sync(on) {
  const btn = document.getElementById('ai-max');
  if (btn) {
    const label = on ? t('Volver al lado del libro') : t('Ampliar agente');
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', label);
    btn.title = `${label} (⌘/Ctrl+Shift+.)`;
  }
  if (on && !strip) {
    // La franja del libro que queda a la vista: un clic en ella vuelve.
    strip = document.createElement('button');
    strip.className = 'ai-max-strip';
    strip.setAttribute('aria-label', t('Volver al lado del libro'));
    strip.addEventListener('click', () => setAiMax(false));
    document.body.appendChild(strip);
  } else if (!on && strip) {
    strip.remove();
    strip = null;
  }
}

export function setAiMax(on) {
  on = !!on && document.body.classList.contains('ai-open') && window.matchMedia(MQ).matches;
  if (on === isAiMax()) return;
  document.body.classList.add('ai-max-anim');
  clearTimeout(setAiMax.t);
  setAiMax.t = setTimeout(() => document.body.classList.remove('ai-max-anim'), 450);
  document.body.classList.toggle('ai-max', on);
  sync(on);
  if (on) document.getElementById('ai-input')?.focus({ preventScroll: true });
}

// Algo modal o flotante abierto encima: su Esc va primero.
const somethingOnTop = () => !!document.querySelector(
  '.dlg-overlay, [aria-modal="true"], .lib-menu, .reader-more-menu, .reading-pop:not([hidden]), .mm-card, .ig-card');

export function initAiMax() {
  document.getElementById('ai-max')?.addEventListener('click', () => setAiMax(!isAiMax()));
  sync(isAiMax());
  if (window.__aiMaxWired) return;   // el panel puede re-montarse; los globales, una vez
  window.__aiMaxWired = true;
  // Cerrar el agente, cambiar a móvil o abrir el índice encima: fuera el modo.
  new MutationObserver(() => {
    if (isAiMax() && (!document.body.classList.contains('ai-open') || document.getElementById('sidebar')?.classList.contains('open'))) setAiMax(false);
  }).observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });
  window.matchMedia(MQ).addEventListener?.('change', (e) => { if (!e.matches) setAiMax(false); });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'Period') {
      if (document.body.classList.contains('ai-open')) { e.preventDefault(); setAiMax(!isAiMax()); }
      return;
    }
    if (e.key === 'Escape' && isAiMax() && !e.defaultPrevented && !somethingOnTop()) {
      e.preventDefault();
      setAiMax(false);
      document.getElementById('ai-max')?.focus();
    }
  });
}
