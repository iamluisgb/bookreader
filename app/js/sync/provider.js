// Proveedor ACTIVO del sync (MON4 F0, ADR-056 §5). El motor (engine.js), la cola de
// ficheros (blobs.js) y la recuperación (recovery.js) hablan con este módulo y no con un
// proveedor concreto: así el mismo motor sirve para Google Drive, para el sync de
// BookReader y, mañana, para WebDAV (P7 F3).
//
// Interfaz que cumple cada proveedor (la de SYNC_PLAN.md, más lo que ya usaba el motor):
//
//   list(prefix)                      -> [{ path, etag, modifiedTime, size }]
//   read(path)                        -> { content, etag, modifiedTime } | null
//   write(path, content, { ifMatch }) -> { etag }        (err.code = 412 si no coincide)
//   remove(path)                      -> void
//   exists(path)                      -> { path, etag, size } | null
//   readBinary(path, onProgress)      -> { blob, etag, size } | null
//   writeBinary(path, data, { mime, onProgress }) -> { etag, size }
//   listRevisions(path)               -> { fileId, revisions: [{ id, modifiedTime, size }] } | null
//   readRevision(fileId, revisionId)  -> string
//   isQuotaError(err)                 -> boolean
//   appUsage(prefix)                  -> bytes que ocupa BookReader
//
// Más lo que cambia de un proveedor a otro y la UI necesita saber: si está conectado, si
// deja sincronizar ficheros de libro y cómo se dicen sus errores.
//
// Cuál está activo vive en `sync_provider` (localStorage, fuera del sync y del backup:
// cada dispositivo elige el suyo). Sin valor, Drive: es lo que había antes de MON4.

import { t } from '../i18n.js';
import * as Storage from '../storage.js';
import * as Drive from './drive-provider.js';
import * as DriveAuth from './drive-auth.js';
import * as BookReader from './bookreader-provider.js';
import * as BookReaderAuth from './bookreader-auth.js';

const ACTIVE_KEY = 'sync_provider';

const IMPLS = {
  drive: {
    ...Drive,
    id: 'drive',
    label: 'Google Drive',
    isConnected: DriveAuth.isConnected,
    // Los ficheros de libro por Drive son gratis (ADR-060): gastan la cuota del propio usuario.
    canTransferFiles: () => true,
    text: {
      missingFile: () => t('El fichero ya no está en Drive.'),
      quotaFull: () => t('Tu Google Drive está lleno. Libera espacio para seguir sincronizando libros.'),
      reconnect: () => t('El permiso de Google caducó. Vuelve a conectar con Drive.'),
      newerSchema: () => t('Lo guardado en Drive es de una versión más nueva de BookReader.'),
      notUploaded: () => t('Este libro se sincronizó desde otro dispositivo, pero su archivo aún no está en Drive. Ábrelo allí una vez para subirlo.'),
      connectToDownload: () => t('Conecta con Google Drive en Ajustes para descargar tus libros en este dispositivo.'),
      connectToUpload: () => t('Conecta con Google Drive en Ajustes para subir tus libros.'),
      deleteEverywhere: (title) => t('¿Eliminar "{title}" de la biblioteca? Se borrará en todos tus dispositivos sincronizados, junto con la copia de Drive.', { title }),
    },
  },
  bookreader: {
    ...BookReader,
    id: 'bookreader',
    label: 'BookReader',
    isConnected: BookReaderAuth.isConnected,
    // Por el sync de BookReader decide el servidor: la suscripción incluye ficheros o no
    // (ADR-056, opción A/B), y al tope de cuota los libros dejan de subir.
    canTransferFiles: () => BookReaderAuth.filesAllowed(),
    text: {
      missingFile: () => t('El fichero ya no está en el sync de BookReader.'),
      quotaFull: () => t('Has llegado al tope de espacio del sync de BookReader. Tus notas siguen sincronizando; los libros nuevos ya no se suben.'),
      reconnect: () => t('Tu suscripción no está activa. El sync de BookReader queda en solo lectura.'),
      newerSchema: () => t('Lo sincronizado es de una versión más nueva de BookReader.'),
      notUploaded: () => t('Este libro se sincronizó desde otro dispositivo, pero su archivo aún no se ha subido. Ábrelo allí una vez para subirlo.'),
      connectToDownload: () => t('Activa la sincronización en Ajustes para descargar tus libros en este dispositivo.'),
      connectToUpload: () => t('Activa la sincronización en Ajustes para subir tus libros.'),
      deleteEverywhere: (title) => t('¿Eliminar "{title}" de la biblioteca? Se borrará en todos tus dispositivos sincronizados, junto con su copia en el sync.', { title }),
    },
  },
};

export const IDS = Object.keys(IMPLS);

export function activeId() {
  const id = Storage.get(ACTIVE_KEY, 'drive');
  return IMPLS[id] ? id : 'drive';
}

export function setActive(id) {
  if (!IMPLS[id]) throw new Error('Proveedor de sync desconocido: ' + id);
  Storage.set(ACTIVE_KEY, id);
}

// El proveedor activo. Para la UI que necesita saber cuál es (Ajustes, mensajes).
export function active() {
  return IMPLS[activeId()];
}

// Un proveedor concreto, esté activo o no (migrar de uno a otro, F5).
export function get(id) {
  return IMPLS[id] || null;
}

export function isConnected() {
  return active().isConnected();
}

export function canTransferFiles() {
  return active().canTransferFiles();
}

export function text(key, ...args) {
  return active().text[key](...args);
}

// ---- Interfaz de almacenamiento: delega en el activo --------------------------

export function list(prefix) { return active().list(prefix); }
export function read(path) { return active().read(path); }
export function write(path, content, opts) { return active().write(path, content, opts); }
export function remove(path) { return active().remove(path); }
export function exists(path) { return active().exists(path); }
export function readBinary(path, onProgress) { return active().readBinary(path, onProgress); }
export function writeBinary(path, data, opts) { return active().writeBinary(path, data, opts); }
export function listRevisions(path) { return active().listRevisions(path); }
export function readRevision(fileId, revisionId) { return active().readRevision(fileId, revisionId); }
export function appUsage(prefix) { return active().appUsage(prefix); }
// Solo el sync de BookReader (el índice de la biblioteca para agentes, IA10).
export function canWriteBlocks() { return typeof active().writeBlocks === 'function'; }
export function writeBlocks(path, blocks) { return active().writeBlocks(path, blocks); }

// Un error de cuota de CUALQUIER proveedor: la cola de ficheros no debe seguir intentando
// con el resto de libros tras uno de estos, venga de donde venga.
export function isQuotaError(err) {
  return IDS.some(id => IMPLS[id].isQuotaError(err));
}
