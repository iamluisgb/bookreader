// MON4 F3 · BookReaderProvider — el sync gestionado de la suscripción (ADR-056 §5).
//
// Misma interfaz que drive-provider.js (ver provider.js), sobre workers/sync. Todo se cifra
// AQUÍ antes de salir (sync-crypto.js): el servidor recibe una ruta opaca (HMAC de la ruta
// real), el nombre cifrado y bytes que no puede leer.
//
// Lo que cambia frente a Drive:
//   - El If-Match es de verdad: lo resuelve el Worker de forma atómica, y un 412 vuelve al
//     motor igual que con Drive.
//   - `list` sale del índice del Worker en D1 (una petición, sin el N+1 de Drive) y los nombres
//     se descifran aquí. Lo que no se puede descifrar (otra clave) no se lista.
//   - Historial: el Worker guarda las últimas versiones de settings.json y de cada libro (se
//     piden con X-Keep-Versions). `fileId` es la propia ruta.

import { t } from '../i18n.js';
import * as A from './bookreader-auth.js';
import * as C from './sync-crypto.js';
import { fetchBinary, TRANSFER_TIMEOUT_MS } from './net.js';

const KEYCHECK = 'bookreader/keycheck';
// Lo que guarda versiones: lo mismo que Drive da por revisiones y recovery.js sabe restaurar.
const VERSIONED = /(^|\/)(settings\.json|books\/[^/]+\.json)$/;
// Por debajo de `singleMax` un fichero va en un solo PUT; el Worker corta en 100 MB (el tope de
// cuerpo de Workers) y el cifrado añade 28 bytes por trozo de 4 MB. Por encima, por partes de
// `partSegs` trozos cifrados enteros: todas miden lo mismo salvo la última (R2 lo exige).
// Mutables solo para los tests, que no van a cifrar 100 MB para probar las partes.
export const limits = { singleMax: 96 * 1024 * 1024, partSegs: 8 };

async function ids(path) {
  const k = await A.keys();
  return { k, pid: await C.pathId(k, path) };
}

async function fail(res) {
  if (res.status === 412) {
    const err = new Error('Precondition failed: el fichero cambió en remoto');
    err.code = 412;
    return err;
  }
  return A.apiError(res);
}

export function isQuotaError(err) {
  return !!err && err.reason === 'quota';
}

export async function list(prefix = '') {
  const res = await A.api('/v1/list');
  if (!res.ok) throw await fail(res);
  const { items = [] } = await res.json();
  const k = await A.keys();
  const out = [];
  let readable = 0;
  for (const it of items) {
    let path;
    try { path = await C.decryptName(k, it.name); } catch { continue; }
    readable++;
    if (path === KEYCHECK || !path.startsWith(prefix)) continue;
    out.push({ path, etag: String(it.etag), modifiedTime: new Date(it.updatedAt).toISOString(), size: Number(it.size || 0) });
  }
  // Hay datos y esta clave no abre ninguno: en otro dispositivo se empezó de cero con una clave
  // nueva. Seguir escribiendo con la vieja crearía un sync paralelo que nadie más lee.
  if (items.length && !readable) {
    const err = new Error(t('La clave de este dispositivo ya no es la de tu sync (¿se empezó de cero en otro?). Desconecta este dispositivo y vuelve a emparejarlo.'));
    err.code = 'wrong_key';
    throw err;
  }
  return out;
}

export async function exists(path) {
  const { pid } = await ids(path);
  const res = await A.api('/v1/meta/' + pid);
  if (res.status === 404) return null;
  if (!res.ok) throw await fail(res);
  const m = await res.json();
  return { path, etag: String(m.etag), size: Number(m.size || 0) };
}

export async function read(path) {
  const { k, pid } = await ids(path);
  const res = await A.api('/v1/o/' + pid);
  if (res.status === 404) return null;
  if (!res.ok) throw await fail(res);
  const etag = res.headers.get('ETag') || '';
  return { content: await C.decryptText(k, pid, await res.blob()), etag };
}

async function put(path, plain, { ifMatch, kind = 'data', mustCreate = false } = {}) {
  const { k, pid } = await ids(path);
  const body = await C.encrypt(k, pid, plain);
  const headers = { 'X-Name': await C.encryptName(k, path), 'X-Kind': kind };
  if (kind === 'data' && VERSIONED.test(path)) headers['X-Keep-Versions'] = '1';
  if (ifMatch !== undefined && ifMatch !== null && ifMatch !== '') headers['If-Match'] = String(ifMatch);
  else if (mustCreate) headers['If-None-Match'] = '*';
  const res = await A.api('/v1/o/' + pid, { method: 'PUT', headers, body }, { timeoutMs: TRANSFER_TIMEOUT_MS });
  if (!res.ok) throw await fail(res);
  const data = await res.json();
  return { etag: String(data.etag), size: body.size };
}

// Sin etag conocido, «crear solo si no existe»: el motor hace el pull antes del push en el mismo
// ciclo, así que no conocer el etag significa que la ruta no existía al listar. Si otro
// dispositivo la acaba de crear, 412 y el motor reintenta fusionando (Drive no puede hacerlo:
// allí la segunda escritura pisa a la primera hasta el siguiente ciclo).
export async function write(path, content, { ifMatch } = {}) {
  const { etag } = await put(path, content, { ifMatch, mustCreate: true });
  return { etag };
}

