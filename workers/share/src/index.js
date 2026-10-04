// P24 F4 · bookreader-share — almacén de dossiers cifrados para compartir por enlace.
//
//   app (emisor) ──cifra con AES-GCM──▶ POST /v1/share ──▶ R2 (bytes ilegibles)
//   app (receptor) ◀── GET /v1/share/:id ◀── R2       …y descifra con la clave del enlace
//
// La clave NUNCA llega aquí: va en el fragmento del enlace (`#d=<id>.<clave>`), que el
// navegador no envía. Este Worker guarda y sirve bytes que no puede leer (ADR-053).
//
// NUNCA PAGAR. R2 cobra al pasar de 10 GB almacenados, 1 M de operaciones de clase A
// (escrituras) o 10 M de clase B (lecturas) al mes. D1 lleva la cuenta (R2 no la da barata)
// y el Worker se niega ANTES, con margen (CAP_*, al 80 %):
//   - Subir: reserva el tamaño en D1 con un INSERT condicionado a que el almacenamiento vivo
//     + este paquete no pase de CAP_STORAGE_BYTES, y cuenta una operación A. Si no cabe, 507.
//   - Bajar: cuenta una operación B si no se ha llegado a CAP_CLASS_B. Si se ha llegado, 503.
//   - Purga diaria: lee lo caducado de D1, no lista R2 (listar es clase A). Borrar es gratis.
// D1 y los Workers del plan gratuito no cobran: al pasar su límite fallan, y aquí un fallo
// es un 503, nunca una factura.
//
// - Sin cuentas ni listados: el id son 128 bits aleatorios.
// - Caduca a los TTL_DAYS. Lo caducado responde 410 y la purga lo borra.
// - Quien sube recibe un `deleteToken` para revocar el enlace (se guarda su hash).
// - Privacidad: no se registran contenidos ni IP (la IP solo cuenta para el límite).

const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const KEY = (id) => `d/${id}`;
const DAY = 24 * 60 * 60 * 1000;

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const randomId = () => b64url(crypto.getRandomValues(new Uint8Array(16)));
export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export const monthOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);

export function caps(env) {
  return {
    storage: Number(env.CAP_STORAGE_BYTES || 8 * 1024 ** 3),
    classA: Number(env.CAP_CLASS_A || 800000),
    classB: Number(env.CAP_CLASS_B || 8000000),
  };
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

const json = (obj, status, cors = {}) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors },
});

// Cuenta UNA operación de la clase dada si no se ha llegado al tope del mes. Atómico: el
// UPSERT con WHERE solo actualiza (y devuelve fila) por debajo del tope.
export async function spend(env, cls, now = Date.now()) {
  const col = cls === 'a' ? 'class_a' : 'class_b';
  const cap = cls === 'a' ? caps(env).classA : caps(env).classB;
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

async function upload(request, env, cors) {
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
  const now = Date.now();
  const id = randomId();
  const deleteToken = randomId();
  const expiresAt = now + Number(env.TTL_DAYS || 7) * DAY;
  // Reserva el sitio SOLO si cabe bajo el tope de almacenamiento. Cuenta TODAS las filas:
  // lo caducado sigue ocupando R2 hasta que pasa la purga, y R2 lo cobra igual.
  const reserved = await env.DB.prepare(
    `INSERT INTO shares (id, size, expires_at, del_hash, created_at)
     SELECT ?, ?, ?, ?, ?
     WHERE (SELECT COALESCE(SUM(size), 0) FROM shares) + ? <= ?
     RETURNING id`,
  ).bind(id, len, expiresAt, await sha256Hex(deleteToken), now, len, caps(env).storage).first();
  if (!reserved) { await refused(env); return json({ error: 'capacity' }, 507, cors); }
  if (!(await spend(env, 'a', now))) {
    await env.DB.prepare('DELETE FROM shares WHERE id = ?').bind(id).run();
    await refused(env);
    return json({ error: 'capacity' }, 507, cors);
  }
  try {
    await env.SHARES.put(KEY(id), request.body, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { expiresAt: String(expiresAt) },
    });
  } catch (e) {
    await env.DB.prepare('DELETE FROM shares WHERE id = ?').bind(id).run();
    throw e;
  }
  return json({ id, expiresAt, deleteToken }, 201, cors);
}

