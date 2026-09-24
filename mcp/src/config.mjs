// config.mjs — de dónde lee el MCP, decidido por argumentos (y variables de entorno como
// atajo). Sin dependencias: parseado a mano y con errores que dicen qué falta.
//
//   --backup <fichero.json>   fuente F1: el backup que produce backup.js · buildBackup()
//   --source backup-file|drive
//   --dir <carpeta>           fuente F2 con proveedor local: una carpeta con el layout de
//                             sync (bookreader/manifest.json, settings.json, books/<id>.json)
//   --base <prefijo>          prefijo del layout en el proveedor (por defecto `bookreader/`)
//   --cache-ms <n>            TTL de la caché del proveedor Drive (por defecto 15000)
//   --access-token <token>    access token de Google para una prueba puntual (caduca en 1 h)
//   --refresh-token-file <p>  fichero con el refresh token de la app (modo 600)
//   --help / --version
//
// El refresh token también entra por BOOKREADER_DRIVE_REFRESH_TOKEN, y el backup por
// BOOKREADER_MCP_BACKUP — así el registro en Claude Desktop no lleva la ruta en el JSON.

export const VERSION = '1.0.0';
export const DEFAULT_BASE = 'bookreader/';
export const DEFAULT_CACHE_MS = 15000;
export const SOURCES = ['backup-file', 'drive'];

export class ConfigError extends Error {}

// Opciones que consumen el argumento siguiente.
const TAKES_VALUE = new Set([
  '--backup',
  '--source',
  '--dir',
  '--base',
  '--cache-ms',
  '--access-token',
  '--refresh-token-file',
]);

export function usage() {
  return [
    'bookreader-mcp — lee tu biblioteca de BookReader desde un agente externo (MCP, stdio).',
    '',
    'Uso:',
    '  node mcp/server.mjs --backup <backup.json>        (F1: instantánea del backup)',
    '  node mcp/server.mjs --dir <carpeta-del-layout>    (F2: layout de sync en disco)',
    '  node mcp/server.mjs --source drive                (F2: Drive real, requiere token)',
    '',
    'Opciones:',
    '  --backup <fichero>         JSON de backup producido por la app (Ajustes > Exportar).',
    '  --dir <carpeta>            Carpeta que contiene bookreader/manifest.json y compañía.',
    '  --source backup-file|drive Fuerza la fuente (si no, se deduce de --backup o --dir).',
    '  --base <prefijo>           Prefijo del layout en el proveedor (por defecto bookreader/).',
    '  --cache-ms <n>             TTL de la caché de Drive en ms (0 la desactiva; 15000 por defecto).',
    '  --access-token <token>     Access token de Google para una prueba de una hora.',
    '  --refresh-token-file <p>   Fichero con el refresh token de la app.',
    '  --help                     Esta ayuda.',
    '  --version                  Versión.',
    '',
    'Entorno: BOOKREADER_MCP_BACKUP · BOOKREADER_MCP_DIR · BOOKREADER_MCP_BASE ·',
    'BOOKREADER_MCP_CACHE_MS · BOOKREADER_DRIVE_REFRESH_TOKEN ·',
    'BOOKREADER_DRIVE_REFRESH_TOKEN_FILE · BOOKREADER_DRIVE_ACCESS_TOKEN',
  ].join('\n');
}

function envOr(env, ...names) {
  for (const n of names) if (env[n]) return env[n];
  return null;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    if (arg === '--version' || arg === '-V') { out.version = true; continue; }
    if (!arg.startsWith('--')) throw new ConfigError('Argumento inesperado: ' + arg);
    if (!TAKES_VALUE.has(arg)) throw new ConfigError('Opción desconocida: ' + arg);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) {
      throw new ConfigError('A ' + arg + ' le falta el valor.');
    }
    out[arg.slice(2)] = value;
  }
  return out;
}

/**
 * Configuración completa del arranque. Pura: no toca el disco (leer el fichero del refresh
 * token es cosa de quien construye la fuente).
 *
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} [env]
 * @returns {object}
 */
export function parseConfig(argv = [], env = {}) {
  const args = parseArgs(argv);
  if (args.help) return { help: true, version: VERSION };
  if (args.version) return { version: VERSION };

  const backupPath = args.backup || envOr(env, 'BOOKREADER_MCP_BACKUP');
  const layoutDir = args.dir || envOr(env, 'BOOKREADER_MCP_DIR');
  const refreshToken = envOr(env, 'BOOKREADER_DRIVE_REFRESH_TOKEN');
  const refreshTokenFile = args['refresh-token-file'] || envOr(env, 'BOOKREADER_DRIVE_REFRESH_TOKEN_FILE');
  const accessToken = args['access-token'] || envOr(env, 'BOOKREADER_DRIVE_ACCESS_TOKEN');

  let source = args.source || null;
  if (source && !SOURCES.includes(source)) {
    throw new ConfigError('Fuente desconocida: ' + source + ' (usa ' + SOURCES.join(' o ') + ').');
  }
  // Sin --source, la fuente se deduce de lo que el usuario dio. Dos a la vez es ambiguo.
  if (!source) {
    if (backupPath && layoutDir) {
      throw new ConfigError('Dime una sola fuente: --backup o --dir, no las dos.');
    }
    if (backupPath) source = 'backup-file';
    else if (layoutDir) source = 'drive';
  }
  if (!source) throw new ConfigError('No sé de dónde leer. Usa --backup o --dir.\n\n' + usage());

  if (source === 'backup-file' && !backupPath) {
    throw new ConfigError('La fuente backup-file necesita --backup <fichero.json>.');
  }
  if (source === 'backup-file' && layoutDir) {
    throw new ConfigError('--dir es de la fuente drive: no lo mezcles con --backup.');
  }
  if (source === 'drive' && layoutDir && (refreshToken || accessToken || refreshTokenFile)) {
    throw new ConfigError('--dir es el proveedor local: no le pases credenciales de Drive.');
  }
  if (source === 'drive' && !layoutDir && !refreshToken && !accessToken && !refreshTokenFile) {
    throw new ConfigError(
      'La fuente drive necesita credenciales: --refresh-token-file, --access-token o\n' +
        'BOOKREADER_DRIVE_REFRESH_TOKEN. Para probar sin credenciales usa --dir <carpeta>.',
    );
  }

  const base = args.base || envOr(env, 'BOOKREADER_MCP_BASE') || DEFAULT_BASE;
  if (!base.endsWith('/')) throw new ConfigError('--base tiene que acabar en «/»: ' + base);
  if (base.includes('..')) throw new ConfigError('--base no puede llevar «..»: ' + base);

  const cacheRaw = args['cache-ms'] || envOr(env, 'BOOKREADER_MCP_CACHE_MS');
  const cacheMs = cacheRaw === undefined || cacheRaw === null ? DEFAULT_CACHE_MS : Number(cacheRaw);
  if (!Number.isFinite(cacheMs) || cacheMs < 0) {
    throw new ConfigError('--cache-ms tiene que ser un número de milisegundos >= 0.');
  }

  return {
    source,
    backupPath: backupPath || null,
    layoutDir: layoutDir || null,
    base,
    cacheMs,
    accessToken: accessToken || null,
    refreshToken: refreshToken || null,
    refreshTokenFile: refreshTokenFile || null,
  };
}
