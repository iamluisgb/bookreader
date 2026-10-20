// Cola de transferencias de FICHEROS de libro (Fases B y C). Sube los binarios
// a Drive y los baja bajo demanda en otro dispositivo — el "descargar" de Play
// Books.
//
// Por qué una cola aparte y no dentro del ciclo del SyncEngine: el ciclo corre
// bajo el Web Lock `bookreader-sync`, y bajar un EPUB de 50 MB dentro de ese
// lock bloquearía el sync de anotaciones de TODAS las pestañas durante minutos.
// Aquí hay lock propio (`bookreader-blobs`), la cola es serie y el engine solo
// la despierta.
//
// El binario es INMUTABLE: el bookId es el SHA-256 del fichero, así que
// files/<id> es contenido direccionable. De ahí que no haya merge, ni etags, ni
// 412: si el fichero ya está en remoto, no se vuelve a subir jamás
// (write-once), y al bajarlo se re-hashea para verificar que es el que
// pedíamos. Es también lo que hace que las anotaciones enganchen solas: el
// dispositivo que descarga obtiene bytes idénticos → mismo hash → mismo bookId.

import { t } from '../i18n.js';
import * as Storage from '../storage.js';
import * as LibStore from '../library/store.js';
import * as Provider from './provider.js';
import { hashBlob } from './hash-blob.js';
import { BASE } from './layout.js';

// Por encima de esto NO se sube solo: consumir varios cientos de MB de la cuota
// de Drive del usuario sin que lo pida sería abusivo. El menú del libro ofrece
// subirlo a mano y el id queda en MANUAL_KEY.
export const MAX_AUTO_UPLOAD = 50 * 1024 * 1024;

// Cadencia máxima de los eventos de progreso (ver emit).
const PROGRESS_MS = 200;

const MANUAL_KEY = 'blob_manual_uploads';  // ids que el usuario mandó subir pese al tamaño
const ENABLED_KEY = 'sync_files';          // interruptor general de sync de ficheros

const downloadQueue = [];
// Libros que NO se subieron por falta de espacio, con el motivo. La tarjeta lo enseña (la
// lección de P7: «Solo notas» sin decir por qué). Se vacía al empezar cada pasada: si el
// espacio se liberó, el siguiente intento lo dirá.
const blocked = new Map();
let inFlight = null; // promesa de la pasada en curso (null si la cola está parada)
let current = null;  // { id, dir, loaded, total }

// ---- Estado / eventos --------------------------------------------------------

// Un evento por trozo recibido eran miles de repintados en una descarga
// grande (la tarjeta se redibuja en cada uno). El progreso solo tiene que
// moverse a ojo: 200 ms basta. Los cambios de estado —queued, done, error— no
// se tiran nunca, que son los que mandan en la UI.
let lastRunningEmit = 0;

function emit(detail) {
  if (detail.state === 'running') {
    const now = Date.now();
    if (now - lastRunningEmit < PROGRESS_MS) return;
    lastRunningEmit = now;
  }
  window.dispatchEvent(new CustomEvent('bookreader:blob-progress', { detail }));
}

export function isEnabled() {
  return Storage.get(ENABLED_KEY, true) !== false;
}

export function setEnabled(on) {
  Storage.set(ENABLED_KEY, !!on);
}

// El sync de ficheros depende del proveedor: por Drive es Pro (gasta la cuota del propio
// usuario); por el sync de BookReader lo decide la suscripción. El de metadatos va siempre.
export function canTransfer() {
  return Provider.isConnected() && Provider.canTransferFiles() && isEnabled();
}

export function uploadBlockReason(id) {
  return blocked.get(id) || '';
}

export function currentTransfer() {
  return current;
}

export function isQueued(id) {
  return (current && current.id === id) || downloadQueue.includes(id);
}

function manualSet() {
  const v = Storage.get(MANUAL_KEY, []);
  return new Set(Array.isArray(v) ? v : []);
}

export function markManualUpload(id) {
  const s = manualSet();
  s.add(id);
  Storage.set(MANUAL_KEY, [...s]);
}

export function blobPath(record) {
  const ext = record.format === 'pdf' ? 'pdf' : 'epub';
  return `${BASE}files/${record.id}.${ext}`;
}

const MIME = { pdf: 'application/pdf', epub: 'application/epub+zip' };

// ---- Descarga (acción explícita del usuario) --------------------------------

// Encola la descarga del fichero de un libro fantasma. Devuelve una promesa que
// resuelve cuando ESA descarga termina (o falla).
export async function requestDownload(id) {
  if (!downloadQueue.includes(id)) downloadQueue.push(id);
  emit({ id, dir: 'down', state: 'queued', loaded: 0, total: 0 });
  const r = await run();
  // Ventana estrecha: si la pasada en curso ya había recorrido la cola cuando
  // encolamos, resuelve sin habernos atendido. Una segunda pasada lo cierra.
  if (downloadQueue.includes(id)) return run();
  return r;
}

