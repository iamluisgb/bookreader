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
const cache = new Map();        // `${bookId}:${kind}` -> { result, params, at }  (espejo en memoria de IndexedDB)
let seq = 0;

// job = { id, bookId, kind, label, params, run, status, progress:{i,n,phase}, result, error, abortCtrl }

function emit() { for (const fn of listeners) { try { fn(active); } catch { /* noop */ } } }

export function subscribe(fn) { listeners.add(fn); fn(active); return () => listeners.delete(fn); }
export function activeJob() { return active; }
export function cached(bookId, kind) { return cache.get(`${bookId}:${kind}`) || null; }

// Al abrir un libro: trae de IndexedDB sus artefactos ya generados (resumen/mapa) al espejo en
// memoria, para que `cached()` los sirva al instante en la apertura del modal. No pisa un
// resultado más reciente que ya esté en memoria (recién generado en esta sesión).
export async function loadForBook(bookId) {
  if (!bookId) return;
  try {
    const arts = await DB.getArtifacts(bookId);
    for (const a of arts) {
      const k = `${a.bookId}:${a.kind}`;
      const at = a.updatedAt || a.createdAt || 0;
      const ex = cache.get(k);
      if (!ex || (ex.at || 0) < at) cache.set(k, { result: a.result, params: a.params, at });
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
      cache.set(`${bookId}:${kind}`, { result, params, at: Date.now() });
      DB.putArtifact({ bookId, kind, result, params }).catch(() => { /* IDB no disponible: queda en memoria */ });
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

// Borra un artefacto generado (Studio): quita el espejo en memoria y la copia de IndexedDB,
// aborta su job si estuviera en curso, y notifica para que el Studio se repinte.
export function remove(bookId, kind) {
  cache.delete(`${bookId}:${kind}`);
  DB.deleteArtifact(bookId, kind).catch(() => { /* IDB no disponible: bastó con la memoria */ });
  if (active && active.bookId === bookId && active.kind === kind) {
    if (active.status === 'running') active.abortCtrl.abort();
    active = null;
  }
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
