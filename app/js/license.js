// license.js — BookReader Pro: licencias de Polar (MON2, ver BACKLOG y
// docs/GUIA_MONETIZACION.md). Sin backend: los endpoints de license keys del customer
// portal de Polar son públicos y con CORS abierto (verificado 2026-07-15), se llaman
// directos desde el navegador. Aquí NO hay DOM: el paywall vive en ui/paywall.js y la
// gestión en ui/app-settings.js (sección Licencia).
//
// Estado en localStorage (`bookreader_license`): { key, activationId, validatedAt,
// revoked }. Entra a propósito en el backup JSON y en el sync de Drive (NO es un secreto
// como la API key del agente): restaurar backup —o que el sync la propague— restaura la
// licencia sin quemar otra activación. Mitiga la purga de storage de Safari/ITP; los
// dispositivos sincronizados comparten una activación (generoso a propósito).
//
// Reglas (guía de monetización, paso 6):
//   - validate en background al arrancar, nunca bloquea la app.
//   - sin red, la última validación buena vale hasta 30 días (OFFLINE_WINDOW_MS).
//   - key inválida/revocada → degradar a Free con aviso; jamás borrar datos.
//
// MODO SIMULADO: mientras `CONFIG.organizationId` esté vacío (aún sin cuenta de Polar)
// no se llama a ninguna API: las keys con prefijo BKRD- se aceptan localmente con el
// mismo contrato (mismos errores, mismos estados). Keys especiales para probar la UI:
//   BKRD-…-REVOKED → se comporta como key revocada (reembolso)
//   BKRD-…-LIMIT   → activate devuelve "límite de activaciones alcanzado"
// Pasar a producción = rellenar organizationId/checkoutUrl/portalUrl. Nada más.
import * as Storage from './storage.js';

export const CONFIG = {
  organizationId: '',      // org id de Polar (público). Vacío = modo simulado.
  sandbox: false,          // true → sandbox-api.polar.sh (pruebas con la API real)
  checkoutUrl: '',         // Checkout Link del dashboard (discount pre-aplicado)
  portalUrl: 'https://polar.sh',   // portal de cliente (recuperar key, desactivar dispositivos)
  price: '$29 · pago único',
};

export const OFFLINE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;   // 30 días
const STORE_KEY = 'license';
const MOCK_RE = /^BKRD-[A-Z0-9-]{4,}$/i;

export function isMock() {
  return !CONFIG.organizationId;
}

export function apiBase() {
  return CONFIG.sandbox
    ? 'https://sandbox-api.polar.sh/v1/customer-portal/license-keys'
    : 'https://api.polar.sh/v1/customer-portal/license-keys';
}

// ---- Estado ------------------------------------------------------------------

export function getState() {
  return Storage.get(STORE_KEY, null);
}

function setState(state) {
  if (state) Storage.set(STORE_KEY, state);
  else Storage.remove(STORE_KEY);
  window.dispatchEvent(new CustomEvent('license:changed', { detail: { pro: isPro() } }));
}

// Pro = hay key no revocada con validación buena dentro de la ventana offline.
// Una key que caducó la ventana no se borra: la próxima validación con red la reactiva.
export function isPro(now = Date.now()) {
  const s = getState();
  if (!s || !s.key || s.revoked) return false;
  return typeof s.validatedAt === 'number' && now - s.validatedAt < OFFLINE_WINDOW_MS;
}

// Label legible de la activación: es lo que el usuario ve en el portal de Polar al
// liberar dispositivos ("Safari · iPhone" en vez de un id opaco).
export function deviceLabel(ua = navigator.userAgent, platform = navigator.platform || '') {
  const browser =
    /edg\//i.test(ua) ? 'Edge' :
    /firefox\//i.test(ua) ? 'Firefox' :
    /chrome\//i.test(ua) ? 'Chrome' :
    /safari\//i.test(ua) ? 'Safari' : 'Navegador';
  const os =
    /iphone/i.test(ua) ? 'iPhone' :
    /ipad/i.test(ua) ? 'iPad' :
    /android/i.test(ua) ? 'Android' :
    /mac/i.test(ua + platform) ? 'Mac' :
    /win/i.test(ua + platform) ? 'Windows' :
    /linux/i.test(ua + platform) ? 'Linux' : 'dispositivo';
  return `${browser} · ${os}`;
}

