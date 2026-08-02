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
// Riesgo aceptado F1: todos los usuarios comparten la key de nan. Se aceptó porque nan
// rechazaba las peticiones concurrentes por key; medido el 2026-08-02, ya no lo hace
// (12/12 simultáneas correctas), así que el riesgo es menor de lo que decía esta nota.
// Los reintentos del cliente (IA3) siguen absorbiendo transitorios; el pool de keys (F2)
// solo si la telemetría muestra colisiones reales.

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
  // Llamadas auxiliares del cliente (query-expand, attenuation): modelo pequeño y
  // rápido (~0.8s vs ~3s del fast, que gasta tokens razonando donde no aporta).
  'bookreader-lite': {
    provider: 'nan',
    model: 'qwen3.6',
    caps: { tools: true, vision: false },
  },
};

// `urlEnv` permite apuntar el proveedor a otro sitio sin tocar código: un mock en
// `wrangler dev` (así se verifican allowlist y devolución de cuota sin gastar
// llamadas reales) o un endpoint de staging. En producción no está definido.
const PROVIDERS = {
  nan: { baseUrl: 'https://api.nan.builders/v1', keyEnv: 'NAN_API_KEY', urlEnv: 'NAN_BASE_URL' },
};

const MAX_TOKENS_CAP = 8192; // mismo techo que usa el cliente; nadie lo sube desde fuera

// Techos de ENTRADA. `MAX_TOKENS_CAP` solo acota la salida: sin esto, una llamada
// puede llevar megas de mensajes y sigue contando **1** contra la cuota y contra
// MAX_DAILY_CALLS — es decir, los disyuntores diarios no acotarían el gasto real.
// El cliente presupuesta 60K tokens de libro por turno (`context.js`
// DEFAULT_BUDGET_TOKENS) + historial + system: 90K deja margen holgado sin dejar
// hueco al abuso. Las imágenes van aparte porque una captura de página (1024px,
// JPEG q0.85) son ~350 KB de data URI y no son "texto" que estimar.
const LIMITS = {
  bodyChars: 1_048_576,  // 1 MB; el peor caso legítimo (visión: imagen + texto) ronda 500 KB
  inputTokens: 90_000,   // solo texto, misma estimación de ~4 chars/token que context.js
  images: 2,             // el cliente adjunta 1 página por turno
};

// Parámetros que se reenvían al proveedor. Allowlist y no `...body` a propósito:
// campos como `n` o `best_of` multiplican el coste de una llamada que la cuota
// sigue contando como una. Lo que el cliente usa (llm.js): messages, stream,
// max_tokens, tools, tool_choice; el resto son estándar e inocuos en coste.
const PASSTHROUGH = [
  'messages', 'stream', 'max_tokens', 'tools', 'tool_choice',
  'temperature', 'top_p', 'stop', 'response_format', 'seed',
];

