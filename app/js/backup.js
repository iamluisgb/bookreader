// Export / import global (P3). Backup round-trip de los datos del usuario en un JSON
// + un resumen legible en Markdown. Permite migrar entre dispositivos (la PWA es
// local-first, sin servidor).
//
// Qué incluye:
//   - localStorage (todo `bookreader_*`): ajustes, subrayados, marcadores, plantillas
//     propias, posiciones de lectura, modelo/auto del agente.
//   - IndexedDB IA: conversaciones, mensajes, notas de libreta, relevancia, metadatos
//     de libros.
// Qué NO incluye (a propósito):
//   - La API key (`ai_key`): es un secreto, no se escribe a un fichero descargable.
//   - El texto segmentado/anclas (`bookText`/`anchors`): voluminoso y regenerable al
//     reabrir el libro.
//   - Los archivos de los libros (EPUB/PDF): binarios fuera de alcance del backup.
import * as Storage from './storage.js';
import * as DB from './ai/db.js';
import { getTemplate } from './ai/templates.js';
import { backfillAll } from './sync/schema.js';

const FORMAT = 'bookreader-backup';
const VERSION = 1;
const SECRET_KEYS = ['ai_key'];                 // nunca exportar la API key
const AI_STORES = ['convos', 'messages', 'notes', 'ratings', 'books'];

// ---- Export ----------------------------------------------------------------

function exportLocal() {
  const ls = Storage.getAll('');                // { shortKey: valor } ya parseado
  for (const k of SECRET_KEYS) delete ls[k];
  return ls;
}

async function exportAi() {
  const out = {};
  for (const store of AI_STORES) out[store] = await DB.getAll(store);
  return out;
}

export async function buildBackup() {
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    localStorage: exportLocal(),
    ai: await exportAi(),
  };
}

// ---- Import (fusiona: sobrescribe lo que coincida, no borra lo demás) -------

function importLocal(ls) {
  let n = 0;
  for (const [k, v] of Object.entries(ls || {})) {
    if (SECRET_KEYS.includes(k)) continue;
    Storage.set(k, v); n++;
  }
  return n;
}

async function importAi(ai) {
  let n = 0;
  for (const store of AI_STORES) {
    const records = ai?.[store];
    if (!Array.isArray(records)) continue;
    for (const r of records) { await DB.put(store, r); n++; }
  }
  return n;
}

export async function importBackup(obj) {
  if (!obj || obj.format !== FORMAT) {
    throw new Error('Archivo no reconocido (no es un backup de BookReader).');
  }
  const localKeys = importLocal(obj.localStorage);
  const aiRecords = await importAi(obj.ai);
  // Backups anteriores a la Fase 0 de sync no traen uid/updatedAt: normalizar
  // lo importado para que sea mergeable (idempotente, no toca lo ya migrado).
  await backfillAll();
  return { localKeys, aiRecords };
}

// ---- Resumen Markdown legible ----------------------------------------------

export async function buildMarkdown() {
  const [convos, notes, books] = await Promise.all([
    DB.getAll('convos'), DB.getAll('notes'), DB.getAll('books'),
  ]);
  const title = Object.fromEntries((books || []).map(b => [b.id, b.title]));
  const oneLine = (s) => (s || '').replace(/\s+/g, ' ').trim();

  const out = ['# BookReader — Resumen', '', `_Exportado: ${new Date().toLocaleString('es')}_`, ''];

  if (convos && convos.length) {
    out.push('## Libretas', '');
    for (const c of convos) {
      const tpl = getTemplate(c.templateId);
      out.push(`### ${[tpl?.name || 'Conversación', title[c.bookId]].filter(Boolean).join(' — ')}`);
      if (c.goal) out.push(`*Objetivo:* ${oneLine(c.goal)}`);
      out.push('');
      const mine = (notes || []).filter(n => n.convoId === c.id && !n.deleted);
      const fields = tpl?.fields || [];
      const byField = {};
      for (const n of mine) (byField[n.fieldKey] = byField[n.fieldKey] || []).push(n);
      const order = [...new Set([...fields.map(f => f.key), ...Object.keys(byField)])];
      for (const k of order) {
        const arr = byField[k];
        if (!arr || !arr.length) continue;
        out.push(`**${fields.find(f => f.key === k)?.label || k}**`);
        for (const n of arr) out.push(`- ${oneLine(n.content)}`);
        out.push('');
      }
    }
  }

  const rawHighlights = Storage.getAll('highlights_');
  const highlights = Object.fromEntries(
    Object.entries(rawHighlights)
      .filter(([, v]) => Array.isArray(v))
      .map(([k, v]) => [k, v.filter(h => !h.deleted)])
  );
  const hKeys = Object.keys(highlights).filter(k => highlights[k].length);
  if (hKeys.length) {
    out.push('## Subrayados', '');
    for (const k of hKeys) {
      const id = k.replace(/^highlights_/, '');
      out.push(`### ${title[id] || id}`, '');
      for (const h of highlights[k]) {
        out.push(`- "${oneLine(h.text)}"${h.chapter ? ` — _${oneLine(h.chapter)}_` : ''}`);
        if (h.note) out.push(`  - Nota: ${oneLine(h.note)}`);
      }
      out.push('');
    }
  }

  if (out.length <= 4) out.push('_(Aún no hay libretas ni subrayados.)_');
  return out.join('\n');
}

