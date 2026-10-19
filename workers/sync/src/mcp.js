// MON4 · El MCP de BookReader, servido desde el Worker del sync: un agente (Claude Code, Hermes,
// claude.ai…) lee la biblioteca del usuario sin instalar nada.
//
// Es el MCP de `mcp/` (mismas tools, misma lectura del layout: mcp/src/tools.mjs y
// sources/drive.mjs) con otro proveedor: en vez de pedir los ficheros por HTTP, los lee de R2
// aquí mismo y los descifra con la clave del sync.
//
// LA CLAVE. El sync es de extremo a extremo y el servidor no tiene la clave. Para responder a un
// agente hace falta, así que viaja así:
//   - Al crear un token (en la app, con la sesión del sync), la app manda la clave y la licencia.
//     Se guardan CIFRADAS con una clave que se deriva del propio token (HKDF), y del token solo
//     se guarda el hash. El token se enseña una vez y no se puede recuperar.
//   - En cada petición del agente, el token descifra la clave en memoria, se leen los ficheros,
//     se responde y se olvida. En D1 no queda nada que se pueda descifrar sin un token.
// El precio: mientras responde, este Worker ve los datos en claro. Es una conexión que el
// usuario crea a sabiendas y revoca cuando quiere (Ajustes → Datos → Agentes).
//
// LA SUSCRIPCIÓN. Un token del MCP dura meses; la licencia se revalida contra Polar cada
// LICENSE_RECHECK_MS con la licencia que guarda cifrada. Caducada: se sigue leyendo durante el
// plazo de gracia, como el sync (solo lectura, que el MCP ya es); después, 403.
//
// PROTOCOLO: MCP sobre HTTP «streamable», sin estado y sin SSE. Cada POST lleva un mensaje
// JSON-RPC (o un lote) y la respuesta es JSON. No hay sesiones ni notificaciones del servidor:
// todas las tools son de lectura y responden en una petición.

import * as C from '../../../app/js/sync/sync-crypto.js';
import { createDriveSource } from '../../../mcp/src/sources/drive.mjs';
import { toolsFor, callTool } from '../../../mcp/src/tools.mjs';
import { spend, refused, sha256Hex, randomId, config, checkLicense, userIdOf } from './index.js';

const DAY = 24 * 60 * 60 * 1000;
export const MCP_TOKEN_PREFIX = 'br-mcp-';
const MAX_TOKENS = 20;
const DEFAULT_DAYS = 90;
const MAX_DAYS = 365;
const NAME_MAX = 60;
const LICENSE_RECHECK_MS = DAY;
const LAST_USED_EVERY_MS = 60 * 60 * 1000;   // `last_used_at` se escribe como mucho una vez por hora
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'bookreader', title: 'BookReader', version: '1.0.0' };
const INSTRUCTIONS = [
  'Lee la biblioteca de BookReader del usuario: libros, subrayados, notas de libreta, estadísticas',
  'de lectura, mazos de estudio y lo creado con el agente de la app. Es de solo lectura.',
  'Empieza por `list_books` para conocer los bookIds; `get_highlights` y `get_notes` aceptan',
  'también `book` con parte del título.',
].join(' ');

const json = (obj, status, headers = {}) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
});

// ---- La clave, cifrada con el token ----------------------------------------------------------

async function wrapKeyOf(secret) {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('bookreader-mcp-wrap-v1') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

const secretOf = (token) => C.fromB64url(token.slice(MCP_TOKEN_PREFIX.length));

export async function wrap(token, props) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await wrapKeyOf(secretOf(token)), new TextEncoder().encode(JSON.stringify(props)));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), 12);
  return C.b64url(out);
}

export async function unwrap(token, wrapped) {
  const buf = C.fromB64url(wrapped);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, await wrapKeyOf(secretOf(token)), buf.slice(12));
  return JSON.parse(new TextDecoder().decode(pt));
}

export function newToken() {
  return MCP_TOKEN_PREFIX + C.b64url(crypto.getRandomValues(new Uint8Array(32)));
}