export function cancelDownload(id) {
  const i = downloadQueue.indexOf(id);
  if (i >= 0) downloadQueue.splice(i, 1);
}

// IA10 · El fichero de un libro que no está en este equipo, solo para trocearlo y subir su texto
// (book-text.js): se baja y se verifica igual, pero NO se guarda. Sin pasar por la cola de
// descargas: no es algo que el usuario pidió ni debe salir en la tarjeta. null si no está en el
// remoto, si no hay sync de ficheros o si no es el fichero que se esperaba.
export async function fetchForText(record) {
  if (!record || !canTransfer() || !(record.blob && record.blob.path)) return null;
  const r = await Provider.readBinary(record.blob.path);
  if (!r) return null;
  if (/^[0-9a-f]{64}$/i.test(record.id) && (await hashBlob(r.blob)) !== record.id) return null;
  return r.blob;
}

async function downloadOne(id) {
  const record = await LibStore.getBook(id);
  if (!record || LibStore.hasFile(record)) return false;
  const path = (record.blob && record.blob.path) || blobPath(record);

  current = { id, dir: 'down', loaded: 0, total: record.size || 0 };
  emit({ ...current, state: 'running' });
  try {
    const r = await Provider.readBinary(path, (loaded, total) => {
      current = { id, dir: 'down', loaded, total: total || record.size || 0 };
      emit({ ...current, state: 'running' });
    });
    if (!r) {
      emit({ id, dir: 'down', state: 'error', message: Provider.text('missingFile') });
      return false;
    }
    // Verificación de integridad: el id ES el hash del fichero, así que
    // comprobarlo garantiza que los subrayados enganchan. Los ids heredados
    // (nombre de fichero, epubjs:…) no son hashes: no se verifican.
    //
    // Estado propio ('verifying') porque en un libro grande esto tarda lo suyo,
    // y una barra al 100% que sigue diciendo "Descargando…" se lee como colgada.
    if (/^[0-9a-f]{64}$/i.test(id)) {
      current = { id, dir: 'down', loaded: r.blob.size, total: r.blob.size };
      emit({ ...current, state: 'verifying' });
      const got = await hashBlob(r.blob);
      if (got !== id) {
        emit({ id, dir: 'down', state: 'error', message: t('El fichero descargado no coincide con el original.') });
        return false;
      }
    }
    // Se guarda el Blob tal cual, sin pasar por ArrayBuffer: IndexedDB los
    // almacena nativamente y así el binario nunca llega a estar entero en el
    // heap. hasFile() ya contaba con las dos formas (byteLength | size).
    await LibStore.putBook({ ...record, file: r.blob, size: r.blob.size }, { stamp: false });
    emit({ id, dir: 'down', state: 'done', loaded: r.blob.size, total: r.blob.size });
    return true;
  } catch (e) {
    emit({ id, dir: 'down', state: 'error', message: transferMessage(e) });
    return false;
  } finally {
    current = null;
  }
}

// ---- Subida (automática, con techo de tamaño) -------------------------------

// Libros de este dispositivo que deberían estar en Drive y no lo están.
async function pendingUploads() {
  const manual = manualSet();
  const records = await LibStore.getAllRecords();
  return records.filter(b =>
    b && b.id && !b.deleted && LibStore.hasFile(b) && !(b.blob && b.blob.path) &&
    ((b.size || 0) <= MAX_AUTO_UPLOAD || manual.has(b.id)));
}

// Libros borrados cuyo binario sigue ocupando cuota en Drive.
async function pendingRemovals() {
  const records = await LibStore.getAllRecords();
  return records.filter(b => b && b.deleted && b.blob && b.blob.path);
}

