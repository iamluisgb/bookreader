// P24 F4 · bookreader-share — almacén de dossiers cifrados para compartir por enlace.
//
//   app (emisor) ──cifra con AES-GCM──▶ POST /v1/share ──▶ R2 (bytes ilegibles)
//   app (receptor) ◀── GET /v1/share/:id ◀── R2       …y descifra con la clave del enlace
//
// La clave NUNCA llega aquí: va en el fragmento del enlace (`#d=<id>.<clave>`), que el
// navegador no envía. Este Worker guarda y sirve bytes que no puede leer (ADR-053).
//
// - Sin cuentas ni listados: el id son 128 bits aleatorios; sin el enlace completo no hay
//   nada que encontrar, y sin la clave lo encontrado no sirve.
// - Caduca a los TTL_DAYS. Lo caducado responde 410 y la purga diaria lo borra.
// - Quien sube recibe un `deleteToken` para revocar el enlace antes de tiempo (solo se
//   guarda su hash).
// - Privacidad: no se registran contenidos, ni nombres, ni IP (la IP solo cuenta para el
//   límite de subidas y no se guarda).

const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const KEY = (id) => `d/${id}`;
const DAY = 24 * 60 * 60 * 1000;

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const randomId = () => b64url(crypto.getRandomValues(new Uint8Array(16)));
export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Delete-Token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

const json = (obj, status, cors) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors },
});

async function upload(request, env, cors) {
  // Solo desde la app: sin origen permitido no hay subida (el GET sí es abierto, porque el
  // enlace se abre en cualquier navegador… que es la propia app, pero no hace falta más).
  if (!cors['Access-Control-Allow-Origin']) return json({ error: 'origin' }, 403, cors);
  const max = Number(env.MAX_BYTES || 104857600);
  const len = Number(request.headers.get('Content-Length') || 0);
  if (!len) return json({ error: 'length_required' }, 411, cors);
  if (len > max) return json({ error: 'too_large', max }, 413, cors);
  if (env.UPLOADS) {
    const ip = request.headers.get('CF-Connecting-IP') || 'anon';
    const { success } = await env.UPLOADS.limit({ key: ip });
    if (!success) return json({ error: 'rate_limited' }, 429, cors);
  }
  const id = randomId();
  const deleteToken = randomId();
  const expiresAt = Date.now() + Number(env.TTL_DAYS || 7) * DAY;
  await env.SHARES.put(KEY(id), request.body, {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: { expiresAt: String(expiresAt), del: await sha256Hex(deleteToken) },
  });
  return json({ id, expiresAt, deleteToken }, 201, cors);
}

async function download(id, env, cors) {
  const obj = await env.SHARES.get(KEY(id));
  if (!obj) return json({ error: 'not_found' }, 404, cors);
  if (Number(obj.customMetadata?.expiresAt || 0) < Date.now()) {
    await env.SHARES.delete(KEY(id));
    return json({ error: 'expired' }, 410, cors);
  }
  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(obj.size),
      // Cifrado e inmutable: puede cachearse en el navegador del receptor, no en proxies.
      'Cache-Control': 'private, max-age=3600',
      ...cors,
    },
  });
}

async function remove(id, request, env, cors) {
  const token = request.headers.get('X-Delete-Token') || '';
  const obj = await env.SHARES.head(KEY(id));
  if (!obj) return json({ ok: true }, 200, cors);             // ya no está: idempotente
  if (!token || (await sha256Hex(token)) !== obj.customMetadata?.del) return json({ error: 'forbidden' }, 403, cors);
  await env.SHARES.delete(KEY(id));
  return json({ ok: true }, 200, cors);
}

// Purga diaria: borra lo caducado.
export async function purge(env, now = Date.now()) {
  let cursor, removed = 0;
  do {
    const page = await env.SHARES.list({ prefix: 'd/', cursor, include: ['customMetadata'] });
    const dead = page.objects.filter((o) => Number(o.customMetadata?.expiresAt || 0) < now).map((o) => o.key);
    if (dead.length) { await env.SHARES.delete(dead); removed += dead.length; }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return removed;
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const { pathname } = new URL(request.url);
    if (pathname === '/v1/share' && request.method === 'POST') return upload(request, env, cors);
    const m = pathname.match(/^\/v1\/share\/([^/]+)$/);
    if (m) {
      if (!ID_RE.test(m[1])) return json({ error: 'not_found' }, 404, cors);
      if (request.method === 'GET') return download(m[1], env, cors);
      if (request.method === 'DELETE') return remove(m[1], request, env, cors);
    }
    return json({ error: 'not_found' }, 404, cors);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(purge(env));
  },
};
