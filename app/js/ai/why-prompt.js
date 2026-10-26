// P46 · Prompt de «¿Por qué?» (la duda desde la tarjeta girada). Puro, sin DOM ni i18n: lo usan
// study.js y la eval (evals/why.mjs), que así mide exactamente el prompt que corre en la app.
//
// v2 (2026-10-26). La v1 contestaba «¿por qué es esta la respuesta?» parafraseando el dorso, sin
// citar el libro y en un bloque. Ahora: no repetir la tarjeta, empezar por una cita literal del
// pasaje (comprobable con quoteOk), marcar lo que no sale del libro, ≤ 80 palabras, y preguntas
// concretas (WHY_KINDS) en vez de la genérica. El contexto lleva los pasajes vecinos: la razón de
// lo que dice una tarjeta suele estar en el párrafo de al lado.
import { normalizeQuote } from './widgets/core.js';

export const WHY_PROMPT_VERSION = 2;

// Preguntas de un toque. La etiqueta la pone study.js (con t()); aquí va el encargo.
export const WHY_KINDS = {
  example: 'Dame un ejemplo concreto y pequeño, con datos mínimos inventados, que muestre la respuesta funcionando paso a paso.',
  alternative: '¿Qué alternativa descarta el libro aquí y por qué es peor? Si el pasaje no nombra ninguna, usa la más natural y márcala (fuera del libro).',
  matters: '¿Por qué importa esto en un sistema real? Qué problema evita o qué coste tiene.',
};

// Con la caja vacía: lo que la tarjeta no dice, no «por qué es esta la respuesta», que solo se
// puede contestar repitiéndola.
export const WHY_DEFAULT = 'Explícame lo que la tarjeta no dice: el mecanismo o la razón que hace que esta respuesta sea cierta.';

// El pasaje de la tarjeta y sus vecinos, del mapa ordenado aN → texto de passagesFor().
export function neighborPassages(map, src) {
  if (!map || !src || !map.has(src)) return { before: '', after: '' };
  const keys = [...map.keys()];
  const i = keys.indexOf(src);
  return { before: i > 0 ? map.get(keys[i - 1]) || '' : '', after: i + 1 < keys.length ? map.get(keys[i + 1]) || '' : '' };
}

export function whyMessages({ book = '', chapter = '', expected, passage = '', before = '', after = '', history = '', yours = '', question = '', kind = '', lang = 'español' }) {
  const ask = kind && WHY_KINDS[kind] ? WHY_KINDS[kind] : (question || WHY_DEFAULT);
  const system = `Eres un profesor que resuelve dudas durante un repaso con tarjetas de memoria. El alumno YA ha leído la tarjeta y su respuesta: no las parafrasees. Cada frase tiene que añadir algo que la tarjeta no dice.

Formato:
1. Empieza con UNA cita literal y corta (como mucho 30 palabras) del PASAJE o de su CONTEXTO que respalde lo que vas a explicar, como cita de Markdown: una línea que empieza por «> ». Cópiala exacta, en el idioma del libro, sin comillas.
2. Después, como mucho 80 palabras: frases cortas o una lista de 2 o 3 puntos. Sin preámbulos ni resumen final.
3. Lo que no salga del pasaje ni de su contexto, márcalo con «(fuera del libro)».
Si el historial muestra que confunde algo de forma repetida, dilo en una frase.
Responde en el idioma de la duda escrita; si la duda es una de las predefinidas o no hay, en ${lang}.`;
  const parts = [
    `LIBRO\n${book}${chapter ? ` · ${chapter}` : ''}`,
    `TARJETA Y RESPUESTA\n${expected}`,
    `PASAJE DEL LIBRO\n${passage || '(no disponible)'}`,
  ];
  if (before || after) parts.push(`CONTEXTO DEL PASAJE${before ? `\nAntes: ${before}` : ''}${after ? `\nDespués: ${after}` : ''}`);
  if (history) parts.push(`HISTORIAL DEL ALUMNO CON ESTA TARJETA\n${history}`);
  if (yours) parts.push(`LO QUE RESPONDIÓ AHORA\n${yours}`);
  parts.push(`DUDA\n${ask}`);
  return [{ role: 'system', content: system }, { role: 'user', content: parts.join('\n\n') }];
}

// La cita con la que empieza la respuesta (líneas «> »), o '' si no hay.
export function leadingQuote(answer) {
  const lines = String(answer || '').trim().split('\n');
  const q = [];
  for (const l of lines) { if (/^\s*>/.test(l)) q.push(l.replace(/^\s*>\s?/, '')); else if (q.length) break; else if (l.trim()) break; }
  return q.join(' ').trim();
}

// ¿La cita está, literal, en el pasaje o su contexto? Mismo normalizador que las citas de los
// widgets: absorbe comillas, guiones y espacios de la extracción.
export function quoteOk(answer, ...texts) {
  const q = normalizeQuote(leadingQuote(answer));
  if (q.split(' ').filter(Boolean).length < 4) return false;
  return texts.some((t) => t && normalizeQuote(t).includes(q));
}