async function uploadOne(meta) {
  const path = blobPath(meta);
  current = { id: meta.id, dir: 'up', loaded: 0, total: meta.size || 0 };
  emit({ ...current, state: 'running' });
  try {
    // Write-once: si otro dispositivo ya lo subió, basta con apuntar al fichero.
    // Re-subir gastaría cuota y ancho de banda para producir bytes idénticos.
    const already = await Provider.exists(path);
    if (!already) {
      // El binario se lee AQUÍ, uno a uno: la lista de pendientes viene sin
      // ficheros justamente para no tener toda la biblioteca en memoria.
      const record = await LibStore.getRaw(meta.id);
      if (!record || !record.file) return false;
      await Provider.writeBinary(path, record.file, {
        mime: MIME[record.format] || 'application/octet-stream',
        onProgress: (loaded, total) => {
          current = { id: record.id, dir: 'up', loaded, total };
          emit({ ...current, state: 'running' });
        },
      });
    }
    // stamp por defecto — `blob` SÍ es sincronizable: es como el resto de
    // dispositivos se entera de que ya pueden descargarlo.
    const fresh = await LibStore.updateBook(meta.id, { blob: { path, uploadedAt: Date.now() } });
    if (fresh) window.dispatchEvent(new Event('bookreader:data-changed'));
    emit({ id: meta.id, dir: 'up', state: 'done', loaded: meta.size || 0, total: meta.size || 0 });
    return true;
  } catch (e) {
    const quota = Provider.isQuotaError(e);
    if (quota) blocked.set(meta.id, transferMessage(e));
    emit({ id: meta.id, dir: 'up', state: 'error', message: transferMessage(e), quota });
    // Cuota llena: no seguir intentando con el resto de la cola, se dará el
    // mismo error con cada libro y solo sirve para quemar peticiones.
    if (quota) throw e;
    return false;
  } finally {
    current = null;
  }
}

async function removeOne(record) {
  try {
    await Provider.remove(record.blob.path);
  } catch (e) {
    if (!e || e.code !== 404) return false; // ya no estaba: sigue adelante
  }
  // Un registro con tombstone no rescata campos monótonos en el merge, así que
  // limpiar `blob` aquí no se deshace en el siguiente pull.
  await LibStore.putBook({ ...record, blob: null }, { stamp: false });
  return true;
}

// ---- Runner ------------------------------------------------------------------

function transferMessage(e) {
  if (Provider.isQuotaError(e)) return Provider.text('quotaFull');
  if (e && e.code === 'timeout') return t('La transferencia se quedó sin respuesta. Se reintentará.');
  if (e && e.message === 'reconnect') return Provider.text('reconnect');
  return (e && e.message) || t('No se pudo transferir el fichero.');
}

async function drain() {
  // Las descargas van primero: son las que el usuario está esperando delante de
  // la pantalla. Las subidas son trabajo de fondo.
  while (downloadQueue.length) {
    const id = downloadQueue.shift();
    await downloadOne(id);
  }
  for (const record of await pendingRemovals()) await removeOne(record);
  blocked.clear();
  const uploads = await pendingUploads();
  for (let i = 0; i < uploads.length; i++) {
    if (downloadQueue.length) break;   // llegó una petición del usuario: atenderla ya
    try {
      await uploadOne(uploads[i]);
    } catch (e) {
      // Al tope: los que quedan tampoco van a caber. Se apuntan con el mismo motivo para que
      // sus tarjetas lo digan, y se corta aquí.
      for (const r of uploads.slice(i + 1)) blocked.set(r.id, transferMessage(e));
      window.dispatchEvent(new CustomEvent('bookreader:library-changed'));
      throw e;
    }
  }
  // Si entraron descargas mientras subíamos, vaciarlas antes de soltar el lock.
  if (downloadQueue.length) await drain();
}

// Vacía la cola. Si ya hay una pasada en curso devuelve SU promesa en vez de
// un 'busy' inmediato: quien hace `await requestDownload(id)` tiene que poder
// contar con que al resolver el fichero está descargado. drain() vuelve a mirar
// la cola en cada vuelta, así que lo encolado a mitad entra en la misma pasada.
function run() {
  if (!canTransfer()) {
    downloadQueue.length = 0;
    return Promise.resolve('off');
  }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      if (!('locks' in navigator)) return await drain();
      return await navigator.locks.request('bookreader-blobs', { ifAvailable: true }, async (lock) => {
        if (!lock) return 'locked';   // otra pestaña está transfiriendo
        return drain();
      });
    } catch (e) {
      emit({ dir: 'up', state: 'error', message: transferMessage(e) });
      return 'error';
    } finally {
      inFlight = null;
      current = null;
      emit({ state: 'idle' });
    }
  })();
  return inFlight;
}

// Despierta la cola: la llama el SyncEngine al terminar un ciclo, FUERA de su
// lock. No espera al resultado.
export function schedule() {
  if (!canTransfer()) return;
  run();
}

// Igual que schedule() pero esperable: vacía la cola y resuelve al terminar.
// Para quien necesita saber que las transferencias acabaron de verdad.
export function flush() {
  return run();
}

// ---- Espacio -----------------------------------------------------------------

// Sin persistencia, el navegador puede desalojar la IndexedDB —y con ella todos
// los libros guardados— cuando anda justo de espacio. Se pide una vez, sin
// bloquear: si el navegador dice que no, la app funciona igual.
export async function requestPersistence() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch (e) {
    return false;
  }
}

export async function localEstimate() {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    const { usage, quota } = await navigator.storage.estimate();
    return { usage: usage || 0, quota: quota || 0 };
  } catch (e) {
    return null;
  }
}
