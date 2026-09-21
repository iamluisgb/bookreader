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
import { buildSnapshot, restoreSnapshot, bookDigest, stable, BASE, SCHEMA_VERSION } from './layout.js';

// { manifestEtag, books: { <path>: etag }, digests: { <path>: digest }, libraryAt, libraryHash,
//   diag: { lastOkAt, lastErrorAt, lastError, consecutive, history[], intentionalOff } }
const STATE_KEY = 'sync_state';
const RETRIES = 3;
// Diagnóstico (P1): el sync fallaba en silencio — el badge solo asomaba el token
// revocado y no había forma de saber desde el dispositivo QUÉ estaba pasando.
// Cada ciclo deja huella en sync_state (que no viaja: está en SKIP_KEYS) y la
// UI la expone en Ajustes → Datos y en el badge.
const DIAG_MAX = 12;        // entradas de historial que se conservan
export const ERROR_BADGE_AFTER = 3; // fallos consecutivos antes de asomar el badge

const LIBRARY_PATH = BASE + LibrarySync.LIBRARY_FILE;
const COVERS_PATH = BASE + LibrarySync.COVERS_FILE;
const SETTINGS_PATH = BASE + 'settings.json';

// Huella corta (djb2) de un objeto, para guardarla en localStorage sin coste.
// `stable` (claves ordenadas) vive en layout.js y la comparte con el digest de libro.
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
  const st = Storage.get(STATE_KEY, { manifestEtag: null, books: {} });
  if (!st.digests) st.digests = {};
  if (!st.diag) st.diag = { lastOkAt: 0, lastErrorAt: 0, lastError: '', consecutive: 0, history: [], intentionalOff: false };
  return st;
}

// ---- Diagnóstico -------------------------------------------------------------

function pushHistory(st, entry) {
  const h = st.diag.history || (st.diag.history = []);
  h.unshift(entry);
  if (h.length > DIAG_MAX) h.length = DIAG_MAX;
}

function recordSuccess(result, ms) {
  const st = loadState();
  st.diag.lastOkAt = Date.now();
  st.diag.consecutive = 0;
  pushHistory(st, { at: st.diag.lastOkAt, ok: true, ms, pulled: result.pulled || 0, pushed: result.pushed || 0 });
  Storage.set(STATE_KEY, st);
}

function recordFailure(e, ms) {
  const st = loadState();
  st.diag.lastErrorAt = Date.now();
  st.diag.lastError = String((e && e.message) || 'error').slice(0, 300);
  st.diag.consecutive = (st.diag.consecutive || 0) + 1;
  pushHistory(st, { at: st.diag.lastErrorAt, ok: false, ms, error: st.diag.lastError });
  Storage.set(STATE_KEY, st);
}

// Lo que la UI pinta (Ajustes → Datos) y usa para decidir el badge.
export function getDiag() {
  return loadState().diag;
}

// ¿Sincronizó este dispositivo alguna vez? Para no alarmar con un badge a quien
// nunca conectó Drive, y para detectar la desconexión SORPRENDIDA: si hay
// historial pero el refresh token desapareció (el navegador purgó el storage,
// p. ej.), el sync queda 'off' y sin señal — justo el caso que hay que enseñar.
export function hasSyncHistory() {
  const st = loadState();
  return !st.diag.intentionalOff && !!(st.diag.lastOkAt || st.manifestEtag);
}

