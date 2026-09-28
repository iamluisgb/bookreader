// P10 · Modo Estudiar — scheduler de repetición espaciada (FSRS-5 desde P19; antes SM-2).
// Módulo PURO (sin DOM, sin IndexedDB): recibe estados y fechas, devuelve estados nuevos.
// El estado vive inline en cada tarjeta (`card.srs`); una tarjeta sin `srs` es NUEVA.
//
// P10 eligió SM-2; P19 lo cambió a FSRS-5 (ver más abajo). El estado se diseñó migrable y
// lo fue: las tarjetas ya programadas se convierten en su siguiente repaso.
//
// `due` e `interval` se miden en DÍAS (medianoche local): "vence hoy" significa hoy de
// calendario, no "hace 24h exactas" — el repaso es un hábito diario, no un cronómetro.

import { t } from '../i18n.js';

export const RATINGS = ['again', 'hard', 'good', 'easy'];

const EASE_START = 2.5;
const MAX_INTERVAL = 365;     // techo: nunca agendar a más de un año

// Fallos a partir de los cuales una tarjeta es un "leech" (mismo umbral que Anki, que ya
// exportamos en la config del .apkg: ver anki-export.js `leechFails`).
export const LEECH_LAPSES = 8;

// Día de calendario local (días desde epoch, cortando a medianoche local).
export function dayOf(ts) {
  const d = new Date(ts);
  return Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 86400000);
}

export function newState(now = Date.now()) {
  return { reps: 0, lapses: 0, ease: EASE_START, interval: 0, due: dayOf(now), lastReview: 0 };
}

// ¿La tarjeta toca hoy? Las nuevas (sin srs) siempre tocan. Una tarjeta borrada
// (tombstone que aún viaja por el sync) o SUSPENDIDA no toca nunca.
export function isDue(card, now = Date.now()) {
  if (!card || card.deleted || card.suspended) return false;
  return !card.srs || card.srs.due <= dayOf(now);
}

// ¿Tarjeta "leech" (fallada una y otra vez)? En Anki el leech suele ser material difícil;
// aquí las tarjetas las escribe un LLM, así que lo más probable es que esté MAL FORMULADA
// —ambigua, con dos preguntas dentro, o con una respuesta que no está en el pasaje—. Por
// eso el repaso no la suspende solo: la señala y ofrece editarla, que es el arreglo real.
export function isLeech(card) {
  if (!card || card.deleted || card.suspended) return false;
  return (card.srs?.lapses || 0) >= LEECH_LAPSES;
}

export function dueCount(cards, now = Date.now()) {
  return (cards || []).filter(c => isDue(c, now)).length;
}

// ---- FSRS-5 (P19) ------------------------------------------------------------------
// Sustituye a SM-2: con parámetros por defecto y sin historial ya predice el recuerdo mejor
// que SM-2 en el 99,5 % de los usuarios y pide un 20-30 % menos de repasos para la misma
// retención (ver BACKLOG · P19). Modelo DSR: cada tarjeta guarda su ESTABILIDAD (días hasta
// que la probabilidad de recordarla baja al 90 %) y su DIFICULTAD (1–10). El intervalo es la
// estabilidad: con retención objetivo 0,9 y esta curva, I = S.
//
// Compatibilidad: el estado sigue siendo `{reps, lapses, interval, due, lastReview}` (+ `ease`
// heredado, que ya no se usa) y se AÑADEN `stability` y `difficulty`. Una tarjeta programada
// con SM-2 se convierte al vuelo en su primer repaso: la estabilidad sale de su intervalo
// (lo que el SM-2 ya había aprendido de ella) y la dificultad, de su ease.
const W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192,
  1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621];
const DECAY = -0.5;
const FACTOR = 19 / 81;
const G = { again: 1, hard: 2, good: 3, easy: 4 };
const clampD = (d) => Math.min(10, Math.max(1, d));

export function retrievability(elapsedDays, stability) {
  return Math.pow(1 + FACTOR * Math.max(0, elapsedDays) / stability, DECAY);
}
const initS = (g) => Math.max(W[g - 1], 0.1);
const initD = (g) => clampD(W[4] - Math.exp(W[5] * (g - 1)) + 1);
function nextD(d, g) {
  const delta = -W[6] * (g - 3);
  const dp = d + delta * (10 - d) / 9;                    // cambio lineal amortiguado
  return clampD(W[7] * initD(4) + (1 - W[7]) * dp);       // reversión a la media
}
function recallS(d, s, r, g) {
  const hard = g === 2 ? W[15] : 1;
  const easy = g === 4 ? W[16] : 1;
  return s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp((1 - r) * W[10]) - 1) * hard * easy);
}
function forgetS(d, s, r) {
  const f = W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp((1 - r) * W[14]);
  return Math.min(f, s);
}
// Repaso en el MISMO día (el «otra vez» re-encolado en la sesión): la curva no ha tenido
// tiempo de caer, así que la estabilidad se ajusta por el término de corto plazo de FSRS-5.
const shortS = (s, g) => s * Math.exp(W[17] * (g - 3 + W[18]));

