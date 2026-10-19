// MON4 · bookreader-sync — el sync gestionado de la suscripción (ADR-056).
//
//   app ──cifra (F2)──▶ PUT /v1/o/<ruta> ──▶ R2 (bytes ilegibles) + índice en D1
//   app ◀── GET /v1/o/<ruta> ◀── R2                …y descifra con su clave
//
// Es el patrón de `share` (ADR-053) en un Worker propio, para que un sync lleno no tumbe los
// enlaces ni al revés, y cada gasto se vea por su lado (`npm run sync:usage`).
//
// IDENTIDAD: la licencia, sin cuentas. POST /v1/sync-token valida la key contra Polar AQUÍ
// (server-side) y devuelve un token `br-sync-…`. El espacio del usuario es el hash de su key.
// Cuando la suscripción caduca, los tokens nuevos salen de SOLO LECTURA durante GRACE_DAYS
// (para leer y exportar) y después la purga lo borra todo.
//
// ESCRITURAS: R2 nunca se sobrescribe. Cada PUT va a una clave nueva (`u/<user>/<ruta>/<id>`)
// y después se mueve el puntero en D1 con un UPDATE condicionado al etag que se leyó. Así:
//   - el If-Match es atómico (lo resuelve D1, no una relectura de cliente como en Drive), y
//     quien pierde recibe un 412 y su clave nueva se borra (borrar en R2 es gratis);
//   - quien lee nunca ve un objeto a medio escribir: el puntero solo cambia con la clave entera;
//   - las versiones salen gratis: la clave anterior se queda como 'version' en vez de borrarse
//     (solo si el cliente lo pide, X-Keep-Versions: 1) y se guardan las MAX_VERSIONS últimas.
//
// COSTE: lo de `share`, con una diferencia que decide ADR-056 (opción A/B). Los topes GLOBALES
// (CAP_*) vienen al 80 % de lo gratis de R2, igual que `share`: con ellos esto no cobra nunca
// (opción B). Subirlos en wrangler.jsonc es la opción A: pagar R2 pasado lo gratis con el dinero
// de los suscriptores, y dejar que manden las cuotas POR USUARIO. Sin tocar nada, no se paga.
//
// - Nunca se lista R2: el listado y las cuotas salen de D1.
// - Cuotas por usuario: DATA_QUOTA_BYTES para datos (y sus versiones), FILE_QUOTA_BYTES para
//   ficheros de libro. Al tope de ficheros, los datos siguen; los libros dejan de subir (507).
// - Privacidad: no se registran rutas, nombres, contenidos ni IP. El servidor guarda bytes
//   cifrados con una clave que nunca le llega.

const DAY = 24 * 60 * 60 * 1000;
const PATH_RE = /^[A-Za-z0-9_-]{16,64}$/;
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const NAME_MAX = 2048;
const TOKEN_PREFIX = 'br-sync-';
const FREE = { storage: 10 * 1024 ** 3, classA: 1000000, classB: 10000000 };

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const randomId = () => b64url(crypto.getRandomValues(new Uint8Array(16)));
export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export const monthOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);
const blobKey = (user, path, id) => `u/${user}/${path}/${id}`;
const idOfKey = (key) => key.slice(key.lastIndexOf('/') + 1);

export function config(env) {
  const n = (v, d) => (v === undefined || v === '' ? d : Number(v));
  return {
    storage: n(env.CAP_STORAGE_BYTES, 8 * 1024 ** 3),
    classA: n(env.CAP_CLASS_A, 800000),
    classB: n(env.CAP_CLASS_B, 8000000),
    maxBytes: n(env.MAX_BYTES, 100 * 1024 * 1024),
    dataQuota: n(env.DATA_QUOTA_BYTES, 256 * 1024 * 1024),
    fileQuota: n(env.FILE_QUOTA_BYTES, 2 * 1024 ** 3),
    filesEnabled: String(env.FILES_ENABLED || '0') === '1',
    maxVersions: n(env.MAX_VERSIONS, 10),
    versionDays: n(env.VERSION_DAYS, 30),
    graceDays: n(env.GRACE_DAYS, 30),
    tokenHours: n(env.TOKEN_HOURS, 24),
  };
}

export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match, If-None-Match, X-Name, X-Kind, X-Keep-Versions, X-Total-Size',
    'Access-Control-Expose-Headers': 'ETag, X-Name, X-Size',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

