// fsrs-optimizer.worker.js — Entrena los parámetros FSRS-6 de ESTA persona (P44 F4).
//
// Corre fsrs-rs (el motor de Anki) compilado a WebAssembly (`vendor/fsrs-browser-6.6.0`), en
// un worker para no congelar la pantalla mientras entrena. Sin hilos: el pool de rayon pide
// aislamiento entre orígenes (COOP/COEP) y la app no lo tiene; en un solo hilo un historial
// de miles de repasos tarda segundos. Nada sale del dispositivo.
//
// Entrada: { ratings, deltas, lengths } (Uint32Array), ítems = prefijos de la historia de cada
// tarjeta, como espera fsrs-rs. Salida: { ok: true, w: number[21] } o { ok: false, error }.
import init, { Fsrs } from '../../vendor/fsrs-browser-6.6.0/fsrs_browser.js';

self.onmessage = async function onMessage({ data }) {
  try {
    await init();
    const fsrs = new Fsrs();
    const w = fsrs.computeParameters(data.ratings, data.deltas, data.lengths, null, true);
    self.postMessage({ ok: true, w: Array.from(w, x => +x.toFixed(4)) });
  } catch (e) {
    self.postMessage({ ok: false, error: String(e?.message || e) });
  }
};