async function download(id, env, cors) {
  // D1 primero: lo que no existe o caducó se contesta sin gastar una lectura de R2.
  const row = await env.DB.prepare('SELECT expires_at FROM shares WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'not_found' }, 404, cors);
  if (row.expires_at < Date.now()) {
    await env.SHARES.delete(KEY(id));
    await env.DB.prepare('DELETE FROM shares WHERE id = ?').bind(id).run();
    return json({ error: 'expired' }, 410, cors);
  }
  if (!(await spend(env, 'b'))) { await refused(env); return json({ error: 'capacity' }, 503, cors); }
  const obj = await env.SHARES.get(KEY(id));
  if (!obj) return json({ error: 'not_found' }, 404, cors);
  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(obj.size),
      'Cache-Control': 'private, max-age=3600',
      ...cors,
    },
  });
}

async function remove(id, request, env, cors) {
  const token = request.headers.get('X-Delete-Token') || '';
  const row = await env.DB.prepare('SELECT del_hash FROM shares WHERE id = ?').bind(id).first();
  if (!row) return json({ ok: true }, 200, cors);             // ya no está: idempotente
  if (!token || (await sha256Hex(token)) !== row.del_hash) return json({ error: 'forbidden' }, 403, cors);
  await env.SHARES.delete(KEY(id));
  await env.DB.prepare('DELETE FROM shares WHERE id = ?').bind(id).run();
  return json({ ok: true }, 200, cors);
}

// Purga diaria desde D1 (sin listar R2, que es clase A). Borrar en R2 es gratis.
export async function purge(env, now = Date.now()) {
  const { results = [] } = await env.DB.prepare('SELECT id FROM shares WHERE expires_at < ? LIMIT 1000').bind(now).all();
  if (!results.length) return 0;
  await env.SHARES.delete(results.map((r) => KEY(r.id)));
  for (const r of results) await env.DB.prepare('DELETE FROM shares WHERE id = ?').bind(r.id).run();
  return results.length;
}

// Estado del gasto frente a lo incluido gratis. Protegido con USAGE_TOKEN (secret).
export async function usage(env, now = Date.now()) {
  const st = await env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM shares').first();
  const u = await env.DB.prepare('SELECT class_a, class_b, refused FROM usage WHERE month = ?').bind(monthOf(now)).first()
    || { class_a: 0, class_b: 0, refused: 0 };
  const c = caps(env);
  const FREE = { storage: 10 * 1024 ** 3, classA: 1000000, classB: 10000000 };
  const pct = (v, of) => Math.round((v / of) * 1000) / 10;
  return {
    month: monthOf(now),
    links: st.n,
    storage: { bytes: st.bytes, cap: c.storage, pctOfFree: pct(st.bytes, FREE.storage) },
    classA: { ops: u.class_a, cap: c.classA, pctOfFree: pct(u.class_a, FREE.classA) },
    classB: { ops: u.class_b, cap: c.classB, pctOfFree: pct(u.class_b, FREE.classB) },
    refused: u.refused,
  };
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/v1/share' && request.method === 'POST') return await upload(request, env, cors);
      if (pathname === '/v1/usage' && request.method === 'GET') {
        const auth = request.headers.get('Authorization') || '';
        if (!env.USAGE_TOKEN || auth !== `Bearer ${env.USAGE_TOKEN}`) return json({ error: 'forbidden' }, 403);
        return json(await usage(env), 200);
      }
      const m = pathname.match(/^\/v1\/share\/([^/]+)$/);
      if (m) {
        if (!ID_RE.test(m[1])) return json({ error: 'not_found' }, 404, cors);
        if (request.method === 'GET') return await download(m[1], env, cors);
        if (request.method === 'DELETE') return await remove(m[1], request, env, cors);
      }
      return json({ error: 'not_found' }, 404, cors);
    } catch (e) {
      // D1 o R2 caídos o sin cuota del plan gratuito: un 503, nunca algo que cobre.
      console.error('share:', e?.message || e);
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
