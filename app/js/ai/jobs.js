// ai/jobs.js — Trabajos pesados de IA (resumen, mapa mental) en SEGUNDO PLANO. El usuario
// pulsa "Generar", puede seguir leyendo, y se le avisa al terminar. UN solo trabajo pesado a
// la vez: las llamadas al LLM ya se serializan en llm.js (nan rechaza concurrencia), y así
// evitamos además interleave resumen↔mapa. El resultado se cachea por libro+tipo, para
// reabrirlo al instante y no re-generar tras clicar una cita.
//
// La UI (chip flotante + toast) vive en jobs-ui.js; los modales (summary/mindmap) aportan la
// función `run` (el bucle map-reduce) y reabren su resultado desde la caché.

import * as DB from './db.js';

const listeners = new Set();
let active = null;              // job en curso o recién terminado, hasta que el usuario lo consume
// `${bookId}:${kind}` -> Array<{ key, id, result, params, at }> (más reciente primero). HISTORIAL:
// cada generación añade una entrada; no se sobrescribe. Espejo en memoria de IndexedDB.
const cache = new Map();
let seq = 0;

// job = { id, bookId, kind, label, params, run, status, progress:{i,n,phase}, result, error, abortCtrl }

function emit() { for (const fn of listeners) { try { fn(active); } catch { /* noop */ } } }

export function subscribe(fn) { listeners.add(fn); fn(active); return () => listeners.delete(fn); }
export function activeJob() { return active; }

// Historial completo de un tipo (más reciente primero) y el más reciente (para reabrir directo).
export function list(bookId, kind) { return cache.get(`${bookId}:${kind}`) || []; }
export function latest(bookId, kind) { return (cache.get(`${bookId}:${kind}`) || [])[0] || null; }
export function cached(bookId, kind) { return latest(bookId, kind); }   // compat: el más reciente

// Al abrir un libro: trae de IndexedDB TODOS sus artefactos (resúmenes/mapas) al espejo en
// memoria, agrupados por tipo y ordenados por fecha. Mezcla por clave con lo que ya haya en
// memoria (recién generado esta sesión, aún no releído) para no perderlo.
export async function loadForBook(bookId) {
  if (!bookId) return;
  try {
    const arts = await DB.getArtifacts(bookId);
    const byKind = new Map();
    for (const a of arts) {
      const k = `${a.bookId}:${a.kind}`;
      if (!byKind.has(k)) byKind.set(k, new Map());
      byKind.get(k).set(a.key, { key: a.key, id: a.id, result: a.result, params: a.params, at: a.createdAt || a.updatedAt || 0 });
    }
    for (const [k, m] of byKind) {
      for (const e of (cache.get(k) || [])) if (!m.has(e.key)) m.set(e.key, e);
      cache.set(k, [...m.values()].sort((a, b) => (b.at || 0) - (a.at || 0)));
    }
  } catch { /* IDB no disponible */ }
}

export function start({ bookId, kind, label, params, run }) {
  if (active && active.status === 'running') active.abortCtrl.abort();   // exclusividad: uno a la vez
  const job = {
    id: ++seq, bookId, kind, label, params, run,
    status: 'running', progress: { i: 0, n: 0, phase: '' },
    result: null, error: null, abortCtrl: new AbortController(),
  };
  active = job; emit();
  const progress = (i, n, phase) => {
    if (active === job) { job.progress = { i, n, phase: phase ?? job.progress.phase }; emit(); }
  };
  (async () => {
    try {
      const result = await run({ signal: job.abortCtrl.signal, progress });
      if (active !== job) return;                       // superado por otro job → descartar
      if (job.abortCtrl.signal.aborted) { active = null; emit(); return; }
      job.status = 'done'; job.result = result;
      // Historial: AÑADE un artefacto nuevo (no sobrescribe el anterior).
      const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(36).slice(2);
      const k = `${bookId}:${kind}`;
      const entry = { key: `${k}:${id}`, id, result, params, at: Date.now() };
      cache.set(k, [entry, ...(cache.get(k) || [])]);
      DB.putArtifact({ bookId, kind, result, params, id }).catch(() => { /* IDB no disponible: queda en memoria */ });
      emit();
    } catch (e) {
      if (active !== job) return;
      if (e.name === 'AbortError') { active = null; }
      else { job.status = 'error'; job.error = e; }
      emit();
    }
  })();
  return job;
}

export function retry(job) {
  if (!job) return null;
  return start({ bookId: job.bookId, kind: job.kind, label: job.label, params: job.params, run: job.run });
}

export function cancel() {
  if (!active) return;
  if (active.status === 'running') active.abortCtrl.abort();
  active = null; emit();
}

// Borra UN artefacto del historial por su clave (Studio): lo quita del espejo en memoria y de
// IndexedDB, y notifica para que el Studio se repinte. No toca los demás del mismo tipo.
export function remove(key) {
  for (const [k, arr] of cache) {
    const i = arr.findIndex(e => e.key === key);
    if (i >= 0) { arr.splice(i, 1); if (!arr.length) cache.delete(k); break; }
  }
  DB.deleteArtifact(key).catch(() => { /* IDB no disponible: bastó con la memoria */ });
  emit();
}

// El usuario consumió el aviso (abrió el resultado o descartó el chip): limpia el job activo.
export function clearActive(id) {
  if (active && active.status !== 'running' && (id == null || active.id === id)) { active = null; emit(); }
}

// Cambio de libro: cancela el trabajo en curso si es de OTRO libro (su índice ya no aplica).
export function cancelForBookChange(newBookId) {
  if (active && active.bookId !== newBookId) {
    if (active.status === 'running') active.abortCtrl.abort();
    active = null; emit();
  }
}
