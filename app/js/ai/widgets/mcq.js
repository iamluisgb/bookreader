// P43 F4 · Tipo 5 «Pregunta con distractores que enseñan». Módulo PURO (sin DOM).
//
// Por capítulo, unas pocas preguntas de aplicación con 3–4 opciones y exactamente una correcta.
// Cada opción lleva su feedback: por qué es la correcta o en qué se equivoca quien la elige (Little
// y Bjork 2015: distractores competitivos obligan a recuperar también lo que hay detrás de las
// falsas). La correcta lleva la cita literal del capítulo.
//
// Es ATÓMICO: cada pregunta acabará como una tarjeta con FSRS. Por eso se valida pregunta a
// pregunta y una mala se descarta sin tirar las demás (`validItems`).
//
// Spec: { type: 'mcq', version, bookId, chapter, title, prompt,
//         items: [{ id, stem, options: [{ id, text, correct, feedback }], cite: { quote, src? } }] }

import { validateCommon, citeErrors } from './core.js';

export const MCQ_LIMITS = { items: [1, 8], options: [3, 4], stem: 300, option: 160, feedback: 280 };

// Errores de UNA pregunta. `where` nombra la pregunta en los mensajes (van al reintento).
export function validateMcqItem(item, where = 'item') {
  const L = MCQ_LIMITS;
  const errors = [];
  if (!item || typeof item !== 'object') return [`${where}: no es un objeto`];
  if (typeof item.id !== 'string' || !item.id.trim()) errors.push(`${where}: falta id`);
  if (typeof item.stem !== 'string' || !item.stem.trim()) errors.push(`${where}: falta stem`);
  else if (item.stem.length > L.stem) errors.push(`${where}: stem pasa de ${L.stem}`);
  const opts = Array.isArray(item.options) ? item.options : null;
  if (!opts) return [...errors, `${where}: faltan options`];
  if (opts.length < L.options[0] || opts.length > L.options[1]) errors.push(`${where}: entre ${L.options[0]} y ${L.options[1]} opciones (hay ${opts.length})`);
  const texts = new Set();
  const ids = new Set();
  for (const [i, o] of opts.entries()) {
    const w = `${where}.options[${i}]`;
    if (!o || typeof o !== 'object') { errors.push(`${w}: no es un objeto`); continue; }
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    if (!id) errors.push(`${w}: falta id`);
    else if (ids.has(id)) errors.push(`${where}: id de opción repetido «${id}»`);
    else ids.add(id);
    if (typeof o.text !== 'string' || !o.text.trim()) errors.push(`${w}: falta text`);
    else if (o.text.length > L.option) errors.push(`${w}: text pasa de ${L.option}`);
    else {
      const k = o.text.trim().toLowerCase();
      if (texts.has(k)) errors.push(`${where}: opciones repetidas`);
      texts.add(k);
    }
    if (typeof o.correct !== 'boolean') errors.push(`${w}: correct debe ser true o false`);
    if (typeof o.feedback !== 'string' || !o.feedback.trim()) errors.push(`${w}: falta feedback`);
    else if (o.feedback.length > L.feedback) errors.push(`${w}: feedback pasa de ${L.feedback}`);
  }
  const right = opts.filter((o) => o && o.correct === true).length;
  if (right !== 1) errors.push(`${where}: tiene que haber exactamente una opción correcta (hay ${right})`);
  errors.push(...citeErrors(item.cite, where));
  return errors;
}

// Lo común y la lista; las preguntas, aparte (validItems).
export function validateMcqShape(spec) {
  const errors = validateCommon(spec);
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return errors;
  const L = MCQ_LIMITS;
  if (!Array.isArray(spec.items)) return [...errors, 'faltan items'];
  if (spec.items.length < L.items[0] || spec.items.length > L.items[1]) errors.push(`items: entre ${L.items[0]} y ${L.items[1]} (hay ${spec.items.length})`);
  const ids = new Set();
  for (const it of spec.items) {
    if (it && typeof it.id === 'string') {
      if (ids.has(it.id)) errors.push(`items: id repetido «${it.id}»`);
      ids.add(it.id);
    }
  }
  return errors;
}

// Spec entero válido = forma + todas las preguntas (lo que exige un widget que se enseña de una).
export function validateMcq(spec) {
  const errors = validateMcqShape(spec);
  if (errors.length || !Array.isArray(spec?.items)) return errors;
  return spec.items.flatMap((it, i) => validateMcqItem(it, `items[${i}]`));
}

export function mcqCites(spec) {
  return (spec.items || []).filter((it) => it && it.cite).map((it) => ({ where: it.id, cite: it.cite }));
}

// Corrección de una pregunta: `choice` es el id de la opción elegida.
export function scoreMcqItem(item, choice, { unsure = false } = {}) {
  const picked = item.options.find((o) => o.id === choice) || null;
  const right = item.options.find((o) => o.correct);
  const ok = !!picked && picked.correct === true;
  return { id: item.id, choice: picked ? picked.id : null, answer: right.id, ok, unsure: !!unsure, feedback: picked ? picked.feedback : null };
}

// Orden de pintado: barajado con semilla (estable para la misma pregunta y semilla), para que la
// correcta no caiga siempre en el mismo sitio aunque el modelo la ponga siempre la primera.
export function shuffledOptions(item, seed = 0) {
  let h = 0x811c9dc5 ^ seed;
  for (const ch of String(item.id) + String(item.stem)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  const out = [...item.options];
  for (let i = out.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Señales que la validez no ve. No bloquean; el eval las cuenta.
//   larga: la correcta es claramente más larga que la media de las falsas (el truco de examen).
//   comodin: «todas las anteriores», «ninguna de las anteriores»: se responden por descarte.
//   eco: la correcta repite literalmente un trozo largo del enunciado.
//   absolutas: la mayoría de las falsas son tajantes («siempre», «nunca», «obligatorio»…) y la
//     correcta no: se acierta eligiendo la matizada sin haber leído (visto en SRE 2.ª ed., 19-oct).
export const LONG_RATIO = 1.5;
const ABSOLUTE = /\b(siempre|nunca|jamás|obligatori[oa]s?|ningún|ninguna|nada|todos?|todas?|cualquier|únicamente|solo|sólo|exclusivamente|always|never|must|only|any|all|none|every)\b/i;
const WILDCARD = /\b(todas las anteriores|ninguna de las anteriores|all of the above|none of the above)\b/i;
export function mcqItemFlags(item) {
  const flags = [];
  const right = item.options.find((o) => o.correct);
  const wrong = item.options.filter((o) => !o.correct);
  if (!right || !wrong.length) return flags;
  const mean = wrong.reduce((a, o) => a + o.text.length, 0) / wrong.length;
  if (right.text.length > mean * LONG_RATIO) flags.push('larga');
  if (item.options.some((o) => WILDCARD.test(o.text))) flags.push('comodin');
  if (!ABSOLUTE.test(right.text) && wrong.filter((o) => ABSOLUTE.test(o.text)).length * 2 > wrong.length) flags.push('absolutas');
  const words = right.text.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  for (let i = 0; i + 4 <= words.length; i++) {
    if (item.stem.toLowerCase().includes(words.slice(i, i + 4).join(' '))) { flags.push('eco'); break; }
  }
  return flags;
}
