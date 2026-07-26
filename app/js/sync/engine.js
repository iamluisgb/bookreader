// SyncEngine (Fase 2) — sincronización automática pull → merge → push.
//
// Ciclo (cycle):
//   1. PULL: lee el manifest remoto y los ficheros de libro cuyo etag cambió
//      desde la última vez (sync_state), y los fusiona en local (merge por uid).
//   2. PUSH: sube los libros cuyo updatedAt local supera al del manifest remoto,
//      con ifMatch del último etag visto; el manifest va el último.
//   3. Si algo devolvió 412 (otro dispositivo escribió entre medias), reintenta
//      el ciclo completo con backoff + jitter (máx. 3). El merge es idempotente,
//      así que reintentar es seguro.
//
// Triggers: al arrancar, tras cambios locales (debounce), periódico con la
// pestaña visible, al ocultarla (flush) y al recuperar la conexión.
// Multi-pestaña: Web Locks — solo una pestaña sincroniza a la vez.
// Estado: evento 'bookreader:sync-status' con 'off|syncing|ok|error|reconnect'.

import { t } from '../i18n.js';
import * as Drive from './drive-provider.js';
import * as DriveAuth from './drive-auth.js';
import * as Highlights from '../highlights.js';
import * as Bookmarks from '../bookmarks.js';
import * as Storage from '../storage.js';
import * as Aliases from './aliases.js';
import * as LibrarySync from './library-sync.js';
import * as Blobs from './blobs.js';
import * as LibStore from '../library/store.js';
import { TOMBSTONE_TTL_MS } from './schema.js';
import { buildSnapshot, restoreSnapshot, BASE, SCHEMA_VERSION } from './layout.js';

const STATE_KEY = 'sync_state'; // { manifestEtag, books: { <path>: etag }, libraryAt, libraryHash, … }
const RETRIES = 3;

const LIBRARY_PATH = BASE + LibrarySync.LIBRARY_FILE;
const COVERS_PATH = BASE + LibrarySync.COVERS_FILE;

// Serialización con claves ordenadas: el "¿cambió la biblioteca?" se decide
// comparando huellas, y con JSON.stringify normal dos objetos idénticos con las
// claves en distinto orden dan huellas distintas → push infinito entre
// dispositivos, cada uno "corrigiendo" al otro sin que nada cambie.
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

// Huella corta (djb2) de un objeto, para guardarla en localStorage sin coste.
function fingerprint(obj) {
  const s = stable(obj);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0) + ':' + s.length;
}

const cfg = { debounceMs: 4000, intervalMs: 90000, startDelayMs: 1500 };
let debounceTimer = null;
let intervalTimer = null;
let running = false;
let inFlight = null;       // promesa del ciclo en curso (null si no hay ninguno)
let pendingChange = false; // hubo cambios locales mientras sincronizábamos
let applyingRemote = false; // las escrituras del propio merge no re-disparan push
let started = false;
let status = 'off';

function setStatus(s) {
  if (status === s) return;
  status = s;
  window.dispatchEvent(new CustomEvent('bookreader:sync-status', { detail: s }));
}

export function getStatus() {
  return status;
}

function loadState() {
  return Storage.get(STATE_KEY, { manifestEtag: null, books: {} });
}

// Un cambio local (subrayado, nota, posición…): push con debounce.
export function notifyLocalChange() {
  if (applyingRemote) return;
  if (!DriveAuth.isConnected()) return;
  if (running) {
    pendingChange = true;
    return;
  }
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => syncSoon(), cfg.debounceMs);
}