// ---- Errores ------------------------------------------------------------------
// code: 'invalid' (key mal/revocada) · 'limit' (sin huecos de activación) · 'network'

function licError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// Clasifica una respuesta 4xx de Polar. El límite de activaciones llega como 403 con
// detalle mencionando las activaciones; cualquier otro 4xx es key inválida/revocada.
async function classify4xx(res) {
  let detail = '';
  try { detail = JSON.stringify(await res.json()); } catch { /* sin cuerpo JSON */ }
  if (/activation/i.test(detail) && /limit|maximum|exceed/i.test(detail)) {
    return licError('limit', 'Esta licencia ya está activa en el máximo de dispositivos.');
  }
  return licError('invalid', 'La licencia no es válida o fue revocada.');
}

// ---- Activate / Validate -------------------------------------------------------

export async function activate(rawKey) {
  const key = (rawKey || '').trim();
  if (!key) throw licError('invalid', 'Introduce tu clave de licencia.');

  if (isMock()) {
    const r = await mockCall('activate', key);
    setState({ key, activationId: r.activationId, validatedAt: Date.now(), revoked: false });
    return;
  }

  let res;
  try {
    res = await fetch(`${apiBase()}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, organization_id: CONFIG.organizationId, label: deviceLabel() }),
    });
  } catch {
    throw licError('network', 'Sin conexión. Inténtalo cuando tengas red.');
  }
  if (res.ok) {
    const data = await res.json();
    setState({ key, activationId: data.id, validatedAt: Date.now(), revoked: false });
    return;
  }
  if (res.status >= 400 && res.status < 500) throw await classify4xx(res);
  throw licError('network', 'El servidor de licencias no responde. Inténtalo en un rato.');
}

// Validación de arranque: en background, nunca lanza, nunca bloquea. Solo degrada a
// Free cuando el servidor dice explícitamente que la key ya no vale; un fallo de red
// deja el estado como está (la ventana offline de isPro() decide).
export async function validateOnStartup() {
  const s = getState();
  if (!s || !s.key || s.revoked) return;

  if (isMock()) {
    try {
      await mockCall('validate', s.key);
      setState({ ...s, validatedAt: Date.now() });
    } catch (e) {
      if (e.code === 'invalid') setState({ ...s, revoked: true });
    }
    return;
  }

  let res;
  try {
    res = await fetch(`${apiBase()}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: s.key, organization_id: CONFIG.organizationId, activation_id: s.activationId }),
    });
  } catch {
    return;   // sin red: la última validación buena vale (hasta 30 días)
  }
  if (res.ok) setState({ ...s, validatedAt: Date.now() });
  else if (res.status >= 400 && res.status < 500) setState({ ...s, revoked: true });
  // 5xx: transitorio del servidor, tratar como sin red.
}

// Quitar la licencia de ESTE navegador (no desactiva la instancia en Polar: eso se hace
// desde el portal de cliente, que es quien lleva la cuenta de huecos).
export function removeLocal() {
  setState(null);
}

// ---- Modo simulado --------------------------------------------------------------

function mockCall(op, key) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {   // latencia pequeña: que la UI ejercite sus estados de espera
      if (!MOCK_RE.test(key)) return reject(licError('invalid', 'La licencia no es válida o fue revocada.'));
      if (/-REVOKED$/i.test(key)) return reject(licError('invalid', 'La licencia no es válida o fue revocada.'));
      if (op === 'activate' && /-LIMIT$/i.test(key)) {
        return reject(licError('limit', 'Esta licencia ya está activa en el máximo de dispositivos.'));
      }
      resolve({ activationId: 'mock-' + Math.random().toString(36).slice(2, 10) });
    }, 150);
  });
}