// F3 · Demo self-service (los topes viven en vars de wrangler.jsonc para ajustarlos
// sin tocar código): cuota por token, tokens emitidos/día e llamadas demo/día.
const num = (v, d) => Number.isFinite(Number(v)) ? Number(v) : d;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === '/v1/models' && request.method === 'GET') {
        return withCors(await handleModels(request, env), cors);
      }
      if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
        return withCors(await handleChat(request, env, ctx), cors);
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
async function handleChat(request, env, ctx) {
  const tok = await getToken(request, env);
  if (!tok.ok) return tok.response;

  // Se lee como texto para poder medir ANTES de parsear: un JSON.parse de 100 MB
  // ya es trabajo (y memoria) hecho a cuenta de quien abusa.
  const raw = await request.text();
  if (raw.length > LIMITS.bodyChars) {
    return oaiError(413, 'request_too_large',
      `Request body too large (max ${Math.round(LIMITS.bodyChars / 1024)} KB).`);
  }

  let body;
  try { body = JSON.parse(raw); } catch {
    return oaiError(400, 'invalid_request', 'Body must be JSON.');
  }

  const size = measureInput(body.messages);
  if (size.images > LIMITS.images) {
    return oaiError(400, 'too_many_images', `At most ${LIMITS.images} images per request.`);
  }
  if (size.tokens > LIMITS.inputTokens) {
    return oaiError(413, 'context_too_large',
      `Input context too large (~${size.tokens} tokens, max ${LIMITS.inputTokens}).`);
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
  const baseUrl = env[provider.urlEnv] || provider.baseUrl;
  const upstream = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env[provider.keyEnv]}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...pick(body, PASSTHROUGH),
      model: route.model,
      max_tokens: Math.min(Number(body.max_tokens) || MAX_TOKENS_CAP, MAX_TOKENS_CAP),
    }),
  });

  // El fallo del proveedor no lo paga el usuario: si el upstream se cae (o rechaza
  // por concurrencia sobre la key compartida — riesgo aceptado en ADR-021 §6), se
  // devuelve la llamada a la cuota. Perder llamadas de la demo sin recibir nada es
  // la peor primera impresión posible justo donde queremos convertir.
  let remaining = dec.remaining;
  if (upstream.status >= 500) {
    const back = await env.DB
      .prepare('UPDATE tokens SET remaining = remaining + 1 WHERE token = ?1 RETURNING remaining')
      .bind(tok.token).first();
    if (back) remaining = back.remaining;
  }

  const headers = {
    'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
    'X-Quota-Remaining': String(remaining),
  };

  // MEDICIÓN (F1.2). Contadores agregados por día, jamás contenido: retención cero
  // intacta. La estimación de entrada se registra siempre; el `usage` real solo se
  // puede leer en las respuestas NO streaming (las de tools y visión) — el stream se
  // reenvía sin parsear, como manda ADR-021 §5. Con las dos series se calibra la
  // estimación y se extrapola al total.
  const stats = { calls: 1, est_input_tokens: size.tokens };

  if (body.stream === true || !upstream.ok) {
    // Passthrough intacto del stream (o del error): no se toca el body.
    ctx?.waitUntil(addStats(env, stats));
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  // No streaming: la respuesta es un JSON pequeño que hay que leer entero de todas
  // formas para reenviarlo, así que leer `usage` de paso no cuesta nada.
  const text = await upstream.text();
  const usage = extractUsage(text);
  if (usage) {
    stats.measured_calls = 1;
    // La estimación de ESTA llamada, aparte: es el término comparable con
    // real_input_tokens. Contra `est_input_tokens` (que incluye las de streaming,
    // sin `usage`) el cociente no mide el error de la estimación sino el mix de
    // tráfico.
    stats.est_input_measured = size.tokens;
    stats.real_input_tokens = usage.input;
    stats.real_output_tokens = usage.output;
  }
  ctx?.waitUntil(addStats(env, stats));
  return new Response(text, { status: upstream.status, headers });
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
  const ipHash = await sha256Hex(`${env.IP_HASH_SALT || ''}|${ipBucket(ip)}`);
  const grant = await env.DB
    .prepare("INSERT INTO demo_grants (ip_hash, day) VALUES (?1, date('now')) ON CONFLICT DO NOTHING RETURNING ip_hash")
    .bind(ipHash).first();
  if (!grant) {
    return oaiError(429, 'demo_already_granted',
      'This network already got a demo today. Try again tomorrow, or add your own API key (BYOK).');
  }

  // Higiene: las concesiones viejas ya no sirven para nada (el límite es por día).
  // Se barren aquí y no en un cron para no añadir otra pieza que operar.
  await env.DB.prepare("DELETE FROM demo_grants WHERE day < date('now', '-30 day')").run();

  const token = 'br-demo-' + randomHex(12);
  const quota = num(env.DEMO_QUOTA, 30);
  await env.DB
    .prepare("INSERT INTO tokens (token, remaining, tier, note) VALUES (?1, ?2, 'demo', 'self-service')")
    .bind(token, quota).run();
  return json(200, { token, remaining: quota, model: 'bookreader-fast' });
}

