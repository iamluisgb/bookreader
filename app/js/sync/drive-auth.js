// Auth de Google Drive: authorization-code + PKCE, con el intercambio y el
// refresh delegados en el Worker de Cloudflare (workers/auth), que es quien
// custodia el client_secret. Aquí solo viven el refresh_token del usuario
// (localStorage, excluido del backup) y el access_token en memoria.
//
// Por qué así y no implicit flow (lo que hace arete): el implicit da tokens de
// 1h sin renovación silenciosa — Google cerró esa puerta al pasar a GIS. Para
// sync automático hace falta refresh_token, que solo entrega el auth-code flow
// con access_type=offline. Ver LAUNCH_PLAN.md · "Auto-sync con Drive".

import * as Storage from '../storage.js';
import { fetchWithTimeout } from './net.js';

const WORKER_URL = 'https://bookreader-auth.luisgonzalezb93.workers.dev';
const CLIENT_ID = '1075634570118-8ipsh5pn768rof3u0mq5rhqv2pp2dgqm.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const CHANNEL = 'bookreader-drive-auth';

const REFRESH_KEY = 'drive_refresh_token'; // secreto: excluido del backup (SECRET_KEYS)

let accessToken = null;
let tokenExpiry = 0;

function b64url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pkcePair() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(digest) };
}

// Debe coincidir EXACTAMENTE con los redirect URIs registrados en el OAuth
// client de Google. document.baseURI resuelve bien tanto en dev
// (localhost:8000/app/) como en producción (/bookreader/app/).
function redirectUri() {
  return new URL('auth/callback.html', document.baseURI).href;
}

export function isConnected() {
  return !!Storage.get(REFRESH_KEY);
}

export function disconnect() {
  Storage.remove(REFRESH_KEY);
  accessToken = null;
  tokenExpiry = 0;
}

async function tokenRequest(path, params) {
  const res = await fetchWithTimeout(WORKER_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.error === 'invalid_grant') {
      // Token revocado/caducado → estado "reconectar", no bucle de error.
      disconnect();
      throw new Error('reconnect');
    }
    throw new Error(data.error_description || data.error || 'auth ' + res.status);
  }
  return data;
}

function storeAccessToken(data) {
  accessToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000 - 60000;
}

// Consentimiento inicial en popup. access_type=offline + prompt=consent fuerzan
// a Google a entregar refresh_token. El popup vuelve a auth/callback.html, que
// reenvía el code por BroadcastChannel y se cierra.
export async function connect() {
  const { verifier, challenge } = await pkcePair();
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const url = AUTH_URL + '?' + new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  const popup = window.open(url, 'bookreader-drive-auth', 'width=500,height=650');
  if (!popup) throw new Error('El navegador bloqueó la ventana de Google. Permite popups e inténtalo de nuevo.');

  const code = await new Promise((resolve, reject) => {
    const bc = new BroadcastChannel(CHANNEL);
    const timer = setTimeout(() => { cleanup(); reject(new Error('Tiempo de espera agotado.')); }, 180000);
    function cleanup() { clearTimeout(timer); bc.close(); }
    bc.onmessage = (e) => {
      const m = e.data || {};
      if (m.state !== state) return; // otro intento u otra pestaña
      cleanup();
      if (m.error || !m.code) reject(new Error(m.error || 'Google no devolvió el código.'));
      else resolve(m.code);
    };
  });

  const data = await tokenRequest('/auth/exchange', {
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  });
  if (!data.refresh_token) {
    throw new Error('Google no entregó permiso permanente. Revoca el acceso de BookReader en myaccount.google.com/permissions y vuelve a conectar.');
  }
  Storage.set(REFRESH_KEY, data.refresh_token);
  storeAccessToken(data);
  return true;
}

// Access token válido, renovándolo en silencio vía Worker cuando caduca.
export async function getAccessToken(force = false) {
  if (!force && accessToken && Date.now() < tokenExpiry) return accessToken;
  const refresh = Storage.get(REFRESH_KEY);
  if (!refresh) throw new Error('reconnect');
  const data = await tokenRequest('/auth/refresh', { refresh_token: refresh });
  storeAccessToken(data);
  return accessToken;
}
