// study-stats.js — Lo que se puede decir del ESTUDIO a partir de lo que ya se guarda (P44).
//
// Fuente: el store `attempts` (P42 F1), un registro inmutable por nota del repaso o por
// ejercicio de widget, y el estado de cada tarjeta (`card.srs`). Aquí no se mide nada: se
// cuenta. Funciones PURAS (reciben listas y fechas) para que los tests no necesiten la UI.
//
// Criterios, todos los de Anki salvo donde se dice:
// - RETENCIÓN REAL: de los repasos que TOCABAN (tarjeta ya aprendida, intervalo previo ≥ 1
//   día), cuántos se recordaron (cualquier nota menos «otra vez»). Solo la PRIMERA nota de
//   cada tarjeta en el día: el «otra vez» re-encolado o una segunda sesión no son memoria a
//   largo plazo. Se separa en jóvenes (intervalo < 21 d) y maduras.
// - TIEMPO: Σ latencias con tope por intento (60 s una tarjeta, 10 min un ejercicio). Una
//   tarjeta abierta mientras se hace otra cosa no infla el total: el mismo principio que la
//   lectura validada de P25.
// - PRACTICADO frente a SOLO GIRAR (P42 F3): escribir la respuesta o hacer un ejercicio es
//   practicar; girar la tarjeta y ponerse nota es reconocer. Se cuentan aparte, nunca se suman.
import { dayOf, isDue, knowledge, isProblem, dailyLoad } from './srs.js';

export const MATURE_DAYS = 21;
export const MIN_RETENTION_N = 30;     // por debajo, la retención es ruido: se dice cuántos faltan
export const MIN_CALIBRATION_N = 20;   // ídem para la calibración (F5)
export const TARGET_RETENTION = 0.9;   // la que programa FSRS (I = S)
const CARD_CAP_MS = 60000;
const WIDGET_CAP_MS = 600000;

const isCard = (a) => a && a.mode !== 'widget' && a.grade;

// Intentos dentro de [from, to) (ms) y, si se pide, de un conjunto de libros.
export function inRange(attempts, from, to, books = null) {
  return (attempts || []).filter(a => a && a.ts >= from && a.ts < to && (!books || books.has(a.bookId)));
}

export function studyTime(attempts) {
  let ms = 0;
  for (const a of attempts || []) {
    if (!a || !Number.isFinite(a.latencyMs)) continue;
    ms += Math.min(a.latencyMs, a.mode === 'widget' ? WIDGET_CAP_MS : CARD_CAP_MS);
  }
  return ms;
}

