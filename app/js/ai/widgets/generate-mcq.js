// P43 F4 · Generación del tipo 5 (preguntas con distractores que enseñan). Módulo PURO, como
// generate.js: lo usan la app y evals/mcq.mjs, para que los dos midan lo mismo.
//
// A diferencia de la matriz, la unidad es la PREGUNTA: cada una se valida sola (forma + cita literal
// en el capítulo) y las que fallan se piden otra vez, solo ellas. Métrica del contrato:
// `mcq_item_valid` = preguntas válidas / preguntas pedidas.

import { verifyQuotes, WIDGET_VERSION } from './core.js';
import { validateMcqShape, validateMcqItem, MCQ_LIMITS } from './mcq.js';
import { parseSpec } from './generate.js';

export const MCQ_PROMPT_VERSION = 'mcq-v2';
export const MCQ_COUNT = 5;
export const CHAPTER_CHAR_CAP = 60000;

const LANG_NAME = { es: 'español', en: 'English' };

export function mcqMessages({ chapter, text, lang = 'es', count = MCQ_COUNT }) {
  const L = MCQ_LIMITS;
  const ui = LANG_NAME[lang] || lang;
  const system = [
    'Eres un profesor que prepara preguntas de práctica sobre un capítulo de un libro.',
    `Escribe ${count} preguntas de opción múltiple que obliguen a APLICAR el capítulo: un caso, una situación o un «qué pasa si», no una definición que se responda copiando una frase.`,
    'Lo importante son las opciones falsas: cada una es un error que cometería de verdad alguien que leyó el capítulo deprisa o que confunde dos ideas del capítulo. Nada absurdo ni de relleno.',
    'La pregunta tiene que depender de ESTE capítulo: de un ejemplo, un dato, una distinción o un matiz suyo. Las falsas, posturas que un experto en el tema podría defender en general pero que este capítulo descarta o matiza. Quien sepa del tema y no haya leído el capítulo tiene que dudar.',
    'Que la correcta no sea la más prudente, la más matizada ni la más «de principios»: a veces lo es una falsa.',
    '',
    'Reglas:',
    `- Cada pregunta: ${L.options[0]} o ${L.options[1]} opciones y EXACTAMENTE una correcta ("correct": true).`,
    '- Las opciones, de longitud y estilo parecidos: que la correcta no se note por ser la más larga, la más matizada o la única con las palabras del enunciado.',
    '- Nunca «todas las anteriores» ni «ninguna de las anteriores».',
    `- Cada opción lleva \`feedback\` (≤ ${L.feedback} caracteres, en ${ui}): en la correcta, por qué lo es; en las falsas, qué confunde quien la elige y qué dice en realidad el capítulo.`,
    '- Cada pregunta lleva `cite.quote`: una cita LITERAL del capítulo, copiada carácter a carácter, de 12 a 400 caracteres, que sostenga la respuesta correcta. En el idioma del libro: no la traduzcas ni la resumas.',
    `- title (≤ 120), prompt (≤ 400), stem (≤ 250 caracteres), opciones (≤ 120 caracteres cada una) y feedback en ${ui}.`,
    '- Preguntas sobre ideas distintas del capítulo, no cinco variantes de la misma.',
    '- No inventes nada que el capítulo no diga.',
    '',
    'Responde SOLO con un objeto JSON, sin texto alrededor, con esta forma:',
    '{"title": "...", "prompt": "...",',
    ' "items": [{"id": "q1", "stem": "...",',
    '   "options": [{"id": "a", "text": "...", "correct": false, "feedback": "..."}],',
    '   "cite": {"quote": "..."}}]}',
  ].join('\n');
  const body = String(text || '').slice(0, CHAPTER_CHAR_CAP);
  const user = `Capítulo: ${chapter || '(sin título)'}\n\n<capitulo>\n${body}\n</capitulo>`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// Lo que no decide el modelo: type, version, bookId, chapter. Y los ids que falten (el modelo a
// veces los omite): q1…, a/b/c/d. No toca lo demás.
export function finishMcq(spec, { bookId, chapter } = {}) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return spec;
  const items = Array.isArray(spec.items) ? spec.items.map((it, i) => {
    if (!it || typeof it !== 'object') return it;
    const options = Array.isArray(it.options)
      ? it.options.map((o, j) => (o && typeof o === 'object' && !o.id ? { ...o, id: 'abcdefgh'[j] || `o${j}` } : o))
      : it.options;
    return { ...it, id: it.id || `q${i + 1}`, options };
  }) : spec.items;
  return { ...spec, items, type: 'mcq', version: WIDGET_VERSION, bookId: bookId ?? null, chapter: chapter ?? '' };
}

// Pregunta a pregunta: [{ id, errors }]. La cita se busca en el capítulo ENTERO.
export function itemResults(spec, chapterText) {
  if (!spec || !Array.isArray(spec.items)) return [];
  return spec.items.map((it, i) => {
    const errors = validateMcqItem(it, `items[${i}]`);
    if (!errors.length && verifyQuotes([{ where: it.id, cite: it.cite }], chapterText).length) {
      errors.push(`items[${i}] (${it.id}): la cita no aparece literal en el capítulo`);
    }
    return { id: it && it.id, errors };
  });
}

// Errores que impiden usar el spec entero (sin JSON, sin items, campos comunes).
export function mcqSpecErrors(spec) {
  if (!spec) return ['la respuesta no contiene un objeto JSON'];
  return validateMcqShape(spec).filter((e) => !e.startsWith('items: entre'));
}

// Solo las preguntas válidas, en su orden. Es lo que se enseña.
export function keepValid(spec, chapterText) {
  const ok = new Set(itemResults(spec, chapterText).filter((r) => !r.errors.length).map((r) => r.id));
  return { ...spec, items: spec.items.filter((it) => it && ok.has(it.id)) };
}

// Reintento: solo las preguntas que fallaron, con sus errores. Devuelve el JSON con esas
// preguntas corregidas (mismos ids); mergeRetry las cambia en el spec.
export function retryMcqMessages(messages, raw, failed) {
  const list = failed.slice(0, 10).map((r) => `- ${r.id}: ${r.errors.slice(0, 4).join('; ')}`).join('\n');
  return [
    ...messages,
    { role: 'assistant', content: String(raw || '') },
    { role: 'user', content: `Estas preguntas no valen:\n${list}\n\nCorrige SOLO esas y responde SOLO con {"items": [...]}, con los mismos ids. Si una cita no aparece literal, cópiala de nuevo del capítulo carácter a carácter o elige otra que sí esté.` },
  ];
}

export function mergeRetry(spec, fixed) {
  const items = Array.isArray(fixed?.items) ? fixed.items : [];
  const byId = new Map(items.filter((it) => it && it.id).map((it) => [it.id, it]));
  return { ...spec, items: spec.items.map((it) => (it && byId.has(it.id) ? byId.get(it.id) : it)) };
}