async function cycle() {
  const st = loadState();
  // El estado (últimos etags vistos) se persiste tras CADA escritura: si el
  // manifest da 412 tras haber subido un libro, el reintento debe partir de
  // los etags nuevos o entraría en bucle de 412 contra sus propias escrituras.
  const save = () => Storage.set(STATE_KEY, st);

  // 1) PULL — manifest + libros con etag remoto distinto al último visto.
  const m = await Drive.read(BASE + 'manifest.json');
  let remoteManifest = null;
  if (m) {
    remoteManifest = JSON.parse(m.content);
    if ((remoteManifest.schemaVersion || 0) > SCHEMA_VERSION) {
      throw new Error(t('Lo guardado en Drive es de una versión más nueva de BookReader.'));
    }
    const remoteFiles = await Drive.list(BASE + 'books/');
    let merged = 0;
    for (const f of remoteFiles) {
      if (st.books[f.path] === f.etag) continue;
      const file = await Drive.read(f.path);
      if (!file) continue;
      const id = f.path.slice((BASE + 'books/').length).replace(/\.json$/, '');
      applyingRemote = true;
      try {
        await restoreSnapshot({ books: { [id]: JSON.parse(file.content) } }, { mode: 'merge' });
      } finally {
        applyingRemote = false;
      }
      st.books[f.path] = file.etag;
      save();
      merged++;
    }
    st.manifestEtag = m.etag;
    save();
    if (merged) window.dispatchEvent(new CustomEvent('bookreader:remote-applied'));
  }

  // 1a) PULL de BIBLIOTECA — metadatos de libros y estanterías. Van en ficheros
  // propios y solo se descargan si el manifest dice que cambiaron: leerlos en
  // cada ciclo costaría dos peticiones de más cada 90 s por nada.
  //
  // library.json y covers.json están separados por su ritmo de escritura: el
  // progreso de lectura mueve library.json constantemente, mientras que las
  // portadas —que son casi todo el peso— solo cambian al añadir o quitar libros.
  let libraryFingerprint = st.libraryHash;
  let coversFingerprint = st.coversHash;
  let libraryChanged = false;
  if (remoteManifest && (remoteManifest.libraryUpdatedAt || 0) !== (st.libraryAt || 0)) {
    const f = await Drive.read(LIBRARY_PATH);
    if (f) {
      const remoteLibrary = JSON.parse(f.content);
      applyingRemote = true;
      try {
        libraryChanged = (await LibrarySync.applyLibrary(remoteLibrary)) > 0;
      } finally {
        applyingRemote = false;
      }
      libraryFingerprint = fingerprint(remoteLibrary);
      st.books[LIBRARY_PATH] = f.etag;
    }
    st.libraryAt = remoteManifest.libraryUpdatedAt || 0;
    save();
  }
  if (remoteManifest && (remoteManifest.coversUpdatedAt || 0) !== (st.coversAt || 0)) {
    const f = await Drive.read(COVERS_PATH);
    if (f) {
      const remoteCovers = JSON.parse(f.content);
      applyingRemote = true;
      try {
        libraryChanged = (await LibrarySync.applyCovers(remoteCovers)) > 0 || libraryChanged;
      } finally {
        applyingRemote = false;
      }
      coversFingerprint = fingerprint(remoteCovers);
      st.books[COVERS_PATH] = f.etag;
    }
    st.coversAt = remoteManifest.coversUpdatedAt || 0;
    save();
  }
  if (libraryChanged) window.dispatchEvent(new CustomEvent('bookreader:library-changed'));

  // 1b) Reconciliación de identidad: el mismo título bajo dos hashes (descargas
  // no byte-idénticas del mismo libro en cada dispositivo) se fusiona en el id
  // canónico ANTES del push, así ambos lados convergen al mismo fichero remoto
  // en vez de sincronizar cada uno "su" libro sin cruzarse jamás.
  applyingRemote = true;
  let reconciled;
  try {
    reconciled = Aliases.reconcile(await Aliases.collectTitles(remoteManifest && remoteManifest.books));
  } finally {
    applyingRemote = false;
  }
  if (reconciled) window.dispatchEvent(new CustomEvent('bookreader:remote-applied'));

  // 2) PUSH — libros locales más nuevos que el manifest remoto.
  const snap = await buildSnapshot();
  const remoteBooks = (remoteManifest && remoteManifest.books) || {};
  // Título PEGAJOSO: un dispositivo que tiene datos de un libro que bajó por sync
  // (no lo importó) no conoce su título y lo pondría a null, pisando el que otro
  // dispositivo sí conocía → aliases.js dejaría de poder agrupar (mismo libro,
  // distinto hash) y los subrayados nunca se cruzarían. Si el remoto sabe el
  // título y el local no, se conserva. Y si ESTE dispositivo aporta un título que
  // el manifest remoto no tenía (o tenía a null), hay que re-subir el manifest
  // aunque no cambie ningún libro, para sanar el Drive viejo donde iban a null.
  let titleHealed = false;
  for (const [id, info] of Object.entries(snap.manifest.books)) {
    const remoteTitle = remoteBooks[id] && remoteBooks[id].title;
    if (!info.title && remoteTitle) info.title = remoteTitle;
    if (info.title && info.title !== remoteTitle) titleHealed = true;
  }
  let pushed = 0;
  for (const [id, info] of Object.entries(snap.manifest.books)) {
    const remoteAt = (remoteBooks[id] && remoteBooks[id].updatedAt) || 0;
    if (info.updatedAt <= remoteAt) continue;
    const path = BASE + info.file;
    const w = await Drive.write(path, JSON.stringify(snap.books[id]), { ifMatch: st.books[path] });
    st.books[path] = w.etag;
    save();
    pushed++;
  }
  // 2a) PUSH de BIBLIOTECA — se sube solo si el contenido difiere de aquello en
  // lo que remoto y local ya coincidían (huella), no si "hay cambios locales":
  // así dos dispositivos con la misma biblioteca no se pisan el fichero en
  // bucle. El manifest hereda los sellos de tiempo del remoto cuando no hay
  // nada que subir.
  // Sube `content` a `path` solo si su huella difiere de la acordada con el
  // remoto, y devuelve el sello de tiempo que debe ir al manifest: el de ahora
  // si hubo subida, el del remoto si no. Comparar huellas —y no "¿hubo cambios
  // locales?"— es lo que evita que dos dispositivos con la misma biblioteca se
  // reescriban el fichero en bucle, cada uno reaccionando al push del otro.
  async function pushIfChanged(path, content, agreedFp, remoteAt, stateKey) {
    const fp = fingerprint(content);
    st[stateKey] = fp;
    if (fp === agreedFp) return { at: remoteAt || 0, pushed: false };
    const w = await Drive.write(path, JSON.stringify(content), { ifMatch: st.books[path] });
    st.books[path] = w.etag;
    return { at: Date.now(), pushed: true };
  }

  const library = await pushIfChanged(
    LIBRARY_PATH, await LibrarySync.buildLibrary(), libraryFingerprint,
    remoteManifest && remoteManifest.libraryUpdatedAt, 'libraryHash');
  st.libraryAt = library.at;

  const covers = await pushIfChanged(
    COVERS_PATH, await LibrarySync.buildCovers(), coversFingerprint,
    remoteManifest && remoteManifest.coversUpdatedAt, 'coversHash');
  st.coversAt = covers.at;
  save();

  snap.manifest.libraryUpdatedAt = library.at;
  snap.manifest.coversUpdatedAt = covers.at;

  if (pushed || titleHealed || library.pushed || covers.pushed || !m) {
    if (!m) await Drive.write(BASE + 'settings.json', JSON.stringify(snap.settings));
    const w = await Drive.write(BASE + 'manifest.json', JSON.stringify(snap.manifest), { ifMatch: m ? m.etag : undefined });
    st.manifestEtag = w.etag;
    save();
  }
  return { pushed };
}

