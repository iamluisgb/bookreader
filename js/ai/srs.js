// P10 · Modo Estudiar — scheduler de repetición espaciada (SM-2, ver BACKLOG · P10).
// Módulo PURO (sin DOM, sin IndexedDB): recibe estados y fechas, devuelve estados nuevos.
// El estado vive inline en cada tarjeta (`card.srs`); una tarjeta sin `srs` es NUEVA.
//
// Se eligió SM-2 sobre FSRS (decisión en BACKLOG · P10): simple, probado y suficiente sin
// historial largo. El estado guarda lo necesario (reps/lapses/ease/interval/due/lastReview)
// para poder migrar a FSRS más adelante sin romper.
//
// `due` e `interval` se miden en DÍAS (medianoche local): "vence hoy" significa hoy de
// calendario, no "hace 24h exactas" — el repaso es un hábito diario, no un cronómetro.

export const RATINGS = ['again', 'hard', 'good', 'easy'];

const EASE_START = 2.5;
const EASE_MIN = 1.3;
const FIRST_INTERVAL = 1;     // días tras el primer "bien"
const SECOND_INTERVAL = 6;    // días tras el segundo
const MAX_INTERVAL = 365;     // techo: nunca agendar a más de un año

// Día de calendario local (días desde epoch, cortando a medianoche local).
export function dayOf(ts) {
  const d = new Date(ts);
  return Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 86400000);
}

export function newState(now = Date.now()) {
  return { reps: 0, lapses: 0, ease: EASE_START, interval: 0, due: dayOf(now), lastReview: 0 };
}

// ¿La tarjeta toca hoy? Las nuevas (sin srs) siempre tocan.
export function isDue(card, now = Date.now()) {
  return !card.srs || card.srs.due <= dayOf(now);
}

export function dueCount(cards, now = Date.now()) {
  return (cards || []).filter(c => isDue(c, now)).length;
}

// Aplica una nota de autoevaluación al estado y devuelve el estado NUEVO (no muta).
// - again: fallo → reps a 0, se re-encola en la sesión (interval 0, due hoy) y baja el ease.
// - hard:  cuesta → crece poco (×1.2) y baja el ease.
// - good:  1d → 6d → ×ease.
// - easy:  ×ease×1.3 y sube el ease.
export function grade(srs, rating, now = Date.now()) {
  const s = { ...(srs || newState(now)) };
  const today = dayOf(now);

  if (rating === 'again') {
    s.reps = 0;
    s.lapses += 1;
    s.interval = 0;
    s.ease = Math.max(EASE_MIN, s.ease - 0.2);
    s.due = today;                       // se repite en la misma sesión
  } else {
    if (rating === 'hard') {
      s.interval = Math.max(1, Math.round(s.interval * 1.2));
      s.ease = Math.max(EASE_MIN, s.ease - 0.15);
    } else if (rating === 'easy') {
      s.interval = Math.max(2, Math.round(Math.max(s.interval, 1) * s.ease * 1.3));
      s.ease = s.ease + 0.15;
    } else { // good
      s.interval = s.reps === 0 ? FIRST_INTERVAL
        : s.reps === 1 ? SECOND_INTERVAL
        : Math.round(s.interval * s.ease);
    }
    s.interval = Math.min(MAX_INTERVAL, s.interval);
    s.reps += 1;
    s.due = today + s.interval;
  }
  s.lastReview = now;
  return s;
}

// Intervalos previstos por nota (para pintarlos en los botones: "bien · 6d").
export function previewIntervals(srs, now = Date.now()) {
  const out = {};
  for (const r of RATINGS) {
    const next = grade(srs, r, now);
    out[r] = r === 'again' ? 0 : next.interval;
  }
  return out;
}

// Etiqueta corta de un intervalo en días ("<10m" para el re-encolado de "otra vez").
export function intervalLabel(days) {
  if (!days) return '<10m';
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}m`;
  return `${(days / 365).toFixed(1).replace('.0', '')}a`;
}

// Desglose nuevas / aprendiendo / maduras (madura = intervalo ≥ 21d, criterio Anki).
export function deckStats(cards, now = Date.now()) {
  const st = { total: 0, nuevas: 0, aprendiendo: 0, maduras: 0, due: 0 };
  for (const c of cards || []) {
    st.total++;
    if (!c.srs || c.srs.reps === 0) st.nuevas++;
    else if (c.srs.interval >= 21) st.maduras++;
    else st.aprendiendo++;
    if (isDue(c, now)) st.due++;
  }
  return st;
}
