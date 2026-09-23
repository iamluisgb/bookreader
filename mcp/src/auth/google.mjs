// auth/google.mjs — el OAuth de la app, traído a Node.
//
// La app no habla con Google directamente para el refresh: manda el `refresh_token` a su
// Worker de Cloudflare (workers/auth), que es quien custodia el `client_secret`, y recibe un
// `access_token`. Aquí se hace exactamente lo mismo, contra el MISMO Worker
// (app/js/sync/drive-auth.js · WORKER_URL), para no inventar una segunda vía de confianza ni
// tocar el cliente OAuth.
//
// Lo que NO hay, y hay que decirlo en el README en vez de disimularlo: el flujo interactivo
// (`authorization-code` + PKCE en un navegador) necesita un `redirect_uri` registrado en el
// cliente OAuth de Google. El de la app es `auth/callback.html` de su propio origen, así que
// un redirect a `http://localhost:<puerto>` daría `redirect_uri_mismatch`. Por eso aquí se
// parte del refresh token que la app YA tiene (`bookreader_drive_refresh_token` en
// localStorage) en vez de fingir un `--connect` que no puede funcionar.

import { readFile as fsReadFile } from 'node:fs/promises';
import { SourceError } from '../errors.mjs';

export const AUTH_WORKER_URL = 'https://bookreader-auth.luisgonzalezb93.workers.dev';
const TIMEOUT_MS = 30000;

/** Lee el fichero del refresh token. Se recorta el salto de línea final (echo > fichero). */
export async function readRefreshTokenFile(path, readFile = fsReadFile) {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch (e) {
    throw new SourceError('No puedo leer el fichero del refresh token «' + path + '»: ' + e.message);
  }
}

/**
 * Access tokens de Google: uno fijo si lo dieron (prueba de una hora), o renovados en
 * silencio contra el Worker mientras haya refresh token.
 *
 * @param {{ refreshToken?: string|null, accessToken?: string|null,
 *           fetchImpl?: typeof fetch, worker?: string, now?: () => number }} opts
 */
export function createGoogleAuth({
  refreshToken = null,
  accessToken = null,
  fetchImpl = fetch,
  worker = AUTH_WORKER_URL,
  now = Date.now,
} = {}) {
  let token = accessToken || null;
  // Un access token dado a mano no trae `expires_in`: se usa sin caducidad conocida y el
  // proveedor reintenta una vez con 401 (renovación real solo con refresh token).
  let expiry = accessToken ? Infinity : 0;

  return {
    async getAccessToken(force = false) {
      if (!force && token && now() < expiry) return token;
      if (!refreshToken) {
        if (token) return token;
        throw new SourceError(
          'Sin credenciales de Drive: pasa --refresh-token-file, --access-token o BOOKREADER_DRIVE_REFRESH_TOKEN.',
        );
      }
      const res = await fetchImpl(worker + '/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.error === 'invalid_grant') {
          throw new SourceError(
            'Google rechazó el refresh token (revocado o caducado): vuelve a conectar el sync en la app y copia el token nuevo.',
          );
        }
        throw new SourceError('No pude renovar el acceso a Drive: ' + (data.error || res.status));
      }
      token = data.access_token;
      expiry = now() + ((data.expires_in || 3600) - 60) * 1000;
      return token;
    },
  };
}
