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

async function _chatStream({ messages, onToken, onReasoning, signal }) {
  const key = getKey().trim();
  if (!key) throw new Error('Falta la API key.');

  const res = await fetch(`${getBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: getModel(),
      messages,
      stream: true,
      max_tokens: 2048,
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
        const delta = json.choices?.[0]?.delta || {};
        if (delta.reasoning_content && onReasoning) onReasoning(delta.reasoning_content);
        if (delta.content) {
          full += delta.content;
          if (onToken) onToken(delta.content);
        }
      }
    }
  }
  return full;
}

// Llamada NO-streaming con herramientas. nan/DeepSeek emite tool_calls de forma
// fiable solo sin streaming (verificado en spike E5). Devuelve { content, toolCalls }.
async function _chatTools({ messages, tools, toolChoice = 'auto', signal }) {
  const key = getKey().trim();
  if (!key) throw new Error('Falta la API key.');

  const res = await fetch(`${getBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: getModel(),
      messages,
      tools,
      tool_choice: toolChoice,
      stream: false,
      max_tokens: 1024,
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
