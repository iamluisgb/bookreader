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
import { buildSnapshot, restoreSnapshot, BASE, SCHEMA_VERSION } from './layout.js';

const STATE_KEY = 'sync_state'; // { manifestEtag, books: { <path>: etag } } — último remoto visto
const RETRIES = 3;

const cfg = { debounceMs: 4000, intervalMs: 90000, startDelayMs: 1500 };
let debounceTimer = null;
let intervalTimer = null;
let running = false;
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
  debounceTimer = setTimeout(() => syncNow(), cfg.debounceMs);
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
  if (pushed || titleHealed || !m) {
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

export async function syncNow() {
  if (!DriveAuth.isConnected()) {
    setStatus('off');
    return 'off';
  }
  if (running) {
    pendingChange = true;
    return 'busy';
  }
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
  return result;
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
      syncNow();
    } else if (document.visibilityState === 'visible') {
      syncNow();
    }
  });
  window.addEventListener('online', notifyLocalChange);

  // Periódico (trae cambios de otros dispositivos) — solo con la pestaña visible.
  intervalTimer = setInterval(() => {
    if (document.visibilityState === 'visible') syncNow();
  }, cfg.intervalMs);

  // syncOnLoad, con un pequeño margen para no competir con el arranque.
  setTimeout(() => syncNow(), cfg.startDelayMs);
}

export function stop() {
  clearInterval(intervalTimer);
  clearTimeout(debounceTimer);
  started = false;
  setStatus('off');
}
