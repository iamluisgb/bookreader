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
// todas las tools responden en una petición. Los bytes de un libro que se sube no van por aquí,
// sino por un PUT aparte a una URL de un solo uso (upload.js).

import * as C from '../../../app/js/sync/sync-crypto.js';
import { createDriveSource } from '../../../mcp/src/sources/drive.mjs';
import { toolsFor, callTool } from '../../../mcp/src/tools.mjs';
import { SourceError } from '../../../mcp/src/errors.mjs';
import { spend, refused, sha256Hex, randomId, config, checkLicense, userIdOf, writeBytes } from './index.js';
import { uploadsFor } from './upload.js';

const DAY = 24 * 60 * 60 * 1000;
export const MCP_TOKEN_PREFIX = 'br-mcp-';
const MAX_TOKENS = 20;
const DEFAULT_DAYS = 90;
const MAX_DAYS = 365;
const NAME_MAX = 60;
const LICENSE_RECHECK_MS = DAY;
const LAST_USED_EVERY_MS = 60 * 60 * 1000;   // `last_used_at` se escribe como mucho una vez por hora
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
// Permisos de un token. 'read' va siempre; los otros, solo si el usuario los marca al crearlo.
export const SCOPES = ['read', 'write', 'text', 'library', 'upload'];
const CHANGES_KEPT_DAYS = 30;
const UNDO_MAX_BYTES = 512 * 1024;
const WRITE_RETRIES = 3;
// Más llamadas a tools que esto por token y minuto (MCP_CALLS en wrangler.jsonc) se contestan
// con un error que el agente lee, sin tocar R2. El 20-oct un agente llamó una vez por segundo
// durante hora y media; cada llamada se pasaba de los 10 ms de CPU, Cloudflare la cortaba sin
// respuesta y el cliente volvía a intentarlo.
const TOO_MANY_CALLS = 'Demasiadas llamadas seguidas a BookReader con este token (más de 60 por minuto). ' +
  'Espera un minuto antes de seguir y no repitas en bucle la misma llamada.';
// Como bookreader-provider.js: el fichero del libro guarda versiones. Y library.json cuando
// escribe un agente (los dispositivos no las piden para él).
const VERSIONED = /\/(books\/[^/]+|library)\.json$/;
const SERVER_INFO = { name: 'bookreader', title: 'BookReader', version: '1.0.0' };
const INSTRUCTIONS = [
  'Lee la biblioteca de BookReader del usuario: libros, subrayados, notas de libreta, estadísticas',
  'de lectura, mazos de estudio y lo creado con el agente de la app. Lo que puede cambiar',
  '(mazos, estanterías, subir libros) depende de los permisos del token: lo dicen las tools.',
  'Empieza por `list_books` para conocer los bookIds; `get_highlights` y `get_notes` aceptan',
  'también `book` con parte del título. Para preguntar a toda la biblioteca («¿qué tenemos sobre',
  'X?»), `search_library` (si el token puede leer el texto de los libros).',
].join(' ');

const json = (obj, status, headers = {}) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
});

// ---- La clave, cifrada con el token ----------------------------------------------------------

// ---- Cambios de agentes que se pueden deshacer ----------------------------------------------

export const undoPath = (changeId) => 'bookreader/undo/' + changeId;

