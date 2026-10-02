// Render de las respuestas del agente: Markdown -> HTML (seguro) y luego las
// anclas [[aN]]/aN -> chips clicables. Extraído de panel.js (T8, ver CHANGELOG).
// `anchors` es el Map<id,{cfi,chapter}> de la conversación; solo se convierten en
// chip las anclas que existen, para no inventar citas.
import { mdToHtml } from './markdown.js';
import { t } from '../i18n.js';
import { escapeHtml } from '../ui/escape.js';

// `pending`: el libro aún se está segmentando (no hay anclas TODAVÍA). Las citas `[[aN]]`
// se pintan como un chip neutro desactivado en vez de borrarse, y quien llama repinta
// cuando lleguen las anclas. Sin `pending`, una cita sin ancla es inventada y se quita.
// Es opt-in porque hay quien pinta con un mapa vacío PARA SIEMPRE (un visor sin libro).
export function renderWithCitations(text, anchors, { pending = false } = {}) {
  return citeReplace(mdToHtml(text), anchors, pending);
}

// Etiqueta VISIBLE del chip (UI1). El id `aN` es interno: el lector necesita saber a DÓNDE
// lleva la cita. El PDF trae la página en el ancla; el EPUB la resuelve el lector desde el
// CFI (lo registra panel.js, porque render.js no conoce al lector). Sin página, el capítulo.
let pageOf = null;
export function setCitePageResolver(fn) { pageOf = typeof fn === 'function' ? fn : null; }

// Solo la página (número) de un ancla, o null. Para los artefactos que la pintan como «p. N»
// (infografía) y no quieren la reserva del capítulo.
export function citePage(a) {
  let page = a && a.page;
  if (!page && a && a.cfi && pageOf) { try { page = pageOf(a.cfi); } catch { /* sin página */ } }
  return page || null;
}

export function citeLabel(id, a) {
  let page = a && a.page;
  if (!page && a && a.cfi && pageOf) { try { page = pageOf(a.cfi); } catch { /* sin página */ } }
  if (page) return t('pág. {n}', { n: page });
  const ch = String((a && a.chapter) || '').trim();
  if (ch) return ch.length > 22 ? ch.slice(0, 21).trimEnd() + '…' : ch;
  return t('Ver pasaje');
}

function citeReplace(html, anchors, pending = false) {
  return html.replace(/\[\[(a\d+)\]\]|\b(a\d+)\b/g, (m, p1, p2) => {
    const id = p1 || p2;
    if (anchors.has(id)) {
      const a = anchors.get(id);
      const tip = a && a.chapter ? `${t('Ir al pasaje')} · ${a.chapter}` : t('Ir al pasaje');
      return `<button class="ai-cite" data-id="${id}" title="${escapeHtml(tip)}">${escapeHtml(citeLabel(id, a))}</button>`;
    }
    if (p1 && pending) {
      return `<span class="ai-cite is-pending" aria-disabled="true" title="${escapeHtml(t('Preparando el libro…'))}">…</span>`;
    }
    // No mapeado: si venía entre corchetes «[[aN]]» era una cita fallida/inventada →
    // se elimina (no ensuciamos la respuesta con marcado crudo). Un `aN` suelto en
    // prosa (sin corchetes) se respeta tal cual.
    return p1 ? '' : m;
  });
}
