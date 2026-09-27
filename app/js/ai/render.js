// Render de las respuestas del agente: Markdown -> HTML (seguro) y luego las
// anclas [[aN]]/aN -> chips clicables. Extraído de panel.js (T8, ver CHANGELOG).
// `anchors` es el Map<id,{cfi,chapter}> de la conversación; solo se convierten en
// chip las anclas que existen, para no inventar citas.
import { mdToHtml } from './markdown.js';
import { t } from '../i18n.js';
import { escapeHtml } from '../ui/escape.js';

export function renderWithCitations(text, anchors) {
  return citeReplace(mdToHtml(text), anchors);
}

// Etiqueta VISIBLE del chip (UI1). El id `aN` es interno: el lector necesita saber a DÓNDE
// lleva la cita. El PDF trae la página en el ancla; el EPUB la resuelve el lector desde el
// CFI (lo registra panel.js, porque render.js no conoce al lector). Sin página, el capítulo.
let pageOf = null;
export function setCitePageResolver(fn) { pageOf = typeof fn === 'function' ? fn : null; }

export function citeLabel(id, a) {
  let page = a && a.page;
  if (!page && a && a.cfi && pageOf) { try { page = pageOf(a.cfi); } catch { /* sin página */ } }
  if (page) return t('pág. {n}', { n: page });
  const ch = String((a && a.chapter) || '').trim();
  if (ch) return ch.length > 22 ? ch.slice(0, 21).trimEnd() + '…' : ch;
  return t('Ver pasaje');
}

function citeReplace(html, anchors) {
  return html.replace(/\[\[(a\d+)\]\]|\b(a\d+)\b/g, (m, p1, p2) => {
    const id = p1 || p2;
    if (anchors.has(id)) {
      const a = anchors.get(id);
      const tip = a && a.chapter ? `${t('Ir al pasaje')} · ${a.chapter}` : t('Ir al pasaje');
      return `<button class="ai-cite" data-id="${id}" title="${escapeHtml(tip)}">${escapeHtml(citeLabel(id, a))}</button>`;
    }
    // No mapeado: si venía entre corchetes «[[aN]]» era una cita fallida/inventada →
    // se elimina (no ensuciamos la respuesta con marcado crudo). Un `aN` suelto en
    // prosa (sin corchetes) se respeta tal cual.
    return p1 ? '' : m;
  });
}
