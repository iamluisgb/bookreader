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

// ---- FSRS-6 (P19; FSRS-5 → FSRS-6 con P44) -------------------------------------------
// Sustituye a SM-2: con parámetros por defecto y sin historial ya predice el recuerdo mejor
// que SM-2 en el 99,5 % de los usuarios y pide un 20-30 % menos de repasos para la misma
// retención (ver BACKLOG · P19). Modelo DSR: cada tarjeta guarda su ESTABILIDAD (días hasta
// que la probabilidad de recordarla baja al 90 %) y su DIFICULTAD (1–10). El intervalo es la
// estabilidad: con retención objetivo 0,9, I = S (la curva está calibrada para eso).
//
// FSRS-6 añade dos parámetros a FSRS-5: el 20, la caída de la curva del olvido, que deja de
// ser fija (−0,5) y se aprende de cada persona; y el 19, que amortigua los repasos del mismo
// día. Se cambió para poder usar los parámetros PERSONALES que calcula el optimizador
// (`fsrs-params.js`), que es FSRS-6. Las fórmulas están contrastadas con fsrs-rs (el motor de
// Anki) en tests/srs.spec.ts. La estabilidad y la dificultad significan lo mismo en las dos
// versiones: las tarjetas ya programadas siguen sin migración.
//
// Compatibilidad: el estado sigue siendo `{reps, lapses, interval, due, lastReview}` (+ `ease`
// heredado, que ya no se usa) y se AÑADEN `stability` y `difficulty`. Una tarjeta programada
// con SM-2 se convierte al vuelo en su primer repaso: la estabilidad sale de su intervalo
// (lo que el SM-2 ya había aprendido de ella) y la dificultad, de su ease.
export const DEFAULT_PARAMETERS = Object.freeze([0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334,
  3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425,
  0.0912, 0.0658, 0.1542]);
let W = DEFAULT_PARAMETERS;
const G = { again: 1, hard: 2, good: 3, easy: 4 };
const clampD = (d) => Math.min(10, Math.max(1, d));

// Parámetros en uso. Solo se aceptan 21 números finitos: cualquier otra cosa (un fichero de
// sync viejo, un valor a medio escribir) deja los de serie, que nunca programan mal.
export function setParameters(w) {
  W = Array.isArray(w) && w.length === 21 && w.every(Number.isFinite) ? w.slice() : DEFAULT_PARAMETERS;
}
export function parameters() { return W; }
export function usingDefaults() { return W === DEFAULT_PARAMETERS; }

// Ejecuta `fn` con otros parámetros y restaura los de antes: para comparar los de serie con
// los personales sobre la misma historia sin tocar el estado global (todo es síncrono).
export function withParameters(w, fn) {
  const prev = W;
  setParameters(w);
  try { return fn(); } finally { W = prev; }
}

const decay = () => -W[20];
const factor = () => Math.pow(0.9, 1 / decay()) - 1;

export function retrievability(elapsedDays, stability) {
  return Math.pow(1 + factor() * Math.max(0, elapsedDays) / stability, decay());
}
const initS = (g) => Math.max(W[g - 1], 0.001);
const rawInitD = (g) => W[4] - Math.exp(W[5] * (g - 1)) + 1;
const initD = (g) => clampD(rawInitD(g));
function nextD(d, g) {
  const delta = -W[6] * (g - 3);
  const dp = d + delta * (10 - d) / 9;                    // cambio lineal amortiguado
  // Reversión a la media hacia la dificultad inicial de «fácil» SIN acotar (como fsrs-rs):
  // acotada a 1 se desviaba unas milésimas en cada repaso.
  return clampD(W[7] * rawInitD(4) + (1 - W[7]) * dp);
}
function recallS(d, s, r, g) {
  const hard = g === 2 ? W[15] : 1;
  const easy = g === 4 ? W[16] : 1;
  return s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp((1 - r) * W[10]) - 1) * hard * easy);
}
function forgetS(d, s, r) {
  const f = W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp((1 - r) * W[14]);
  // Tras un fallo la estabilidad no puede quedar por encima de la que daría el repaso de
  // corto plazo con «otra vez» (cota de FSRS-6).
  return Math.min(f, s / Math.exp(W[17] * W[18]));
}
// Repaso en el MISMO día (el «otra vez» re-encolado en la sesión): la curva no ha tenido
// tiempo de caer, así que la estabilidad se ajusta por el término de corto plazo. En FSRS-6
// solo «otra vez» la baja en el mismo día, y cuanto más estable, menos sube.
function shortS(s, g) {
  const inc = Math.exp(W[17] * (g - 3 + W[18])) * Math.pow(s, -W[19]);
  return s * (g >= 2 ? Math.max(inc, 1) : inc);
}

