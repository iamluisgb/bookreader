// providers/google-drive.mjs — el proveedor de verdad: el `appDataFolder` del Drive del
// usuario, con las mismas llamadas REST que usa la app (app/js/sync/drive-provider.js), pero
// en Node y de solo lectura.
//
// Por qué se replica en vez de importar el módulo de la app: ese módulo es un módulo de
// navegador (tira de `localStorage` y del wrapper de fetch con CORS del navegador) y aquí no
// hay DOM. La parte que importa de verdad —el flujo de tokens y la forma del layout— sí se
// comparte: los tokens vienen de auth/google.mjs, que habla con el mismo Worker.
//
// Solo lectura a propósito: F3 (escritura) está fuera del alcance de P28.

import { SourceError } from '../errors.mjs';

const API = 'https://www.googleapis.com/drive/v3';
const FIELDS = 'id,name,version,modifiedTime,size';
const TIMEOUT_MS = 30000;

async function driveError(res) {
  let reason = '';
  let message = '';
  try {
    const body = await res.json();
    const e = (body.error && body.error.errors && body.error.errors[0]) || {};
    reason = e.reason || '';
    message = (body.error && body.error.message) || '';
  } catch {
    /* respuesta sin cuerpo JSON */
  }
  return new SourceError(
    'Drive ' + res.status + (reason ? ' (' + reason + ')' : '') + (message ? ': ' + message : ''),
  );
}

/**
 * @param {{ getAccessToken: (force?: boolean) => Promise<string>, fetchImpl?: typeof fetch,
 *           spaces?: string }} opts
 */
export function createGoogleDriveProvider({ getAccessToken, fetchImpl = fetch, spaces = 'appDataFolder' }) {
  async function request(url, retry = true, token = null) {
    const bearer = token || (await getAccessToken());
    const res = await fetchImpl(url, {
      headers: { Authorization: 'Bearer ' + bearer },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 && retry) {
      // Caducó en vuelo: renovar UNA vez y reintentar con el token nuevo (mismo criterio que
      // la app). El token viaja al reintento para no volver a pedirlo: una renovación, no dos.
      return request(url, false, await getAccessToken(true));
    }
    if (!res.ok) throw await driveError(res);
    return res;
  }

  async function findByName(name) {
    const url =
      API +
      '/files?' +
      new URLSearchParams({
        spaces,
        q: "name='" + name.replace(/'/g, "\\'") + "'",
        fields: 'files(' + FIELDS + ')',
        pageSize: '1',
      });
    const data = await (await request(url)).json();
    return (data.files || [])[0] || null;
  }

  return {
    /**
     * Ficheros del appDataFolder con ese prefijo. La fuente del MCP lee por NOMBRE (`read`),
     * así que esto no está en su camino caliente; se implementa entero —con `nextPageToken`—
     * para que la interfaz del proveedor sea la misma que la de la app y no una versión a
     * medias que sorprenda a quien la use.
     */
    async list(prefix = '') {
      const files = [];
      let pageToken = '';
      do {
        const url =
          API +
          '/files?' +
          new URLSearchParams({
            spaces,
            fields: 'nextPageToken,files(' + FIELDS + ')',
            pageSize: '1000',
            ...(pageToken ? { pageToken } : {}),
          });
        const data = await (await request(url)).json();
        files.push(...(data.files || []));
        pageToken = data.nextPageToken || '';
      } while (pageToken);
      return files
        .filter((f) => f.name.startsWith(prefix))
        .map((f) => ({
          path: f.name,
          etag: String(f.version || ''),
          modifiedTime: f.modifiedTime || null,
          size: Number(f.size || 0),
        }));
    },
    async read(path) {
      const file = await findByName(path);
      if (!file) return null;
      const res = await request(API + '/files/' + file.id + '?alt=media');
      return {
        content: await res.text(),
        etag: String(file.version || ''),
        modifiedTime: file.modifiedTime || null,
      };
    },
  };
}