// P8 · Export LEGIBLE y SELECTIVO de UNA conversación (libreta + chat), a diferencia del
// volcado global de arriba. Preserva el formato de las notas/mensajes (sin aplanar) e incluye
// la transcripción del chat. Resuelve las citas [[aN]] a "(pág. N)"/"(capítulo)" si el libro
// está segmentado. Reutiliza el `download()` CSP-safe. Ver BACKLOG · P8.
export async function buildConvoMarkdown(convoId, { includeChat = true, includeNotebook = true } = {}) {
  const convo = await DB.getConvo(convoId);
  if (!convo) return '# Conversación no encontrada';
  const [notes, messages, books, seg] = await Promise.all([
    DB.getNotes(convoId),
    DB.getMessages(convoId),
    DB.getAll('books'),
    DB.loadSegmented(convo.bookId).catch(() => null),
  ]);
  const bookTitle = (books || []).find(b => b.id === convo.bookId)?.title || 'Libro';
  const anchors = seg?.anchors || new Map();
  const tpl = getTemplate(convo.templateId);

  const out = [];
  out.push(`# ${[tpl?.name || 'Conversación', bookTitle].filter(Boolean).join(' — ')}`, '');
  if (convo.goal) out.push(`*Objetivo:* ${(convo.goal || '').replace(/\s+/g, ' ').trim()}`, '');
  out.push(`_Exportado: ${new Date().toLocaleString('es')}_`, '');

  if (includeNotebook) {
    const fields = tpl?.fields || [];
    const byField = {};
    for (const n of (notes || [])) (byField[n.fieldKey] = byField[n.fieldKey] || []).push(n);
    const order = [...new Set([...fields.map(f => f.key), ...Object.keys(byField)])];
    if (order.some(k => byField[k]?.length)) {
      out.push('## Libreta', '');
      for (const k of order) {
        const arr = byField[k];
        if (!arr || !arr.length) continue;
        out.push(`### ${fields.find(f => f.key === k)?.label || k}`, '');
        for (const n of arr) out.push(resolveCites(n.content, anchors).trim(), '');
      }
    }
  }

  if (includeChat && messages && messages.length) {
    out.push('## Conversación', '');
    for (const m of messages) {
      out.push(`**${m.role === 'user' ? '🧑 Tú' : '🤖 Agente'}:**`, '', resolveCites(m.content, anchors).trim(), '');
    }
  }

  if ((!notes || !notes.length) && (!messages || !messages.length)) out.push('_(Conversación vacía.)_');
  return out.join('\n');
}

// Sustituye las anclas [[aN]]/aN por una referencia legible (pág./capítulo) usando el mapa
// de anclas del libro. Si no hay anclas (libro sin segmentar) deja el texto tal cual.
function resolveCites(text, anchors) {
  if (!anchors || !anchors.size) return text || '';
  return (text || '').replace(/\[\[(a\d+)\]\]|\b(a\d+)\b/g, (m, p1, p2) => {
    const a = anchors.get(p1 || p2);
    if (!a) return m;
    if (a.page != null) return `(pág. ${a.page})`;
    if (a.chapter) return `(${a.chapter})`;
    return '';
  });
}

// ---- Descargas (mismo patrón CSP-safe que la exportación de subrayados) -----

// Descarga pública (para el botón de exportar del panel).
export function downloadText(filename, content, mime = 'text/markdown') {
  download(filename, content, mime);
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const stamp = () => new Date().toISOString().slice(0, 10);

export async function downloadBackup() {
  download(`bookreader-backup-${stamp()}.json`, JSON.stringify(await buildBackup(), null, 2), 'application/json');
}

export async function downloadMarkdown() {
  download(`bookreader-resumen-${stamp()}.md`, await buildMarkdown(), 'text/markdown');
}
