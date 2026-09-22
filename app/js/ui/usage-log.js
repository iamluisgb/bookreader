// usage-log.js — Registro local de uso (P30 · "Medir antes de rediseñar").
//
// Sin telemetría no hay forma de saber qué feature "no se encuentra": esta es la
// valla mínima. Guarda en localStorage QUÉ controles y eventos se disparan (hints
// mostrados/descartados, guía abierta, pasos completados), con rotación acotada.
// NADA sale del dispositivo: es suelo para auditoría local (exportar backup /
// inspección), no analítica. Si algún día hace falta telemetría real, es otra
// decisión con su propio ADR — nunca un inline aquí.
//
// API mínima a propósito: track(evento, id). El coste tiene que ser tan bajo que
// instrumentar sea gratis; el análisis, aparte.

const LOG_KEY = 'bookreader_ui_log';
const MAX_ENTRIES = 400;

export function track(action, id = '') {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    let log;
    try { log = raw ? JSON.parse(raw) : []; } catch (e) { log = []; }
    if (!Array.isArray(log)) log = [];
    log.push({ ts: Date.now(), a: String(action), id: String(id || '') });
    localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(-MAX_ENTRIES)));
  } catch (e) { /* storage bloqueado: la medición nunca puede romper la app */ }
}

// Volcado para auditoría local (consola, export futuro). Copia defensiva.
export function dump() {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    const log = raw ? JSON.parse(raw) : [];
    return Array.isArray(log) ? log.slice() : [];
  } catch (e) { return []; }
}