// Guarda un token nuevo para `user`. Lo usan los tokens personales y, con kind 'oauth', el
// flujo OAuth (cada conexión de claude.ai es un token más, revocable igual).
export async function storeToken(env, { user, name, kind = 'pat', raw, license, days = DEFAULT_DAYS }, now = Date.now()) {
  const token = newToken();
  const id = randomId();
  const expiresAt = now + days * DAY;
  await env.DB.prepare(
    `INSERT INTO mcp_tokens (id, user, hash, name, kind, wrapped, created_at, expires_at, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, user, await sha256Hex(token), name, kind, await wrap(token, { k: C.b64url(raw), l: license }), now, expiresAt, now).run();
  return { id, token, name, kind, createdAt: now, expiresAt };
}

// ---- Gestión desde la app (con la sesión del sync) -------------------------------------------

// POST /v1/mcp-tokens { name, key, license, days }: la app crea un token para un agente.
// La licencia tiene que ser la de esta cuenta (su hash ES el usuario) y la clave, la del sync.
export async function createTokenRoute(request, env, cors, who, now = Date.now()) {
  if (who.readOnly) return json({ error: 'read_only' }, 403, cors);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400, cors); }
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, NAME_MAX) : '';
  const license = typeof body?.license === 'string' ? body.license.trim() : '';
  let raw;
  try { raw = C.fromB64url(String(body?.key || '')); } catch { raw = null; }
  const days = Math.min(MAX_DAYS, Math.max(1, Math.round(Number(body?.days) || DEFAULT_DAYS)));
  if (!name || !license || !raw || raw.length !== 32) return json({ error: 'bad_request' }, 400, cors);
  if (await userIdOf(env, license) !== who.user) return json({ error: 'license_mismatch' }, 403, cors);
  if (!(await keyOpens(env, who.user, raw))) return json({ error: 'wrong_key' }, 403, cors);
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM mcp_tokens WHERE user = ? AND expires_at > ?').bind(who.user, now).first();
  if (n.n >= MAX_TOKENS) return json({ error: 'too_many' }, 409, cors);
  return json(await storeToken(env, { user: who.user, name, raw, license, days }, now), 200, cors);
}

// La clave tiene que abrir este sync: con otra, el agente vería una biblioteca vacía y nadie
// sabría por qué. Basta con que la ruta del manifest exista (su id es un HMAC con la clave).
async function keyOpens(env, user, raw) {
  const pid = await C.pathId(await C.importKeys(raw), 'bookreader/manifest.json');
  const any = await env.DB.prepare('SELECT 1 AS x FROM objects WHERE user = ? LIMIT 1').bind(user).first();
  if (!any) return true;   // sync vacío: no hay con qué comprobarla
  return !!(await env.DB.prepare('SELECT 1 AS x FROM objects WHERE user = ? AND path = ?').bind(user, pid).first());
}

export async function listTokensRoute(env, cors, who, now = Date.now()) {
  const { results = [] } = await env.DB.prepare(
    `SELECT id, name, kind, created_at, expires_at, last_used_at FROM mcp_tokens WHERE user = ? AND expires_at > ? ORDER BY created_at DESC`,
  ).bind(who.user, now).all();
  return json({
    tokens: results.map((r) => ({ id: r.id, name: r.name, kind: r.kind, createdAt: r.created_at, expiresAt: r.expires_at, lastUsedAt: r.last_used_at })),
  }, 200, cors);
}

export async function revokeTokenRoute(id, env, cors, who) {
  await env.DB.prepare('DELETE FROM mcp_tokens WHERE id = ? AND user = ?').bind(id, who.user).run();
  return json({ ok: true }, 200, cors);
}

// ---- El agente ---------------------------------------------------------------------------------

// Token → { user, raw, license } o un motivo para negarse. Revalida la licencia si toca.
export async function authenticateAgent(env, token, now = Date.now(), fetchImpl = fetch) {
  if (!token.startsWith(MCP_TOKEN_PREFIX)) return { error: 'unauthorized' };
  const row = await env.DB.prepare('SELECT id, user, wrapped, expires_at, last_used_at, checked_at FROM mcp_tokens WHERE hash = ?')
    .bind(await sha256Hex(token)).first();
  if (!row || row.expires_at <= now) return { error: 'unauthorized' };
  let props;
  try { props = await unwrap(token, row.wrapped); } catch { return { error: 'unauthorized' }; }

  if (now - row.checked_at > LICENSE_RECHECK_MS) {
    let verdict = null;
    try { verdict = await checkLicense(env, props.l, fetchImpl); } catch { /* Polar caído: se sigue con lo que había */ }
    if (verdict === 'granted') {
      await env.DB.prepare('UPDATE users SET lapsed_at = NULL WHERE id = ?').bind(row.user).run();
    } else if (verdict) {
      await env.DB.prepare('UPDATE users SET lapsed_at = COALESCE(lapsed_at, ?) WHERE id = ?').bind(now, row.user).run();
    }
    if (verdict) await env.DB.prepare('UPDATE mcp_tokens SET checked_at = ? WHERE id = ?').bind(now, row.id).run();
  }
  const u = await env.DB.prepare('SELECT lapsed_at FROM users WHERE id = ?').bind(row.user).first();
  if (!u || (u.lapsed_at && now - u.lapsed_at >= config(env).graceDays * DAY)) return { error: 'lapsed' };

  if (!row.last_used_at || now - row.last_used_at > LAST_USED_EVERY_MS) {
    await env.DB.prepare('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?').bind(now, row.id).run();
  }
  return { user: row.user, raw: C.fromB64url(props.k), license: props.l };
}

// El proveedor del layout para la fuente de mcp/: lee de R2 y descifra aquí.
export function r2Provider(env, user, raw) {
  let keysP = null;
  const keys = () => (keysP ||= C.importKeys(raw));
  return {
    async read(path) {
      const k = await keys();
      const pid = await C.pathId(k, path);
      const row = await env.DB.prepare('SELECT key FROM objects WHERE user = ? AND path = ?').bind(user, pid).first();
      if (!row) return null;
      if (!(await spend(env, 'b'))) {
        await refused(env);
        throw Object.assign(new Error('capacity'), { capacity: true });
      }
      const obj = await env.SYNC.get(row.key);
      if (!obj) return null;
      return { content: await C.decryptText(k, pid, await new Response(obj.body).blob()) };
    },
  };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function handleMessage(msg, source) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'Invalid Request');
  const isNotification = msg.id === undefined || msg.id === null;
  if (isNotification) return null;   // notifications/initialized y compañía: nada que responder
  const p = msg.params || {};
  switch (msg.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0', id: msg.id,
        result: {
          protocolVersion: PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };
    case 'ping':
      return { jsonrpc: '2.0', id: msg.id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id: msg.id, result: { tools: toolsFor(source) } };
    case 'tools/call':
      return { jsonrpc: '2.0', id: msg.id, result: await callTool(source, p.name, p.arguments) };
    default:
      return rpcError(msg.id, -32601, 'Method not found: ' + msg.method);
  }
}

// POST /mcp. `resourceMetadata` es la URL de los metadatos OAuth, para el WWW-Authenticate.
export async function mcpRoute(request, env, { resourceMetadata = null } = {}) {
  const origin = request.headers.get('Origin');
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim());
  // Protección contra DNS rebinding (la pide la especificación): un navegador en otra web no.
  if (origin && !allowed.includes(origin)) return json({ error: 'origin' }, 403);
  if (request.method === 'GET' || request.method === 'DELETE') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  if (request.method !== 'POST') return json({ error: 'not_found' }, 404);

  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const who = token ? await authenticateAgent(env, token) : { error: 'unauthorized' };
  if (who.error) {
    const h = who.error === 'unauthorized'
      ? { 'WWW-Authenticate': 'Bearer' + (resourceMetadata ? ` resource_metadata="${resourceMetadata}"` : '') }
      : {};
    return json({ error: who.error }, who.error === 'unauthorized' ? 401 : 403, h);
  }

  let body;
  try { body = await request.json(); } catch { return json(rpcError(null, -32700, 'Parse error'), 400); }
  // Una fuente por petición: la caché del layout vive lo que vive la petición.
  const source = createDriveSource({ provider: r2Provider(env, who.user, who.raw), kind: 'bookreader', cacheMs: 60000 });
  try {
    const batch = Array.isArray(body);
    const out = (await Promise.all((batch ? body : [body]).map((m) => handleMessage(m, source)))).filter(Boolean);
    if (!out.length) return new Response(null, { status: 202 });
    return json(batch ? out : out[0], 200);
  } catch (e) {
    if (e.capacity) return json({ error: 'capacity' }, 503);
    throw e;
  }
}
