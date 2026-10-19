// MON4 F2 · Identidad y clave del sync de BookReader (ADR-056 §3-4).
//
// Dos cosas distintas, y a propósito separadas:
//   - QUIÉN eres: tu licencia. El Worker la valida contra Polar y da un token `br-sync-…` de
//     24 h. Aquí se guarda el token (secreto, fuera del backup y del sync) y se renueva solo.
//   - QUÉ puede leerse: la clave del sync (32 bytes aleatorios), que el servidor no ve nunca.
//     Nace en el primer dispositivo; los demás la reciben por el enlace de emparejamiento
//     (`#pair=…`) o tecleando la clave de recuperación.
//
// Para saber si una clave es la buena sin descifrar datos de verdad, el primer dispositivo
// deja un fichero de control (`keycheck`) cifrado con ella. Un dispositivo que se empareja lo
// descifra antes de guardar la clave: con una clave equivocada no llega a escribir nada.

import { t } from '../i18n.js';
import * as Storage from '../storage.js';
import * as License from '../license.js';
import { fetchWithTimeout } from './net.js';
import * as C from './sync-crypto.js';

// Exportado para la sonda de alcanzabilidad del diagnóstico y para los tests.
export const WORKER_URL = 'https://bookreader-sync.luisgonzalezb93.workers.dev';

// El Worker está desplegado EN PRUEBA: sin Polar real solo entran las licencias de su secret
// TEST_LICENSES (MON4). Mientras tanto la opción no se enseña en Ajustes: para el resto sería un
// botón que falla. Para probarla, visitar la app con `?sync-preview=1` (`=0` la quita), o en la
// consola: localStorage.setItem('bookreader_sync_preview', 'true'). Al lanzar, LAUNCHED = true.
const LAUNCHED = false;

try {
  const q = new URLSearchParams(location.search).get('sync-preview');
  if (q === '1') Storage.set('sync_preview', true);
  if (q === '0') Storage.remove('sync_preview');
} catch { /* sin localStorage: simplemente sin vista previa */ }

export function available() {
  return LAUNCHED || Storage.get('sync_preview', false) === true;
}

const KEY_KEY = 'sync_key';        // secreto: excluido del backup y del sync (SECRET_KEYS)
const TOKEN_KEY = 'sync_token';    // secreto: { token, expiresAt, readOnly, files, purgeAt }
const KEYCHECK_PATH = 'bookreader/keycheck';
const KEYCHECK_TEXT = 'bookreader-sync-keycheck-v1';

let keysCache = null;   // { raw: string, keys }

// ---- Estado ---------------------------------------------------------------------------------

export function licenseKey() {
  const s = License.getState();
  return (s && s.key && !s.revoked) ? s.key : '';
}

export function hasKey() {
  return !!Storage.get(KEY_KEY);
}

// Conectado = hay licencia y clave en este dispositivo. Que la suscripción siga activa lo dice
// el servidor al pedir el token (y si no, el sync queda en solo lectura con el motivo).
export function isConnected() {
  return hasKey() && !!licenseKey();
}

function tokenInfo() {
  return Storage.get(TOKEN_KEY, null);
}

// Ficheros de libro: los decide el servidor (FILES_ENABLED, ADR-056 opción A/B) y no se suben
// en solo lectura. Sin token todavía, no: el primer ciclo lo traerá.
export function filesAllowed() {
  const s = tokenInfo();
  return !!(s && s.files && !s.readOnly);
}

export function readOnlyInfo() {
  const s = tokenInfo();
  return s && s.readOnly ? { purgeAt: s.purgeAt || null } : null;
}

export async function keys() {
  const raw = Storage.get(KEY_KEY);
  if (!raw) throw new Error('reconnect');
  if (keysCache && keysCache.raw === raw) return keysCache.keys;
  const k = await C.importKeys(C.fromB64url(raw));
  keysCache = { raw, keys: k };
  return k;
}

function setKey(raw) {
  Storage.set(KEY_KEY, C.b64url(raw));
  keysCache = null;
}

// Olvida la clave y el token en ESTE dispositivo. Lo sincronizado sigue en el servidor y en
// los otros dispositivos.
export function disconnect() {
  Storage.remove(KEY_KEY);
  Storage.remove(TOKEN_KEY);
  keysCache = null;
}

// ---- Token ----------------------------------------------------------------------------------

function authError(code) {
  // 'reconnect' es lo que el motor entiende como «el sync necesita que hagas algo»: el badge y
  // Ajustes dicen el motivo (Provider.text('reconnect')).
  const e = new Error('reconnect');
  e.code = code;
  return e;
}

// Un token de solo lectura se vuelve a pedir cada READ_ONLY_RECHECK_MS aunque no haya
// caducado: quien renueva la suscripción no debe esperar a que venza el de 24 h para volver a
// escribir.
const READ_ONLY_RECHECK_MS = 15 * 60 * 1000;

