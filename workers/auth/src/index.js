// Worker stateless de refresh de tokens OAuth de Google Drive.
// Único cometido: custodiar el client_secret y barajar tokens.
// No almacena nada y jamás ve los datos del usuario (spec en LAUNCH_PLAN.md).

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

async function google(params, env) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      ...params,
    }),
  });
  return new Response(res.body, { status: res.status, headers: cors(env) });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(env) });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (request.headers.get('Origin') !== env.ALLOWED_ORIGIN)
      return new Response('Forbidden', { status: 403 });

    const url = new URL(request.url);
    const body = await request.json().catch(() => ({}));

    if (url.pathname === '/auth/exchange' && body.code) {
      return google({
        grant_type: 'authorization_code',
        code: body.code,
        redirect_uri: body.redirect_uri,
        code_verifier: body.code_verifier, // PKCE
      }, env);
    }
    if (url.pathname === '/auth/refresh' && body.refresh_token) {
      return google({ grant_type: 'refresh_token', refresh_token: body.refresh_token }, env);
    }
    return new Response('Not found', { status: 404, headers: cors(env) });
  },
};