// Estado FSRS de partida para una tarjeta ya programada con SM-2.
function migrate(s) {
  if (s.stability || !(s.reps > 0)) return s;
  return {
    ...s,
    stability: Math.max(0.5, s.interval || 1),
    difficulty: clampD(5 + (2.5 - (s.ease || EASE_START)) * 5),
  };
}

// Estabilidad de una tarjeta para leerla (no para programarla): la suya, o la que tendría
// migrada desde SM-2. null = nueva (sin memoria que medir).
export function stabilityOf(srs) {
  if (!srs || !(srs.reps > 0 || srs.stability || srs.lastReview)) return null;
  return migrate({ ...srs }).stability || null;
}

// Siguiente estado de memoria {S, D} desde {S, D} (null = tarjeta nueva) tras `elapsed` días.
// Es la transición pura de FSRS, sin intervalos ni contadores: la usan `grade` y el
// optimizador para repasar una historia con otros parámetros.
export function nextMemory(state, g, elapsed) {
  if (!state || !state.stability) return { stability: initS(g), difficulty: initD(g) };
  const { stability: s, difficulty: d } = state;
  if (elapsed === 0) return { stability: shortS(s, g), difficulty: nextD(d, g) };
  const r = retrievability(elapsed, s);
  return {
    stability: g === 1 ? forgetS(d, s, r) : recallS(d, s, r, g),
    difficulty: nextD(d, g),
  };
}

function core(srs, rating, now) {
  const today = dayOf(now);
  const g = G[rating] || 3;
  let s = migrate({ ...(srs || newState(now)) });
  const elapsed = s.lastReview ? Math.max(0, today - dayOf(s.lastReview)) : 0;
  const m = nextMemory(s.stability ? s : null, g, elapsed);
  s = { ...s, stability: +m.stability.toFixed(4), difficulty: +m.difficulty.toFixed(4) };
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

// Lo que se recuerda HOY de un conjunto de tarjetas (P44 F2; sustituye al «dominio» de T2,
// que ponderaba por intervalo). Es el «conocimiento estimado» de Anki: la suma de la
// probabilidad de recordar cada tarjeta ahora mismo, con la misma curva que programa.
//   known      Σ R de las tarjetas con memoria: «tarjetas que recordarías hoy».
//   total      todas las vivas, nuevas incluidas: una nueva vale 0, no se sabe todavía.
//   share      known / total ∈ [0, 1]: lo que se sabe del material del libro.
// Las suspendidas cuentan con su R: es material aprendido que alguien aparcó, no ignorado.
// Una tarjeta repasada hoy mismo vale su R a 0 días (1).
export function knowledge(cards, now = Date.now()) {
  const today = dayOf(now);
  let total = 0, known = 0, studied = 0, nuevas = 0;
  for (const c of cards || []) {
    if (!c || c.deleted) continue;             // tombstone: no cuenta
    total++;
    const S = stabilityOf(c.srs);
    if (!S) { nuevas++; continue; }
    studied++;
    const elapsed = c.srs.lastReview ? Math.max(0, today - dayOf(c.srs.lastReview)) : Math.max(0, today - (c.srs.due - (c.srs.interval || 0)));
    known += retrievability(elapsed, S);
  }
  return { total, known, studied, nuevas, share: total ? known / total : 0 };
}

// Tarjetas que cuestan (P44 F2): falladas 3 veces o más. Es antes que el umbral de leech (8)
// a propósito: el leech avisa EN el repaso; aquí se busca arreglarlas antes de llegar a eso,
// y casi siempre están mal formuladas (ver isLeech).
export const PROBLEM_LAPSES = 3;
export function isProblem(card) {
  if (!card || card.deleted || card.suspended) return false;
  return (card.srs?.lapses || 0) >= PROBLEM_LAPSES;
}

// Carga diaria media que añaden las tarjetas en rotación (criterio de Anki): cada tarjeta
// aporta 1/intervalo repasos al día. Una de intervalo 1 suma un repaso diario; una de 30,
// uno al mes. Las nuevas no cargan hasta que entran.
export function dailyLoad(cards) {
  let load = 0;
  for (const c of cards || []) {
    if (!c || c.deleted || c.suspended || !c.srs || !(c.srs.reps > 0 || c.srs.stability)) continue;
    load += 1 / Math.max(1, c.srs.interval || 1);
  }
  return load;
}
