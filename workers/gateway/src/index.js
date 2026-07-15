// MON1 F1 · bookreader-gateway — proxy OpenAI-compatible con tokens propios.
//
// bookreader ──Bearer br-…──▶ este Worker ──alias→modelo──▶ nan
//
// - Valida el token contra D1 y decrementa su cuota de forma ATÓMICA por petición.
// - Expone ALIAS propios (bookreader-fast…), nunca nombres de modelos del proveedor:
//   cambiar de proveedor = cambiar una fila de ROUTING, nadie reconfigura (ver ADR-021).
// - Passthrough transparente del stream SSE (el body upstream se devuelve tal cual).
// - Privacidad: retención cero — jamás se loguean prompts ni respuestas.
// - Anti-abuso F1: cuota por token + allowlist de alias + tope de max_tokens server-side.
//   (rate-limit rpm y pool de keys → F2, si la medición lo pide.)
//
// Riesgo aceptado F1: todos los usuarios comparten la key de nan y nan rechaza
// peticiones concurrentes por key; con tráfico demo bajo, los reintentos del
// cliente (IA3) absorben los transitorios. F2 lo resuelve si hace falta.

// Tabla de routing: alias público → destino real + capacidades. Una fila por
// alias; `provider` está para el día que haya un segundo backend (OpenRouter…).
const ROUTING = {
  'bookreader-fast': {
    provider: 'nan',
    model: 'deepseek-v4-flash',
    caps: { tools: true, vision: false },
  },
  'bookreader-vision': {
    provider: 'nan',
    model: 'mimo-v2.5',
    caps: { tools: false, vision: true },
  },
};

const PROVIDERS = {
  nan: { baseUrl: 'https://api.nan.builders/v1', keyEnv: 'NAN_API_KEY' },
};

const MAX_TOKENS_CAP = 8192; // mismo techo que usa el cliente; nadie lo sube desde fuera

// F3 · Demo self-service (los topes viven en vars de wrangler.jsonc para ajustarlos
// sin tocar código): cuota por token, tokens emitidos/día e llamadas demo/día.
const num = (v, d) => Number.isFinite(Number(v)) ? Number(v) : d;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === '/v1/models' && request.method === 'GET') {
        return withCors(await handleModels(request, env), cors);
      }
      if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
        return withCors(await handleChat(request, env), cors);
      }
      if (url.pathname === '/demo-token' && request.method === 'POST') {
        return withCors(await handleDemoToken(request, env), cors);
      }
      return withCors(oaiError(404, 'not_found', 'Unknown endpoint.'), cors);
    } catch (e) {
      // Nunca filtrar detalles internos; el error real queda en observability.
      console.error('gateway:', e.message);
      return withCors(oaiError(500, 'internal', 'Gateway error.'), cors);
    }
  },
};

// ---- endpoints ---------------------------------------------------------------

// GET /v1/models — lista los ALIAS (así la UI de bookreader los descubre sola).
// Requiere token válido pero NO consume cuota.
async function handleModels(request, env) {
  const tok = await getToken(request, env);
  if (!tok.ok) return tok.response;
  const data = Object.keys(ROUTING).map((id) => ({ id, object: 'model', owned_by: 'bookreader' }));
  return json(200, { object: 'list', data });
}

