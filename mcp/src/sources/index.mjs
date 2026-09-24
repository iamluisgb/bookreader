// sources/index.mjs — qué fuente tiene detrás el MCP, decidido una vez al arrancar.
//
// La interfaz que cumplen las dos (y que la tool consume sin saber más):
//
//   kind             'backup-file' | 'drive'
//   hasReadingStats  si la fuente lleva el registro de lectura (F1 no; F2 sí)
//   describe()       identificación corta para resultados y mensajes de error
//   ping()           validación barata de arranque (falla antes de aceptar ninguna tool)
//   listBooks()      resumen por libro (contadores, título, última actividad)
//   getHighlights(bookId) / getNotes(bookId)   ya normalizados y sin tombstones
//   readingDays()    registros de lectura del layout, sin `key` ni `deviceId` ([] en F1)
//
// Ninguna de las dos escribe: P28 · F3 queda fuera.

import { readFile as fsReadFile } from 'node:fs/promises';
import { ConfigError } from '../config.mjs';
import { createBackupFileSource } from './backup-file.mjs';
import { createDriveSource } from './drive.mjs';
import { createFsProvider } from '../providers/fs.mjs';
import { createGoogleDriveProvider } from '../providers/google-drive.mjs';
import { createGoogleAuth, readRefreshTokenFile } from '../auth/google.mjs';

/**
 * Construye la fuente de la configuración. `deps` es inyectable para los tests (fetch falso,
 * lectura de fichero falsa): el camino real no necesita más que lo que hay en Node.
 */
export async function createSource(config, deps = {}) {
  const { fetchImpl = fetch, readFile = fsReadFile } = deps;

  if (config.source === 'backup-file') {
    return createBackupFileSource({ path: config.backupPath, readFile });
  }

  if (config.source === 'drive') {
    if (config.layoutDir) {
      const provider = createFsProvider({ root: config.layoutDir, readFile });
      return createDriveSource({ provider, base: config.base, cacheMs: config.cacheMs });
    }
    let refreshToken = config.refreshToken;
    if (!refreshToken && config.refreshTokenFile) {
      refreshToken = await readRefreshTokenFile(config.refreshTokenFile, readFile);
    }
    if (!refreshToken && !config.accessToken) {
      throw new ConfigError('La fuente drive necesita credenciales (ver --help).');
    }
    const auth = createGoogleAuth({
      refreshToken,
      accessToken: config.accessToken,
      fetchImpl,
    });
    const provider = createGoogleDriveProvider({ getAccessToken: (f) => auth.getAccessToken(f), fetchImpl });
    return createDriveSource({ provider, base: config.base, cacheMs: config.cacheMs });
  }

  throw new ConfigError('Fuente no soportada: ' + config.source);
}
