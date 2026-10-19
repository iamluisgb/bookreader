// P43 F2 · Generación de specs por el agente. Módulo PURO (sin DOM, sin red): arma los mensajes,
// parsea la respuesta del modelo y dice qué falla. La llamada al modelo la hace quien lo use (la
// app con llm.js; el eval con evals/widgets.mjs), para que los dos midan exactamente lo mismo.
//
// Un spec vale si pasa la validación de su tipo Y todas sus citas aparecen literales en el texto
// del capítulo (core.verifyQuotes). Es la métrica `widget_spec_valid` del contrato de P43.
//
// Ciclo: messages → modelo → parseSpec → specErrors. Si hay errores, retryMessages añade la
// respuesta y los errores concretos, y se pide una vez más. Lo que el modelo NO decide va fuera
// del prompt y lo pone `finishSpec`: type, version, bookId y chapter.

import { verifyQuotes, normalizeQuote, WIDGET_VERSION } from './core.js';
import { validateMatrix, matrixCites, MATRIX_LIMITS } from './matrix.js';

// Sube con cada cambio del prompt: va en cada run del eval para comparar contra el baseline.
export const PROMPT_VERSION = 'matrix-v2';

// Lo que cabe del capítulo en el prompt. Las citas se verifican contra el capítulo ENTERO: una
// cita literal sigue siendo del libro aunque quede fuera de lo enviado.
export const CHAPTER_CHAR_CAP = 60000;

const LANG_NAME = { es: 'español', en: 'English' };