const json = (obj, status, cors = {}) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors },
});

// ---- Gasto global (lo mismo que `share`) -------------------------------------------------

// Cuenta UNA operación de la clase dada si no se ha llegado al tope del mes. Atómico.
export async function spend(env, cls, now = Date.now()) {
  const col = cls === 'a' ? 'class_a' : 'class_b';
  const cap = cls === 'a' ? config(env).classA : config(env).classB;
  const row = await env.DB.prepare(
    `INSERT INTO usage (month, ${col}) VALUES (?, 1)
     ON CONFLICT(month) DO UPDATE SET ${col} = ${col} + 1 WHERE ${col} < ?
     RETURNING ${col} AS n`,
  ).bind(monthOf(now), cap).first();
  return !!row;
}

async function refused(env, now = Date.now()) {
  try {
    await env.DB.prepare(
      `INSERT INTO usage (month, refused) VALUES (?, 1) ON CONFLICT(month) DO UPDATE SET refused = refused + 1`,
    ).bind(monthOf(now)).run();
  } catch { /* contar un rechazo nunca debe romper la respuesta */ }
}

// ---- Licencias -----------------------------------------------------------------------------

// El id del usuario: hash de la key (con sal opcional, USER_SALT; se fija UNA vez: cambiarla
// deja huérfanos los datos de todos).
export async function userIdOf(env, licenseKey) {
  return sha256Hex('bookreader-sync:' + (env.USER_SALT || '') + licenseKey);
}