async function runWithLock(fn) {
  if (!('locks' in navigator)) return fn(); // sin Web Locks: mejor sincronizar que no hacerlo
  return navigator.locks.request('bookreader-sync', { ifAvailable: true }, (lock) => {
    if (!lock) return 'locked'; // otra pestaña está sincronizando
    return fn();
  });
}

// Un ciclo completo, con reintento en 412. No mira si ya hay otro en curso: de
// eso se encargan syncNow/syncSoon.
async function runOnce() {
  clearTimeout(debounceTimer);
  running = true;
  let result;
  try {
    result = await runWithLock(async () => {
      setStatus('syncing');
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await cycle();
          setStatus('ok');
          return r;
        } catch (e) {
          if (e && e.code === 412 && attempt < RETRIES - 1) {
            await new Promise(res => setTimeout(res, 300 * (attempt + 1) + Math.random() * 300));
            continue;
          }
          throw e;
        }
      }
    });
  } catch (e) {
    setStatus(e && e.message === 'reconnect' ? 'reconnect' : 'error');
    result = 'error';
  } finally {
    running = false;
  }
  if (pendingChange) {
    pendingChange = false;
    notifyLocalChange();
  }
  // Los ficheros de libro van FUERA del lock de sync: una descarga de 50 MB
  // dentro de él dejaría a todas las pestañas sin sincronizar durante minutos.
  Blobs.schedule();
  return result;
}

