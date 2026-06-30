// Render de las respuestas del agente: Markdown -> HTML (seguro) y luego las
// anclas [[aN]]/aN -> chips clicables. Extraído de panel.js (BACKLOG-TECH T8).
// `anchors` es el Map<id,{cfi,chapter}> de la conversación; solo se convierten en
// chip las anclas que existen, para no inventar citas.
import { mdToHtml } from './markdown.js';

export function renderWithCitations(text, anchors) {
  return citeReplace(mdToHtml(text), anchors);
}

function citeReplace(html, anchors) {
  return html.replace(/\[\[(a\d+)\]\]|\b(a\d+)\b/g, (m, p1, p2) => {
    const id = p1 || p2;
    return anchors.has(id)
      ? `<button class="ai-cite" data-id="${id}" title="Ir al pasaje">${id}</button>`
      : m;
  });
}