// Valida la licencia contra Polar. Devuelve 'granted' | 'lapsed' | 'not_subscribed' | 'invalid'.
//   - 'lapsed': la key existe pero ya no da derecho (suscripción cancelada o caducada).
//   - 'not_subscribed': key válida de un producto sin sync (el pago único de Pro, p. ej.).
// Modo simulado SOLO con ALLOW_MOCK_LICENSES=1 (dev y tests): las keys BKRD-… valen como en
// license.js, -REVOKED caduca y -NOSUB es un Pro sin suscripción.
// TEST_LICENSES (secret, keys exactas separadas por comas): cuentas de prueba en producción
// antes de Polar. Solo esas; cualquier otra key sigue el camino normal.
export async function checkLicense(env, key, fetchImpl = fetch) {
  const testKeys = String(env.TEST_LICENSES || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (testKeys.includes(key)) return 'granted';
  if (String(env.ALLOW_MOCK_LICENSES || '') === '1' && /^BKRD-[A-Z0-9-]{4,}$/i.test(key)) {
    if (/-REVOKED$/i.test(key)) return 'lapsed';
    if (/-NOSUB$/i.test(key)) return 'not_subscribed';
    return 'granted';
  }
  if (!env.POLAR_ORG_ID) {
    const e = new Error('not_configured');
    e.status = 503;
    throw e;
  }
  const base = String(env.POLAR_SANDBOX || '') === '1' ? 'https://sandbox-api.polar.sh' : 'https://api.polar.sh';
  const res = await fetchImpl(`${base}/v1/customer-portal/license-keys/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, organization_id: env.POLAR_ORG_ID }),
  });
  if (res.status === 404 || res.status === 422) return 'invalid';
  if (!res.ok) {
    const e = new Error('polar_' + res.status);
    e.status = 502;
    throw e;
  }
  const lk = await res.json();
  const benefits = String(env.SYNC_BENEFIT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (benefits.length && !benefits.includes(lk.benefit_id)) return 'not_subscribed';
  if (lk.status !== 'granted') return 'lapsed';
  if (lk.expires_at && Date.parse(lk.expires_at) < Date.now()) return 'lapsed';
  return 'granted';
}

async function issueToken(request, env, cors, now = Date.now()) {
  if (!cors['Access-Control-Allow-Origin']) return json({ error: 'origin' }, 403, cors);
  if (env.TOKENS) {
    const ip = request.headers.get('CF-Connecting-IP') || 'anon';
    const { success } = await env.TOKENS.limit({ key: ip });
    if (!success) return json({ error: 'rate_limited' }, 429, cors);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400, cors); }
  const key = typeof body?.license === 'string' ? body.license.trim() : '';
  if (!key || key.length > 200) return json({ error: 'bad_request' }, 400, cors);

  let verdict;
  try { verdict = await checkLicense(env, key); }
  catch (e) { return json({ error: e.message }, e.status || 502, cors); }

  const c = config(env);
  const user = await userIdOf(env, key);
  const existing = await env.DB.prepare('SELECT lapsed_at FROM users WHERE id = ?').bind(user).first();
  let readOnly = false;
  let lapsedAt = null;
  if (verdict === 'granted') {
    await env.DB.prepare(
      `INSERT INTO users (id, created_at) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET lapsed_at = NULL`,
    ).bind(user, now).run();
  } else {
    // Sin derecho a escribir. Si ya tenía datos, se le deja leerlos y exportarlos un tiempo.
    if (!existing) return json({ error: verdict === 'lapsed' ? 'lapsed' : verdict }, 403, cors);
    lapsedAt = existing.lapsed_at || now;
    if (!existing.lapsed_at) await env.DB.prepare('UPDATE users SET lapsed_at = ? WHERE id = ?').bind(lapsedAt, user).run();
    if (now - lapsedAt >= c.graceDays * DAY) return json({ error: 'lapsed' }, 403, cors);
    readOnly = true;
  }
  const token = TOKEN_PREFIX + randomId() + randomId();
  const expiresAt = now + c.tokenHours * 60 * 60 * 1000;
  await env.DB.prepare('INSERT INTO tokens (hash, user, expires_at, read_only) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), user, expiresAt, readOnly ? 1 : 0).run();
  return json({
    token, expiresAt, readOnly, files: c.filesEnabled,
    lapsedAt, purgeAt: lapsedAt ? lapsedAt + c.graceDays * DAY : null,
  }, 200, cors);
}

async function authenticate(request, env, now = Date.now()) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const row = await env.DB.prepare('SELECT user, expires_at, read_only FROM tokens WHERE hash = ?')
    .bind(await sha256Hex(token)).first();
  if (!row || row.expires_at <= now) return null;
  return { user: row.user, readOnly: !!row.read_only };
}

// ---- Cuotas --------------------------------------------------------------------------------

// Reserva `size` bytes para una clave nueva SOLO si cabe en la cuota del usuario (de su tipo)
// y bajo el tope global. Un INSERT condicionado: dos subidas a la vez no pueden pasarse las dos.
// Devuelve null si cabe, o el motivo ('quota' del usuario, 'capacity' del servicio).
async function reserve(env, { key, user, path, size, kind, uploadId = null }, now = Date.now()) {
  const c = config(env);
  const quota = kind === 'file' ? c.fileQuota : c.dataQuota;
  const row = await env.DB.prepare(
    `INSERT INTO blobs (key, user, path, size, kind, state, upload_id, created_at)
     SELECT ?, ?, ?, ?, ?, 'pending', ?, ?
     WHERE (SELECT COALESCE(SUM(size), 0) FROM blobs WHERE user = ? AND kind = ?) + ? <= ?
       AND (SELECT COALESCE(SUM(size), 0) FROM blobs) + ? <= ?
     RETURNING key`,
  ).bind(key, user, path, size, kind, uploadId, now, user, kind, size, quota, size, c.storage).first();
  if (row) return null;
  const mine = await env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM blobs WHERE user = ? AND kind = ?').bind(user, kind).first();
  return mine.n + size > quota ? 'quota' : 'capacity';
}

async function dropBlob(env, key) {
  await env.SYNC.delete(key);
  await env.DB.prepare('DELETE FROM blobs WHERE key = ?').bind(key).run();
}

// ---- Objetos -------------------------------------------------------------------------------

function readMeta(request) {
  const name = request.headers.get('X-Name') || '';
  const kind = request.headers.get('X-Kind') === 'file' ? 'file' : 'data';
  const keepVersions = request.headers.get('X-Keep-Versions') === '1' && kind === 'data';
  // El etag que el cliente vio la última vez. Sin él, la escritura no es condicional (igual que
  // el proveedor de Drive con ifMatch undefined).
  const ifMatch = (request.headers.get('If-Match') || '').replace(/^"|"$/g, '') || null;
  // `If-None-Match: *` = crear solo si no existe. El motor lo manda cuando no conoce etag de la
  // ruta: dos dispositivos que crean el mismo fichero a la vez no se pisan, uno recibe 412.
  const mustCreate = !ifMatch && (request.headers.get('If-None-Match') || '').trim() === '*';
  return { name, kind, keepVersions, ifMatch, mustCreate };
}

// Mueve el puntero de `path` a la clave nueva, si el etag actual sigue siendo el esperado.
// Devuelve { ok, old } (old = fila anterior, o null). Las claves sobrantes las limpia quien llama.
async function commit(env, { user, path, name, key, etag, size, kind, ifMatch, mustCreate }, now = Date.now()) {
  const old = await env.DB.prepare('SELECT key, etag FROM objects WHERE user = ? AND path = ?').bind(user, path).first();
  if (ifMatch && old && old.etag !== ifMatch) return { ok: false, old };
  if (mustCreate && old) return { ok: false, old };
  let row;
  if (old) {
    // CAS sobre lo que se acaba de leer: si otro escribió entre medias, no se toca.
    row = await env.DB.prepare(
      `UPDATE objects SET key = ?, etag = ?, size = ?, name = ?, kind = ?, updated_at = ?
       WHERE user = ? AND path = ? AND etag = ? RETURNING key`,
    ).bind(key, etag, size, name, kind, now, user, path, old.etag).first();
  } else {
    row = await env.DB.prepare(
      `INSERT INTO objects (user, path, name, key, etag, size, kind, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user, path) DO NOTHING RETURNING key`,
    ).bind(user, path, name, key, etag, size, kind, now).first();
  }
  if (!row) return { ok: false, old };
  await env.DB.prepare(`UPDATE blobs SET state = 'live', upload_id = NULL WHERE key = ?`).bind(key).run();
  return { ok: true, old };
}

// Tras un commit: la clave anterior pasa a versión (si se pidió) o se borra. Las versiones de
// más se borran también. Borrar en R2 es gratis.
async function retire(env, { user, path, old, keepVersions }) {
  if (!old) return;
  if (!keepVersions) { await dropBlob(env, old.key); return; }
  await env.DB.prepare(`UPDATE blobs SET state = 'version' WHERE key = ?`).bind(old.key).run();
  const { results = [] } = await env.DB.prepare(
    `SELECT key FROM blobs WHERE user = ? AND path = ? AND state = 'version' ORDER BY created_at DESC LIMIT -1 OFFSET ?`,
  ).bind(user, path, config(env).maxVersions).all();
  for (const r of results) await dropBlob(env, r.key);
}

async function putObject(path, request, env, cors, who, now = Date.now()) {
  if (who.readOnly) return json({ error: 'read_only' }, 403, cors);
  const c = config(env);
  const meta = readMeta(request);
  if (meta.name.length > NAME_MAX) return json({ error: 'bad_request' }, 400, cors);
  if (meta.kind === 'file' && !c.filesEnabled) return json({ error: 'files_disabled' }, 403, cors);
  const len = Number(request.headers.get('Content-Length') || 0);
  if (!len) return json({ error: 'length_required' }, 411, cors);
  if (len > c.maxBytes) return json({ error: 'too_large', max: c.maxBytes }, 413, cors);
  if (env.WRITES) {
    const { success } = await env.WRITES.limit({ key: who.user });
    if (!success) return json({ error: 'rate_limited' }, 429, cors);
  }
  // Antes de gastar nada: un If-Match que ya no coincide es un 412 sin tocar R2.
  if (meta.ifMatch || meta.mustCreate) {
    const cur = await env.DB.prepare('SELECT etag FROM objects WHERE user = ? AND path = ?').bind(who.user, path).first();
    if (cur && (meta.mustCreate || cur.etag !== meta.ifMatch)) return json({ error: 'precondition_failed', etag: cur.etag }, 412, cors);
  }
  const etag = randomId();
  const key = blobKey(who.user, path, etag);
  const why = await reserve(env, { key, user: who.user, path, size: len, kind: meta.kind }, now);
  if (why) { await refused(env, now); return json({ error: why }, 507, cors); }
  if (!(await spend(env, 'a', now))) {
    await env.DB.prepare('DELETE FROM blobs WHERE key = ?').bind(key).run();
    await refused(env, now);
    return json({ error: 'capacity' }, 507, cors);
  }
  try {
    await env.SYNC.put(key, request.body, { httpMetadata: { contentType: 'application/octet-stream' } });
  } catch (e) {
    await env.DB.prepare('DELETE FROM blobs WHERE key = ?').bind(key).run();
    throw e;
  }
  const r = await commit(env, { user: who.user, path, name: meta.name, key, etag, size: len, kind: meta.kind, ifMatch: meta.ifMatch, mustCreate: meta.mustCreate }, now);
  if (!r.ok) {
    await dropBlob(env, key);
    return json({ error: 'precondition_failed', etag: r.old && r.old.etag }, 412, cors);
  }
  await retire(env, { user: who.user, path, old: r.old, keepVersions: meta.keepVersions });
  return json({ etag, size: len }, 200, { ...cors, ETag: etag });
}

// ---- Subida por partes (F4) ----------------------------------------------------------------
//
// Para los libros que no caben en un PUT (100 MB de cuerpo en Workers). Mismo modelo que un PUT:
// se reserva la cuota con el tamaño TOTAL antes de empezar, las partes van a una clave nueva y
// al completar se mueve el puntero. El identificador de la subida que ve el cliente es el etag
// que tendrá el fichero (aleatorio), no el uploadId de R2: ese se queda en D1.
//
//   POST   /v1/mp/<ruta>                      X-Total-Size  → { uploadId }
//   PUT    /v1/mp/<ruta>/<uploadId>/<n>       una parte     → { etag }
//   POST   /v1/mp/<ruta>/<uploadId>/complete  { parts, name } → { etag, size }
//   DELETE /v1/mp/<ruta>/<uploadId>         abandonar (libera la cuota)

async function mpStart(path, request, env, cors, who, now = Date.now()) {
  if (who.readOnly) return json({ error: 'read_only' }, 403, cors);
  const c = config(env);
  if (!c.filesEnabled) return json({ error: 'files_disabled' }, 403, cors);
  const total = Number(request.headers.get('X-Total-Size') || 0);
  if (!total) return json({ error: 'length_required' }, 411, cors);
  if (env.WRITES) {
    const { success } = await env.WRITES.limit({ key: who.user });
    if (!success) return json({ error: 'rate_limited' }, 429, cors);
  }
  const etag = randomId();
  const key = blobKey(who.user, path, etag);
  const why = await reserve(env, { key, user: who.user, path, size: total, kind: 'file' }, now);
  if (why) { await refused(env, now); return json({ error: why }, 507, cors); }
  if (!(await spend(env, 'a', now))) {
    await env.DB.prepare('DELETE FROM blobs WHERE key = ?').bind(key).run();
    await refused(env, now);
    return json({ error: 'capacity' }, 507, cors);
  }
  const up = await env.SYNC.createMultipartUpload(key, { httpMetadata: { contentType: 'application/octet-stream' } });
  await env.DB.prepare('UPDATE blobs SET upload_id = ? WHERE key = ?').bind(up.uploadId, key).run();
  return json({ uploadId: etag }, 200, cors);
}

async function pendingUpload(env, who, path, handle) {
  const key = blobKey(who.user, path, handle);
  const row = await env.DB.prepare(`SELECT key, size, received, upload_id FROM blobs WHERE key = ? AND user = ? AND state = 'pending' AND upload_id IS NOT NULL`)
    .bind(key, who.user).first();
  return row;
}

async function mpPart(path, handle, n, request, env, cors, who, now = Date.now()) {
  if (who.readOnly) return json({ error: 'read_only' }, 403, cors);
  const c = config(env);
  const row = await pendingUpload(env, who, path, handle);
  if (!row) return json({ error: 'not_found' }, 404, cors);
  const len = Number(request.headers.get('Content-Length') || 0);
  if (!len) return json({ error: 'length_required' }, 411, cors);
  if (len > c.maxBytes) return json({ error: 'too_large', max: c.maxBytes }, 413, cors);
  // Lo que llega no puede pasar de lo reservado: es lo que se contó contra la cuota.
  const ok = await env.DB.prepare('UPDATE blobs SET received = received + ? WHERE key = ? AND received + ? <= size RETURNING key')
    .bind(len, row.key, len).first();
  if (!ok) return json({ error: 'too_large' }, 413, cors);
  if (!(await spend(env, 'a', now))) {
    await env.DB.prepare('UPDATE blobs SET received = received - ? WHERE key = ?').bind(len, row.key).run();
    await refused(env, now);
    return json({ error: 'capacity' }, 507, cors);
  }
  const part = await env.SYNC.resumeMultipartUpload(row.key, row.upload_id).uploadPart(n, request.body);
  return json({ etag: part.etag, partNumber: part.partNumber }, 200, cors);
}

async function mpComplete(path, handle, request, env, cors, who, now = Date.now()) {
  if (who.readOnly) return json({ error: 'read_only' }, 403, cors);
  const row = await pendingUpload(env, who, path, handle);
  if (!row) return json({ error: 'not_found' }, 404, cors);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400, cors); }
  const parts = (Array.isArray(body?.parts) ? body.parts : [])
    .filter((p) => Number.isInteger(p?.partNumber) && typeof p?.etag === 'string')
    .sort((a, b) => a.partNumber - b.partNumber);
  const name = typeof body?.name === 'string' ? body.name : '';
  if (!parts.length || name.length > NAME_MAX) return json({ error: 'bad_request' }, 400, cors);
  if (!(await spend(env, 'a', now))) { await refused(env, now); return json({ error: 'capacity' }, 507, cors); }
  const obj = await env.SYNC.resumeMultipartUpload(row.key, row.upload_id).complete(parts);
  const size = obj.size ?? row.received;
  // El tamaño real (no el declarado) es el que queda en la cuota.
  await env.DB.prepare('UPDATE blobs SET size = ? WHERE key = ?').bind(size, row.key).run();
  const r = await commit(env, { user: who.user, path, name, key: row.key, etag: handle, size, kind: 'file' }, now);
  if (!r.ok) {
    await dropBlob(env, row.key);
    return json({ error: 'precondition_failed' }, 412, cors);
  }
  await retire(env, { user: who.user, path, old: r.old, keepVersions: false });
  return json({ etag: handle, size }, 200, cors);
}

async function mpAbort(path, handle, env, cors, who) {
  const row = await pendingUpload(env, who, path, handle);
  if (!row) return json({ ok: true }, 200, cors);
  try { await env.SYNC.resumeMultipartUpload(row.key, row.upload_id).abort(); } catch { /* ya no existía */ }
  await dropBlob(env, row.key);
  return json({ ok: true }, 200, cors);
}

async function getObject(path, env, cors, who) {
  // D1 primero: lo que no existe se contesta sin gastar una lectura de R2.
  const row = await env.DB.prepare('SELECT key, etag, name, size, updated_at FROM objects WHERE user = ? AND path = ?').bind(who.user, path).first();
  if (!row) return json({ error: 'not_found' }, 404, cors);
  return serveKey(env, row.key, cors, { ETag: row.etag, 'X-Name': row.name, 'X-Size': String(row.size) });
}

async function serveKey(env, key, cors, extra = {}) {
  if (!(await spend(env, 'b'))) { await refused(env); return json({ error: 'capacity' }, 503, cors); }
  const obj = await env.SYNC.get(key);
  if (!obj) return json({ error: 'not_found' }, 404, cors);
  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(obj.size),
      'Cache-Control': 'no-store',
      ...extra,
      ...cors,
    },
  });
}

async function deleteObject(path, env, cors, who) {
  if (who.readOnly) return json({ error: 'read_only' }, 403, cors);
  const row = await env.DB.prepare('DELETE FROM objects WHERE user = ? AND path = ? RETURNING key').bind(who.user, path).first();
  if (!row) return json({ ok: true }, 200, cors);   // ya no estaba: idempotente
  // Con la ruta se van también sus versiones.
  const { results = [] } = await env.DB.prepare('SELECT key FROM blobs WHERE user = ? AND path = ?').bind(who.user, path).all();
  for (const r of results) await dropBlob(env, r.key);
  return json({ ok: true }, 200, cors);
}

async function listObjects(env, cors, who) {
  const { results = [] } = await env.DB.prepare(
    'SELECT path, name, etag, size, kind, updated_at AS updatedAt FROM objects WHERE user = ?',
  ).bind(who.user).all();
  return json({ items: results }, 200, cors);
}

async function metaOf(path, env, cors, who) {
  const row = await env.DB.prepare('SELECT etag, size, name, updated_at AS updatedAt FROM objects WHERE user = ? AND path = ?').bind(who.user, path).first();
  return row ? json(row, 200, cors) : json({ error: 'not_found' }, 404, cors);
}

async function listVersions(path, env, cors, who) {
  const { results = [] } = await env.DB.prepare(
    `SELECT key, size, created_at FROM blobs WHERE user = ? AND path = ? AND state = 'version' ORDER BY created_at DESC`,
  ).bind(who.user, path).all();
  return json({ versions: results.map((r) => ({ id: idOfKey(r.key), size: r.size, at: r.created_at })) }, 200, cors);
}

async function getVersion(path, id, env, cors, who) {
  const key = blobKey(who.user, path, id);
  const row = await env.DB.prepare(`SELECT key FROM blobs WHERE key = ? AND user = ? AND state = 'version'`).bind(key, who.user).first();
  if (!row) return json({ error: 'not_found' }, 404, cors);
  return serveKey(env, key, cors);
}

export async function status(env, who, now = Date.now()) {
  const c = config(env);
  const { results = [] } = await env.DB.prepare(
    `SELECT kind, state, COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS n FROM blobs WHERE user = ? GROUP BY kind, state`,
  ).bind(who.user).all();
  const sum = (pred) => results.filter(pred).reduce((a, r) => a + r.bytes, 0);
  const u = await env.DB.prepare('SELECT lapsed_at FROM users WHERE id = ?').bind(who.user).first();
  const objects = await env.DB.prepare('SELECT COUNT(*) AS n FROM objects WHERE user = ?').bind(who.user).first();
  const lapsedAt = (u && u.lapsed_at) || null;
  return {
    readOnly: who.readOnly,
    files: c.filesEnabled,
    objects: objects.n,
    used: {
      data: sum((r) => r.kind === 'data' && r.state !== 'version'),
      versions: sum((r) => r.state === 'version'),
      files: sum((r) => r.kind === 'file'),
    },
    quota: { data: c.dataQuota, files: c.filesEnabled ? c.fileQuota : 0 },
    lapsedAt,
    purgeAt: lapsedAt ? lapsedAt + c.graceDays * DAY : null,
    now,
  };
}

// Borra TODO lo del usuario (empezar de cero tras perder la clave, o darse de baja).
export async function wipeUser(env, user) {
  for (;;) {
    const { results = [] } = await env.DB.prepare('SELECT key FROM blobs WHERE user = ? LIMIT 1000').bind(user).all();
    if (!results.length) break;
    await env.SYNC.delete(results.map((r) => r.key));
    for (const r of results) await env.DB.prepare('DELETE FROM blobs WHERE key = ?').bind(r.key).run();
  }
  await env.DB.prepare('DELETE FROM objects WHERE user = ?').bind(user).run();
}

// ---- Mantenimiento y gasto -----------------------------------------------------------------

// Purga diaria, siempre desde D1 (sin listar R2):
//   - tokens caducados;
//   - usuarios con la suscripción caducada hace más de GRACE_DAYS (todo lo suyo);
//   - versiones de más de VERSION_DAYS;
//   - reservas que nunca se completaron (subidas cortadas) de hace más de un día.
export async function purge(env, now = Date.now()) {
  const c = config(env);
  const out = { tokens: 0, users: 0, versions: 0, pending: 0 };
  const t = await env.DB.prepare('DELETE FROM tokens WHERE expires_at < ? RETURNING hash').bind(now).all();
  out.tokens = (t.results || []).length;

  const { results: gone = [] } = await env.DB.prepare('SELECT id FROM users WHERE lapsed_at IS NOT NULL AND lapsed_at < ?')
    .bind(now - c.graceDays * DAY).all();
  for (const u of gone) {
    await wipeUser(env, u.id);
    await env.DB.prepare('DELETE FROM tokens WHERE user = ?').bind(u.id).run();
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(u.id).run();
    out.users++;
  }

  const { results: old = [] } = await env.DB.prepare(`SELECT key FROM blobs WHERE state = 'version' AND created_at < ? LIMIT 1000`)
    .bind(now - c.versionDays * DAY).all();
  for (const r of old) await dropBlob(env, r.key);
  out.versions = old.length;

  const { results: stale = [] } = await env.DB.prepare(`SELECT key, upload_id FROM blobs WHERE state = 'pending' AND created_at < ? LIMIT 1000`)
    .bind(now - DAY).all();
  for (const r of stale) {
    if (r.upload_id) {
      try { await env.SYNC.resumeMultipartUpload(r.key, r.upload_id).abort(); } catch { /* ya no existía */ }
    }
    await dropBlob(env, r.key);
  }
  out.pending = stale.length;
  return out;
}

// Estado del gasto frente a lo incluido gratis. Protegido con USAGE_TOKEN (secret).
export async function usage(env, now = Date.now()) {
  const st = await env.DB.prepare('SELECT COUNT(DISTINCT user) AS users, COALESCE(SUM(size), 0) AS bytes FROM blobs').first();
  const active = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE lapsed_at IS NULL').first();
  const u = await env.DB.prepare('SELECT class_a, class_b, refused FROM usage WHERE month = ?').bind(monthOf(now)).first()
    || { class_a: 0, class_b: 0, refused: 0 };
  const c = config(env);
  const pct = (v, of) => Math.round((v / of) * 1000) / 10;
  return {
    month: monthOf(now),
    users: { active: active.n, withData: st.users },
    storage: { bytes: st.bytes, cap: c.storage, pctOfFree: pct(st.bytes, FREE.storage) },
    classA: { ops: u.class_a, cap: c.classA, pctOfFree: pct(u.class_a, FREE.classA) },
    classB: { ops: u.class_b, cap: c.classB, pctOfFree: pct(u.class_b, FREE.classB) },
    refused: u.refused,
  };
}

// ---- Router --------------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const { pathname } = new URL(request.url);
    const method = request.method;
    try {
      if (pathname === '/v1/sync-token' && method === 'POST') return await issueToken(request, env, cors);
      if (pathname === '/v1/usage' && method === 'GET') {
        const auth = request.headers.get('Authorization') || '';
        if (!env.USAGE_TOKEN || auth !== `Bearer ${env.USAGE_TOKEN}`) return json({ error: 'forbidden' }, 403);
        return json(await usage(env), 200);
      }
      if (!pathname.startsWith('/v1/')) return json({ error: 'not_found' }, 404, cors);

      const who = await authenticate(request, env);
      if (!who) return json({ error: 'unauthorized' }, 401, cors);

      if (pathname === '/v1/status' && method === 'GET') return json(await status(env, who), 200, cors);
      if (pathname === '/v1/list' && method === 'GET') return await listObjects(env, cors, who);
      if (pathname === '/v1/all' && method === 'DELETE') { await wipeUser(env, who.user); return json({ ok: true }, 200, cors); }

      const mp = pathname.match(/^\/v1\/mp\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?$/);
      if (mp && PATH_RE.test(mp[1])) {
        const [, path, handle, step] = mp;
        if (!handle && method === 'POST') return await mpStart(path, request, env, cors, who);
        if (handle && ID_RE.test(handle)) {
          if (!step && method === 'DELETE') return await mpAbort(path, handle, env, cors, who);
          if (step === 'complete' && method === 'POST') return await mpComplete(path, handle, request, env, cors, who);
          if (/^[1-9]\d{0,3}$/.test(step || '') && method === 'PUT') return await mpPart(path, handle, Number(step), request, env, cors, who);
        }
        return json({ error: 'not_found' }, 404, cors);
      }

      const m = pathname.match(/^\/v1\/(o|meta|versions)\/([^/]+)(?:\/([^/]+))?$/);
      if (m && PATH_RE.test(m[2])) {
        const [, kind, path, sub] = m;
        if (kind === 'o' && !sub) {
          if (method === 'GET') return await getObject(path, env, cors, who);
          if (method === 'PUT') return await putObject(path, request, env, cors, who);
          if (method === 'DELETE') return await deleteObject(path, env, cors, who);
        }
        if (kind === 'meta' && !sub && method === 'GET') return await metaOf(path, env, cors, who);
        if (kind === 'versions' && method === 'GET') {
          if (!sub) return await listVersions(path, env, cors, who);
          if (ID_RE.test(sub)) return await getVersion(path, sub, env, cors, who);
        }
      }
      return json({ error: 'not_found' }, 404, cors);
    } catch (e) {
      // D1 o R2 caídos o sin cuota del plan gratuito: un 503, nunca algo que cobre. Sin rutas
      // ni nombres en el log: solo el mensaje del error.
      console.error('sync:', e?.message || e);
      return json({ error: 'unavailable' }, 503, cors);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      const removed = await purge(env);
      const u = await usage(env);
      // Aviso en los logs (observability) desde el 50 % de lo gratis.
      const worst = Math.max(u.storage.pctOfFree, u.classA.pctOfFree, u.classB.pctOfFree);
      console.log(JSON.stringify({ purge: removed, ...u, alert: worst >= 50 }));
    })());
  },
};
