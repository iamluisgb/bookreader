// fsrs-params.js — Parámetros FSRS personales: cuándo se pueden calcular, cómo y si mejoran
// (P44 F4).
//
// FSRS trae parámetros de serie que ya funcionan bien; ajustados a la historia de cada uno
// predicen mejor su memoria y piden menos repasos para la misma retención. Anki lo hace con
// un botón y recomienda repetirlo más o menos cada mes. Aquí igual, con tres reglas:
// 1. Solo historias COMPLETAS: tarjetas cuyo primer intento registrado es su primer repaso
//    (`prevInterval === null`). El registro de intentos empezó el 15-oct-2026, y la historia
//    a medias de una tarjeta vieja enseñaría al optimizador una curva que no es.
// 2. No se aplica solo: se enseña el resultado (error de predicción y repasos del próximo mes,
//    con los de serie y con los tuyos) y el lector decide. Si no mejora, ni se ofrece.
// 3. Viaja con el sync (es un ajuste en localStorage) y se puede volver a los de serie.
import * as Storage from '../storage.js';
import * as Srs from './srs.js';

const KEY = 'fsrs_params';
export const MIN_REVIEWS = 400;   // por debajo, el resultado depende más del azar que de ti
const G = { again: 1, hard: 2, good: 3, easy: 4 };

export function stored() {
  const v = Storage.get(KEY, null);
  return v && Array.isArray(v.w) && v.w.length === 21 ? v : null;
}

// Aplica los parámetros guardados (o los de serie). Barato: se llama al abrir el repaso, el
// análisis y la biblioteca, así un cambio que llegue por sync entra en la siguiente apertura.
export function applyStored() {
  Srs.setParameters(stored()?.w || null);
}

// Se guarda la vuelta a los de serie (sin `w`) en vez de borrar la clave: así viaja por el
// sync y el otro dispositivo también vuelve.
export function reset() {
  Storage.set(KEY, { w: null, ts: Date.now() });
  applyStored();
}

export function accept(result) {
  Storage.set(KEY, {
    w: result.w, ts: Date.now(), reviews: result.reviews,
    lossDefault: result.lossDefault, lossPersonal: result.lossPersonal,
  });
  applyStored();
}

// Historias completas por tarjeta: [{ uid, reviews: [{ g, dt, ts }] }] con dt en días desde el
// repaso anterior (0 en el primero y en los del mismo día).
export function histories(attempts) {
  const by = new Map();
  for (const a of attempts || []) {
    if (!a || a.mode === 'widget' || !a.grade || !a.cardUid) continue;
    if (!by.has(a.cardUid)) by.set(a.cardUid, []);
    by.get(a.cardUid).push(a);
  }
  const out = [];
  for (const [uid, list] of by) {
    list.sort((a, b) => a.ts - b.ts);
    if (list[0].prevInterval !== null) continue;          // historia a medias (regla 1)
    let prev = null;
    out.push({
      uid,
      reviews: list.map((a) => {
        const dt = prev == null ? 0 : Math.max(0, Srs.dayOf(a.ts) - Srs.dayOf(prev));
        prev = a.ts;
        return { g: G[a.grade] || 3, dt, ts: a.ts };
      }),
    });
  }
  return out;
}

// Repasos que sirven para entrenar: todos menos el primero de cada historia.
export function trainableReviews(hist) {
  return hist.reduce((n, h) => n + Math.max(0, h.reviews.length - 1), 0);
}

// Ítems de fsrs-rs: cada prefijo de longitud ≥ 2 de cada historia.
export function toItems(hist) {
  const ratings = [], deltas = [], lengths = [];
  for (const h of hist) {
    for (let L = 2; L <= h.reviews.length; L++) {
      for (let k = 0; k < L; k++) { ratings.push(h.reviews[k].g); deltas.push(h.reviews[k].dt); }
      lengths.push(L);
    }
  }
  return { ratings: new Uint32Array(ratings), deltas: new Uint32Array(deltas), lengths: new Uint32Array(lengths) };
}

// Error de predicción (log loss) de unos parámetros sobre la historia: en cada repaso de otro
// día, la probabilidad de recordar que daba el modelo frente a lo que pasó. Menor es mejor.
// Los repasos del mismo día no cuentan (el benchmark de FSRS tampoco): no miden la curva.
export function logLoss(hist, w) {
  return Srs.withParameters(w, () => {
    let loss = 0, n = 0;
    for (const h of hist) {
      let state = null;
      for (const r of h.reviews) {
        if (state && r.dt > 0) {
          const p = Math.min(1 - 1e-4, Math.max(1e-4, Srs.retrievability(r.dt, state.stability)));
          const y = r.g > 1 ? 1 : 0;
          loss -= y * Math.log(p) + (1 - y) * Math.log(1 - p);
          n++;
        }
        state = Srs.nextMemory(state, r.g, r.dt);
      }
    }
    return n ? loss / n : null;
  });
}

// Repasos previstos en los próximos 30 días, suponiendo que cada repaso sale bien. Las
// tarjetas con historia completa se re-calculan con `w`; el resto conserva su estado, así que
// la diferencia entre los de serie y los tuyos sale solo de lo que el optimizador aprendió.
export function projectReviews(decks, hist, w, now = Date.now()) {
  const byUid = new Map(hist.map(h => [h.uid, h]));
  const today = Srs.dayOf(now);
  return Srs.withParameters(w, () => {
    let total = 0;
    for (const d of decks || []) for (const c of d.cards || []) {
      if (!c || c.deleted || c.suspended || !c.srs) continue;
      let state, last;
      const h = byUid.get(c.uid);
      if (h) {
        state = null;
        for (const r of h.reviews) state = Srs.nextMemory(state, r.g, r.dt);
        last = Srs.dayOf(h.reviews[h.reviews.length - 1].ts);
      } else {
        const S = Srs.stabilityOf(c.srs);
        if (!S) continue;
        state = { stability: S, difficulty: c.srs.difficulty || 5 };
        last = c.srs.due - Math.max(1, c.srs.interval || 1);
      }
      let due = Math.max(today, last + Math.max(1, Math.round(state.stability)));
      while (due <= today + 30) {
        total++;
        state = Srs.nextMemory(state, 3, Math.max(1, due - last));
        last = due;
        due = last + Math.max(1, Math.min(365, Math.round(state.stability)));
      }
    }
    return total;
  });
}

// Entrena en un worker. `attempts` y `decks` vienen de quien llama (Análisis ya los tiene).
export function optimize(attempts, decks, now = Date.now()) {
  const hist = histories(attempts);
  const reviews = trainableReviews(hist);
  if (reviews < MIN_REVIEWS) return Promise.resolve({ ok: false, reason: 'few', reviews });
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./fsrs-optimizer.worker.js', import.meta.url), { type: 'module' });
    const done = (r) => { worker.terminate(); resolve(r); };
    worker.onerror = (e) => done({ ok: false, reason: 'error', error: e.message || 'worker' });
    worker.onmessage = ({ data }) => {
      if (!data.ok) return done({ ok: false, reason: 'error', error: data.error });
      const w = data.w;
      const lossDefault = logLoss(hist, Srs.DEFAULT_PARAMETERS);
      const lossPersonal = logLoss(hist, w);
      done({
        ok: true, w, reviews, lossDefault, lossPersonal,
        better: lossPersonal != null && lossDefault != null && lossPersonal < lossDefault,
        projDefault: projectReviews(decks, hist, Srs.DEFAULT_PARAMETERS, now),
        projPersonal: projectReviews(decks, hist, w, now),
      });
    };
    worker.postMessage(toItems(hist));
  });
}