export function matrixMessages({ chapter, text, lang = 'es' }) {
  const L = MATRIX_LIMITS;
  const ui = LANG_NAME[lang] || lang;
  const system = [
    'Eres un profesor que prepara un ejercicio de práctica sobre un capítulo de un libro.',
    'El ejercicio es una MATRIZ: filas = conceptos del capítulo que se confunden entre sí; columnas = atributos en los que difieren.',
    'Cada columna tiene opciones cerradas y cada celda tiene exactamente una respuesta correcta, que el capítulo sostiene.',
    'El lector rellena las celdas antes de ver nada; al comprobar ve el porqué y la cita del libro.',
    '',
    'Reglas:',
    `- Entre 3 y 6 filas y entre ${L.columns[0]} y 4 columnas, cada una con ${L.options[0]}–4 opciones.`,
    '- Filas: conceptos, casos o mecanismos del capítulo que el lector confundiría. La etiqueta es SOLO el nombre, sin pistas de ninguna respuesta.',
    '- Columnas: atributos en que esas filas difieren y que exigen haber entendido el capítulo (qué pasa si…, cuándo, de qué depende, qué consecuencia), no definiciones. Nada que se responda con cultura general.',
    '- Opciones CORTAS (≤ 40 caracteres): una categoría, un sí/no, un valor, un nombre. Nunca una frase que describa o parafrasee una fila.',
    '- Las opciones se REPITEN entre filas: en cada columna al menos dos filas comparten respuesta, o hay menos opciones que filas. Una columna con una opción distinta para cada fila se resuelve descartando, no comparando: no la hagas.',
    '- Cada celda: una respuesta que es EXACTAMENTE uno de los textos de `options` de su columna.',
    '- Puedes dar hechas 0–2 celdas (`"given": true`) como ejemplo, sin que las dadas permitan deducir otra celda por descarte. Las celdas dadas no llevan why ni cite.',
    `- Cada celda no dada lleva \`why\` (≤ ${L.why} caracteres, en ${ui}) y \`cite.quote\`: una cita LITERAL del capítulo, copiada carácter a carácter, de 12 a 400 caracteres, que sostenga la respuesta. No la traduzcas ni la resumas: en el idioma del libro.`,
    `- title (≤ 120), prompt (≤ 400), labels (≤ ${L.label}), options y why en ${ui}.`,
    '- No inventes nada que el capítulo no diga.',
    '',
    'Responde SOLO con un objeto JSON, sin texto alrededor, con esta forma:',
    '{"title": "...", "prompt": "...",',
    ' "rows": [{"id": "r1", "label": "..."}],',
    ' "columns": [{"id": "c1", "label": "...", "options": ["...", "..."]}],',
    ' "cells": [{"row": "r1", "col": "c1", "answer": "...", "why": "...", "cite": {"quote": "..."}}]}',
    'Una celda por cada fila × columna.',
  ].join('\n');
  const body = String(text || '').slice(0, CHAPTER_CHAR_CAP);
  const user = `Capítulo: ${chapter || '(sin título)'}\n\n<capitulo>\n${body}\n</capitulo>`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// Parseo tolerante: el modelo puede envolver el JSON en ```json, en razonamiento <think> o en
// prosa. Se queda con el objeto balanceado más grande que parsee.
export function parseSpec(raw) {
  const t = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, ' ').replace(/```(?:json)?/gi, ' ');
  const objs = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}' && depth > 0) { depth--; if (depth === 0 && start >= 0) { objs.push(t.slice(start, i + 1)); start = -1; } }
  }
  objs.sort((a, b) => b.length - a.length);
  for (const o of objs) {
    try { return JSON.parse(o); } catch { /* el siguiente */ }
    try { return JSON.parse(o.replace(/,\s*([}\]])/g, '$1')); } catch { /* el siguiente */ }
  }
  return null;
}

// Completa lo que no decide el modelo. No toca lo demás: si el modelo puso otro type, gana el
// nuestro (pedimos una matriz). Además repara las respuestas fuera de sus opciones (repairAnswers).
export function finishSpec(spec, { bookId, chapter } = {}) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return spec;
  return repairAnswers({ ...spec, type: 'matrix', version: WIDGET_VERSION, bookId: bookId ?? null, chapter: chapter ?? '' });
}

// Respuesta que no es una de las opciones de su columna (medido en la app el 19-oct: «Ninguna»
// en Pro Git, repetido en el reintento). Si casa salvo mayúsculas y espacios, se usa el texto de
// la opción; si no, y la columna tiene sitio, se añade como opción: sigue siendo cerrada y la
// sostiene su cita. Sin sitio se deja, y validateMatrix lo nombra para el reintento.
export function repairAnswers(spec) {
  if (!Array.isArray(spec.columns) || !Array.isArray(spec.cells)) return spec;
  const columns = spec.columns.map((c) => (c && Array.isArray(c.options) ? { ...c, options: [...c.options] } : c));
  const byId = new Map(columns.filter((c) => c && c.id).map((c) => [c.id, c]));
  const canon = (x) => String(x ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const cells = spec.cells.map((cell) => {
    const col = cell && byId.get(cell.col);
    if (!col || !Array.isArray(col.options) || typeof cell.answer !== 'string' || !cell.answer.trim()) return cell;
    if (col.options.includes(cell.answer)) return cell;
    const same = col.options.find((o) => canon(o) === canon(cell.answer));
    if (same) return { ...cell, answer: same };
    if (col.options.length < MATRIX_LIMITS.options[1]) {
      col.options.push(cell.answer.trim());
      return { ...cell, answer: cell.answer.trim() };
    }
    return cell;
  });
  return { ...spec, columns, cells };
}

// Errores de un spec ya completado: validación del tipo y, si pasa, citas que no están en el
// capítulo. Mensajes en español fijo: van al reintento y al informe del eval.
export function specErrors(spec, chapterText) {
  if (!spec) return ['la respuesta no contiene un objeto JSON'];
  const errors = validateMatrix(spec);
  if (errors.length) return errors;
  const missing = verifyQuotes(matrixCites(spec), chapterText);
  return missing.map((where) => `celda ${where}: la cita no aparece literal en el capítulo`);
}

// Señales de calidad que la validez no ve. No bloquean (un spec válido puede tenerlas); el eval
// las cuenta y deciden el siguiente ciclo de prompt.
//   constante: columna con la misma respuesta en todas las filas — no hay nada que comparar.
//   fuga: la respuesta está escrita en la etiqueta de la fila — se responde sin pensar.
//   emparejar: cada fila tiene su propia opción y ninguna se repite — se resuelve descartando,
//     no comparando (con una celda dada, la última sale gratis).
//   larga: opciones de más de 60 caracteres de media — la redacción delata la fila.
export const LONG_OPTION = 60;
export function qualityFlags(spec) {
  const flags = [];
  const norm = (s) => normalizeQuote(s).trim();
  for (const col of spec.columns) {
    const cells = spec.cells.filter((c) => c.col === col.id);
    const answers = new Set(cells.map((c) => c.answer));
    if (cells.length > 1 && answers.size === 1) flags.push({ kind: 'constante', where: col.id });
    if (cells.length > 2 && answers.size === cells.length) flags.push({ kind: 'emparejar', where: col.id });
    if (col.options.reduce((a, o) => a + o.length, 0) / col.options.length > LONG_OPTION) flags.push({ kind: 'larga', where: col.id });
    for (const c of cells) {
      if (c.given) continue;
      const row = spec.rows.find((r) => r.id === c.row);
      const a = norm(c.answer);
      // Solo respuestas con contenido (no «Sí», «No»): una palabra de 3 letras casa en cualquier parte.
      if (row && a.length >= 4 && norm(row.label).includes(a)) flags.push({ kind: 'fuga', where: `${c.row}|${c.col}` });
    }
  }
  return flags;
}

// Mensajes del reintento: la conversación anterior, la respuesta y los errores concretos.
export function retryMessages(messages, raw, errors) {
  const list = errors.slice(0, 20).map((e) => `- ${e}`).join('\n');
  return [
    ...messages,
    { role: 'assistant', content: String(raw || '') },
    { role: 'user', content: `El JSON no vale por esto:\n${list}\n\nCorrígelo y responde SOLO con el JSON completo. Si una cita no aparece literal, cópiala de nuevo del capítulo carácter a carácter o elige otra que sí esté.` },
  ];
}