// Un fichero de bloques sellados por separado (el almacén de pasajes del índice, IA10 ·
// sync-crypto.js · sealBlocks): el MCP lee solo los bloques que necesita. Pisa lo que haya: se
// regenera entero desde el texto del libro. Devuelve { etag, offsets }.
export async function writeBlocks(path, blocks) {
  const { k, pid } = await ids(path);
  const { body, offsets } = await C.sealBlocks(k, pid, blocks);
  const headers = { 'X-Name': await C.encryptName(k, path), 'X-Kind': 'data' };
  const cur = await exists(path);
  if (cur) headers['If-Match'] = cur.etag;
  const res = await A.api('/v1/o/' + pid, { method: 'PUT', headers, body: new Blob([body]) }, { timeoutMs: TRANSFER_TIMEOUT_MS });
  if (!res.ok) throw await fail(res);
  return { etag: String((await res.json()).etag), offsets };
}

export async function remove(path) {
  const { pid } = await ids(path);
  const res = await A.api('/v1/o/' + pid, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw await fail(res);
}

// ---- Ficheros de libro --------------------------------------------------------------------

const MIME = { pdf: 'application/pdf', epub: 'application/epub+zip' };

export async function readBinary(path, onProgress = null) {
  const { k, pid } = await ids(path);
  const get = async () => fetchBinary(A.WORKER_URL + '/v1/o/' + pid, { headers: { Authorization: 'Bearer ' + (await A.getToken()) } }, onProgress);
  let r = await get();
  if (r.status === 401) { await A.getToken(true); r = await get(); }
  if (r.status === 404) return null;
  if (!r.ok) {
    const err = new Error('Sync de BookReader ' + r.status);
    err.code = r.status;
    throw err;
  }
  const ext = (path.match(/\.(\w+)$/) || [])[1];
  const blob = await C.decrypt(k, pid, r.blob, { type: MIME[ext] || 'application/octet-stream' });
  return { blob, etag: '', size: blob.size };
}

export async function writeBinary(path, data, { mime = 'application/octet-stream', onProgress = null } = {}) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  if (C.encryptedSize(blob.size) > limits.singleMax) return writeMultipart(path, blob, onProgress);
  const r = await put(path, blob, { kind: 'file' });
  if (onProgress) onProgress(blob.size, blob.size);
  return { etag: r.etag, size: blob.size };
}

// Libros de más de ~96 MB: subida por partes (F4).
async function writeMultipart(path, blob, onProgress) {
  const { k, pid } = await ids(path);
  const total = C.encryptedSize(blob.size);
  const start = await A.api('/v1/mp/' + pid, { method: 'POST', headers: { 'X-Total-Size': String(total) } });
  if (!start.ok) throw await fail(start);
  const { uploadId } = await start.json();
  const segs = C.segmentCount(blob.size);
  const parts = [];
  try {
    for (let s = 0, n = 1; s < segs; s += limits.partSegs, n++) {
      const body = await C.encryptRange(k, pid, blob, s, s + limits.partSegs);
      const res = await A.api(`/v1/mp/${pid}/${uploadId}/${n}`, { method: 'PUT', body }, { timeoutMs: TRANSFER_TIMEOUT_MS });
      if (!res.ok) throw await fail(res);
      parts.push({ partNumber: n, etag: (await res.json()).etag });
      if (onProgress) onProgress(Math.min(blob.size, (s + limits.partSegs) * 4 * 1024 * 1024), blob.size);
    }
    const done = await A.api(`/v1/mp/${pid}/${uploadId}/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts, name: await C.encryptName(k, path) }),
    });
    if (!done.ok) throw await fail(done);
    return { etag: String((await done.json()).etag), size: blob.size };
  } catch (e) {
    // Lo subido a medias se libera ya, sin esperar a la purga diaria.
    A.api(`/v1/mp/${pid}/${uploadId}`, { method: 'DELETE' }).catch(() => {});
    throw e;
  }
}

// ---- Historial ----------------------------------------------------------------------------

export async function listRevisions(path) {
  const { pid } = await ids(path);
  const res = await A.api('/v1/versions/' + pid);
  if (res.status === 404) return null;
  if (!res.ok) throw await fail(res);
  const { versions = [] } = await res.json();
  return {
    fileId: path,
    revisions: versions.map(v => ({ id: v.id, modifiedTime: new Date(v.at).toISOString(), size: v.size })),
  };
}

export async function readRevision(fileId, revisionId) {
  const { k, pid } = await ids(fileId);
  const res = await A.api(`/v1/versions/${pid}/${revisionId}`);
  if (!res.ok) throw await fail(res);
  return C.decryptText(k, pid, await res.blob());
}

// ---- Espacio ------------------------------------------------------------------------------

export async function appUsage() {
  const st = await A.status();
  return st.used.data + st.used.versions + st.used.files;
}

export async function storageInfo() {
  const st = await A.status();
  return { limit: st.quota.data + st.quota.files, usage: st.used.data + st.used.versions + st.used.files, status: st };
}
