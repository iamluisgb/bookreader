// LLMProvider — cliente OpenAI-compatible con streaming (BYOK). Funciona con
// cualquier proveedor OpenAI-compatible: base URL, modelo y key son configurables
// (Ajustes → Agente). Por defecto, nan. La key vive solo en el navegador
// (localStorage vía Storage). E1.1 + E1.2 (TEC3) del backlog.
//
// Nota CSP: `connect-src 'self' blob: https:` permite llamar a cualquier endpoint
// HTTPS. `script-src 'self'` sigue intacto, así que la key no es exfiltrable por
// scripts inyectados.
import * as Storage from '../storage.js';
import { t } from '../i18n.js';

const DEFAULT_BASE_URL = 'https://api.nan.builders/v1';

// MON1 F3 · Gateway propio para la demo sin API key (ver workers/gateway y ADR-021).
// El botón "Probar la demo" pide un token self-service y autoconfigura el proveedor.
const GATEWAY_BASE_URL = 'https://bookreader-gateway.luisgonzalezb93.workers.dev/v1';
const DEFAULT_MODEL = 'deepseek-v4-flash';
// Tope de tokens de salida por respuesta. Antes era 2048 (~1500 palabras), que
// cortaba en seco las respuestas largas (análisis del Artesano del Texto, etc.). Con
// 4096 cabe casi todo; si aun así el proveedor corta por longitud (finish_reason
// 'length'), el panel ofrece "Continuar" (ver onDone).
const MAX_TOKENS = 4096;

