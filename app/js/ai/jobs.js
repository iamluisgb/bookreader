// ai/jobs.js — Trabajos pesados de IA (resumen, mapa mental) en SEGUNDO PLANO. El usuario
// pulsa "Generar", puede seguir leyendo, y se le avisa al terminar. UN solo trabajo pesado a
// la vez: las llamadas al LLM ya se serializan en llm.js (nan rechaza concurrencia), y así
// evitamos además interleave resumen↔mapa. El resultado se cachea por libro+tipo, para
// reabrirlo al instante y no re-generar tras clicar una cita.
//
// La UI (chip flotante + toast) vive en jobs-ui.js; los modales (summary/mindmap) aportan la
// función `run` (el bucle map-reduce) y reabren su resultado desde la caché.

const listeners = new Set();
let active = null;              // job en curso o recién terminado, hasta que el usuario lo consume
const cache = new Map();        // `${bookId}:${kind}` -> { result, params, at }
let seq = 0;

// job = { id, bookId, kind, label, params, run, status, progress:{i,n,phase}, result, error, abortCtrl }

function emit() { for (const fn of listeners) { try { fn(active); } catch { /* noop */ } } }

export function subscribe(fn) { listeners.add(fn); fn(active); return () => listeners.delete(fn); }
export function activeJob() { return active; }
export function cached(bookId, kind) { return cache.get(`${bookId}:${kind}`) || null; }

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
