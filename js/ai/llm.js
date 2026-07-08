// LLMProvider — cliente OpenAI-compatible con streaming (BYOK). Funciona con
// cualquier proveedor OpenAI-compatible: base URL, modelo y key son configurables
// (Ajustes → Agente). Por defecto, nan. La key vive solo en el navegador
// (localStorage vía Storage). E1.1 + E1.2 (TEC3) del backlog.
//
// Nota CSP: `connect-src 'self' blob: https:` permite llamar a cualquier endpoint
// HTTPS. `script-src 'self'` sigue intacto, así que la key no es exfiltrable por
// scripts inyectados.
import * as Storage from '../storage.js';

const DEFAULT_BASE_URL = 'https://api.nan.builders/v1';
const DEFAULT_MODEL = 'deepseek-v4-flash';
// Tope de tokens de salida por respuesta. Antes era 2048 (~1500 palabras), que
// cortaba en seco las respuestas largas (análisis del Artesano del Texto, etc.). Con
// 4096 cabe casi todo; si aun así el proveedor corta por longitud (finish_reason
// 'length'), el panel ofrece "Continuar" (ver onDone).
const MAX_TOKENS = 4096;

// Presets para prefijar base URL + modelos sugeridos en la UI. `id: 'custom'` es
// implícito (cualquier base URL fuera de estos). No son exhaustivos: el usuario
// puede escribir su propia base URL y su propio modelo.
export const PROVIDERS = [
  { id: 'nan',        name: 'nan',        baseUrl: 'https://api.nan.builders/v1',   models: ['deepseek-v4-flash', 'mimo-v2.5', 'qwen3.6', 'gemma4'] },
  { id: 'openai',     name: 'OpenAI',     baseUrl: 'https://api.openai.com/v1',     models: ['gpt-4o', 'gpt-4o-mini', 'o4-mini'] },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1',  models: ['deepseek/deepseek-chat', 'anthropic/claude-3.7-sonnet', 'google/gemini-2.0-flash-001'] },
  { id: 'groq',       name: 'Groq',       baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'] },
];

export function getKey()        { return Storage.get('ai_key', '') || ''; }
export function setKey(k)        { Storage.set('ai_key', k || ''); }
export function getModel()      { return Storage.get('ai_model', DEFAULT_MODEL) || DEFAULT_MODEL; }
export function setModel(m)      { Storage.set('ai_model', (m || '').trim() || DEFAULT_MODEL); }
// Modelo de VISIÓN (opcional, independiente del de texto): se usa solo en los turnos que
// necesitan "ver" una página (figuras/diagramas). Vacío = no configurado → sin visión.
export function getVisionModel() { return (Storage.get('ai_vision_model', '') || '').trim(); }
export function setVisionModel(m) { Storage.set('ai_vision_model', (m || '').trim()); }
export function hasVision()      { return getVisionModel().length > 0; }
export function hasKey()         { return getKey().trim().length > 0; }

// Base URL del proveedor (sin barra final). Debe ser el endpoint OpenAI-compatible
// que expone /chat/completions.
export function getBaseUrl()    { return (Storage.get('ai_base_url', DEFAULT_BASE_URL) || DEFAULT_BASE_URL).trim().replace(/\/+$/, ''); }
export function setBaseUrl(u)    { Storage.set('ai_base_url', ((u || '').trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')); }

// Preset que coincide con la base URL actual, o null si es personalizada.
export function currentProvider() {
  const b = getBaseUrl();
  return PROVIDERS.find(p => p.baseUrl.replace(/\/+$/, '') === b) || null;
}

// Descubre los modelos que ofrece el proveedor: GET /models (OpenAI-compatible,
// devuelve `{ data: [{ id }] }`). Acepta baseUrl/key sueltos para poder consultarlos
// con lo que hay en el formulario antes de guardar. Devuelve ids ordenados; lanza si
// la respuesta no es OK. Sujeto a la misma política CORS que /chat/completions.
export async function listModels({ baseUrl, key, signal } = {}) {
  const b = (baseUrl != null ? baseUrl : getBaseUrl()).trim().replace(/\/+$/, '');
  const k = (key != null ? key : getKey()).trim();
  if (!b) throw new Error('Falta la Base URL.');
  let res;
  try {
    res = await fetch(`${b}/models`, {
      headers: k ? { 'Authorization': `Bearer ${k}` } : {},
      signal,
    });
  } catch (e) {
    // TypeError de fetch = fallo de red o, muy habitual aquí, bloqueo CORS: el
    // endpoint /models de algunos proveedores (p. ej. nan) no envía cabeceras CORS,
    // así que el navegador rechaza la respuesta aunque el servidor exista. No hay
    // arreglo posible desde el cliente; lo señalamos para que la UI ofrezca el modo manual.
    const err = new Error('el proveedor no permite consultar /models desde el navegador (CORS).');
    err.cors = true;
    throw err;
  }
  if (res.status === 401 || res.status === 403) throw new Error('la API key es inválida o falta.');
  if (!res.ok) throw new Error(`el proveedor respondió ${res.status}.`);
  const data = await res.json().catch(() => null);
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  const ids = list.map(m => (typeof m === 'string' ? m : m && m.id)).filter(Boolean);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

// Auto-extracción a la libreta tras cada respuesta (por defecto activada).
export function getAutoExtract() { return Storage.get('ai_auto_extract', true); }
export function setAutoExtract(v) { Storage.set('ai_auto_extract', !!v); }

// Streamea una respuesta de chat. `onToken(text)` se llama por cada fragmento de
// contenido visible. Devuelve el texto completo. `signal` permite abortar.
// nan rechaza peticiones concurrentes a la misma key (da "network error"), así que
// serializamos TODAS las llamadas: cada una espera a que termine la anterior.
let lastCall = Promise.resolve();
function serialize(task) {
  const p = lastCall.then(task, task);
  lastCall = p.then(() => {}, () => {});
  return p;
}

export function chatStream(opts)  { return serialize(() => _chatStream(opts)); }
export function chatTools(opts)   { return serialize(() => _chatTools(opts)); }
export function chatToolsLoop(opts) { return serialize(() => _chatToolsLoop(opts)); }
export function chatVision(opts)  { return serialize(() => _chatVision(opts)); }

// ---- IA3 · Reintentos con backoff en errores transitorios --------------------
// Ver ADR-008 en DECISIONS.md. Los proveedores BYOK dan 429/5xx transitorios; casi
// todos se resuelven en segundos. Reintentamos ANTES de consumir el stream (no se
// re-emiten tokens ya mostrados). Helpers puros exportados para poder testarlos.

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
export function isRetryableStatus(status) { return RETRYABLE_STATUS.has(status); }

// Cabecera Retry-After: segundos (número) o fecha HTTP. Devuelve ms o null.
export function parseRetryAfter(value) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(value);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

// Backoff exponencial con jitter, con techo. i = 0,1,2… → ~700, 1400, 2800 ms (+jitter).
export function backoffDelay(i, rnd = Math.random) {
  return Math.min(700 * 2 ** i + rnd() * 300, 8000);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => {
      clearTimeout(t); reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

// fetch con reintentos. Reintenta ante red caída y estados retryables; honra Retry-After.
// Devuelve la respuesta final (aunque siga siendo un error tras agotar): el llamante ya
// tiene su manejo de status. Respeta AbortSignal.
async function fetchRetrying(url, opts, { retries = 3 } = {}) {
  const signal = opts.signal;
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const res = await fetch(url, opts);
      if (res.ok || !isRetryableStatus(res.status) || i === retries) return res;
      const wait = parseRetryAfter(res.headers.get('retry-after')) ?? backoffDelay(i);
      await sleep(wait, signal);
    } catch (e) {
      if (e.name === 'AbortError') throw e;   // abort del usuario: no reintentar
      lastErr = e;
      if (i === retries) throw e;             // agotados: propaga el error de red
      await sleep(backoffDelay(i), signal);
    }
  }
  throw lastErr;
}

async function _chatStream({ messages, onToken, onReasoning, onDone, signal, maxTokens = MAX_TOKENS }) {
  const key = getKey().trim();
  if (!key) throw new Error('Falta la API key.');

  const res = await fetchRetrying(`${getBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: getModel(),
      messages,
      stream: true,
      max_tokens: maxTokens,
    }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('API key inválida (401).');
    if (res.status === 429) throw new Error('Límite de uso alcanzado (429). Reintenta en un momento.');
    throw new Error(`Error del modelo (${res.status}). ${body.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let finishReason = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE: eventos separados por \n\n, cada línea "data: {json}".
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      for (const line of part.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        let json;
        try { json = JSON.parse(payload); } catch { continue; }
        const choice = json.choices?.[0] || {};
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta || {};
        if (delta.reasoning_content && onReasoning) onReasoning(delta.reasoning_content);
        if (delta.content) {
          full += delta.content;
          if (onToken) onToken(delta.content);
        }
      }
    }
  }
  // finish_reason 'length' = el proveedor cortó por el tope de tokens (respuesta
  // incompleta). El llamante puede ofrecer "Continuar".
  if (onDone) onDone({ finishReason, truncated: finishReason === 'length' });
  return full;
}

// Llamada NO-streaming con herramientas. nan/DeepSeek emite tool_calls de forma
// fiable solo sin streaming (verificado en spike E5). Devuelve { content, toolCalls }.
async function _chatTools({ messages, tools, toolChoice = 'auto', maxTokens = 1024, signal }) {
  const key = getKey().trim();
  if (!key) throw new Error('Falta la API key.');

  const res = await fetchRetrying(`${getBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: getModel(),
      messages,
      tools,
      tool_choice: toolChoice,
      stream: false,
      max_tokens: maxTokens,
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Error del modelo (${res.status}). ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  const msg = json.choices?.[0]?.message || {};
  const toolCalls = (msg.tool_calls || []).map(tc => {
    let args = {};
    try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* args inválidos */ }
    return { name: tc.function?.name, args };
  });
  return { content: msg.content || '', toolCalls };
}

// Llamada MULTIMODAL (texto + imagen) al MODELO DE VISIÓN. `messages` ya trae el contenido
// en formato OpenAI-compatible (content puede ser un array con {type:'text'} y
// {type:'image_url'}). No streaming (más simple y suficiente para un turno de visión).
async function _chatVision({ messages, signal, maxTokens = 1024 }) {
  const key = getKey().trim();
  if (!key) throw new Error('Falta la API key.');
  const model = getVisionModel();
  if (!model) throw new Error('No hay modelo de visión configurado.');

  const res = await fetchRetrying(`${getBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, max_tokens: maxTokens }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Error del modelo de visión (${res.status}). ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content || '';
}

// Bucle multi-turno de tool-use (IA5 Fase 1b, ver DECISIONS.md · ADR-009). No-streaming
// (nan/DeepSeek solo emiten tool_calls fiables sin streaming). En cada ronda el modelo
// puede pedir herramientas; ejecutamos `execute(name, args)` (async → string) y le
// devolvemos el resultado como mensaje `tool` (preservando tool_call_id), hasta que deje
// de pedir herramientas o se agoten las rondas. Devuelve { content, rounds, calls }.
async function _chatToolsLoop({ messages, tools, execute, maxRounds = 3, signal }) {
  const key = getKey().trim();
  if (!key) throw new Error('Falta la API key.');
  const convo = [...messages];
  const calls = [];
  for (let round = 1; round <= maxRounds; round++) {
    const res = await fetchRetrying(`${getBaseUrl()}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: getModel(), messages: convo, tools,
        tool_choice: round < maxRounds ? 'auto' : 'none',   // última ronda: obliga a cerrar
        stream: false, max_tokens: 1024,
      }),
      signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Error del modelo (${res.status}). ${body.slice(0, 200)}`);
    }
    const msg = (await res.json()).choices?.[0]?.message || {};
    const toolCalls = msg.tool_calls || [];
    if (!toolCalls.length) return { content: msg.content || '', rounds: round, calls };
    // El proveedor exige devolver el mensaje del asistente (con sus tool_calls) antes que
    // los resultados de herramienta.
    convo.push({ role: 'assistant', content: msg.content || null, tool_calls: toolCalls });
    for (const tc of toolCalls) {
      let args = {};
      try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* args inválidos */ }
      let result;
      try { result = await execute(tc.function?.name, args); } catch (e) { result = 'ERROR: ' + e.message; }
      calls.push({ name: tc.function?.name, args });
      convo.push({ role: 'tool', tool_call_id: tc.id, name: tc.function?.name, content: String(result ?? '') });
    }
  }
  return { content: '', rounds: maxRounds, calls, exhausted: true };
}
