// Escapado de HTML compartido. Escapa también comillas ('"' y "'"), así que es
// seguro tanto en contexto de contenido (<div>…</div>) como de atributo
// (src="…", title="…"). Centraliza las copias que había en app.js, panel.js y
// library/view.js.

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ENTITIES[c]);
}
