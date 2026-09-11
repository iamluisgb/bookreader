// ai/offline.js — Preguntar al libro SIN COBERTURA (leer en un avión, en el metro).
//
// La observación que lo hace posible: de las dos mitades de una respuesta del agente,
// solo una necesita red. ENCONTRAR el pasaje es local —`retrieval.js` es BM25 en el
// navegador, cero API— y REDACTARLO es lo que vive al otro lado de la conexión. Sin
// cobertura, el agente no se queda mudo: se queda sin prosa.
//
// Así que aquí hay dos cosas, no una:
//
//   1. RESPUESTA DEGRADADA HONESTA — los mejores pasajes del libro para esa pregunta,
//      con sus anclas [[aN]] (clicables, saltan al sitio). No se inventa una respuesta
//      ni se disfraza de una: se dice que es el libro, no el agente.
//   2. COLA — la pregunta queda guardada y se responde de verdad al recuperar la
//      conexión, sin que el usuario tenga que acordarse de repetirla.
//
// Lo que NO se hace, y es deliberado: meter un modelo local (WebLLM/WebGPU). Son 1-2 GB
// de pesos, se come la batería, y un modelo de 1-3B no respeta las anclas de cita — o
// sea, degrada justo el foso del producto en el escenario donde nadie puede verificar
// nada. Ver la conversación de diseño en BACKLOG · OFF1.

import * as Storage from '../storage.js';
import { t } from '../i18n.js';

const QUEUE_KEY = 'ai_offline_queue';
const MAX_QUEUE = 50;          // tope sano: una cola infinita no es una cola, es un vertedero
const MAX_PASSAGES = 6;        // pasajes que se muestran sin redactar (más es un muro de texto)

const listeners = new Set();

// ---- Estado de la conexión ---------------------------------------------------

// `navigator.onLine` miente en un sentido conocido (dice true con wifi de avión sin
// salida), y por eso NO es el único camino: si una llamada falla por red, deliver()
// cae igualmente a la respuesta por pasajes vía `isNetworkError`. Aquí solo se
// resuelve el caso barato, el que evita una espera inútil de varios segundos.
export function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

// ¿Este error es "no hay red"? `fetch` rechaza con TypeError ante DNS/conexión caída,
// y el proveedor puede además devolver un error de timeout propio (llm.js · code
// 'timeout'). Un 4xx/5xx del proveedor NO cuenta: ahí sí hay red y el mensaje real es
// más útil que un puñado de pasajes.
export function isNetworkError(e) {
  if (!e) return false;
  if (e.code === 'timeout') return true;
  if (e.name === 'AbortError') return false;
  return e instanceof TypeError || /network|failed to fetch|load failed|networkerror/i.test(e.message || '');
}

// ---- Respuesta por pasajes ---------------------------------------------------

// Compone la respuesta degradada a partir de los pasajes que YA eligió el retrieval
// del turno (los mismos que habrían ido al modelo): no hay una segunda búsqueda ni un
// criterio distinto, solo se enseña en crudo lo que el agente habría leído.
//
// Sale en Markdown con `[[aN]]` porque el render del panel ya convierte esas anclas en
// citas clicables: sin tocar el renderizador, los pasajes saltan al libro.
export function passageAnswer(picked, { max = MAX_PASSAGES } = {}) {
  const list = (picked || []).slice(0, max);
  if (!list.length) return null;
  const out = [t('**Sin conexión.** No puedo redactarte una respuesta, así que te enseño lo que dice el libro: estos son los pasajes que mejor encajan con tu pregunta.')];
  let chapter = null;
  for (const p of list) {
    if (p.chapter && p.chapter !== chapter) { out.push(`\n### ${p.chapter}`); chapter = p.chapter; }
    out.push(`> [[${p.id}]] ${collapse(p.text)}`);
  }
  return out.join('\n\n');
}

// Los pasajes vienen con los saltos de línea del libro; dentro de una cita de Markdown
// cada salto rompe el bloque. Se compactan a espacios.
function collapse(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

// ---- Cola de preguntas -------------------------------------------------------

function read() {
  const v = Storage.get(QUEUE_KEY, []);
  return Array.isArray(v) ? v : [];
}

function write(list) {
  Storage.set(QUEUE_KEY, list.slice(-MAX_QUEUE));
  for (const fn of listeners) { try { fn(list); } catch { /* un oyente roto no rompe la cola */ } }
}

// Guarda una pregunta para responderla al volver la conexión. Devuelve su uid.
//
// Se guarda `aug` (la pregunta ya montada con el fragmento adjunto, si lo había) y no
// solo el texto: al recuperar la conexión el fragmento de la selección ya no está a
// mano, y sin él la pregunta deíctica («¿qué significa esto?») se responde sola mal.
export function enqueue({ convoId, bookId, question, aug, ref = null }) {
  if (!convoId || !question) return null;
  const uid = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(36).slice(2);
  const list = read();
  list.push({ uid, convoId, bookId, question, aug: aug || question, ref, at: Date.now() });
  write(list);
  return uid;
}

export function pending(convoId = null) {
  const list = read();
  return convoId ? list.filter(x => x.convoId === convoId) : list;
}

export function count() { return read().length; }

export function remove(uid) {
  write(read().filter(x => x.uid !== uid));
}

export function clear() { write([]); }

// Avisos de cambio de la cola (el chip del panel se repinta con esto).
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Llama a `fn` cuando vuelve la conexión. Se engancha a los dos eventos que importan:
// `online` (el del navegador) y volver a la pestaña, porque en móvil el dispositivo
// suele reconectar con la pantalla apagada y `online` llega mientras nadie mira.
export function onBackOnline(fn) {
  const fire = () => { if (!isOffline() && count()) fn(); };
  window.addEventListener('online', fire);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') fire(); });
}
