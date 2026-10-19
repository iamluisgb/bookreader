// P43 · Carcasa común de los widgets de estudio. Módulo PURO (sin DOM, sin red, sin IDB).
//
// Un widget es un SPEC (JSON) que rellena el agente y un MOTOR que es nuestro: el agente produce
// datos, nunca HTML ni código (ADR-057). Cada tipo (matrix.js, y los que vengan) valida su parte
// y corrige; aquí vive lo que comparten todos:
//
//   - la forma común del spec y su validación (`validateCommon`),
//   - que cada cita exista de verdad en el texto del capítulo (`verifyQuotes`),
//   - la huella del contenido (`specHash`), para saber contra qué versión se hizo un intento,
//   - el registro de intento que va al store `attempts` de P42 (`widgetAttempt`),
//   - las tarjetas básicas de lo fallado (`missCard`), que vuelven con FSRS.
//
// Spec común (los campos propios de cada tipo van aparte):
//   { type, version: 1, bookId, chapter, title, prompt, ... }
// Cada ítem que se corrige lleva su `cite: { quote, src? }`: la cita LITERAL del pasaje que
// sostiene la respuesta y, si se sabe, su ancla (`a42`, la misma de las citas del chat). Es lo
// que hace verificable lo que generó el agente.

import { normalizeAnswer } from '../cloze-check.js';

export const WIDGET_VERSION = 1;
export const WIDGET_TYPES = ['matrix', 'mcq'];

// Una cita más corta no prueba nada (casaría en cualquier texto); una más larga suele ser un
// párrafo parafraseado, no una cita.
export const QUOTE_MIN = 12;
export const QUOTE_MAX = 400;

const TEXT_MAX = { title: 120, prompt: 400 };

// Valida lo común. Devuelve la lista de errores (vacía si está bien). Los mensajes son para el
// reintento del agente (F2) y para los tests, no para el lector: van en español fijo.
export function validateCommon(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return ['el spec no es un objeto'];
  if (!WIDGET_TYPES.includes(spec.type)) errors.push(`type desconocido: ${String(spec.type)}`);
  if (spec.version !== WIDGET_VERSION) errors.push(`version debe ser ${WIDGET_VERSION}`);
  for (const k of ['title', 'prompt']) {
    if (typeof spec[k] !== 'string' || !spec[k].trim()) errors.push(`falta ${k}`);
    else if (spec[k].length > TEXT_MAX[k]) errors.push(`${k} pasa de ${TEXT_MAX[k]} caracteres`);
  }
  if (spec.chapter != null && typeof spec.chapter !== 'string') errors.push('chapter debe ser texto');
  return errors;
}

// Valida una cita suelta (forma, no existencia: eso es verifyQuotes, que necesita el texto).
export function citeErrors(cite, where) {
  if (!cite || typeof cite !== 'object') return [`${where}: falta cite`];
  const q = typeof cite.quote === 'string' ? cite.quote.trim() : '';
  if (!q) return [`${where}: cite.quote vacío`];
  if (q.length < QUOTE_MIN) return [`${where}: cita demasiado corta (${q.length} < ${QUOTE_MIN})`];
  if (q.length > QUOTE_MAX) return [`${where}: cita demasiado larga (${q.length} > ${QUOTE_MAX})`];
  if (cite.src != null && !/^a\d+$/.test(String(cite.src))) return [`${where}: cite.src debe ser un ancla tipo a42`];
  return [];
}

// Forma canónica para buscar una cita en el texto: la misma normalización que el comparador de
// cloze (mayúsculas, acentos, guiones, espacios), y además fuera las comillas y la puntuación de
// en medio, que la extracción de PDF y EPUB cambia sin que cambie la cita (‘ ’ “ ” — – …).
// Antes, las palabras partidas al final de línea («consis-\ntency», también con el guion U+2010
// que deja la extracción de PDF) se vuelven a unir y fuera el guion blando (U+00AD), que el PDF
// deja en medio de las palabras. La viñeta • sale porque el PDF la pega a final de línea.
export function normalizeQuote(text) {
  const joined = String(text || '').replace(/\u00AD/g, '').replace(/(\p{L})[-\u2010\u2011]\s*\n\s*(\p{L})/gu, '$1$2');
  return normalizeAnswer(joined.replace(/[‘’“”"'«»–—…•.,;:!?¡¿()[\]]/g, ' '));
}

// ¿Están todas las citas del spec, literales, en el texto del capítulo? Devuelve los ítems cuya
// cita NO aparece. Es la comprobación que convierte «el agente dice» en «el libro dice».
export function verifyQuotes(cites, chapterText) {
  const hay = normalizeQuote(chapterText);
  const missing = [];
  for (const { where, cite } of cites) {
    const q = normalizeQuote(cite && cite.quote);
    if (!q || !hay.includes(q)) missing.push(where);
  }
  return missing;
}

// Huella del contenido del spec (FNV-1a a 32 bits, como cardFingerprint en study.js): no es
// criptografía, es detección de cambio. Si el spec se regenera, los intentos viejos se
// distinguen de los nuevos. Claves ordenadas para que el orden de las propiedades no cuente.
export function specHash(spec) {
  const text = stableStringify(spec);
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

// Registro para el store `attempts` (P42). Mismos 14 campos que el del repaso, para que sync,
// backup y quien analice los intentos no necesiten un caso aparte; lo propio del widget va en
// `widget`. `cardUid`/`deckUid`/`grade`/`prevInterval` no aplican: null.
//   verdict: 'good' si acertó todo, 'partial' si acertó algo, 'wrong' si nada.
//   answer: lo que respondió, en JSON recortado a 500 (mismo tope que el repaso).
export function widgetAttempt({ uid, spec, bookId, ts, latencyMs, result, answer }) {
  const json = JSON.stringify(answer ?? null);
  return {
    uid,
    cardUid: null,
    deckUid: null,
    bookId: bookId ?? spec.bookId ?? null,
    ts,
    mode: 'widget',
    verdict: result.total && result.correct === result.total ? 'good' : result.correct > 0 ? 'partial' : 'wrong',
    exact: result.total ? result.correct === result.total : null,
    grade: null,
    prevInterval: null,
    latencyMs: latencyMs ?? null,
    arm: null,
    answer: json.length > 500 ? json.slice(0, 500) : json,
    cardHash: specHash(spec),
    widget: { type: spec.type, correct: result.correct, total: result.total, confidentMisses: result.confidentMisses ?? 0 },
  };
}

// Tarjeta básica a partir de un ítem fallado. Lleva la cita en el dorso: al repasarla, el
// lector ve de dónde sale la respuesta, no solo cuál es.
// Misma forma que las del mazo (sanitizeCards en flashcards.js): {type, front, back, chapter, src}.
export function missCard({ front, back, why, cite, chapter }) {
  const parts = [back];
  if (why) parts.push(why);
  if (cite && cite.quote) parts.push(`«${cite.quote.trim()}»`);
  return { type: 'basic', front, back: parts.join('\n\n'), chapter: chapter || '', src: (cite && cite.src) || '' };
}