// POST /v1/chat/completions — valida, decrementa, enruta y hace passthrough
// (streaming incluido: se devuelve el body upstream sin tocarlo).
async function handleChat(request, env) {
  const tok = await getToken(request, env);
  if (!tok.ok) return tok.response;

  let body;
  try { body = await request.json(); } catch {
    return oaiError(400, 'invalid_request', 'Body must be JSON.');
  }

  const route = ROUTING[body.model];
  if (!route) {
    return oaiError(400, 'model_not_found',
      `Unknown model "${body.model}". Available: ${Object.keys(ROUTING).join(', ')}.`);
  }

  // DISYUNTOR global (F3): tope de llamadas demo/día. Protege el gasto máximo
  // diario aunque el abuso sea distribuido (VPNs, muchas IPs). Incremento atómico
  // con RETURNING; un pequeño rebase por peticiones en vuelo es irrelevante.
  if (tok.tier === 'demo') {
    const st = await bumpStat(env, 'demo_calls');
    if (st > num(env.MAX_DAILY_CALLS, 2000)) {
      return oaiError(403, 'demo_paused',
        'The demo is taking a breather today (daily budget reached). Come back tomorrow, or add your own API key in Settings → Agent.');
    }
  }

  // Decremento ATÓMICO: solo pasa si el token sigue activo y con cuota. El
  // RETURNING evita la carrera leer-luego-escribir entre peticiones simultáneas.
  const dec = await env.DB
    .prepare('UPDATE tokens SET remaining = remaining - 1 WHERE token = ?1 AND active = 1 AND remaining > 0 RETURNING remaining')
    .bind(tok.token).first();
  if (!dec) {
    // El token existía (getToken lo validó) → la cuota se agotó entre medias o justo ahora.
    // 403 y no 429 a propósito: el cliente (IA3) reintenta los 429 con backoff y aquí
    // reintentar no ayuda; el 403 aflora el mensaje al usuario a la primera.
    return oaiError(403, 'demo_exhausted',
      'Demo quota exhausted. Add your own API key in Settings → Agent (BYOK) to keep using the agent.');
  }

  const provider = PROVIDERS[route.provider];
  const upstream = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env[provider.keyEnv]}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...body,
      model: route.model,
      max_tokens: Math.min(Number(body.max_tokens) || MAX_TOKENS_CAP, MAX_TOKENS_CAP),
    }),
  });

  // Passthrough del body (SSE o JSON) con las cabeceras que importan. Las CORS
  // las añade withCors; el resto de cabeceras upstream no se filtran.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
      'X-Quota-Remaining': String(dec.remaining),
    },
  });
}

// POST /demo-token — emite un token demo self-service (F3). Guardas, en orden:
// (1) disyuntor de emisión diaria; (2) 1 demo por IP (hasheada) y día. El botón
// "Probar la demo" del cliente llama aquí y se autoconfigura con la respuesta.
async function handleDemoToken(request, env) {
  const issued = await bumpStat(env, 'tokens_issued');
  if (issued > num(env.MAX_DAILY_TOKENS, 200)) {
    return oaiError(429, 'demo_sold_out',
      'No demo tokens left today. Come back tomorrow, or add your own API key (BYOK).');
  }

  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const ipHash = await sha256Hex(`${env.IP_HASH_SALT || ''}|${ip}`);
  const grant = await env.DB
    .prepare("INSERT INTO demo_grants (ip_hash, day) VALUES (?1, date('now')) ON CONFLICT DO NOTHING RETURNING ip_hash")
    .bind(ipHash).first();
  if (!grant) {
    return oaiError(429, 'demo_already_granted',
      'This network already got a demo today. Try again tomorrow, or add your own API key (BYOK).');
  }

  const token = 'br-demo-' + randomHex(12);
  const quota = num(env.DEMO_QUOTA, 30);
  await env.DB
    .prepare("INSERT INTO tokens (token, remaining, tier, note) VALUES (?1, ?2, 'demo', 'self-service')")
    .bind(token, quota).run();
  return json(200, { token, remaining: quota, model: 'bookreader-fast' });
}

// Incrementa (y crea si no existe) el contador diario indicado; devuelve el valor.
async function bumpStat(env, col) {
  const row = await env.DB
    .prepare(`INSERT INTO daily_stats (day, ${col}) VALUES (date('now'), 1)
              ON CONFLICT(day) DO UPDATE SET ${col} = ${col} + 1 RETURNING ${col}`)
    .first();
  return row ? row[col] : 0;
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- auth / util ---------------------------------------------------------------

// Valida el Bearer br-… contra D1. Devuelve { ok, token } o { ok:false, response }.
async function getToken(request, env) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(br-[\w-]+)$/i);
  if (!m) return { ok: false, response: oaiError(401, 'invalid_token', 'Missing or malformed token (expected "Bearer br-…").') };
  const row = await env.DB.prepare('SELECT active, remaining, tier FROM tokens WHERE token = ?1').bind(m[1]).first();
  if (!row || !row.active) return { ok: false, response: oaiError(401, 'invalid_token', 'Unknown or revoked token.') };
  return { ok: true, token: m[1], remaining: row.remaining, tier: row.tier };
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim());
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Expose-Headers': 'X-Quota-Remaining',
    'Vary': 'Origin',
  };
}

function withCors(response, cors) {
  const h = new Headers(response.headers);
  for (const [k, v] of Object.entries(cors)) h.set(k, v);
  return new Response(response.body, { status: response.status, headers: h });
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

// Errores con la forma OpenAI ({error:{message,code}}): los clientes compatibles
// (bookreader incluido) enseñan `message` al usuario.
function oaiError(status, code, message) {
  return json(status, { error: { message, code, type: 'gateway_error' } });
}
