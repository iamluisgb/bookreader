// DriveProvider — implementación Google Drive (appDataFolder) de la interfaz
// StorageProvider del plan de sync (SYNC_PLAN.md):
//
//   list(prefix) -> [{ path, etag, modifiedTime }]
//   read(path)   -> { content, etag } | null
//   write(path, content, { ifMatch }) -> { etag }   (err.code=412 si ifMatch no coincide)
//   remove(path) -> void
//
// Concurrencia optimista: `version` del fichero hace de etag. Drive v3 no
// soporta If-Match real, así que write() con ifMatch relee la versión justo
// antes de subir (mejor esfuerzo); el bucle de reintento del SyncEngine
// (Fase 2) completa la garantía. Patrón REST portado de arete (js/drive.js).

import { getAccessToken } from './drive-auth.js';
import { fetchWithTimeout, fetchArrayBuffer, TRANSFER_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from './net.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

// Umbral de Drive para uploadType=multipart. Por encima hay que ir por sesión
// resumable, y la mayoría de PDFs lo pasan de largo.
const MULTIPART_MAX = 5 * 1024 * 1024;
// Múltiplo de 256 KB, requisito de Drive para los trozos intermedios.
const CHUNK_SIZE = 8 * 1024 * 1024;

// Techo por petición (ver net.js): sin él, un fetch estancado colgaba el ciclo de sync para
// siempre — badge "Sincronizando…" eterno y Web Lock retenido.
async function driveFetch(url, options = {}, retry = true, timeoutMs = REQUEST_TIMEOUT_MS) {
  const token = await getAccessToken();
  const res = await fetchWithTimeout(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: 'Bearer ' + token },
  }, timeoutMs);
  if (res.status === 401 && retry) {
    await getAccessToken(true); // caducó en vuelo → renovar y un solo reintento
    return driveFetch(url, options, false, timeoutMs);
  }
  if (!res.ok) throw await driveError(res);
  return res;
}

// La razón concreta importa para hablarle claro al usuario: un 403 por cuota
// llena ("tu Drive está lleno") no es lo mismo que un 403 por permisos, y
// mostrarlos igual como "Drive 403" no ayuda a nadie a arreglarlo.
async function driveError(res) {
  let reason = '';
  let message = '';
  try {
    const body = await res.json();
    const e = (body.error && body.error.errors && body.error.errors[0]) || {};
    reason = e.reason || '';
    message = (body.error && body.error.message) || '';
  } catch (e) { /* respuesta sin cuerpo JSON */ }
  const err = new Error(message ? `Drive ${res.status}: ${message}` : 'Drive ' + res.status);
  err.code = res.status;
  err.reason = reason;
  if (res.status === 403 && /quota/i.test(reason + message)) err.reason = 'storageQuotaExceeded';
  return err;
}

export function isQuotaError(err) {
  return !!err && err.reason === 'storageQuotaExceeded';
}

const FILE_FIELDS = 'id,name,version,modifiedTime,size';

async function findByName(name) {
  const url = API + '/files?' + new URLSearchParams({
    spaces: 'appDataFolder',
    q: `name='${name.replace(/'/g, "\\'")}'`,
    fields: `files(${FILE_FIELDS})`,
    pageSize: '1',
  });
  const data = await (await driveFetch(url)).json();
  return (data.files || [])[0] || null;
}

export async function list(prefix = '') {
  const files = [];
  let pageToken = '';
  do {
    const url = API + '/files?' + new URLSearchParams({
      spaces: 'appDataFolder',
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      pageSize: '100',
      ...(pageToken ? { pageToken } : {}),
    });
    const data = await (await driveFetch(url)).json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return files
    .filter(f => f.name.startsWith(prefix))
    .map(f => ({ path: f.name, etag: String(f.version), modifiedTime: f.modifiedTime, size: Number(f.size || 0) }));
}

export async function exists(path) {
  const f = await findByName(path);
  return f ? { path, etag: String(f.version), size: Number(f.size || 0) } : null;
}

export async function read(path) {
  const file = await findByName(path);
  if (!file) return null;
  const res = await driveFetch(`${API}/files/${file.id}?alt=media`);
  return { content: await res.text(), etag: String(file.version), modifiedTime: file.modifiedTime };
}

export async function write(path, content, { ifMatch } = {}) {
  const existing = await findByName(path);
  if (ifMatch !== undefined && existing && String(existing.version) !== String(ifMatch)) {
    const err = new Error('Precondition failed: el fichero cambió en remoto');
    err.code = 412;
    throw err;
  }
  const metadata = existing ? { name: path } : { name: path, parents: ['appDataFolder'] };
  const boundary = '---bookreader_boundary';
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  const url = existing
    ? `${UPLOAD}/files/${existing.id}?uploadType=multipart&fields=${FILE_FIELDS}`
    : `${UPLOAD}/files?uploadType=multipart&fields=${FILE_FIELDS}`;
  const res = await driveFetch(url, {
    method: existing ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  const data = await res.json();
  return { etag: String(data.version) };
}

export async function remove(path) {
  const file = await findByName(path);
  if (file) await driveFetch(`${API}/files/${file.id}`, { method: 'DELETE' });
}

// ---- Binarios (ficheros de libro) ------------------------------------------
//
// read()/write() son solo-texto a propósito: write() concatena el contenido
// DENTRO de un template literal, lo que corrompería cualquier binario, y read()
// hace res.text(). Los libros van por estas dos funciones aparte.

// Descarga el binario de `path`. `onProgress(loaded, total)` para la barra.
export async function readBinary(path, onProgress = null) {
  const file = await findByName(path);
  if (!file) return null;
  const token = await getAccessToken();
  const r = await fetchArrayBuffer(
    `${API}/files/${file.id}?alt=media`,
    { headers: { Authorization: 'Bearer ' + token } },
    onProgress,
  );
  if (!r.ok) {
    const err = new Error('Drive ' + r.status);
    err.code = r.status;
    throw err;
  }
  return { buffer: r.buffer, etag: String(file.version), size: Number(file.size || 0) };
}

// Sube un binario. Hasta MULTIPART_MAX va en una petición (el cuerpo se ensambla
// como Blob, NUNCA como string: concatenar bytes en un template literal los
// destroza). Por encima, sesión resumable en trozos de CHUNK_SIZE, cada uno con
// su propio timeout — así el techo de red se aplica por trozo y no mata una
// transferencia larga pero sana.
export async function writeBinary(path, data, { mime = 'application/octet-stream', onProgress = null } = {}) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const existing = await findByName(path);
  return blob.size <= MULTIPART_MAX
    ? uploadMultipart(path, blob, mime, existing, onProgress)
    : uploadResumable(path, blob, mime, existing, onProgress);
}

async function uploadMultipart(path, blob, mime, existing, onProgress) {
  const metadata = existing ? { name: path } : { name: path, parents: ['appDataFolder'] };
  const boundary = '---bookreader_boundary';
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
    blob,
    `\r\n--${boundary}--`,
  ]);
  const url = existing
    ? `${UPLOAD}/files/${existing.id}?uploadType=multipart&fields=${FILE_FIELDS}`
    : `${UPLOAD}/files?uploadType=multipart&fields=${FILE_FIELDS}`;
  const res = await driveFetch(url, {
    method: existing ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  }, true, TRANSFER_TIMEOUT_MS);
  const data = await res.json();
  if (onProgress) onProgress(blob.size, blob.size);
  return { etag: String(data.version), size: blob.size };
}

