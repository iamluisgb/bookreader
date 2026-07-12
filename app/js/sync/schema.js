// Fase 0 del sync (SYNC_PLAN.md): identidad estable y merge determinista.
//
// Cada item mergeable (subrayados, marcadores, mensajes, notas) lleva:
//   uid       — identidad global estable entre dispositivos. En EPUB el CFI ya
//               es determinista (mismo pasaje → mismo uid en cualquier equipo);
//               donde no hay clave natural se genera un UUID.
//   updatedAt — última modificación local (LWW por item en el merge).
//   deleted / deletedAt — borrado lógico (tombstone): el borrado se propaga
//               entre dispositivos en vez de "resucitar" en la unión. Se purga
//               físicamente pasado TOMBSTONE_TTL_MS.
//
// migrateSchema() hace backfill de los datos previos a este esquema. Es
// idempotente (solo escribe campos ausentes); la marca en localStorage evita
// repetir el trabajo en cada arranque.

import * as Storage from '../storage.js';
import { backfillSyncFields, purgeDeletedNotes } from '../ai/db.js';

const MIGRATED_KEY = 'sync_schema_migrated';
const SCHEMA_VERSION = 1;
const COLLECTION_PREFIXES = ['highlights_', 'bookmarks_'];

export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

export function newUid() {
  return crypto.randomUUID();
}

// Marca un item como borrado (tombstone) en vez de eliminarlo del array.
export function tombstone(item, now = Date.now()) {
  item.deleted = true;
  item.deletedAt = now;
  item.updatedAt = now;
}

// Quita el tombstone de un item re-creado (mismo uid, el merge lo fusiona bien).
export function revive(item, now = Date.now()) {
  delete item.deleted;
  delete item.deletedAt;
  item.updatedAt = now;
}

// Backfill de un item: uid estable (CFI si existe, si no el id previo o un UUID)
// y updatedAt desde el timestamp que ya tuviera. Solo escribe campos ausentes.
function backfillItem(item, now) {
  let changed = false;
  if (!item.uid) {
    item.uid = item.cfi || item.id || newUid();
    changed = true;
  }
  if (!item.updatedAt) {
    item.updatedAt = item.timestamp || item.ts || now;
    changed = true;
  }
  return changed;
}

function backfillCollections(prefix, now) {
  const all = Storage.getAll(prefix);
  for (const [key, list] of Object.entries(all)) {
    if (!Array.isArray(list)) continue;
    let changed = false;
    for (const item of list) changed = backfillItem(item, now) || changed;
    if (changed) Storage.set(key, list);
  }
}

// Backfill completo (localStorage + IndexedDB), sin marca: lo usa la migración
// del arranque y también el import de backups antiguos sin uid.
export async function backfillAll(now = Date.now()) {
  for (const prefix of COLLECTION_PREFIXES) backfillCollections(prefix, now);
  await backfillSyncFields(now);
}

// Migración al arrancar. Devuelve true si hizo trabajo.
export async function migrateSchema(now = Date.now()) {
  if (Storage.get(MIGRATED_KEY) === SCHEMA_VERSION) return false;
  await backfillAll(now);
  Storage.set(MIGRATED_KEY, SCHEMA_VERSION);
  return true;
}

// Purga física de tombstones caducados. Corre en cada arranque: los borrados ya
// propagados no necesitan sobrevivir más de TOMBSTONE_TTL_MS.
export async function purgeExpiredTombstones(now = Date.now()) {
  for (const prefix of COLLECTION_PREFIXES) {
    const all = Storage.getAll(prefix);
    for (const [key, list] of Object.entries(all)) {
      if (!Array.isArray(list)) continue;
      const kept = list.filter(i => !i.deleted || now - (i.deletedAt || 0) < TOMBSTONE_TTL_MS);
      if (kept.length !== list.length) Storage.set(key, kept);
    }
  }
  await purgeDeletedNotes(now - TOMBSTONE_TTL_MS);
}
