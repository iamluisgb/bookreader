// Subir un libro por MCP (mcp/src/upload-tools.mjs): la URL de un solo uso y el PUT que la usa.
//
//   create_book_upload ──▶ fila en mcp_uploads + URL /v1/upload/<id>/<secreto>
//   PUT de los bytes    ──▶ tamaño, formato y SHA-256 comprobados; cifrado trozo a trozo con la
//                           clave del sync; files/<sha>.<ext> en R2; alta en library.json
//
// LA CLAVE. Como con los tokens del MCP (mcp.js · wrap): la URL lleva un secreto, la fila guarda
// su hash y, cifrados con él, la clave del sync y lo declarado. El PUT no lleva token: quien
// tiene la URL puede subir ESE fichero (ese tamaño, ese hash) una vez, en 15 minutos, y nada más.
//
// MEMORIA Y CPU. Lo que entra se corta en trozos de 4 MB (los de sync-crypto) y se cifra según
// llega; en memoria solo queda el cifrado, para subirlo a R2 de una vez. De ahí el máximo
// (MCP_UPLOAD_MAX_BYTES, 50 MB por defecto): los Workers tienen 128 MB. El hash y el cifrado
// gastan CPU, unos 2-3 ms por MB: por encima de los 10 ms del plan gratis (como el resto del MCP).

import * as C from '../../../app/js/sync/sync-crypto.js';
import { ToolError } from '../../../mcp/src/errors.mjs';
import { addBook, bookFile } from '../../../mcp/src/upload-tools.mjs';
import { config, randomId, sha256Hex, writeBytes } from './index.js';
import { r2Provider, wrap, unwrap } from './mcp.js';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const UPLOAD_MINUTES = 15;
const SECRET_PREFIX = 'br-up-';   // solo para derivar la clave de `wrap` (mcp.js · secretOf)
export const UPLOAD_RE = /^\/v1\/upload\/([A-Za-z0-9_-]{22})\/([A-Za-z0-9_-]{43})$/;
// Marcas de DRM en el directorio del zip (va al final del EPUB): Adobe, Apple y Readium LCP.
// `encryption.xml` solo no lo es: lo usan también las fuentes ofuscadas de EPUB normales.
const DRM_MARKS = ['META-INF/rights.xml', 'META-INF/sinf.xml', 'META-INF/license.lcpl'];

const BASE = 'bookreader/';   // como app/js/sync/layout.js (que no se puede importar aquí: tira de IndexedDB)
const LIB = BASE + 'library.json';
const mb = (n) => Math.round(n / 1048576) + ' MB';
export const uploadMaxBytes = (env) => {
  const v = env.MCP_UPLOAD_MAX_BYTES;
  return v === undefined || v === '' ? 50 * 1024 * 1024 : Number(v);
};

class UploadError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const json = (obj, status) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

// Lo que ve el agente de una subida (get_book_upload).
const STATE_TEXT = {
  pending: 'Falta subir el fichero con el PUT a la URL.',
  uploading: 'Se está recibiendo el fichero.',
  done: 'El libro está en la biblioteca.',
  expired: 'La URL caducó sin recibir el fichero: pide otra con create_book_upload.',
};

// ---- Las tools (con la sesión del MCP) -------------------------------------------------------