// Presets para prefijar base URL + modelos sugeridos en la UI. `id: 'custom'` es
// implícito (cualquier base URL fuera de estos). No son exhaustivos: el usuario
// puede escribir su propia base URL y su propio modelo.
// `liteModel` (opcional): modelo por defecto para las llamadas AUXILIARES (expansión de
// consulta, atenuación del TOC) — tareas baratas y sensibles a latencia donde un modelo
// pequeño rinde igual. Solo se declara donde está verificado (nan: qwen3.6 responde en
// <1s y soporta tools); en el resto, las auxiliares usan el modelo principal.
// `concurrent` (opcional): el proveedor tolera peticiones simultáneas con la misma key.
// Se declara solo donde está verificado; sin declarar → se serializa (conservador: es
// lo único seguro ante un BYOK desconocido). nan lo tenía SIN declarar porque en su día
// devolvía "network error" ante concurrencia; ya no: 12/12 simultáneas correctas en dos
// medidas independientes (tests/provider-contract.spec.ts, 2026-08-01 y 2026-08-02).
// `visionModel` (opcional): modelo multimodal del proveedor, para que la VISTA SIMPLE
// pueda dejar "Explicar lo que veo" funcionando sin que el usuario configure un segundo
// slot. Igual que `liteModel`, solo se declara donde está verificado.
// `catalogId` (opcional): clave de este proveedor en models.dev (ver ai/catalog.js).
// Con ella el selector ofrece nombres y capacidades en vez de ids pelados.
// `discover: false`: el proveedor NO deja enumerar sus modelos desde el navegador.
// nan responde 200 a `GET /models` pero sin cabeceras CORS, así que el navegador lo
// bloquea: ofrecer ahí un botón que solo puede fallar es peor que no ofrecerlo
// (verificado 2026-08-02, y el contrato con el proveedor lo revisa).
export const PROVIDERS = [
  { id: 'nan',        name: 'nan',        baseUrl: 'https://api.nan.builders/v1',   models: ['deepseek-v4-flash', 'mimo-v2.5', 'qwen3.6', 'gemma4'], liteModel: 'qwen3.6', visionModel: 'mimo-v2.5', concurrent: true, discover: false },
  { id: 'openai',     name: 'OpenAI',     baseUrl: 'https://api.openai.com/v1',     models: ['gpt-4o', 'gpt-4o-mini', 'o4-mini'], concurrent: true, catalogId: 'openai' },
  // Verificado contra la API real el 2026-08-02 (tests/provider-contract.spec.ts):
  // `claude-3.7-sonnet` y `gemini-2.0-flash-001` ya NO existen en el catálogo, así que
  // el preset ofrecía ids muertos. Los de ahora sí tienen tools y visión.
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1',  models: ['google/gemini-2.5-flash', 'google/gemini-2.5-flash-lite', 'deepseek/deepseek-chat-v3.1', 'anthropic/claude-haiku-4.5'], liteModel: 'google/gemini-2.5-flash-lite', visionModel: 'google/gemini-2.5-flash', concurrent: true, catalogId: 'openrouter' },
  { id: 'groq',       name: 'Groq',       baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'], concurrent: true, catalogId: 'groq' },
];

export function getKey()        { return Storage.get('ai_key', '') || ''; }
export function setKey(k)        { Storage.set('ai_key', k || ''); }
export function getModel()      { return Storage.get('ai_model', DEFAULT_MODEL) || DEFAULT_MODEL; }
export function setModel(m)      { Storage.set('ai_model', (m || '').trim() || DEFAULT_MODEL); }
// Modelo LITE (opcional): para llamadas auxiliares baratas/sensibles a latencia
// (query-expand, attenuation). Resolución: ajuste explícito del usuario → liteModel del
// preset del proveedor → alias lite del gateway (demo) → modelo principal. Las tareas
// que importan (chat, resumen, flashcards, mindmap) NUNCA pasan por aquí.
export function getLiteModelSetting() { return (Storage.get('ai_model_lite', '') || '').trim(); }
export function setLiteModel(m)  { Storage.set('ai_model_lite', (m || '').trim()); }
export function getLiteModel() {
  const explicit = getLiteModelSetting();
  if (explicit) return explicit;
  const preset = currentProvider();
  if (preset && preset.liteModel) return preset.liteModel;
  if (getBaseUrl() === GATEWAY_BASE_URL) return 'bookreader-lite';
  return getModel();
}
// Modelo de VISIÓN (opcional, independiente del de texto): se usa solo en los turnos que
// necesitan "ver" una página (figuras/diagramas). Vacío = no configurado → sin visión.
export function getVisionModel() { return (Storage.get('ai_vision_model', '') || '').trim(); }
export function setVisionModel(m) { Storage.set('ai_vision_model', (m || '').trim()); }
export function hasVision()      { return getVisionModel().length > 0; }

// Modelo de transcripción (voz → texto). Opcional: vacío = se usa el dictado del navegador.
export function getSttModel()    { return (Storage.get('ai_stt_model', '') || '').trim(); }
export function setSttModel(m)   { Storage.set('ai_stt_model', (m || '').trim()); }
export function hasStt()         { return getSttModel().length > 0; }
export function hasKey()         { return getKey().trim().length > 0; }

// Base URL del proveedor (sin barra final). Debe ser el endpoint OpenAI-compatible
// que expone /chat/completions.
export function getBaseUrl()    { return (Storage.get('ai_base_url', DEFAULT_BASE_URL) || DEFAULT_BASE_URL).trim().replace(/\/+$/, ''); }
export function setBaseUrl(u)    { Storage.set('ai_base_url', ((u || '').trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')); }

// ---- Proveedores propios del usuario -----------------------------------------
// Los presets de arriba son los que traemos verificados, pero cualquier endpoint
// OpenAI-compatible vale (un LLM local, un gateway de empresa, un proveedor que no
// conocemos). Guardarlo como PROVEEDOR —y no solo como "base URL personalizada"—
// es lo que le da nombre, lo mete en el desplegable y lo hace utilizable desde la
// vista simple, que es donde vive quien no quiere pensar en esto cada vez.
const CUSTOM_KEY = 'ai_custom_providers';
const normUrl = (u) => (u || '').trim().replace(/\/+$/, '');

export function getCustomProviders() {
  const list = Storage.get(CUSTOM_KEY, []);
  if (!Array.isArray(list)) return [];
  return list.filter(p => p && p.id && p.baseUrl && Array.isArray(p.models) && p.models.length);
}

// Todos los proveedores seleccionables: los de fábrica primero. El resto del código
// resuelve SIEMPRE contra esta lista; `PROVIDERS` es solo la parte de fábrica.
export function allProviders() {
  return [...PROVIDERS, ...getCustomProviders()];
}

export function isCustomProvider(id) { return String(id || '').startsWith('custom:'); }

// Alta o actualización. La identidad de un proveedor es su base URL: guardar dos
// veces el mismo endpoint con distinto nombre daría dos filas que `currentProvider()`
// no sabría distinguir (busca por URL), así que se actualiza la que ya hubiera.
export function saveCustomProvider({ name, baseUrl, models, liteModel, visionModel }) {
  const url = normUrl(baseUrl);
  const list = models.map(m => String(m || '').trim()).filter(Boolean);
  if (!url) throw new Error(t('Falta la Base URL.'));
  if (!list.length) throw new Error(t('Falta el id del modelo.'));
  const clean = {
    id: 'custom:' + url,
    name: (name || '').trim() || url.replace(/^https?:\/\//, '').split('/')[0],
    baseUrl: url,
    models: [...new Set(list)],
    liteModel: (liteModel || '').trim() || undefined,
    visionModel: (visionModel || '').trim() || undefined,
  };
  const rest = getCustomProviders().filter(p => p.baseUrl !== url);
  Storage.set(CUSTOM_KEY, [...rest, clean]);
  return clean;
}

export function removeCustomProvider(id) {
  Storage.set(CUSTOM_KEY, getCustomProviders().filter(p => p.id !== id));
}

// Preset que coincide con la base URL actual, o null si es personalizada.
export function currentProvider() {
  const b = getBaseUrl();
  return allProviders().find(p => normUrl(p.baseUrl) === b) || null;
}

// ---- Vista simple / avanzada de Ajustes → Agente -----------------------------
// Elegir modelo es una decisión que la mayoría no puede tomar (no sabe qué es
// `deepseek-v4-flash` ni por qué debería importarle) y que nosotros SÍ sabemos tomar:
// cada preset declara su modelo bueno. La vista simple pide lo mínimo —proveedor y
// key— y resuelve los cuatro slots; la avanzada es el formulario completo de siempre.
// La preferencia se recuerda: quien la abre una vez, la quiere siempre.
export function isAdvanced()      { return Storage.get('ai_advanced', false) === true; }
export function setAdvanced(v)     { Storage.set('ai_advanced', !!v); }

// ¿Es la demo del gateway lo que está configurado? La vista simple la trata como un
// estado propio (no es un proveedor de la lista y no tiene key que enseñar).
export function isDemo()          { return isGatewayUrl(getBaseUrl()); }

// Igual que isDemo pero para una URL suelta: el formulario avanzado necesita saber si
// lo que hay ESCRITO en el campo sigue siendo el gateway antes de decidir qué hacer
// con una key vacía (el token de la demo no se enseña, así que vacío no es "bórralo").
export function isGatewayUrl(u)   { return (u || '').trim().replace(/\/+$/, '') === GATEWAY_BASE_URL; }

// Reparación de un estado imposible: un token `br-…` es del gateway y solo vale ahí,
// así que verlo junto a otra base URL significa que Ajustes lo movió de sitio (lo hacía
// "Guardar" en la vista simple con la demo activa). El síntoma era 401 en todo, con el
// usuario convencido de que la key de la demo nacía rota. Se restaura la demo en vez de
// dejarla inservible; quien pegue su propia key lo pisa igual que siempre.
if (/^br-/i.test(getKey().trim()) && !isGatewayUrl(getBaseUrl())) {
  setBaseUrl(GATEWAY_BASE_URL);
  setModel('bookreader-fast');
  setVisionModel('');
}

// La vista simple solo sabe representar un preset o la demo. Una base URL propia
// (BYOK contra un proveedor no listado) no cabe en ella: se fuerza la avanzada, o
// abriríamos Ajustes mostrando algo que no es lo que está configurado.
export function canUseSimple()    { return isDemo() || currentProvider() !== null; }

// Los cuatro slots que la vista simple resuelve sola a partir del preset. `model`
// respeta el que ya hubiera si pertenece al proveedor (alguien pudo elegirlo en la
// avanzada); el resto solo se rellenan si están vacíos — nunca pisamos una elección
// explícita del usuario por el hecho de guardar en la vista simple.
export function presetDefaults(providerId) {
  const p = allProviders().find(x => x.id === providerId);
  if (!p) return null;
  return {
    baseUrl: p.baseUrl,
    model: p.models.includes(getModel()) ? getModel() : p.models[0],
    visionModel: getVisionModel() || p.visionModel || '',
    liteModel: getLiteModelSetting(),   // vacío = automático, que ya usa p.liteModel
  };
}

// Descubre los modelos que ofrece el proveedor: GET /models (OpenAI-compatible,
// devuelve `{ data: [{ id }] }`). Acepta baseUrl/key sueltos para poder consultarlos
// con lo que hay en el formulario antes de guardar. Devuelve ids ordenados; lanza si
// la respuesta no es OK. Sujeto a la misma política CORS que /chat/completions.
export async function listModels({ baseUrl, key, signal } = {}) {
  const b = (baseUrl != null ? baseUrl : getBaseUrl()).trim().replace(/\/+$/, '');
  const k = (key != null ? key : getKey()).trim();
  if (!b) throw new Error(t('Falta la Base URL.'));
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
    const err = new Error(t('el proveedor no permite consultar /models desde el navegador (CORS).'));
    err.cors = true;
    throw err;
  }
  if (res.status === 401 || res.status === 403) throw new Error(t('la API key es inválida o falta.'));
  if (!res.ok) throw new Error(t('el proveedor respondió {status}.', { status: res.status }));
  const data = await res.json().catch(() => null);
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  const ids = list.map(m => (typeof m === 'string' ? m : m && m.id)).filter(Boolean);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

// ---- Probar un slot de modelo ----------------------------------------------
// Hay CUATRO slots (principal, rápido, visión, transcripción) y todos son texto libre: un
// id mal escrito no se nota al guardar, se nota mucho después y en otro sitio. `hasVision()`
// solo mira que la cadena no esté vacía, así que un typo deja la feature "activada" y
// fallando en el momento de usarla. Esto convierte ese fallo silencioso y diferido en una
// respuesta inmediata: se prueba el slot con una llamada mínima del tipo que le corresponde.
//
// Usa los valores del FORMULARIO (aún sin guardar), como `listModels`: se prueba antes de
// comprometerse. Va por el carril interactivo de la cola (el usuario espera mirando, pero en
// nan no se puede atropellar una llamada en vuelo).

// PNG de 1×1 transparente: la imagen más pequeña posible para comprobar que el modelo
// acepta contenido multimodal. No nos importa qué conteste, solo que no rechace la forma.
const PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// WAV de silencio (PCM 16 bit mono). Vale para verificar el endpoint y el id del modelo: si
// transcribe a cadena vacía, es un éxito — lo que se prueba es que la llamada no revienta.
function silentWav(ms = 300, rate = 16000) {
  const n = Math.floor(rate * ms / 1000);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  return new Blob([buf], { type: 'audio/wav' });   // el cuerpo ya es todo ceros = silencio
}

// kind: 'text' | 'vision' | 'stt'. Devuelve { ok, ms }; lanza con un mensaje legible.
export async function probeModel({ kind = 'text', model, baseUrl, key, signal } = {}) {
  const b = (baseUrl != null ? baseUrl : getBaseUrl()).trim().replace(/\/+$/, '');
  const k = (key != null ? key : getKey()).trim();
  const m = String(model || '').trim();
  if (!b) throw new Error(t('Falta la Base URL.'));
  if (!k) throw new Error(t('Falta la API key.'));
  if (!m) throw new Error(t('Falta el id del modelo.'));

  const t0 = Date.now();
  const run = async () => {
    let res;
    if (kind === 'stt') {
      const form = new FormData();
      form.append('file', silentWav(), 'probe.wav');
      form.append('model', m);
      res = await fetch(`${b}/audio/transcriptions`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${k}` }, body: form, signal,
      });
    } else {
      const content = kind === 'vision'
        ? [{ type: 'text', text: 'ok?' }, { type: 'image_url', image_url: { url: PIXEL_PNG } }]
        : 'ok?';
      res = await fetch(`${b}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${k}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m, messages: [{ role: 'user', content }], stream: false, max_tokens: 1 }),
        signal,
      });
    }
    if (res.status === 401 || res.status === 403) throw new Error(t('la API key es inválida o falta.'));
    if (res.status === 404) throw new Error(t('el proveedor no reconoce ese modelo (404).'));
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(t('el proveedor respondió {status}. {body}', { status: res.status, body: body.slice(0, 160) }));
    }
    return { ok: true, ms: Date.now() - t0 };
  };

  try {
    return await enqueue(run, false);
  } catch (e) {
    // TypeError de fetch = red caída o CORS. El mensaje del navegador ("Failed to fetch")
    // no le dice nada a nadie; lo traducimos conservando la causa.
    if (e instanceof TypeError) throw new Error(t('no se pudo conectar (red o CORS).'), { cause: e });
    throw e;
  }
}

// Auto-extracción a la libreta tras cada respuesta (por defecto activada).
export function getAutoExtract() { return Storage.get('ai_auto_extract', true); }
export function setAutoExtract(v) { Storage.set('ai_auto_extract', !!v); }

// ---- Cola de llamadas: prioridad + serialización solo donde hace falta -------
// nan rechazaba peticiones concurrentes a la misma key (daba "network error") — ya no,
// ver la nota de `concurrent` arriba y ADR-027. De aquel límite venía una cadena de
// promesas que serializaba TODAS las llamadas de la app. Dos problemas:
//
// 1. Es un límite de UN proveedor aplicado a todos. En OpenAI/Groq/OpenRouter no hace
//    falta y estábamos regalando paralelismo.
// 2. Peor: el CHAT quedaba detrás de los trabajos en segundo plano. Un resumen es un
//    map-reduce de muchas llamadas; preguntar algo durante esa generación encolaba la
//    pregunta detrás de TODOS los trozos que quedaran. jobs.js promete "puede seguir
//    leyendo", pero el agente quedaba inutilizable. Es el mismo argumento por el que
//    `transcribe` ya estaba fuera de la cola: cuando el usuario espera mirando, encolarlo
//    detrás de una generación larga no es aceptable.
//
// Ahora: una cola con dos carriles. Lo interactivo (chat, visión del chat) adelanta a lo
// de fondo (jobs). No hay preempción —una llamada en vuelo se termina—, así que lo que se
// gana es no esperar a los trozos QUE FALTAN, que es donde estaba el minuto de espera.
const INTERACTIVE = 0, BACKGROUND = 1;
const waiting = [[], []];        // [interactivas, de fondo]; FIFO dentro de cada carril
let running = 0;

// ¿Este proveedor tolera llamadas concurrentes? Solo se declara donde está verificado.
// Ante una base URL desconocida (BYOK), lo conservador es serializar: es el comportamiento
// que había, así que ningún proveedor personalizado puede empeorar con este cambio.
function maxConcurrent() {
  const p = currentProvider();
  return p && p.concurrent ? 4 : 1;
}

function pump() {
  while (running < maxConcurrent()) {
    const next = waiting[INTERACTIVE].shift() || waiting[BACKGROUND].shift();
    if (!next) return;
    running++;
    Promise.resolve()
      .then(next.task)
      .then(next.resolve, next.reject)
      .finally(() => { running--; pump(); });
  }
}

// `background: true` manda la llamada al carril lento. Por defecto todo es interactivo:
// si alguien añade una ruta nueva y se olvida de marcarla, el fallo es que va rápida —
// no que el usuario se queda esperando.
function enqueue(task, background) {
  return new Promise((resolve, reject) => {
    waiting[background ? BACKGROUND : INTERACTIVE].push({ task, resolve, reject });
    pump();
  });
}

// Estado de la cola (para tests y diagnóstico).
export function queueState() {
  return { running, interactive: waiting[INTERACTIVE].length, background: waiting[BACKGROUND].length };
}

// Streamea una respuesta de chat. `onToken(text)` se llama por cada fragmento de
// contenido visible. Devuelve el texto completo. `signal` permite abortar.
export function chatStream(opts)  { return enqueue(() => _chatStream(opts), opts?.background); }
export function chatTools(opts)   { return enqueue(() => _chatTools(opts), opts?.background); }
export function chatToolsLoop(opts) { return enqueue(() => _chatToolsLoop(opts), opts?.background); }
export function chatVision(opts)  { return enqueue(() => _chatVision(opts), opts?.background); }

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

// `model` (opcional) permite a una tarea concreta usar otro modelo (p. ej. el lite en
// query-expand/attenuation); sin él, el modelo principal de Ajustes.
async function _chatStream({ messages, onToken, onReasoning, onDone, signal, maxTokens = MAX_TOKENS, model }) {
  const key = getKey().trim();
  if (!key) throw new Error(t('Falta la API key.'));

  const res = await fetchRetrying(`${getBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model || getModel(),
      messages,
      stream: true,
      max_tokens: maxTokens,
    }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401) throw new Error(t('API key inválida (401).'));
    if (res.status === 429) throw new Error(t('Límite de uso alcanzado (429). Reintenta en un momento.'));
    // Si el body tiene forma OpenAI ({error:{message}}), mostrar SOLO el mensaje
    // (el gateway y muchos proveedores la usan); si no, el texto crudo recortado.
    throw new Error(`Error del modelo (${res.status}). ${apiErrMsg(body)}`);
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
async function _chatTools({ messages, tools, toolChoice = 'auto', maxTokens = 1024, signal, model }) {
  const key = getKey().trim();
  if (!key) throw new Error(t('Falta la API key.'));

  const res = await fetchRetrying(`${getBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || getModel(),
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
  if (!key) throw new Error(t('Falta la API key.'));
  const model = getVisionModel();
  if (!model) throw new Error(t('No hay modelo de visión configurado.'));

  const res = await fetchRetrying(`${getBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, max_tokens: maxTokens }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(t('Error del modelo de visión ({status}). {body}', { status: res.status, body: body.slice(0, 200) }));
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
  if (!key) throw new Error(t('Falta la API key.'));
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

// TRANSCRIPCIÓN (voz → texto) contra `/audio/transcriptions`, formato OpenAI. No pasa por
// `serialize`: el usuario espera con el modal delante y encolarlo detrás de una generación
// larga lo dejaría mirando "transcribiendo…" un minuto.
//
// `prompt` es la pieza que justifica todo esto. Whisper lo usa para SESGAR el vocabulario, y
// nosotros tenemos el del capítulo antes de que el usuario hable (concepto + expectativas de
// la sesión Feynman). Medido el 2026-07-28 sobre la misma grabación, en español con términos
// técnicos en inglés:
//   sin prompt: "dos matrices de bajo rago, o sea IV"   ← la frase pierde el sentido
//   con prompt: "dos matrices de bajo rango, o sea A y B"
// También arregla "KVKH" → "KV cache". El navegador no puede hacer esto.
export async function transcribe({ blob, prompt = '', language = '', signal } = {}) {
  const key = getKey().trim();
  if (!key) throw new Error(t('Falta la API key.'));
  const model = getSttModel();
  if (!model) throw new Error(t('No hay modelo de transcripción configurado.'));

  const form = new FormData();
  // El nombre importa: algunos proveedores deciden el formato por la extensión del fichero.
  form.append('file', blob, `audio.${extFor(blob.type)}`);
  form.append('model', model);
  if (prompt) form.append('prompt', prompt.slice(0, 900));   // el límite de Whisper son 224 tokens
  if (language) form.append('language', language);

  // Sin `Content-Type`: lo pone el navegador con el `boundary` del multipart.
  const res = await fetchRetrying(`${getBaseUrl()}/audio/transcriptions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}` },
    body: form,
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401) throw new Error(t('API key inválida (401).'));
    if (res.status === 404) throw new Error(t('El proveedor no ofrece transcripción, o el modelo no existe.'));
    throw new Error(t('Error al transcribir ({status}). {body}', { status: res.status, body: apiErrMsg(body) }));
  }
  const json = await res.json().catch(() => ({}));
  return (json.text || '').trim();
}

function extFor(mime) {
  const m = String(mime || '');
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('wav')) return 'wav';
  return 'webm';
}

// Extrae el `error.message` de un body con forma OpenAI; si no la tiene, recorta el texto.
function apiErrMsg(bodyText) {
  try {
    const m = JSON.parse(bodyText)?.error?.message;
    if (m) return String(m).slice(0, 300);
  } catch (e) { /* no era JSON */ }
  return String(bodyText || '').slice(0, 200);
}

// MON1 F3 · Pide un token demo al gateway y AUTOCONFIGURA el proveedor (base URL +
// key + modelo alias). El usuario no ve token ni URLs: pulsa un botón y pregunta.
export async function requestDemoToken() {
  const res = await fetch(GATEWAY_BASE_URL.replace(/\/v1$/, '') + '/demo-token', { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  setBaseUrl(GATEWAY_BASE_URL);
  setKey(body.token);
  setModel(body.model || 'bookreader-fast');
  return body; // { token, remaining, model }
}
