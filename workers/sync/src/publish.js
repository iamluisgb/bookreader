// Publicar el perfil público desde la app (paso 1b del experimento `/@handle/`; ver CHANGELOG).
//
// La app manda la MISMA foto que antes se descargaba («Descargar para publicar») y aquí se guarda
// en R2; luego se avisa a GitHub, cuya Action (.github/workflows/publicar-perfil.yml) la baja,
// corre `scripts/publicar-perfil.mjs`, commitea y despliega Pages. La Action devuelve el resultado
// y la app lo enseña. Nada de esto toca el sync cifrado: la foto es lo que el usuario eligió hacer
// público, explícito y aparte (publish.js de la app).
//
// Solo para quien está en PUBLISH_PROFILES (secret, JSON `{"<user>": "<handle>"}`): hoy, Luis.
// Abrirlo a otros (handles, R2 servido, moderación, ADR) es el paso 2 del BACKLOG.
//
// Rutas:
//   POST /v1/profile/publish            (token de sync)  guarda la foto y lanza la Action
//   GET  /v1/profile/publish            (token de sync)  estado de la última publicación
//   GET  /v1/profile/snapshot/<handle>  (PUBLISH_PULL_TOKEN)  la Action baja la foto
//   POST /v1/profile/status/<handle>    (PUBLISH_PULL_TOKEN)  la Action informa: done | failed

export const MAX_SNAPSHOT_BYTES = 12 * 1024 * 1024;   // ~40 portadas de 640 px en webp, con aire
const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const snapKey = (h) => `publish/${h}.json`;
const statusKey = (h) => `publish/${h}.status.json`;

export function handleFor(env, user) {
  let map = {};
  try { map = JSON.parse(env.PUBLISH_PROFILES || '{}'); } catch { /* mal configurado: nadie publica */ }
  const h = map[user];
  return typeof h === 'string' && HANDLE_RE.test(h) ? h : null;
}

async function readStatus(env, handle) {
  const o = await env.SYNC.get(statusKey(handle));
  return o ? await new Response(o.body).json() : { state: 'none' };
}
async function writeStatus(env, handle, st) {
  await env.SYNC.put(statusKey(handle), JSON.stringify(st), { httpMetadata: { contentType: 'application/json' } });
}

// La foto que hace la app (`snapshot()` en app/js/library/publish.js, formato 2). Se comprueba la
// forma, no el contenido: el script la vuelve a validar al publicar.
export function validSnapshot(s, handle) {
  return !!s && s.format === 'bookreader-perfil' && s.version === 2 && s.handle === handle
    && Array.isArray(s.shelves) && s.shelves.length > 0 && Array.isArray(s.books);
}

async function dispatch(env, handle, id, fetchImpl) {
  if (!env.GITHUB_DISPATCH_TOKEN || !env.PUBLISH_REPO) return false;
  const res = await fetchImpl(`https://api.github.com/repos/${env.PUBLISH_REPO}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'bookreader-sync',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ event_type: 'publicar-perfil', client_payload: { handle, id } }),
  });
  return res.status === 204;
}

export async function publishRoute(request, env, cors, who, json, fetchImpl = fetch, now = Date.now()) {
  const handle = handleFor(env, who.user);
  if (!handle) return json({ error: 'not_allowed' }, 403, cors);
  if (request.method === 'GET') return json(await readStatus(env, handle), 200, cors);

  if (env.WRITES) {
    const { success } = await env.WRITES.limit({ key: 'publish:' + who.user });
    if (!success) return json({ error: 'rate_limited' }, 429, cors);
  }
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_SNAPSHOT_BYTES) return json({ error: 'too_large' }, 413, cors);
  const text = await request.text();
  if (text.length > MAX_SNAPSHOT_BYTES) return json({ error: 'too_large' }, 413, cors);
  let snap;
  try { snap = JSON.parse(text); } catch { return json({ error: 'bad_json' }, 400, cors); }
  if (!validSnapshot(snap, handle)) return json({ error: 'bad_snapshot' }, 400, cors);

  const id = crypto.randomUUID();
  await env.SYNC.put(snapKey(handle), text, { httpMetadata: { contentType: 'application/json' } });
  const ok = await dispatch(env, handle, id, fetchImpl).catch(() => false);
  const st = ok ? { state: 'queued', id, at: now } : { state: 'failed', id, at: now, reason: 'dispatch' };
  await writeStatus(env, handle, st);
  return json(st, ok ? 202 : 502, cors);
}

function pullAuthorized(request, env) {
  const auth = request.headers.get('Authorization') || '';
  return !!env.PUBLISH_PULL_TOKEN && auth === `Bearer ${env.PUBLISH_PULL_TOKEN}`;
}

// Las dos rutas de la Action. Devuelve null si la ruta no es suya.
export async function actionRoute(pathname, request, env, json, now = Date.now()) {
  const m = pathname.match(/^\/v1\/profile\/(snapshot|status)\/([^/]+)$/);
  if (!m) return null;
  const [, what, handle] = m;
  if (!pullAuthorized(request, env)) return json({ error: 'forbidden' }, 403);
  if (!HANDLE_RE.test(handle)) return json({ error: 'not_found' }, 404);
  if (what === 'snapshot' && request.method === 'GET') {
    const o = await env.SYNC.get(snapKey(handle));
    if (!o) return json({ error: 'not_found' }, 404);
    return new Response(o.body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (what === 'status' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    if (!['running', 'done', 'failed'].includes(body.state)) return json({ error: 'bad_state' }, 400);
    const cur = await readStatus(env, handle);
    // Solo se informa de la publicación en curso: una Action vieja no pisa el estado de la nueva.
    if (body.id && cur.id && body.id !== cur.id) return json({ ok: false, stale: true }, 409);
    const st = { ...cur, state: body.state, at: now,
      ...(body.sha ? { sha: String(body.sha).slice(0, 40) } : {}),
      ...(body.run ? { run: String(body.run).slice(0, 200) } : {}) };
    await writeStatus(env, handle, st);
    return json({ ok: true }, 200);
  }
  return json({ error: 'not_found' }, 404);
}