export async function getToken(force = false) {
  const s = tokenInfo();
  const stale = s && s.readOnly && Date.now() - (s.checkedAt || 0) > READ_ONLY_RECHECK_MS;
  if (!force && !stale && s && s.token && s.expiresAt - 60000 > Date.now()) return s.token;
  const license = licenseKey();
  if (!license) throw authError('no_license');
  const res = await fetchWithTimeout(WORKER_URL + '/v1/sync-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ license }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 403) {
    Storage.remove(TOKEN_KEY);
    throw authError(data.error || 'forbidden');
  }
  if (!res.ok) {
    const e = new Error(data.error === 'not_configured'
      ? t('El sync de BookReader aún no está disponible.')
      : t('El servidor del sync no responde ({status}).', { status: res.status }));
    e.code = res.status;
    throw e;
  }
  Storage.set(TOKEN_KEY, {
    token: data.token, expiresAt: data.expiresAt, readOnly: !!data.readOnly,
    files: !!data.files, purgeAt: data.purgeAt || null, checkedAt: Date.now(),
  });
  return data.token;
}

// Petición al Worker con el token; un 401 (token caducado o purgado) se renueva una vez.
//
// Un 429 (límite de escrituras por minuto) se espera y se reintenta: la primera subida de una
// biblioteca grande, o una migración, son ráfagas legítimas de cientos de ficheros, y fallar
// el ciclo entero por eso sería peor que tardar un poco más. El cuerpo es un Blob, así que se
// puede reenviar tal cual.
const RATE_WAITS_MS = [1000, 3000, 8000, 15000, 30000];

export async function api(path, options = {}, { timeoutMs, retry = true } = {}) {
  for (let attempt = 0; ; attempt++) {
    const token = await getToken();
    const res = await fetchWithTimeout(WORKER_URL + path, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: 'Bearer ' + token },
    }, timeoutMs);
    if (res.status === 401 && retry) {
      await getToken(true);
      return api(path, options, { timeoutMs, retry: false });
    }
    if (res.status === 429 && attempt < RATE_WAITS_MS.length) {
      await new Promise(r => setTimeout(r, RATE_WAITS_MS[attempt] * (0.75 + Math.random() * 0.5)));
      continue;
    }
    return res;
  }
}

export async function apiError(res) {
  let body = {};
  try { body = await res.json(); } catch { /* sin cuerpo JSON */ }
  if (res.status === 403 && body.error === 'read_only') {
    const s = tokenInfo();
    if (s) Storage.set(TOKEN_KEY, { ...s, readOnly: true });
    return authError('read_only');
  }
  const e = new Error(body.error === 'quota'
    ? t('Has llegado al tope de espacio del sync de BookReader.')
    : body.error === 'capacity'
      ? t('El sync de BookReader está al límite ahora mismo. Se reintentará más tarde.')
      : t('Sync de BookReader: error {status}.', { status: res.status }));
  e.code = res.status;
  e.reason = body.error || '';
  return e;
}

export async function status() {
  const res = await api('/v1/status');
  if (!res.ok) throw await apiError(res);
  return res.json();
}

// ---- Fichero de control de la clave ---------------------------------------------------------

async function writeKeycheck(k) {
  const pid = await C.pathId(k, KEYCHECK_PATH);
  const body = await C.encrypt(k, pid, KEYCHECK_TEXT);
  const res = await api('/v1/o/' + pid, {
    method: 'PUT',
    headers: { 'X-Name': await C.encryptName(k, KEYCHECK_PATH), 'X-Kind': 'data' },
    body,
  });
  if (!res.ok) throw await apiError(res);
}

// ¿Esta clave abre lo que hay en el servidor? null si el servidor está vacío (no hay sync
// todavía), true/false si no.
//
// Ojo: la ruta del fichero de control sale de la PROPIA clave, así que una clave ajena lo
// busca en otra ruta y recibe un 404. Ese 404 solo significa «no hay nada» si de verdad no hay
// objetos; si los hay, son de otra clave y esta no los abre.
async function keyOpens(k) {
  const pid = await C.pathId(k, KEYCHECK_PATH);
  const res = await api('/v1/o/' + pid);
  if (res.status === 404) return (await status()).objects > 0 ? false : null;
  if (!res.ok) throw await apiError(res);
  try {
    return (await C.decryptText(k, pid, await res.blob())) === KEYCHECK_TEXT;
  } catch {
    return false;
  }
}

// ---- Activar, emparejar, recuperar ----------------------------------------------------------

// Primer paso al elegir «Sync de BookReader». Devuelve:
//   { state: 'ready' }       — ya había clave aquí, o no había nada en el servidor y se creó;
//   { state: 'needs-key' }   — el servidor ya tiene datos: hay que emparejar o recuperar.
export async function enable() {
  if (!licenseKey()) throw authError('no_license');
  await getToken(true);
  if (hasKey()) {
    const ok = await keyOpens(await keys());
    if (ok === false) return { state: 'needs-key' };
    if (ok === null) await writeKeycheck(await keys());
    return { state: 'ready' };
  }
  const st = await status();
  if (st.objects > 0) return { state: 'needs-key' };
  const raw = C.generateKey();
  const k = await C.importKeys(raw);
  await writeKeycheck(k);
  setKey(raw);
  return { state: 'ready', created: true };
}

