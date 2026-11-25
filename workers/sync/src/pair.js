// Añadir un dispositivo (docs/PROPUESTA_EMPAREJAR_DISPOSITIVOS.md).
//
// F2 · Relevo del emparejamiento `#pair2=<id>.<s>`:
//
//   origen ──POST /v1/pair {blob}──────────▶ D1 (blob cifrado con `s`, 10 min, un solo uso)
//   origen ◀─GET /v1/pair/<id> cada 2 s──── { state: pending | claimed | expired, device }
//   nuevo  ──POST /v1/pair/<id>/claim────▶ devuelve el blob y lo borra (sin token, Origin + IP)
//
// El blob lleva la licencia y la clave del sync cifradas con `s`, un secreto de 16 bytes que solo
// viaja en el FRAGMENTO del enlace: el servidor guarda bytes que no puede abrir y los tira en
// cuanto se usan. Un enlace reenviado o un QR fotografiado valen una vez y diez minutos, y el
// origen ve quién lo usó.
//
// F3 · POST /v1/key-owner {pid}: ¿el fichero de control de esta clave está en el espacio de OTRO
// usuario? Solo contesta sí/no, y solo a quien ya tiene la clave (el pid es su HMAC de 256 bits).
// Sirve para decir «esta clave es de un sync abierto con otra licencia» en vez de «no hay nada».

const PAIR_TTL_MS = 10 * 60 * 1000;
const MAX_LIVE = 5;
const BLOB_MAX = 4096;
const DEVICE_MAX = 80;
const PID_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const PAIR_ID_RE = /^[A-Za-z0-9_-]{22}$/;

async function readJson(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > 16 * 1024) return null;
  try { return await request.json(); } catch { return null; }
}

async function limited(env, key) {
  if (!env.PAIRING) return false;
  const { success } = await env.PAIRING.limit({ key });
  return !success;
}

export async function createPairRoute(request, env, cors, who, { json, randomId }, now = Date.now()) {
  if (who.readOnly) return json({ error: 'read_only' }, 403, cors);
  if (await limited(env, 'new:' + who.user)) return json({ error: 'rate_limited' }, 429, cors);
  const body = await readJson(request);
  const blob = typeof body?.blob === 'string' ? body.blob : '';
  if (!blob || blob.length > BLOB_MAX || !/^[A-Za-z0-9_-]+$/.test(blob)) return json({ error: 'bad_request' }, 400, cors);
  const live = await env.DB.prepare('SELECT COUNT(*) AS n FROM pair_codes WHERE user = ? AND claimed_at IS NULL AND expires_at > ?')
    .bind(who.user, now).first();
  if (live.n >= MAX_LIVE) return json({ error: 'too_many' }, 429, cors);
  const id = randomId();
  const expiresAt = now + PAIR_TTL_MS;
  await env.DB.prepare('INSERT INTO pair_codes (id, user, blob, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, who.user, blob, now, expiresAt).run();
  return json({ id, expiresAt }, 200, cors);
}

export async function pairStatusRoute(id, env, cors, who, { json }, now = Date.now()) {
  const row = await env.DB.prepare('SELECT expires_at, claimed_at, claimed_by FROM pair_codes WHERE id = ? AND user = ?')
    .bind(id, who.user).first();
  if (!row) return json({ error: 'not_found' }, 404, cors);
  const state = row.claimed_at ? 'claimed' : row.expires_at <= now ? 'expired' : 'pending';
  return json({ state, expiresAt: row.expires_at, claimedAt: row.claimed_at || null, device: row.claimed_by || null }, 200, cors);
}

// Cerrar el diálogo sin usarlo: el código deja de valer al momento.
export async function cancelPairRoute(id, env, cors, who, { json }) {
  await env.DB.prepare('DELETE FROM pair_codes WHERE id = ? AND user = ? AND claimed_at IS NULL').bind(id, who.user).run();
  return json({ ok: true }, 200, cors);
}

// Sin token: el id del enlace es la credencial. Solo desde los orígenes de la app (un navegador
// en otra web no puede reclamarlo por el usuario) y con tope por IP.
export async function claimPairRoute(id, request, env, cors, { json }, now = Date.now()) {
  if (!cors['Access-Control-Allow-Origin']) return json({ error: 'origin' }, 403, cors);
  const ip = request.headers.get('CF-Connecting-IP') || 'anon';
  if (await limited(env, 'claim:' + ip)) return json({ error: 'rate_limited' }, 429, cors);
  const body = (await readJson(request)) || {};
  const device = typeof body.device === 'string' ? body.device.trim().slice(0, DEVICE_MAX) : '';
  // Un solo UPDATE condicionado decide quién gana: dos reclamaciones a la vez no pueden
  // llevarse las dos el blob. RETURNING da el valor ya escrito, así que el blob se lee en la
  // misma sentencia que lo marca (sin tocarlo) y se borra justo después.
  const row = await env.DB.prepare(
    `UPDATE pair_codes SET claimed_at = ?, claimed_by = ?
     WHERE id = ? AND claimed_at IS NULL AND expires_at > ? AND blob IS NOT NULL
     RETURNING blob`,
  ).bind(now, device || '?', id, now).first();
  if (!row) return json({ error: 'gone' }, 410, cors);
  await env.DB.prepare('UPDATE pair_codes SET blob = NULL WHERE id = ?').bind(id).run();
  return json({ blob: row.blob }, 200, cors);
}

export async function keyOwnerRoute(request, env, cors, who, { json }) {
  if (await limited(env, 'owner:' + who.user)) return json({ error: 'rate_limited' }, 429, cors);
  const body = await readJson(request);
  const pid = typeof body?.pid === 'string' ? body.pid : '';
  if (!PID_RE.test(pid)) return json({ error: 'bad_request' }, 400, cors);
  const row = await env.DB.prepare('SELECT 1 AS x FROM objects WHERE path = ? AND user != ? LIMIT 1').bind(pid, who.user).first();
  return json({ elsewhere: !!row }, 200, cors);
}

// ¿Tiene quien llama la clave de ESTE espacio? El pid de cualquier fichero suyo lo prueba (es un
// HMAC con la clave); la app manda el del fichero de control.
export async function provesKey(env, user, pid) {
  if (typeof pid !== 'string' || !PID_RE.test(pid)) return false;
  return !!(await env.DB.prepare('SELECT 1 AS x FROM objects WHERE user = ? AND path = ?').bind(user, pid).first());
}

export async function purgePairs(env, now = Date.now()) {
  // El blob ya no sirve pasado el plazo; la fila se guarda un día para que el origen pueda leer
  // «caducado» o «emparejado» si vuelve a mirar.
  await env.DB.prepare('UPDATE pair_codes SET blob = NULL WHERE expires_at < ? AND blob IS NOT NULL').bind(now).run();
  const r = await env.DB.prepare('DELETE FROM pair_codes WHERE expires_at < ? RETURNING id').bind(now - 24 * 60 * 60 * 1000).all();
  return (r.results || []).length;
}