// `source.uploads` para el MCP: crear una subida y consultarla.
export function uploadsFor(env, who, source, origin, now = () => Date.now()) {
  return {
    maxBytes: uploadMaxBytes(env),

    async create(meta) {
      const c = config(env);
      if (!c.filesEnabled) throw new ToolError('Este sync no guarda ficheros de libro: no se pueden subir.');
      const path = BASE + bookFile(meta.sha256, meta.format);

      // ¿Ya está? En la biblioteca con su fichero, nada que hacer. Con el fichero en el sync pero
      // fuera de la biblioteca (se borró), basta con volver a darlo de alta: sin subir nada.
      const lib = await source.library();
      const cur = lib && lib.books && lib.books[meta.sha256];
      if (cur && !cur.deleted && cur.blob && cur.blob.path) {
        return { status: 'exists', bookId: meta.sha256, title: cur.title || '', author: cur.author || '', message: 'Ese libro ya está en la biblioteca.' };
      }
      const k = await C.importKeys(who.raw);
      const pid = await C.pathId(k, path);
      const stored = await env.DB.prepare('SELECT 1 AS x FROM objects WHERE user = ? AND path = ?').bind(who.user, pid).first();
      if (stored) {
        const out = await source.writeLibrary((value) => libraryChange(value, meta, path, now()));
        return { ...out, message: 'El fichero ya estaba en el sync: el libro vuelve a la biblioteca sin subir nada.' };
      }

      // La cuota antes que los bytes: lo que no cabe se dice ahora, no después de mandar 40 MB.
      const need = C.encryptedSize(meta.size);
      const mine = await env.DB.prepare(`SELECT COALESCE(SUM(size), 0) AS n FROM blobs WHERE user = ? AND kind = 'file'`).bind(who.user).first();
      if (mine.n + need > c.fileQuota) {
        throw new ToolError(`No cabe: el espacio para libros del sync está en ${mb(mine.n)} de ${mb(c.fileQuota)} y este ocupa ${mb(need)}.`);
      }
      if (env.WRITES) {
        const { success } = await env.WRITES.limit({ key: who.user });
        if (!success) throw new ToolError('Demasiadas escrituras seguidas: espera un minuto y repite.');
      }

      const id = randomId();
      const secret = C.b64url(crypto.getRandomValues(new Uint8Array(32)));
      const at = now();
      const expiresAt = at + UPLOAD_MINUTES * MINUTE;
      await env.DB.prepare(
        `INSERT INTO mcp_uploads (id, user, token_id, agent, secret_hash, wrapped, size, state, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'created', ?, ?)`,
      ).bind(
        id, who.user, who.tokenId || null, who.name || 'MCP', await sha256Hex(secret),
        await wrap(SECRET_PREFIX + secret, { k: C.b64url(who.raw), meta }), meta.size, at, expiresAt,
      ).run();
      const url = `${origin}/v1/upload/${id}/${secret}`;
      return {
        status: 'pending', uploadId: id, bookId: meta.sha256,
        upload: { method: 'PUT', url, size: meta.size, expiresAt: new Date(expiresAt).toISOString() },
        curl: `curl -sS -T '${meta.fileName.replace(/'/g, `'\\''`)}' '${url}'`,
        next: 'Sube el fichero tal cual (sin multipart) con ese PUT. Su respuesta dice si el libro quedó en la biblioteca.',
      };
    },

    async status(id) {
      const row = await env.DB.prepare('SELECT state, error, change_id, expires_at FROM mcp_uploads WHERE id = ? AND user = ?').bind(id, who.user).first();
      if (!row) throw new ToolError(`No hay ninguna subida «${id}».`);
      const state = row.state === 'created' ? (row.expires_at <= now() ? 'expired' : 'pending') : row.state;
      const out = { uploadId: id, state };
      if (state === 'failed') Object.assign(out, { error: row.error, message: FAIL_TEXT[row.error] || 'La subida falló: repítela.' });
      else out.message = STATE_TEXT[state];
      if (row.change_id) out.changeId = row.change_id;
      return out;
    },
  };
}

// El cambio de library.json, para `update` del proveedor (con su deshacer si hay algo que deshacer).
function libraryChange(value, meta, path, now) {
  const undo = { books: {}, shelves: {} };
  const r = addBook(value, meta, path, now, undo);
  if (!r.changed) return { next: null, result: r.result };
  return { next: value, result: r.result, summary: r.summary, ...(r.undoable ? { undo } : {}) };
}

// ---- El PUT (sin token: la URL es la credencial) ---------------------------------------------

const FAIL_TEXT = {
  size_mismatch: 'El fichero no tiene el tamaño declarado.',
  hash_mismatch: 'El SHA-256 del fichero no es el declarado.',
  not_epub: 'No es un EPUB (no empieza como un zip).',
  not_pdf: 'No es un PDF.',
  drm: 'El EPUB tiene DRM: BookReader no puede abrirlo.',
  quota: 'No cabe en el espacio para libros del sync.',
  capacity: 'El servicio está lleno este mes: prueba más tarde.',
  no_library: 'La biblioteca no tiene catálogo (library.json): ábrela una vez con la app actual.',
  unavailable: 'Fallo del servicio: repite la subida.',
};

export async function uploadRoute(id, secret, request, env, now = Date.now()) {
  if (request.method !== 'PUT') return new Response(null, { status: 405, headers: { Allow: 'PUT' } });
  const row = await env.DB.prepare('SELECT * FROM mcp_uploads WHERE id = ?').bind(id).first();
  if (!row || row.secret_hash !== await sha256Hex(secret)) return json({ error: 'not_found' }, 404);
  if (row.state !== 'created') return json({ error: 'used', message: 'Esta URL ya se usó: pide otra con create_book_upload.' }, 409);
  if (row.expires_at <= now) return json({ error: 'expired', message: STATE_TEXT.expired }, 410);
  const len = Number(request.headers.get('Content-Length') || 0);
  if (!len) return json({ error: 'length_required', message: 'Falta Content-Length: sube el fichero entero (curl -T).' }, 411);
  if (len !== row.size) return json({ error: 'size_mismatch', message: FAIL_TEXT.size_mismatch }, 400);
  // Un solo uso de verdad: dos PUT a la vez, solo uno pasa.
  const mine = await env.DB.prepare(`UPDATE mcp_uploads SET state = 'uploading' WHERE id = ? AND state = 'created' RETURNING id`).bind(id).first();
  if (!mine) return json({ error: 'used', message: 'Esta URL ya se usó: pide otra con create_book_upload.' }, 409);

  try {
    const out = await ingest(env, row, secret, request.body);
    await env.DB.prepare(`UPDATE mcp_uploads SET state = 'done', change_id = ? WHERE id = ?`).bind(out.changeId || null, id).run();
    return json({ ok: true, ...out }, 200);
  } catch (e) {
    const code = e instanceof UploadError ? e.code : e instanceof ToolError ? 'no_library' : 'unavailable';
    await env.DB.prepare(`UPDATE mcp_uploads SET state = 'failed', error = ? WHERE id = ?`).bind(code, id).run();
    if (code === 'unavailable') console.error('upload:', e?.message || e);
    return json({ error: code, message: FAIL_TEXT[code] }, e.status || (code === 'no_library' ? 409 : 503));
  }
}

async function ingest(env, row, secret, body) {
  const { k: rawB64, meta } = await unwrap(SECRET_PREFIX + secret, row.wrapped);
  const raw = C.fromB64url(rawB64);
  const k = await C.importKeys(raw);
  const path = BASE + bookFile(meta.sha256, meta.format);
  const pid = await C.pathId(k, path);

  const parts = await encryptStream(k, pid, body, meta);

  const stored = await env.DB.prepare('SELECT 1 AS x FROM objects WHERE user = ? AND path = ?').bind(row.user, pid).first();
  if (!stored) {
    const enc = new Blob(parts);
    const w = await writeBytes(env, {
      user: row.user, path: pid, name: await C.encryptName(k, path), body: enc, size: enc.size, kind: 'file', mustCreate: true,
    });
    // precondition_failed: otro lo subió entre medias. Es el mismo fichero (mismo hash): vale.
    if (w.error === 'quota') throw new UploadError('quota', 507, FAIL_TEXT.quota);
    if (w.error === 'capacity') throw new UploadError('capacity', 507, FAIL_TEXT.capacity);
  }

  const provider = r2Provider(env, row.user, raw, { canWrite: true, agent: { tokenId: row.token_id, name: row.agent } });
  return provider.update(LIB, (value) => libraryChange(value, meta, path, Date.now()));
}

// Lee el cuerpo en trozos de C.SEG, comprueba formato, DRM y hash, y cifra cada trozo según
// llega. Devuelve los trozos cifrados (en orden). Lanza UploadError si algo no cuadra.
async function encryptStream(k, pid, body, meta) {
  const count = C.segmentCount(meta.size);
  const hash = hasher();
  const parts = [];
  let seg = new Uint8Array(Math.min(C.SEG, meta.size));
  let fill = 0;
  let total = 0;
  const seal = async () => {
    const i = parts.length;
    if (i === 0) checkFormat(seg, meta.format);
    if (i === count - 1 && meta.format === 'epub') checkDrm(seg);
    await hash.update(seg);
    parts.push(await C.sealSegment(k, pid, i, count, seg));
    const left = meta.size - total;
    seg = new Uint8Array(Math.min(C.SEG, left));
    fill = 0;
  };
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let off = 0;
    while (off < value.length) {
      if (total >= meta.size) {
        reader.cancel().catch(() => {});
        throw new UploadError('size_mismatch', 400, FAIL_TEXT.size_mismatch);
      }
      const n = Math.min(value.length - off, seg.length - fill, meta.size - total);
      seg.set(value.subarray(off, off + n), fill);
      fill += n;
      off += n;
      total += n;
      if (fill === seg.length) await seal();
    }
  }
  if (total !== meta.size) throw new UploadError('size_mismatch', 400, FAIL_TEXT.size_mismatch);
  if ((await hash.hex()) !== meta.sha256) throw new UploadError('hash_mismatch', 422, FAIL_TEXT.hash_mismatch);
  return parts;
}

function checkFormat(first, format) {
  if (format === 'epub') {
    if (!(first[0] === 0x50 && first[1] === 0x4b && first[2] === 0x03 && first[3] === 0x04)) throw new UploadError('not_epub', 422, FAIL_TEXT.not_epub);
    return;
  }
  // %PDF- puede llevar basura delante (la tolera cualquier lector): en el primer KB.
  if (!hasAscii(first.subarray(0, 1024), '%PDF-')) throw new UploadError('not_pdf', 422, FAIL_TEXT.not_pdf);
}

function checkDrm(last) {
  if (DRM_MARKS.some((m) => hasAscii(last, m))) throw new UploadError('drm', 422, FAIL_TEXT.drm);
}

// ¿Están los bytes de `text` (ASCII) en `bytes`? Sin TextDecoder: workerd no trae latin1.
function hasAscii(bytes, text) {
  const pat = Uint8Array.from(text, (ch) => ch.charCodeAt(0));
  for (let i = bytes.indexOf(pat[0]); i !== -1 && i <= bytes.length - pat.length; i = bytes.indexOf(pat[0], i + 1)) {
    let j = 1;
    while (j < pat.length && bytes[i + j] === pat[j]) j++;
    if (j === pat.length) return true;
  }
  return false;
}

// SHA-256 incremental. En workerd, DigestStream; fuera (los tests en Node), se juntan los trozos
// y se calcula al final.
function hasher() {
  const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (typeof crypto.DigestStream === 'function') {
    const ds = new crypto.DigestStream('SHA-256');
    const w = ds.getWriter();
    return {
      update: (bytes) => w.write(bytes),
      async hex() { await w.close(); return toHex(await ds.digest); },
    };
  }
  const chunks = [];
  return {
    update(bytes) { chunks.push(bytes); },
    async hex() { return toHex(await crypto.subtle.digest('SHA-256', await new Blob(chunks).arrayBuffer())); },
  };
}

// Purga: las subidas de hace más de un día (usadas, fallidas o caducadas) ya no sirven de nada.
export async function purgeUploads(env, now = Date.now()) {
  const r = await env.DB.prepare('DELETE FROM mcp_uploads WHERE expires_at < ? RETURNING id').bind(now - DAY).all();
  return (r.results || []).length;
}