// "Sincroniza AHORA, incluyendo lo que acabo de cambiar". Si hay un ciclo en
// vuelo, espera a que acabe y lanza otro: el que estaba corriendo pudo empezar
// antes de mi cambio y no lo llevaría.
//
// Antes devolvía 'busy' al instante, y eso convertía a `await syncNow()` en una
// promesa mentirosa — resolvía sin haber sincronizado nada. Lo usan el botón de
// Ajustes y los tests, justo donde esa mentira más duele.
export function syncNow() {
  if (!DriveAuth.isConnected()) {
    setStatus('off');
    return Promise.resolve('off');
  }
  if (inFlight) return inFlight.then(() => syncNow());
  inFlight = runOnce().finally(() => { inFlight = null; });
  return inFlight;
}

// Disparadores automáticos (intervalo, pestaña visible, reconexión): si ya hay
// un ciclo en curso no encadenan otro — sería tráfico por nada. Marcan que
// quedaron cambios y el propio ciclo se reprograma al terminar.
function syncSoon() {
  if (!DriveAuth.isConnected()) {
    setStatus('off');
    return;
  }
  // `running` se pone en síncrono al empezar el ciclo; `inFlight` un tick
  // después. Mirar los dos cierra esa ventana.
  if (running || inFlight) {
    pendingChange = true;
    return;
  }
  syncNow();
}

// Reevalúa la conexión (tras Conectar/Desconectar en Ajustes).
export function refreshConnection() {
  if (DriveAuth.isConnected()) syncNow();
  else {
    clearTimeout(debounceTimer);
    setStatus('off');
  }
}

export function start(options = {}) {
  Object.assign(cfg, options);
  if (started) return;
  started = true;

  // Cambios locales: colecciones (UI y módulos) + IDB/posición (evento).
  Highlights.setOnChange(notifyLocalChange);
  Bookmarks.setOnChange(notifyLocalChange);
  window.addEventListener('bookreader:data-changed', notifyLocalChange);

  // Al ocultar/mostrar pestaña: flush al ocultarse, sync inmediato al mostrarse.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && debounceTimer) {
      clearTimeout(debounceTimer);
      syncSoon();
    } else if (document.visibilityState === 'visible') {
      syncSoon();
    }
  });
  window.addEventListener('online', notifyLocalChange);

  // Periódico (trae cambios de otros dispositivos) — solo con la pestaña visible.
  intervalTimer = setInterval(() => {
    if (document.visibilityState === 'visible') syncSoon();
  }, cfg.intervalMs);

  // Guardar libros enteros en IndexedDB sin pedir persistencia es jugársela: el
  // navegador desaloja el origen cuando anda justo de espacio y se lleva la
  // biblioteca por delante. Con sync eso sería recuperable, pero sin él no.
  Blobs.requestPersistence();

  // syncOnLoad, con un pequeño margen para no competir con el arranque.
  setTimeout(() => syncSoon(), cfg.startDelayMs);

  // Purga de tombstones de biblioteca ya propagados (mismo TTL que el resto).
  setTimeout(() => {
    const before = Date.now() - TOMBSTONE_TTL_MS;
    LibStore.purgeDeleted(before).catch(() => {});
    LibStore.purgeDeletedShelves(before).catch(() => {});
  }, cfg.startDelayMs + 5000);
}

export function stop() {
  clearInterval(intervalTimer);
  clearTimeout(debounceTimer);
  started = false;
  setStatus('off');
}
