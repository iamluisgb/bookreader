// redact.mjs — la lista de lo que este MCP NUNCA lee ni devuelve, escrita en código y no
// dejada a la costumbre (BACKLOG · P28).
//
// El MCP es un puente local hacia los datos del lector, y hay claves que no cruzan esa
// frontera ni de refilón:
//
//   ai_key                la API key del agente (BYOK): secreto del usuario.
//   drive_refresh_token   el permiso permanente sobre su Drive.
//   device_id             no es inocuo y no es solo «estado local»: es la mitad de la clave
//                         con la que cada equipo escribe SUS días de lectura
//                         (`${día}|${deviceId}`, P25 F3). Si se clona, dos equipos escriben
//                         la misma fila y uno de los dos deja de contar — el mismo motivo
//                         que `SKIP_KEYS` en sync/layout.js y `LOCAL_ONLY_KEYS` en backup.js.
//   license               la app SÍ la mete en el backup (restaurar Pro tras la purga de
//                         storage es el caso real), pero aquí no hay ninguna tool que la
//                         necesite: se veta por conservadora, no porque sea un secreto.
//   sync_state / sync_schema_migrated
//                         estado de sincronización de ESTE equipo: sin sentido fuera de él.
//
// La app ya excluye los secretos por su cuenta, pero eso es una decisión de otro módulo:
// aquí se comprueba. `scrub()` los borra de cualquier estructura antes de proyectarla, y
// `findForbidden()` es el detector que usan los tests.
//
// El caso que no basta con vetar una clave: el registro de lectura del layout viaja como
// `{ key: '<día>|<deviceId>', day, deviceId, ... }` — el identificador está DENTRO del valor
// de `key`. Por eso existe `DROPPED_READING_FIELDS`: la proyección de esos registros se
// queda solo con `day`, `updatedAt` y `books`.

/** Secretos que jamás salen del dispositivo (mismo criterio que app/js/backup.js). */
export const SECRET_KEYS = ['ai_key', 'drive_refresh_token'];

/** Estado puramente local, sin sentido en otro dispositivo (mismo criterio que layout.js). */
export const LOCAL_ONLY_KEYS = ['device_id', 'sync_state', 'sync_schema_migrated'];

/**
 * Claves que el MCP ni lee ni devuelve, a ningún nivel de profundidad. `deviceId` es la
 * forma en camelCase que usa el registro de lectura (`reading-log.js` · exportDays).
 */
export const NEVER_EXPOSED_KEYS = [
  ...SECRET_KEYS,
  ...LOCAL_ONLY_KEYS,
  'deviceId',
  'license',
];

/**
 * Campos que se tiran al proyectar un registro de lectura: `key` es `<día>|<deviceId>` y
 * `deviceId` es el identificador literal. Lo que queda (`day`, `updatedAt`, `books`) es todo
 * lo que necesita `reading_stats`.
 */
export const DROPPED_READING_FIELDS = ['key', 'deviceId'];

/**
 * Devuelve una copia de `value` sin ninguna clave de `NEVER_EXPOSED_KEYS`, a cualquier
 * profundidad. No muta la entrada (las fuentes reutilizan su caché).
 *
 * @param {unknown} value
 * @returns {any}
 */
export function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (NEVER_EXPOSED_KEYS.includes(k)) continue;
      out[k] = scrub(v);
    }
    return out;
  }
  return value;
}

/**
 * Rutas donde aparece una clave vetada (para tests y auto-chequeo). Con `needles` busca
 * además esos literales DENTRO de cualquier cadena, que es la única forma de detectar un
 * `deviceId` embebido en `'<día>|<deviceId>'`.
 *
 * @param {unknown} value
 * @param {{ needles?: string[], path?: string, out?: string[] }} [opts]
 * @returns {string[]}
 */
export function findForbidden(value, { needles = [], path = '$', out = [] } = {}) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => findForbidden(v, { needles, path: path + '[' + i + ']', out }));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (NEVER_EXPOSED_KEYS.includes(k)) out.push(path + '.' + k);
      findForbidden(v, { needles, path: path + '.' + k, out });
    }
    return out;
  }
  if (typeof value === 'string') {
    for (const n of needles) {
      if (n && value.includes(n)) out.push(path + ' :: ' + n);
    }
  }
  return out;
}

/**
 * Proyecta un registro de lectura del layout a lo que el MCP puede devolver: sin `key` (que
 * lleva el deviceId dentro) y sin `deviceId`. Tolerante a entradas raras: devuelve `null` si
 * el registro no es utilizable.
 *
 * @param {any} rec
 * @returns {{ day: string, updatedAt: number, books: Record<string, { ms: number, words: number, units: number }> } | null}
 */
export function sanitizeReadingDay(rec) {
  if (!rec || typeof rec !== 'object' || typeof rec.day !== 'string') return null;
  const books = {};
  for (const [bookId, v] of Object.entries(rec.books || {})) {
    if (!v || typeof v !== 'object') continue;
    books[bookId] = {
      ms: Number(v.ms) || 0,
      words: Number(v.words) || 0,
      units: Number(v.units) || 0,
    };
  }
  return { day: rec.day, updatedAt: Number(rec.updatedAt) || 0, books };
}