async function recordChange(env, k, { user, agent, target, summary, undo }, now = Date.now()) {
  const id = randomId();
  const pid = await C.pathId(k, undoPath(id));
  const bytes = new Uint8Array(await (await C.encrypt(k, pid, JSON.stringify(undo))).arrayBuffer());
  if (bytes.length > UNDO_MAX_BYTES) return null;   // un cambio enorme se queda sin deshacer (lo dice el resultado)
  await env.DB.prepare(
    `INSERT INTO mcp_changes (id, user, token_id, agent, target, summary, undo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, user, agent.tokenId || null, agent.name || 'MCP', target, JSON.stringify(summary), C.b64url(bytes), now).run();
  return id;
}

// GET /v1/mcp-changes: los últimos cambios de agentes (para la lista con «Deshacer»).
export async function listChangesRoute(env, cors, who, now = Date.now()) {
  const { results = [] } = await env.DB.prepare(
    `SELECT id, agent, target, summary, created_at, undone_at FROM mcp_changes WHERE user = ? AND created_at > ? ORDER BY created_at DESC LIMIT 20`,
  ).bind(who.user, now - CHANGES_KEPT_DAYS * DAY).all();
  return json({
    changes: results.map((r) => ({ id: r.id, agent: r.agent, target: r.target, summary: JSON.parse(r.summary), createdAt: r.created_at, undoneAt: r.undone_at })),
  }, 200, cors);
}

// GET /v1/mcp-changes/<id>/undo: el `undo` cifrado (lo descifra y lo aplica la app).
export async function getUndoRoute(id, env, cors, who) {
  const r = await env.DB.prepare('SELECT undo, undone_at FROM mcp_changes WHERE id = ? AND user = ?').bind(id, who.user).first();
  if (!r) return json({ error: 'not_found' }, 404, cors);
  return json({ undo: r.undo, undoneAt: r.undone_at }, 200, cors);
}

// POST /v1/mcp-changes/<id>/undone: la app ya lo deshizo.
export async function markUndoneRoute(id, env, cors, who, now = Date.now()) {
  await env.DB.prepare('UPDATE mcp_changes SET undone_at = ? WHERE id = ? AND user = ? AND undone_at IS NULL').bind(now, id, who.user).run();
  return json({ ok: true }, 200, cors);
}

export async function purgeChanges(env, now = Date.now()) {
  const r = await env.DB.prepare('DELETE FROM mcp_changes WHERE created_at < ? RETURNING id').bind(now - CHANGES_KEPT_DAYS * DAY).all();
  return (r.results || []).length;
}

async function wrapKeyOf(secret) {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('bookreader-mcp-wrap-v1') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

// El secreto de un token o de un código OAuth: los bytes aleatorios tras el prefijo.
export const secretOf = (token) => C.fromB64url(token.slice(token.indexOf('-', 3) + 1));

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
export function normScopes(list) {
  const set = new Set(['read']);
  for (const s of Array.isArray(list) ? list : []) if (SCOPES.includes(s)) set.add(s);
  return SCOPES.filter((s) => set.has(s));
}

export async function storeToken(env, { user, name, kind = 'pat', raw, license, days = DEFAULT_DAYS, scopes = ['read'] }, now = Date.now()) {
  const token = newToken();
  const id = randomId();
  const expiresAt = now + days * DAY;
  const sc = normScopes(scopes);
  await env.DB.prepare(
    `INSERT INTO mcp_tokens (id, user, hash, name, kind, wrapped, created_at, expires_at, checked_at, scopes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, user, await sha256Hex(token), name, kind, await wrap(token, { k: C.b64url(raw), l: license }), now, expiresAt, now, sc.join(',')).run();
  return { id, token, name, kind, scopes: sc, createdAt: now, expiresAt };
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
  return json(await storeToken(env, { user: who.user, name, raw, license, days, scopes: body?.scopes }, now), 200, cors);
}

// La clave tiene que abrir este sync: con otra, el agente vería una biblioteca vacía y nadie
// sabría por qué. Basta con que la ruta del manifest exista (su id es un HMAC con la clave).
export async function keyOpens(env, user, raw) {
  const pid = await C.pathId(await C.importKeys(raw), 'bookreader/manifest.json');
  const any = await env.DB.prepare('SELECT 1 AS x FROM objects WHERE user = ? LIMIT 1').bind(user).first();
  if (!any) return true;   // sync vacío: no hay con qué comprobarla
  return !!(await env.DB.prepare('SELECT 1 AS x FROM objects WHERE user = ? AND path = ?').bind(user, pid).first());
}

export async function listTokensRoute(env, cors, who, now = Date.now()) {
  const { results = [] } = await env.DB.prepare(
    `SELECT id, name, kind, scopes, created_at, expires_at, last_used_at FROM mcp_tokens WHERE user = ? AND expires_at > ? ORDER BY created_at DESC`,
  ).bind(who.user, now).all();
  return json({
    tokens: results.map((r) => ({
      id: r.id, name: r.name, kind: r.kind, scopes: String(r.scopes || 'read').split(','),
      createdAt: r.created_at, expiresAt: r.expires_at, lastUsedAt: r.last_used_at,
    })),
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
  const row = await env.DB.prepare('SELECT id, user, name, scopes, wrapped, expires_at, last_used_at, checked_at FROM mcp_tokens WHERE hash = ?')
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
  return {
    tokenId: row.id, user: row.user, raw: C.fromB64url(props.k), license: props.l, name: row.name,
    scopes: new Set(String(row.scopes || 'read').split(',')),
    // Suscripción caducada (en el plazo de gracia): se lee, no se escribe. Como el sync.
    readOnly: !!u.lapsed_at,
  };
}

// El proveedor del layout para la fuente de mcp/: lee de R2 y descifra aquí. Con `canWrite`,
// también escribe (`update`): como un dispositivo más, leer con su etag, cambiar, cifrar y
// guardar solo si nadie escribió entre medias (CAS en D1); si alguien lo hizo, se relee y se
// vuelve a aplicar el cambio. Los dispositivos lo bajan en su próximo ciclo y lo funden.
// `mutate` puede devolver también `undo` (los valores anteriores de lo que cambió) y `summary`
// (contadores): entonces el cambio queda en mcp_changes, con el `undo` cifrado con la clave del
// usuario, y la app lo puede deshacer (Ajustes → Datos → Agentes).
// `trace`, si llega, apunta qué se leyó y cuánto pesaba (lo registra mcpRoute).
export function r2Provider(env, user, raw, { canWrite = false, agent = null, trace = null } = {}) {
  let keysP = null;
  const keys = () => (keysP ||= C.importKeys(raw));
  // Solo la carpeta: los ids de libros y mazos no salen a los logs.
  const note = (path, bytes) => trace && trace.push({ path: path.split('/').slice(0, 2).join('/'), bytes });

  async function readRaw(path) {
    const k = await keys();
    const pid = await C.pathId(k, path);
    const row = await env.DB.prepare('SELECT key, etag, name FROM objects WHERE user = ? AND path = ?').bind(user, pid).first();
    if (!row) return { k, pid, row: null, value: null };
    if (!(await spend(env, 'b'))) {
      await refused(env);
      throw Object.assign(new Error('capacity'), { capacity: true });
    }
    const obj = await env.SYNC.get(row.key);
    if (!obj) return { k, pid, row: null, value: null };
    note(path, obj.size);
    return { k, pid, row, value: JSON.parse(await C.decryptText(k, pid, await new Response(obj.body).blob())) };
  }

  const update = async (path, mutate, { dryRun = false } = {}) => {
    if (env.WRITES && !dryRun) {
      const { success } = await env.WRITES.limit({ key: user });
      if (!success) throw new SourceError('Demasiadas escrituras seguidas: espera un minuto y repite.');
    }
    for (let attempt = 0; attempt <= WRITE_RETRIES; attempt++) {
      const { k, pid, row, value } = await readRaw(path);
      const { next, result, undo, summary } = await mutate(value);
      if (dryRun || !next) return result;
      const body = new Uint8Array(await (await C.encrypt(k, pid, JSON.stringify(next))).arrayBuffer());
      const w = await writeBytes(env, {
        user, path: pid, name: row ? row.name : await C.encryptName(k, path), body, size: body.length, kind: 'data',
        ifMatch: row ? row.etag : null, mustCreate: !row, keepVersions: VERSIONED.test(path),
      });
      if (!w.error) {
        if (undo && agent) {
          const changeId = await recordChange(env, k, { user, agent, target: 'library', summary: summary || {}, undo });
          return { ...result, changeId };
        }
        return result;
      }
      if (w.error === 'quota') throw new SourceError('El sync de BookReader está lleno: no cabe el cambio.');
      if (w.error !== 'precondition_failed') throw Object.assign(new Error('capacity'), { capacity: true });
    }
    throw new SourceError('Otro dispositivo está escribiendo en este libro ahora mismo: repite en unos segundos.');
  };

  return {
    ...(canWrite ? { update } : {}),
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
      note(path, obj.size);
      return { content: await C.decryptText(k, pid, await new Response(obj.body).blob()) };
    },
    // Bloques sueltos de un fichero sellado por bloques (el almacén de pasajes, IA10): una
    // lectura por rango de R2 por bloque, y solo se descifran esos. `specs`: [{ i, count,
    // offset, length }] (el mapa va en el manifiesto del índice).
    async readBlocks(path, specs) {
      const k = await keys();
      const pid = await C.pathId(k, path);
      const row = await env.DB.prepare('SELECT key FROM objects WHERE user = ? AND path = ?').bind(user, pid).first();
      if (!row) return null;
      // Una reserva para todo el lote: una escritura en D1, no una por bloque.
      if (!(await spend(env, 'b', Date.now(), specs.length))) {
        await refused(env);
        throw Object.assign(new Error('capacity'), { capacity: true });
      }
      const dec = new TextDecoder();
      note(path, specs.reduce((n, s) => n + s.length, 0));
      return Promise.all(specs.map(async ({ i, count, offset, length }) => {
        const obj = await env.SYNC.get(row.key, { range: { offset, length } });
        if (!obj) throw new SourceError('Falta el almacén de pasajes: reconstruye el índice desde la app.');
        return dec.decode(await C.openBlock(k, pid, new Uint8Array(await new Response(obj.body).arrayBuffer()), i, count));
      }));
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
      if (source.overLimit && await source.overLimit()) {
        return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: TOO_MANY_CALLS }], isError: true } };
      }
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
  // Una fuente por petición: la caché del layout vive lo que vive la petición. Lo que el token
  // permite decide qué tools se anuncian (toolsFor mira estas marcas).
  const canWrite = who.scopes.has('write') && !who.readOnly;
  const canOrganize = who.scopes.has('library') && !who.readOnly;
  const canUpload = who.scopes.has('upload') && !who.readOnly;
  const reads = [];
  const provider = r2Provider(env, who.user, who.raw, { canWrite: canWrite || canOrganize || canUpload, agent: { tokenId: who.tokenId, name: who.name }, trace: reads });
  const source = createDriveSource({ provider, kind: 'bookreader', cacheMs: 60000 });
  Object.assign(source, { canWrite, canOrganize, canUpload, canReadText: who.scopes.has('text'), agentName: who.name });
  if (canUpload) source.uploads = uploadsFor(env, who, source, new URL(request.url).origin);
  let limited = 0;
  if (env.MCP_CALLS) {
    source.overLimit = async () => {
      const { success } = await env.MCP_CALLS.limit({ key: who.tokenId });
      if (!success) limited++;
      return !success;
    };
  }
  const batch = Array.isArray(body);
  // Qué pidió el agente, para Workers Logs, que pone al lado la CPU de la petición. Una línea
  // antes de trabajar (si Cloudflare la corta, es la que queda) y otra al acabar con lo leído.
  // Ni argumentos ni contenido: solo nombres de tools y tamaños.
  const tools = (batch ? body : [body]).filter((m) => m?.method === 'tools/call').map((m) => String(m.params?.name || '?'));
  if (tools.length) console.log(JSON.stringify({ mcp: 'call', token: who.tokenId, tools }));
  try {
    const out = (await Promise.all((batch ? body : [body]).map((m) => handleMessage(m, source)))).filter(Boolean);
    if (!out.length) return new Response(null, { status: 202 });
    return json(batch ? out : out[0], 200);
  } catch (e) {
    if (e.capacity) return json({ error: 'capacity' }, 503);
    throw e;
  } finally {
    if (tools.length) {
      console.log(JSON.stringify({ mcp: 'done', token: who.tokenId, tools, limited, reads, bytes: reads.reduce((n, r) => n + (r.bytes || 0), 0) }));
    }
  }
}
