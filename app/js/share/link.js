// P24 F4 · Compartir por enlace (ADR-053).
//
// El dossier (el mismo ZIP `.bookreader` que viaja como fichero) se CIFRA en este navegador
// con AES-GCM y una clave aleatoria, se sube cifrado a workers/share y el enlace lleva la
// clave en el fragmento:
//
//   https://bookreader.raiatech.com/app/#d=<id>.<clave>
//
// El fragmento no sale nunca del navegador (no va en la petición HTTP), así que el servidor
// guarda bytes que no puede leer. Quien abre el enlace descarga, descifra aquí y entra en la
// misma revisión que al importar un fichero (import-ui.js · importDossier).
//
// Formato del blob subido: «BRL1» (4 bytes) · IV (12) · texto cifrado (con su etiqueta).

export const SHARE_BASE_URL = 'https://bookreader-share.luisgonzalezb93.workers.dev/v1';
// 100 MB: tope de subida del Worker. Medido sobre el blob CIFRADO (16 bytes más que el ZIP).
export const MAX_LINK_BYTES = 100 * 1024 * 1024;
const MAGIC = new TextEncoder().encode('BRL1');
const APP_URL = 'https://bookreader.raiatech.com/app/';

const b64url = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

function base() {
  try { return localStorage.getItem('bookreader_share_url') || SHARE_BASE_URL; } catch { return SHARE_BASE_URL; }
}

export async function encrypt(blob) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, await blob.arrayBuffer()));
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  return { blob: new Blob([MAGIC, iv, ct], { type: 'application/octet-stream' }), key: b64url(raw) };
}

export async function decrypt(buffer, keyB64) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 16 + 16 || new TextDecoder().decode(bytes.subarray(0, 4)) !== 'BRL1') throw new Error('format');
  const key = await crypto.subtle.importKey('raw', fromB64url(keyB64), { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(4, 16) }, key, bytes.subarray(16));
  return new Blob([plain], { type: 'application/zip' });
}

// Enlace de la app en este despliegue (local, pages.dev o producción): el receptor abre la
// misma app que el emisor. En un origen raro (file://) cae a producción.
function appUrl() {
  const { origin, pathname } = location;
  if (!/^https?:/.test(origin)) return APP_URL;
  return origin + pathname.replace(/[^/]*$/, '');
}

// Cifra y sube. Devuelve { url, expiresAt, id, deleteToken }. Errores con `code`:
// 'too_large' (pasa del tope), 'rate_limited', 'capacity' (el servidor llegó a su tope del
// mes: se niega antes de que R2 cobre, ver workers/share), 'network'.
export async function createLink(zipBlob) {
  const { blob, key } = await encrypt(zipBlob);
  if (blob.size > MAX_LINK_BYTES) throw Object.assign(new Error('too_large'), { code: 'too_large' });
  let res;
  try {
    res = await fetch(base() + '/share', { method: 'POST', body: blob, headers: { 'Content-Type': 'application/octet-stream' } });
  } catch (e) { throw Object.assign(new Error('network'), { code: 'network' }); }
  if (!res.ok) {
    const code = res.status === 413 ? 'too_large' : res.status === 429 ? 'rate_limited'
      : res.status === 507 || res.status === 503 ? 'capacity' : 'network';
    throw Object.assign(new Error(code), { code });
  }
  const { id, expiresAt, deleteToken } = await res.json();
  return { id, expiresAt, deleteToken, url: `${appUrl()}#d=${id}.${key}` };
}

// `#d=<id>.<clave>` del fragmento actual, o null.
export function parseLinkHash(hash = location.hash) {
  const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const m = (p.get('d') || '').match(/^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/);
  return m ? { id: m[1], key: m[2] } : null;
}

// Descarga y descifra. Errores con `code`: 'expired' (caducado o revocado), 'broken' (la
// clave no abre el paquete: enlace cortado al copiarlo), 'busy' (tope del mes del servidor),
// 'network'.
export async function fetchLink({ id, key }) {
  let res;
  try { res = await fetch(`${base()}/share/${id}`); }
  catch (e) { throw Object.assign(new Error('network'), { code: 'network' }); }
  if (res.status === 404 || res.status === 410) throw Object.assign(new Error('expired'), { code: 'expired' });
  if (res.status === 503) throw Object.assign(new Error('busy'), { code: 'busy' });
  if (!res.ok) throw Object.assign(new Error('network'), { code: 'network' });
  try { return await decrypt(await res.arrayBuffer(), key); }
  catch (e) { throw Object.assign(new Error('broken'), { code: 'broken' }); }
}
