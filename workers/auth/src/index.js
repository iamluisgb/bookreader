// Worker stateless de refresh de tokens OAuth de Google Drive.
// Único cometido: custodiar el client_secret y barajar tokens.
// No almacena nada y jamás ve los datos del usuario (spec en LAUNCH_PLAN.md).

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function matchOrigin(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  return allowed.includes(origin) ? origin : null;
}

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

async function google(params, origin, env) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      ...params,
    }),
  });
  return new Response(res.body, { status: res.status, headers: cors(origin) });
}

export default {
  async fetch(request, env) {
    const origin = matchOrigin(request, env);
    if (!origin) return new Response('Forbidden', { status: 403 });
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    const url = new URL(request.url);
    const body = await request.json().catch(() => ({}));

    if (url.pathname === '/auth/exchange' && body.code) {
      return google({
        grant_type: 'authorization_code',
        code: body.code,
        redirect_uri: body.redirect_uri,
        code_verifier: body.code_verifier, // PKCE
      }, origin, env);
    }
    if (url.pathname === '/auth/refresh' && body.refresh_token) {
      return google({ grant_type: 'refresh_token', refresh_token: body.refresh_token }, origin, env);
    }
    return new Response('Not found', { status: 404, headers: cors(origin) });
  },
};