// Columnas de daily_stats que se pueden incrementar. Los nombres se interpolan en
// el SQL (D1 no parametriza identificadores), así que la allowlist es lo que evita
// que un nombre inesperado acabe en la sentencia.
const STAT_COLS = [
  'tokens_issued', 'demo_calls', 'calls',
  'est_input_tokens', 'measured_calls', 'est_input_measured',
  'real_input_tokens', 'real_output_tokens',
];

// Incrementa (y crea si no existe) el contador diario indicado; devuelve el valor.
async function bumpStat(env, col) {
  const row = await addStats(env, { [col]: 1 }, col);
  return row ? row[col] : 0;
}

// Suma varios contadores del día en una sola sentencia atómica. `returning` pide
// de vuelta una columna (la usa el disyuntor para decidir en el acto).
async function addStats(env, deltas, returning) {
  const cols = Object.keys(deltas).filter((c) => STAT_COLS.includes(c));
  if (!cols.length) return null;
  const vals = cols.map((c) => Number(deltas[c]) || 0);
  const params = cols.map((_, i) => `?${i + 1}`);
  const sets = cols.map((c, i) => `${c} = ${c} + ?${i + 1}`);
  const tail = returning && STAT_COLS.includes(returning) ? ` RETURNING ${returning}` : '';
  return env.DB
    .prepare(`INSERT INTO daily_stats (day, ${cols.join(', ')}) VALUES (date('now'), ${params.join(', ')})
              ON CONFLICT(day) DO UPDATE SET ${sets.join(', ')}${tail}`)
    .bind(...vals)
    .first();
}

// Saca {input, output} del `usage` de una respuesta OpenAI-compatible. Solo mira
// esos dos números: el resto del cuerpo ni se guarda ni se registra.
export function extractUsage(text) {
  let u;
  try { u = JSON.parse(text)?.usage; } catch { return null; }
  if (!u) return null;
  const input = Number(u.prompt_tokens);
  const output = Number(u.completion_tokens);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  return { input: input || 0, output: output || 0 };
}

// ---- límites de entrada (puros: testeados en test/limits.test.mjs) --------------

// Copia solo las claves permitidas (ver PASSTHROUGH).
export function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

// Estima el tamaño de entrada de `messages` (formato OpenAI). Devuelve tokens de
// TEXTO (~4 chars/token, igual que context.js) e imágenes contadas aparte: un data
// URI de imagen son cientos de KB que no tiene sentido medir como texto.
export function measureInput(messages) {
  let chars = 0, images = 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    const c = m?.content;
    if (typeof c === 'string') { chars += c.length; continue; }
    for (const part of Array.isArray(c) ? c : []) {
      if (part?.type === 'image_url') images++;
      else if (typeof part?.text === 'string') chars += part.text.length;
    }
    // tool_calls: los argumentos son JSON y también ocupan contexto.
    for (const tc of Array.isArray(m?.tool_calls) ? m.tool_calls : []) {
      chars += (tc?.function?.arguments || '').length;
    }
  }
  return { tokens: Math.round(chars / 4), images };
}

// Agrupa la IP en su bloque de red antes de hashearla. Con la IP exacta, "1 demo
// por IP y día" no frena nada en IPv6: a un usuario doméstico le sobran direcciones
// dentro de su propia /64 para pedir tokens indefinidamente y vaciar la demo del
// día (MAX_DAILY_TOKENS) para todos. /64 en IPv6 y /24 en IPv4 (que además agrupa
// el CGNAT móvil). Coste: vecinos de la misma red comparten cupo — aceptable para
// una demo de 30 llamadas, y `MAX_DAILY_TOKENS` sigue siendo el techo global.
export function ipBucket(ip) {
  if (!ip.includes(':')) return ip.split('.').slice(0, 3).concat('0/24').join('.');
  // Expandir `::` para que 2001:db8::1 y 2001:db8:0:0:0:0:0:1 caigan en el mismo bucket.
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::')
    ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t]
    : ip.split(':');
  return groups.slice(0, 4).map((g) => (g || '0').replace(/^0+(?=.)/, '')).join(':') + '::/64';
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
