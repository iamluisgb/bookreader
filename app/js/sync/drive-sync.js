// Fase 1 del sync: Guardar/Restaurar MANUAL en Drive sobre el layout por-libro.
// Sin merge automático todavía (eso es el SyncEngine, Fase 2): guardar sube el
// estado local; restaurar trae el remoto y lo aplica encima (fusiona clave a
// clave, no borra lo local que no coincida).

import * as Drive from './drive-provider.js';
import { buildSnapshot, restoreSnapshot, BASE, SCHEMA_VERSION } from './layout.js';
import { backfillAll } from './schema.js';

export async function saveToDrive(onProgress = () => {}) {
  const snap = await buildSnapshot();
  const total = Object.keys(snap.books).length + 2;
  let done = 0;
  const step = async (path, obj) => {
    await Drive.write(path, JSON.stringify(obj));
    onProgress(++done, total);
  };
  await step(BASE + 'settings.json', snap.settings);
  for (const [id, book] of Object.entries(snap.books)) {
    await step(BASE + 'books/' + id + '.json', book);
  }
  // El manifest se sube el ÚLTIMO: si algo falló antes, el índice remoto nunca
  // apunta a un estado a medias.
  await step(BASE + 'manifest.json', snap.manifest);
  return { books: Object.keys(snap.books).length };
}

// Devuelve null si no hay nada guardado en Drive todavía.
export async function restoreFromDrive(onProgress = () => {}) {
  const m = await Drive.read(BASE + 'manifest.json');
  if (!m) return null;
  const manifest = JSON.parse(m.content);
  if ((manifest.schemaVersion || 0) > SCHEMA_VERSION) {
    throw new Error('Lo guardado en Drive es de una versión más nueva de BookReader. Actualiza la app.');
  }
  const entries = Object.entries(manifest.books || {});
  const total = entries.length + 1;
  let done = 0;

  const settingsFile = await Drive.read(BASE + 'settings.json');
  onProgress(++done, total);

  const books = {};
  for (const [id, info] of entries) {
    const f = await Drive.read(BASE + (info.file || 'books/' + id + '.json'));
    if (f) books[id] = JSON.parse(f.content);
    onProgress(++done, total);
  }

  const r = await restoreSnapshot({
    settings: settingsFile ? JSON.parse(settingsFile.content) : {},
    books,
  });
  // Datos guardados por versiones antiguas: normalizar a esquema mergeable.
  await backfillAll();
  return r;
}

// Metadatos de lo guardado en Drive (para mostrar "última copia: ...").
export async function remoteInfo() {
  const m = await Drive.read(BASE + 'manifest.json');
  if (!m) return null;
  const manifest = JSON.parse(m.content);
  return {
    updatedAt: manifest.updatedAt || null,
    books: Object.keys(manifest.books || {}).length,
    modifiedTime: m.modifiedTime,
  };
}