// Retención real sobre una lista de intentos. `n` = repasos que cuentan; `rate` null si n = 0.
export function trueRetention(attempts) {
  const seen = new Set();
  const out = { young: { n: 0, ok: 0 }, mature: { n: 0, ok: 0 }, all: { n: 0, ok: 0 } };
  const sorted = (attempts || []).filter(isCard).sort((a, b) => a.ts - b.ts);
  for (const a of sorted) {
    const key = `${a.cardUid || a.uid}|${dayOf(a.ts)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!(a.prevInterval >= 1)) continue;          // nueva o re-aprendiendo: no tocaba
    const ok = a.grade !== 'again' ? 1 : 0;
    const bucket = a.prevInterval >= MATURE_DAYS ? out.mature : out.young;
    bucket.n++; bucket.ok += ok;
    out.all.n++; out.all.ok += ok;
  }
  for (const b of Object.values(out)) b.rate = b.n ? b.ok / b.n : null;
  return out;
}

// Practicado (escrito, opción elegida o ejercicio) frente a solo girar.
export function practiceSplit(attempts) {
  let practiced = 0, revealed = 0, judged = 0;
  for (const a of attempts || []) {
    if (!a) continue;
    if (a.mode === 'widget' || a.mode === 'choice') { practiced++; judged++; }
    else if (a.mode === 'written') { practiced++; if (a.verdict) judged++; }
    else if (a.grade) revealed++;
  }
  return { practiced, revealed, judged };
}

// Calibración (F5): en los intentos ESCRITOS que el agente juzgó, cuántas veces el lector se
// dio por bueno (nota ≠ «otra vez») frente a cuántas lo dio por bueno el agente («good»; un
// «partial» no es acierto). Si la primera es mucho mayor, se está sobreestimando.
export function calibration(attempts) {
  let n = 0, self = 0, agent = 0;
  for (const a of attempts || []) {
    if (!isCard(a) || a.mode !== 'written' || !a.verdict) continue;
    n++;
    if (a.grade !== 'again') self++;
    if (a.verdict === 'good') agent++;
  }
  return { n, self: n ? self / n : null, agent: n ? agent / n : null };
}

// Repasos por día natural (clave = dayOf). `legacy` es el contador por día de `study_log`, de
// antes de que existiera `attempts` (P42 F1, 15-oct-2026): solo rellena días SIN intentos, así
// que un día nunca se cuenta dos veces.
export function reviewsByDay(attempts, legacy = {}) {
  const by = {};
  for (const a of attempts || []) if (a) by[dayOf(a.ts)] = (by[dayOf(a.ts)] || 0) + 1;
  for (const [k, v] of Object.entries(legacy || {})) {
    const n = typeof v === 'number' ? v : v?.n || 0;
    if (n && !by[k]) by[k] = n;
  }
  return by;
}

// Memoria de un libro: lo que se recuerda hoy y qué tarjetas cuestan. `decks` = los mazos del
// libro. Devuelve también el mazo con más tarjetas problemáticas, para abrirlo al pulsar
// «Revisar».
export function bookMemory(decks, now = Date.now()) {
  const cards = [];
  let worst = null;
  for (const d of decks || []) {
    const live = (d.cards || []).filter(c => c && !c.deleted);
    cards.push(...live);
    const probs = (d.cards || []).map((c, i) => (isProblem(c) ? i : -1)).filter(i => i >= 0);
    if (probs.length && (!worst || probs.length > worst.idx.length)) worst = { deckId: d.id, idx: probs };
  }
  const k = knowledge(cards, now);
  return {
    ...k,
    problems: cards.filter(isProblem).length,
    problemDeck: worst,
    due: cards.filter(c => isDue(c, now)).length,
  };
}

// Lo que se viene: vencidas hoy (y nuevas sin empezar, aparte), previsión de los próximos 7 días y carga diaria media.
export function workload(decks, now = Date.now()) {
  const today = dayOf(now);
  const days = Array(7).fill(0);
  const cards = [];
  let dueNow = 0, fresh = 0;
  for (const d of decks || []) for (const c of d.cards || []) {
    if (!c || c.deleted || c.suspended) continue;
    cards.push(c);
    if (!c.srs) { fresh++; continue; }           // nuevas: entran por el tope, no vencen
    const k = c.srs.due - today;
    if (k <= 0) dueNow++;
    else if (k <= 7) days[k - 1]++;
  }
  return { dueNow, fresh, days, load: dailyLoad(cards) };
}

// Ritmo habitual: repasos medios en los días CON repaso de las últimas dos semanas (sin hoy,
// que va a medias). Es la vara con la que se mide si lo que viene cabe.
export function typicalPace(byDay, now = Date.now()) {
  const today = dayOf(now);
  const vals = [];
  for (let d = today - 14; d < today; d++) if (byDay[d]) vals.push(byDay[d]);
  if (vals.length < 3) return null;              // con menos no hay costumbre que medir
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// ¿Se va a desbordar? Lo que vence de media en los próximos 7 días supera en un 30 % el
// ritmo habitual. Avisar, nunca bloquear: la acción es pausar las nuevas de HOY.
export function overloaded(work, pace) {
  if (!pace) return false;
  const avg = work.days.reduce((a, b) => a + b, 0) / work.days.length;
  return avg > pace * 1.3 && avg - pace >= 5;
}