// Usa una clave que llega de fuera (enlace o clave de recuperación). Comprueba que abre lo que
// hay ANTES de guardarla: si no, lanza y no toca nada.
//   - 'wrong_key': hay datos y esta clave no los abre.
//   - 'empty': con ESTA licencia no hay nada sincronizado. Una clave de fuera siempre viene de
//     un sync que existe, así que eso significa que este dispositivo está con otra licencia: si
//     se aceptara, quedaría «emparejado» con un espacio vacío, sin cruzarse nunca con el otro.
export async function useKey(raw) {
  const k = await C.importKeys(raw);
  const ok = await keyOpens(k);
  if (ok === false) throw Object.assign(new Error(t('Esa clave no es la de tu sync. Compruébala o usa el enlace de otro dispositivo.')), { code: 'wrong_key' });
  if (ok === null) throw Object.assign(new Error(t('Con la licencia de este dispositivo no hay nada sincronizado. Usa en los dos la misma licencia.')), { code: 'empty' });
  setKey(raw);
}

export async function useRecoveryCode(code) {
  let raw;
  try { raw = await C.parseRecoveryCode(code); }
  catch { throw Object.assign(new Error(t('La clave de recuperación no está completa o tiene un error. Revísala.')), { code: 'typo' }); }
  await useKey(raw);
}

// Empezar de cero: borra TODO lo del servidor y crea una clave nueva. Para quien perdió la
// clave en todos sus dispositivos (lo de antes no se puede leer: es el precio de que nosotros
// tampoco podamos).
export async function startOver() {
  const res = await api('/v1/all', { method: 'DELETE' });
  if (!res.ok) throw await apiError(res);
  Storage.remove(KEY_KEY);
  keysCache = null;
  return enable();
}

export async function recoveryCode() {
  const raw = Storage.get(KEY_KEY);
  if (!raw) return '';
  return C.recoveryCode(C.fromB64url(raw));
}

// Enlace para otro dispositivo: la clave del sync y la licencia, en el fragmento (el navegador
// no lo envía a ningún servidor). Mismo truco que compartir por enlace y el traspaso de demo.
export function pairingLink(base = location.origin + location.pathname) {
  const raw = Storage.get(KEY_KEY);
  if (!raw) return '';
  const lic = C.b64url(new TextEncoder().encode(licenseKey()));
  return `${base}#pair=${raw}.${lic}`;
}

// Saca el emparejamiento del hash (y lo BORRA de la URL antes de usarlo, como la demo).
export function consumePairLink() {
  const p = new URLSearchParams(location.hash.replace(/^#/, ''));
  const v = (p.get('pair') || '').trim();
  if (!v) return null;
  p.delete('pair');
  const rest = p.toString();
  history.replaceState({}, '', location.pathname + location.search + (rest ? '#' + rest : ''));
  const [rawB64, licB64] = v.split('.');
  try {
    const raw = C.fromB64url(rawB64);
    if (raw.length !== 32) return { broken: true };
    return { raw, license: licB64 ? new TextDecoder().decode(C.fromB64url(licB64)) : '' };
  } catch {
    return { broken: true };
  }
}

// ---- Agentes (MCP remoto) ------------------------------------------------------------------
//
// Un token deja a un agente (Claude Code, Hermes…) leer la biblioteca por MCP en MCP_URL. Para
// eso el servidor necesita la clave del sync: se la manda AQUÍ, una vez, y la guarda cifrada con
// el propio token (workers/sync/src/mcp.js). El token se enseña una sola vez.

export const MCP_URL = WORKER_URL + '/mcp';

export async function mcpTokens() {
  const res = await api('/v1/mcp-tokens');
  if (!res.ok) throw await apiError(res);
  return (await res.json()).tokens;
}

// `scopes`: además de leer ('read', siempre), 'write' (tarjetas, mazos y artefactos) y 'text'
// (el texto de los libros). Solo los que el usuario marque.
export async function createMcpToken(name, { days = 90, scopes = [] } = {}) {
  const res = await api('/v1/mcp-tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, days, scopes, key: Storage.get(KEY_KEY), license: licenseKey() }),
  });
  if (!res.ok) {
    const e = await apiError(res);
    if (e.reason === 'too_many') e.message = t('Ya tienes 20 agentes conectados. Revoca alguno para crear otro.');
    throw e;
  }
  return res.json();
}

export async function revokeMcpToken(id) {
  const res = await api('/v1/mcp-tokens/' + encodeURIComponent(id), { method: 'DELETE' });
  if (!res.ok) throw await apiError(res);
}
