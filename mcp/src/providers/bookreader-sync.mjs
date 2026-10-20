// providers/bookreader-sync.mjs — el sync de BookReader (MON4) como proveedor del layout: lo
// mismo que lee la fuente de Drive, pero desde el Worker `bookreader-sync` y descifrado aquí.
//
// El servidor no ve nada en claro (ADR-056): ni contenidos ni rutas. Para leer, el MCP hace lo
// mismo que un dispositivo emparejado:
//   1. Con la LICENCIA pide un token al Worker (POST /v1/sync-token, sin cabecera Origin: no es
//      un navegador).
//   2. Con la CLAVE del sync calcula el id de cada ruta (HMAC) y descifra lo que baja.
// Las dos cosas viajan juntas en el enlace de emparejamiento de la app (Ajustes → Datos →
// «Enlace para otro dispositivo»): `…#pair=<clave>.<licencia>`. Ese enlace es la credencial
// entera y se guarda en un fichero de modo 600, como el refresh token de Drive.
//
// El cifrado NO se replica: se importa el módulo de la app (app/js/sync/sync-crypto.js), que
// solo usa WebCrypto y no depende del navegador. Así el MCP no puede divergir del formato.
//
// Solo lectura a propósito, como el proveedor de Drive.

import { stat as fsStat } from 'node:fs/promises';
import { SourceError } from '../errors.mjs';
import * as C from '../../../app/js/sync/sync-crypto.js';

export const WORKER_URL = 'https://bookreader-sync.luisgonzalezb93.workers.dev';
const TIMEOUT_MS = 30000;

/**
 * Saca clave y licencia del enlace de emparejamiento. Acepta el enlace entero o solo lo que va
 * tras `pair=`.
 * @returns {{ raw: Uint8Array, license: string }}
 */
export function parsePairLink(text) {
  const s = String(text || '').trim();
  const m = s.match(/(?:^|[#&?]pair=)([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]+)\s*$/);
  if (!m) {
    throw new SourceError(
      'El enlace de emparejamiento no es válido. Cópialo de nuevo en la app: Ajustes → Datos → ' +
        '«Enlace para otro dispositivo».',
    );
  }
  const raw = C.fromB64url(m[1]);
  const license = new TextDecoder().decode(C.fromB64url(m[2])).trim();
  if (raw.length !== 32 || !license) throw new SourceError('El enlace de emparejamiento está incompleto.');
  return { raw, license };
}

/** Lee el enlace de un fichero y se niega si otros usuarios de la máquina pueden leerlo. */
export async function readPairFile(path, readFile, stat = fsStat) {
  let info;
  try {
    info = await stat(path);
  } catch (e) {
    throw new SourceError('No se puede leer el fichero del enlace (' + path + '): ' + e.message);
  }
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new SourceError(
      'El fichero del enlace (' + path + ') lo pueden leer otros usuarios. Lleva la clave de tu ' +
        'sync: déjalo en modo 600 (chmod 600 ' + path + ').',
    );
  }
  return parsePairLink(await readFile(path, 'utf8'));
}

/**
 * @param {{ raw: Uint8Array, license: string, fetchImpl?: typeof fetch, workerUrl?: string,
 *           now?: () => number }} opts
 */
export function createBookReaderSyncProvider({ raw, license, fetchImpl = fetch, workerUrl = WORKER_URL, now = Date.now }) {
  let keysP = null;
  let token = null;   // { token, expiresAt }

  const keys = () => (keysP ||= C.importKeys(raw));

  async function getToken(force = false) {
    if (!force && token && token.expiresAt - 60000 > now()) return token.token;
    const res = await fetchImpl(workerUrl + '/v1/sync-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const why = {
        not_configured: 'el sync de BookReader no acepta esta licencia todavía',
        lapsed: 'la suscripción ha caducado y el plazo de solo lectura ha terminado',
        not_subscribed: 'esta licencia no incluye el sync de BookReader',
        invalid: 'la licencia no es válida',
      }[data.error] || 'error ' + res.status + (data.error ? ' (' + data.error + ')' : '');
      throw new SourceError('Sync de BookReader: ' + why + '.');
    }
    token = { token: data.token, expiresAt: data.expiresAt };
    return token.token;
  }

  async function request(path, retry = true, bearer = null) {
    const res = await fetchImpl(workerUrl + path, {
      headers: { Authorization: 'Bearer ' + (bearer || (await getToken())) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Token caducado o revocado en vuelo: uno nuevo y UN reintento (como la app).
    if (res.status === 401 && retry) return request(path, false, await getToken(true));
    return res;
  }

  return {
    async read(path) {
      const k = await keys();
      const pid = await C.pathId(k, path);
      const res = await request('/v1/o/' + pid);
      if (res.status === 404) return null;
      if (!res.ok) throw new SourceError('Sync de BookReader ' + res.status + ' al leer ' + path + '.');
      try {
        return { content: await C.decryptText(k, pid, await res.blob()), etag: res.headers.get('ETag') || '' };
      } catch {
        // Lo que no descifra con esta clave es de otra clave: se empezó de cero en otro
        // dispositivo y este enlace es viejo.
        throw new SourceError(
          'No se puede descifrar ' + path + ' con la clave del enlace. Si empezaste de cero en ' +
            'la app, copia el enlace de emparejamiento nuevo.',
        );
      }
    },
    // Bloques sueltos de un fichero sellado por bloques (el almacén de pasajes, IA10). En local
    // no hay prisa de CPU: se baja entero y se abren solo los pedidos.
    async readBlocks(path, specs) {
      const k = await keys();
      const pid = await C.pathId(k, path);
      const res = await request('/v1/o/' + pid);
      if (res.status === 404) return null;
      if (!res.ok) throw new SourceError('Sync de BookReader ' + res.status + ' al leer ' + path + '.');
      const body = new Uint8Array(await res.arrayBuffer());
      const dec = new TextDecoder();
      return Promise.all(specs.map(async ({ i, count, offset, length }) =>
        dec.decode(await C.openBlock(k, pid, body.subarray(offset, offset + length), i, count))));
    },
  };
}