async function uploadResumable(path, blob, mime, existing, onProgress) {
  const metadata = existing ? { name: path } : { name: path, parents: ['appDataFolder'] };
  const initUrl = existing
    ? `${UPLOAD}/files/${existing.id}?uploadType=resumable&fields=${FILE_FIELDS}`
    : `${UPLOAD}/files?uploadType=resumable&fields=${FILE_FIELDS}`;
  const init = await driveFetch(initUrl, {
    method: existing ? 'PATCH' : 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mime,
      'X-Upload-Content-Length': String(blob.size),
    },
    body: JSON.stringify(metadata),
  });
  const session = init.headers.get('Location');
  if (!session) {
    // El navegador no ve la cabecera Location (CORS sin Access-Control-Expose-
    // Headers). Sin sesión no hay subida resumable posible: mejor decirlo que
    // fallar con un error opaco a mitad del primer trozo.
    const err = new Error('Drive no devolvió la sesión de subida (Location).');
    err.code = 'no-session';
    throw err;
  }

  const token = await getAccessToken();
  let offset = 0;
  while (offset < blob.size) {
    const end = Math.min(offset + CHUNK_SIZE, blob.size);
    const chunk = blob.slice(offset, end);
    const res = await fetchWithTimeout(session, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Range': `bytes ${offset}-${end - 1}/${blob.size}`,
      },
      body: chunk,
    }, TRANSFER_TIMEOUT_MS);

    if (res.status === 308) {
      // Drive confirma hasta dónde tiene. Continuar DESDE AHÍ y no desde donde
      // creíamos: si aceptó un trozo parcial, reenviar desde nuestro offset
      // duplicaría bytes y corrompería el fichero.
      const range = res.headers.get('Range');
      const m = range && range.match(/bytes=0-(\d+)/);
      offset = m ? Number(m[1]) + 1 : end;
    } else if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (onProgress) onProgress(blob.size, blob.size);
      return { etag: String(data.version || ''), size: blob.size };
    } else {
      throw await driveError(res);
    }
    if (onProgress) onProgress(offset, blob.size);
  }
  return { etag: '', size: blob.size };
}

// ---- Cuota ------------------------------------------------------------------
//
// appDataFolder NO es visible en drive.google.com pero SÍ consume los 15 GB del
// usuario. Sin enseñar esto, quedarse sin espacio es un misterio total: por eso
// Ajustes muestra el total de la cuenta y lo que ocupa BookReader dentro.
export async function storageInfo() {
  const res = await driveFetch(`${API}/about?fields=storageQuota`);
  const q = (await res.json()).storageQuota || {};
  return {
    limit: Number(q.limit || 0),          // 0 = cuenta sin límite (Workspace)
    usage: Number(q.usage || 0),
  };
}

// Lo que ocupa BookReader en el appDataFolder, sumando sus propios ficheros.
export async function appUsage(prefix = '') {
  const files = await list(prefix);
  return files.reduce((n, f) => n + (f.size || 0), 0);
}

// Recovery: Drive conserva revisiones de cada fichero (~30 días). La UI de
// restauración por versión llega en Fase 3; la API queda disponible ya.
export async function listRevisions(path) {
  const file = await findByName(path);
  if (!file) return null;
  const res = await driveFetch(`${API}/files/${file.id}/revisions?fields=revisions(id,modifiedTime,size)`);
  const data = await res.json();
  return { fileId: file.id, revisions: data.revisions || [] };
}

export async function readRevision(fileId, revisionId) {
  const res = await driveFetch(`${API}/files/${fileId}/revisions/${revisionId}?alt=media`);
  return res.text();
}
