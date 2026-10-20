// MCP · Deshacer un cambio que un agente hizo en la biblioteca (Ajustes → Datos → Agentes).
//
// El Worker guarda, de cada cambio, los valores ANTERIORES de los libros y estanterías que tocó,
// cifrados con la clave del sync (workers/sync/src/mcp.js · recordChange): él no los puede leer.
// Aquí se descifran y se aplican como un cambio más de este dispositivo, con sus sellos de
// ahora (updatedAt, shelvesAt, statusAt, metaAt), para que ganen en el merge y el sync los lleve
// a todos lados. Solo se revierte lo que tocó el agente: lo demás de la biblioteca no se mira.
//
// Restaurar una versión entera de library.json no valdría: el merge decide por sellos y una
// versión vieja pierde siempre; y desharía también lo que el usuario cambió después.

import * as BRAuth from './bookreader-auth.js';
import * as C from './sync-crypto.js';
import * as LibStore from '../library/store.js';

const undoPath = (changeId) => 'bookreader/undo/' + changeId;   // como mcp.js · undoPath

export async function undoChange(changeId) {
  const res = await BRAuth.api('/v1/mcp-changes/' + encodeURIComponent(changeId) + '/undo');
  if (!res.ok) throw await BRAuth.apiError(res);
  const { undo: b64, undoneAt } = await res.json();
  if (undoneAt) return { already: true };
  const k = await BRAuth.keys();
  const pid = await C.pathId(k, undoPath(changeId));
  const undo = JSON.parse(await C.decryptText(k, pid, new Blob([C.fromB64url(b64)])));
  const out = await applyUndo(undo);
  await BRAuth.api('/v1/mcp-changes/' + encodeURIComponent(changeId) + '/undone', { method: 'POST' });
  return out;
}

// Pura respecto del servidor: lo que hay que dejar como estaba. Exportada para los tests.
export async function applyUndo(undo, now = Date.now()) {
  let books = 0;
  let shelves = 0;
  // Primero las estanterías: un libro que vuelve a una estantería borrada por el agente
  // necesita que la estantería exista.
  for (const [id, prev] of Object.entries((undo && undo.shelves) || {})) {
    const cur = (await LibStore.getAllShelfRecords()).find((s) => s.id === id);
    if (prev === null) {
      // La creó el agente: fuera (como borrarla en la app, con su cascada).
      if (cur && !cur.deleted) { await LibStore.deleteShelf(id); shelves++; }
      continue;
    }
    const next = { ...(cur || { id }), id, name: prev.name, createdAt: prev.createdAt || (cur && cur.createdAt) || now, updatedAt: now };
    if (Number.isFinite(prev.order)) next.order = prev.order; else delete next.order;
    if (prev.rule && Object.keys(prev.rule).length) next.rule = prev.rule; else delete next.rule;
    if (prev.deleted) Object.assign(next, { deleted: true, deletedAt: now });
    else { delete next.deleted; delete next.deletedAt; }
    await LibStore.putShelf(next);
    shelves++;
  }
  for (const [id, prev] of Object.entries((undo && undo.books) || {})) {
    const r = await LibStore.updateBook(id, (cur) => {
      if (cur.deleted) return {};
      const patch = { shelfIds: prev.shelfIds || [] };
      if ((cur.title || '') !== prev.title || (cur.author || '') !== prev.author) Object.assign(patch, { title: prev.title, author: prev.author, metaAt: now });
      if ((cur.status || 'unread') !== prev.status) Object.assign(patch, { status: prev.status, statusAt: now, finishedAt: prev.finishedAt || null });
      return patch;
    });
    if (r) books++;
  }
  return { books, shelves };
}
