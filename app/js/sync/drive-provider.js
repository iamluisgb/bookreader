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
import { fetchWithTimeout } from './net.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

// Techo por petición (ver net.js): sin él, un fetch estancado colgaba el ciclo de sync para
// siempre — badge "Sincronizando…" eterno y Web Lock retenido.
async function driveFetch(url, options = {}, retry = true) {
  const token = await getAccessToken();
  const res = await fetchWithTimeout(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: 'Bearer ' + token },
  });
  if (res.status === 401 && retry) {
    await getAccessToken(true); // caducó en vuelo → renovar y un solo reintento
    return driveFetch(url, options, false);
  }
  if (!res.ok) {
    const err = new Error('Drive ' + res.status);
    err.code = res.status;
    throw err;
  }
  return res;
}

const FILE_FIELDS = 'id,name,version,modifiedTime';

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
    .map(f => ({ path: f.name, etag: String(f.version), modifiedTime: f.modifiedTime }));
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