// Desconexión a propósito (botón "Desconectar"): no es un síntoma, no avisa.
// La reconexión la deshace refreshConnection().
export function setIntentionalOff(v) {
  const st = loadState();
  st.diag.intentionalOff = !!v;
  Storage.set(STATE_KEY, st);
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
  let pulledBooks = 0;
  // Versiones de TODO lo que hay en remoto, en una sola petición (el listado de
  // Drive trae ya la de cada fichero). Es la referencia que decide qué bajar:
  // la asigna el proveedor en cada escritura y no puede retroceder, a
  // diferencia de los sellos de tiempo del manifest (ver 1a).
  const remoteFiles = await Drive.list(BASE);
  const remoteEtags = new Map(remoteFiles.map(f => [f.path, String(f.etag)]));
  const isFresh = (path) => remoteEtags.has(path) && remoteEtags.get(path) !== String(st.books[path] || '');
  if (m) {
    remoteManifest = JSON.parse(m.content);
    if ((remoteManifest.schemaVersion || 0) > SCHEMA_VERSION) {
      throw new Error(t('Lo guardado en Drive es de una versión más nueva de BookReader.'));
    }
    let merged = 0;
    for (const f of remoteFiles.filter(x => x.path.startsWith(BASE + 'books/'))) {
      if (st.books[f.path] === f.etag) continue;
      const file = await Drive.read(f.path);
      if (!file) continue;
      const id = f.path.slice((BASE + 'books/').length).replace(/\.json$/, '');
      const remoteBook = JSON.parse(file.content);
      applyingRemote = true;
      try {
        await restoreSnapshot({ books: { [id]: remoteBook } }, { mode: 'merge' });
      } finally {
        applyingRemote = false;
      }
      st.books[f.path] = file.etag;
      // Lo que el remoto ya sabe de este libro. Compararlo con lo local es lo que
      // detecta "tengo cambios que él no tiene" cuando los updatedAt ya empatan.
      st.digests[f.path] = bookDigest(remoteBook);
      save();
      merged++;
      pulledBooks++;
    }
    st.manifestEtag = m.etag;
    save();
    if (merged) window.dispatchEvent(new CustomEvent('bookreader:remote-applied'));
  }

  // 1a) PULL de BIBLIOTECA — metadatos de libros y estanterías. Van en ficheros
  // propios y solo se descargan si su VERSIÓN remota cambió: leerlos enteros en
  // cada ciclo costaría dos peticiones de más cada 90 s por nada.
  //
  // library.json y covers.json están separados por su ritmo de escritura: el
  // progreso de lectura mueve library.json constantemente, mientras que las
  // portadas —que son casi todo el peso— solo cambian al añadir o quitar libros.
  //
  // La decisión NO puede colgar de `manifest.libraryUpdatedAt`, y es la misma
  // historia que ya costó los ajustes (ver 1c): ese sello PUEDE RETROCEDER. No
  // hace falta ni una carrera — basta un 412 en el manifest, que es lo normal
  // con dos dispositivos sincronizando a la vez: el reintento relee el manifest
  // remoto y, como la biblioteca ya está subida, hereda el sello VIEJO y lo
  // reescribe encima del suyo. A partir de ahí el otro dispositivo tiene ese
  // mismo número apuntado, la condición —que era una IGUALDAD— da falso, y NO
  // VUELVE A LEER `library.json` JAMÁS: sus libros nuevos están en Drive todo el
  // tiempo, pero nadie los pide. Ese era el "descargué libros en el móvil y en
  // la tablet no aparecen".
  //
  // La versión del propio fichero sí es monótona: la asigna Drive en cada
  // escritura. Y viene gratis en el listado que ya hacemos para los libros.
  let libraryFingerprint = st.libraryHash;
  let coversFingerprint = st.coversHash;
  let libraryChanged = false;
  let pulledLibrary = 0;
  if (isFresh(LIBRARY_PATH)) {
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
      pulledLibrary++;
    }
    st.libraryAt = (remoteManifest && remoteManifest.libraryUpdatedAt) || st.libraryAt || 0;
    save();
  }
  if (isFresh(COVERS_PATH)) {
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
    st.coversAt = (remoteManifest && remoteManifest.coversUpdatedAt) || st.coversAt || 0;
    save();
    pulledLibrary++;
  }
  if (libraryChanged) window.dispatchEvent(new CustomEvent('bookreader:library-changed'));

  // 1c) PULL de AJUSTES globales. settings.json se escribía solo en el primer push y no
  // se leía jamás: los ajustes no viajaban entre dispositivos. Se aplica en modo 'merge'
  // (solo rellena lo que falta en local), así que no pisa las preferencias de este
  // equipo; lo que sí cruza es la RACHA de estudio, que no es una preferencia sino un
  // contador que avanza allí donde repasas (ver layout.js · mergeStreak).
  //
  // La decisión NO puede colgar de `manifest.settingsUpdatedAt`. Drive no soporta
  // If-Match, así que el manifest se escribe releyendo la versión justo antes (ver
  // drive-provider.js): hay una ventana en la que dos equipos que sincronizan a la vez
  // se pisan, y el segundo puede dejar un `settingsUpdatedAt` MÁS VIEJO. Cuando eso
  // pasa, ambos acaban con el mismo número mientras uno conserva los ajustes viejos —
  // y comparando por igualdad, ese equipo no vuelve a leer settings.json NUNCA: la
  // racha de estudio y cualquier ajuste global se le congelan, en silencio y para
  // siempre. Medido: pasaba en ~6 de cada 10 arranques solapados.
  //
  // La versión del PROPIO settings.json sí es monótona: la asigna el proveedor en cada
  // escritura y no puede retroceder. Se compara contra la que este equipo aplicó (o
  // subió, que también la guarda). Cuesta una lectura por ciclo de un fichero pequeño,
  // a cambio de que el estado no pueda quedar encallado.
  //
  // Y esa lectura se hace AQUÍ, no con la versión que trae el listado del principio del
  // ciclo: entre el listado y este punto se han bajado libros y biblioteca, y en esa
  // ventana el otro dispositivo puede haber escrito settings.json. Decidir con el
  // listado viejo es no leerlo, y como el merge de ajustes solo RELLENA lo que falta
  // —no es una unión simétrica como la de biblioteca—, el que se lo salta se queda con
  // los suyos y ya no vuelve a haber quien los cruce. Ahorrarse la petición sale caro
  // justo aquí.
  const remoteSettings = await Drive.read(SETTINGS_PATH);
  let pulledSettings = 0;
  if (remoteSettings && String(remoteSettings.etag) !== String(st.books[SETTINGS_PATH] || '')) {
    applyingRemote = true;
    try {
      await restoreSnapshot({ settings: JSON.parse(remoteSettings.content) }, { mode: 'merge' });
    } finally {
      applyingRemote = false;
    }
    st.books[SETTINGS_PATH] = remoteSettings.etag;
    st.settingsAt = (remoteManifest && remoteManifest.settingsUpdatedAt) || st.settingsAt || 0;
    save();
    pulledSettings++;
  }

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
    const path = BASE + info.file;
    // El sello de tiempo por sí solo no basta: al fusionar, el updatedAt local sube al
    // del remoto, y lo que este dispositivo hizo ANTES (repasar sin conexión mientras el
    // otro editaba) se quedaba por debajo del umbral y no subía nunca. El digest
    // responde a la otra mitad de la pregunta: "¿tengo algo que él no tenga?".
    const digest = bookDigest(snap.books[id]);
    const agreed = st.digests[path];
    if (info.updatedAt <= remoteAt && agreed !== undefined && digest === agreed) continue;
    const w = await Drive.write(path, JSON.stringify(snap.books[id]), { ifMatch: st.books[path] });
    st.books[path] = w.etag;
    st.digests[path] = digest;
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
  // Los sellos del manifest ya no deciden nada aquí (lo decide la versión del
  // fichero, ver 1a), pero se siguen escribiendo para las versiones anteriores
  // de la app que aún los miran — y sin dejar que RETROCEDAN, que es justo lo
  // que las dejaba encalladas.
  st.libraryAt = Math.max(library.at, st.libraryAt || 0);

  const covers = await pushIfChanged(
    COVERS_PATH, await LibrarySync.buildCovers(), coversFingerprint,
    remoteManifest && remoteManifest.coversUpdatedAt, 'coversHash');
  st.coversAt = Math.max(covers.at, st.coversAt || 0);
  save();

  snap.manifest.libraryUpdatedAt = st.libraryAt;
  snap.manifest.coversUpdatedAt = st.coversAt;

  // 2b) PUSH de AJUSTES. A diferencia de biblioteca y portadas, la huella se compara
  // contra lo que ESTE dispositivo subió la última vez, no contra lo acordado con el
  // remoto: en modo 'merge' las preferencias locales no se pisan, así que dos equipos
  // con ajustes distintos nunca convergen a un mismo fichero y compararse con el remoto
  // los dejaría re-subiéndoselo el uno al otro para siempre. Así cada uno sube solo
  // cuando cambia lo suyo, y el último en escribir manda.
  const settingsFp = fingerprint(snap.settings);
  let settingsAt = (remoteManifest && remoteManifest.settingsUpdatedAt) || 0;
  let settingsPushed = false;
  if (settingsFp !== st.settingsHash) {
    const w = await Drive.write(SETTINGS_PATH, JSON.stringify(snap.settings), { ifMatch: st.books[SETTINGS_PATH] });
    st.books[SETTINGS_PATH] = w.etag;
    st.settingsHash = settingsFp;
    settingsAt = Date.now();
    settingsPushed = true;
  }
  // `settingsUpdatedAt` NO PUEDE RETROCEDER. Dos dispositivos escriben el manifest casi
  // a la vez y el segundo en llegar puede llevar un valor MÁS VIEJO: el If-Match es de
  // cliente (Drive no lo soporta, ver drive-provider.js), así que entre releer la versión
  // y escribir hay una ventana. Si el número retrocede, ambos equipos acaban con el mismo
  // valor mientras uno conserva los ajustes viejos — y como la condición de pull (1c) es
  // una IGUALDAD, ese equipo no vuelve a leer settings.json NUNCA: la racha de estudio y
  // cualquier ajuste global se le congelan en silencio y para siempre.
  //
  // Quedarse con el máximo cierra el agujero sin tocar el protocolo: el que va por detrás
  // ve un número mayor que el suyo y sí re-lee.
  settingsAt = Math.max(settingsAt, st.settingsAt || 0);
  st.settingsAt = settingsAt;
  save();
  snap.manifest.settingsUpdatedAt = settingsAt;

  if (pushed || titleHealed || library.pushed || covers.pushed || settingsPushed || !m) {
    const w = await Drive.write(BASE + 'manifest.json', JSON.stringify(snap.manifest), { ifMatch: m ? m.etag : undefined });
    st.manifestEtag = w.etag;
    save();
  }
  // pulled: cuántos ficheros remotos se aplicaron (libros + biblioteca + ajustes).
  // Es la métrica que responde "¿el ciclo de hoy trajo algo del otro dispositivo?".
  return { pulled: pulledBooks + pulledLibrary + pulledSettings, pushed };
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
  const t0 = Date.now();
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
    // Huella de diagnóstico solo de ciclos REALES: 'locked' (otra pestaña)
    // no es ni acierto ni fallo, es no haber corrido.
    if (result && typeof result === 'object') recordSuccess(result, Date.now() - t0);
  } catch (e) {
    setStatus(e && e.message === 'reconnect' ? 'reconnect' : 'error');
    recordFailure(e, Date.now() - t0);
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
  if (DriveAuth.isConnected()) {
    setIntentionalOff(false);
    syncNow();
  } else {
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
