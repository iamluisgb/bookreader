// Publicar el perfil público desde la app (MON7, ADR-064).
//
// La app arma la foto de lo que se elige enseñar (`snapshot()` en app/js/library/publish.js) y la
// manda aquí con su token de sync. El perfil se guarda en R2 y lo sirve este Worker al momento
// (profiles.js): sin build, sin commit y sin GitHub. Nada de esto toca el sync cifrado.
//
// Rutas (token de sync):
//   POST   /v1/profile/publish   publica (o vuelve a publicar)
//   GET    /v1/profile/publish   estado: { state: 'done' | 'none', handle, url, at }
//   DELETE /v1/profile/publish   retira el perfil

import { publishHosted, unpublishHosted, profileOf } from './profiles.js';

export const MAX_SNAPSHOT_BYTES = 12 * 1024 * 1024;   // ~40 portadas de 640 px en webp, con aire
export const PUBLIC_ORIGIN = 'https://bookreader.raiatech.com';

async function readSnapshot(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_SNAPSHOT_BYTES) return { error: 'too_large', status: 413 };
  const text = await request.text();
  if (text.length > MAX_SNAPSHOT_BYTES) return { error: 'too_large', status: 413 };
  try {
    const snap = JSON.parse(text);
    if (!snap || snap.format !== 'bookreader-perfil' || snap.version !== 2) return { error: 'bad_snapshot', status: 400 };
    return { snap };
  } catch { return { error: 'bad_json', status: 400 }; }
}

export async function publishRoute(request, env, cors, who, json, now = Date.now()) {
  if (request.method === 'GET') {
    const p = await profileOf(env, who.user);
    return json(p ? { state: 'done', hosted: true, handle: p.handle, at: p.updated_at, books: p.books, url: `${PUBLIC_ORIGIN}/@${p.handle}/` }
      : { state: 'none', hosted: true }, 200, cors);
  }
  if (who.readOnly) return json({ error: 'read_only' }, 403, cors);
  if (request.method === 'DELETE') {
    await unpublishHosted(env, who.user);
    return json({ state: 'none', hosted: true }, 200, cors);
  }
  const limiter = env.PUBLISH || env.WRITES;
  if (limiter) {
    const { success } = await limiter.limit({ key: 'publish:' + who.user });
    if (!success) return json({ error: 'rate_limited' }, 429, cors);
  }
  const r = await readSnapshot(request);
  if (r.error) return json({ error: r.error }, r.status, cors);
  const [status, body] = await publishHosted(env, who, r.snap, { origin: PUBLIC_ORIGIN, now });
  return json(body, status, cors);
}