// Estado FSRS de partida para una tarjeta ya programada con SM-2.
function migrate(s) {
  if (s.stability || !(s.reps > 0)) return s;
  return {
    ...s,
    stability: Math.max(0.5, s.interval || 1),
    difficulty: clampD(5 + (2.5 - (s.ease || EASE_START)) * 5),
  };
}

function core(srs, rating, now) {
  const today = dayOf(now);
  const g = G[rating] || 3;
  let s = migrate({ ...(srs || newState(now)) });
  const elapsed = s.lastReview ? Math.max(0, today - dayOf(s.lastReview)) : 0;
  let S, D;
  if (!s.stability) { S = initS(g); D = initD(g); }
  else if (elapsed === 0) { S = shortS(s.stability, g); D = nextD(s.difficulty, g); }
  else {
    const r = retrievability(elapsed, s.stability);
    D = nextD(s.difficulty, g);
    S = g === 1 ? forgetS(s.difficulty, s.stability, r) : recallS(s.difficulty, s.stability, r, g);
  }
  s = { ...s, stability: +S.toFixed(4), difficulty: +D.toFixed(4) };
  return { s, today, g };
}

// Aplica una nota de autoevaluación al estado y devuelve el estado NUEVO (no muta).
// - again: fallo → reps a 0, cuenta el lapse y vuelve HOY (se re-encola en la sesión).
// - hard / good / easy: el intervalo es la nueva estabilidad, con difícil ≤ bien < fácil.
export function grade(srs, rating, now = Date.now()) {
  const { s, today, g } = core(srs, rating, now);
  if (g === 1) {
    s.reps = 0;
    s.lapses = (s.lapses || 0) + 1;
    s.interval = 0;
    s.due = today;
  } else {
    let interval = Math.min(MAX_INTERVAL, Math.max(1, Math.round(s.stability)));
    // Orden de los botones: una nota más alta nunca programa MENOS días que una más baja.
    if (g !== 3) {
      const good = Math.min(MAX_INTERVAL, Math.max(1, Math.round(core(srs, 'good', now).s.stability)));
      if (g === 2) interval = Math.min(interval, good);
      if (g === 4) interval = Math.min(MAX_INTERVAL, Math.max(interval, good + 1));
    }
    s.interval = interval;
    s.reps = (s.reps || 0) + 1;
    s.due = today + interval;
  }
  s.lastReview = now;
  return s;
}

// Intervalos previstos por nota (para pintarlos en los botones: «bien · en 3 días»).
export function previewIntervals(srs, now = Date.now()) {
  const out = {};
  for (const r of RATINGS) {
    const next = grade(srs, r, now);
    out[r] = r === 'again' ? 0 : next.interval;
  }
  return out;
}

// Etiqueta de un intervalo en PALABRAS («mañana», «3 días»): «1d» obligaba a descifrar.
// 0 = se repite en esta misma sesión.
export function intervalLabel(days) {
  if (!days) return t('ahora');
  if (days === 1) return t('mañana');
  if (days < 30) return t('{n} días', { n: days });
  if (days < 365) {
    const m = Math.round(days / 30);
    return m === 1 ? t('1 mes') : t('{n} meses', { n: m });
  }
  const y = (days / 365).toFixed(1).replace('.0', '');
  return y === '1' ? t('1 año') : t('{n} años', { n: y });
}

// ---- Racha de estudio (F3): días consecutivos con al menos un repaso ---------------

// Actualiza la racha al repasar. Idempotente dentro del mismo día; si el último repaso
// fue ayer, suma; si hubo hueco, reinicia a 1.
export function bumpStreak(streak, now = Date.now()) {
  const today = dayOf(now);
  const s = streak && streak.lastDay ? streak : { count: 0, lastDay: 0 };
  if (s.lastDay === today) return s;
  return { count: s.lastDay === today - 1 ? s.count + 1 : 1, lastDay: today };
}

// Racha vigente para MOSTRAR: si el último repaso fue antes de ayer, ya se rompió (0).
export function currentStreak(streak, now = Date.now()) {
  if (!streak || !streak.lastDay) return 0;
  return streak.lastDay >= dayOf(now) - 1 ? streak.count : 0;
}

// Desglose nuevas / aprendiendo / maduras (madura = intervalo ≥ 21d, criterio Anki).
// Las suspendidas van a su propio cubo: siguen existiendo (se pueden reactivar y se
// exportan a Anki) pero no son ni nuevas ni maduras, están fuera de la rotación.
export function deckStats(cards, now = Date.now()) {
  const st = { total: 0, nuevas: 0, aprendiendo: 0, maduras: 0, due: 0, suspendidas: 0 };
  for (const c of cards || []) {
    if (!c || c.deleted) continue;             // tombstone: no cuenta en el desglose
    st.total++;
    if (c.suspended) st.suspendidas++;
    else if (!c.srs || c.srs.reps === 0) st.nuevas++;
    else if (c.srs.interval >= 21) st.maduras++;
    else st.aprendiendo++;
    if (isDue(c, now)) st.due++;
  }
  return st;
}
