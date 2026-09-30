// NB2 · La libreta que guía. Lógica pura (sin DOM ni red) de la pestaña Libreta del panel:
// qué pregunta te toca ahora, cómo se agrupan las notas por capítulo y cómo se lee un par
// HQ&A para llevarlo al mazo. El render y los eventos siguen en panel.js.
//
// Por qué «Te toca» y no un formulario: los campos de cognición (los que escribes tú) solo
// existían si abrías la libreta por tu cuenta, y se quedaban en «—». Cada campo declara
// CUÁNDO se pregunta (`when` en templates.js) y la libreta enseña UNA pregunta pendiente,
// en su momento: al empezar, al terminar un capítulo o al terminar el libro.
import { t } from '../i18n.js';
import * as Storage from '../storage.js';
import { isCognitionField } from './templates.js';

export function whenLabel(when) {
  if (when === 'inicio') return t('al empezar');
  if (when === 'capitulo') return t('en cada capítulo');
  if (when === 'final') return t('al terminar el libro');
  return '';
}

// ---- Estado por conversación (localStorage: pequeño y síncrono) ------------------------
// Último capítulo TERMINADO (se fija al avanzar al siguiente) y preguntas que dejaste para
// luego. Se guardan por conversación: otra conversación del mismo libro es otro objetivo.
const DONE_KEY = 'nb_done_chapter';
const SKIP_KEY = 'nb_skipped';

export function doneChapter(convoId) {
  return (Storage.get(DONE_KEY, {}) || {})[convoId] || '';
}
export function setDoneChapter(convoId, label) {
  const all = Storage.get(DONE_KEY, {}) || {};
  all[convoId] = label;
  Storage.set(DONE_KEY, all);
}
function skipId(key, chapter) { return `${key}|${chapter || ''}`; }
export function skipped(convoId) {
  return new Set(((Storage.get(SKIP_KEY, {}) || {})[convoId]) || []);
}
export function skipPrompt(convoId, key, chapter) {
  const all = Storage.get(SKIP_KEY, {}) || {};
  const list = new Set(all[convoId] || []);
  list.add(skipId(key, chapter));
  all[convoId] = [...list].slice(-200);
  Storage.set(SKIP_KEY, all);
}

// ---- La pregunta pendiente ------------------------------------------------------------
// Orden: lo de empezar (una vez), la del último capítulo terminado y, con el libro
// terminado, las del final. UNA sola a la vez: más sería otra vez un formulario.
// Devuelve { field, chapter } o null.
export function pendingPrompt(template, notes, { convoId, finished = false } = {}) {
  if (!template || !convoId) return null;
  const has = (key, chapter) => notes.some(n => n.fieldKey === key && (chapter == null || n.chapter === chapter));
  const skip = skipped(convoId);
  const asked = template.fields.filter(f => isCognitionField(f) && f.when && !f.fromGoal);

  for (const f of asked.filter(f => f.when === 'inicio')) {
    if (!has(f.key) && !skip.has(skipId(f.key))) return { field: f, chapter: '' };
  }
  const chap = doneChapter(convoId);
  const perChapter = asked.find(f => f.when === 'capitulo');
  if (chap && perChapter && !has(perChapter.key, chap) && !skip.has(skipId(perChapter.key, chap))) {
    return { field: perChapter, chapter: chap };
  }
  if (finished) {
    for (const f of asked.filter(f => f.when === 'final')) {
      if (!has(f.key) && !skip.has(skipId(f.key))) return { field: f, chapter: '' };
    }
  }
  return null;
}

// ---- Agrupar por capítulo ---------------------------------------------------------------
// En el orden del índice cuando lo hay; los capítulos que no están en él (o las notas
// antiguas sin capítulo) van al final. `current` siempre aparece, aunque aún no tenga notas.
export function groupByChapter(notes, { order = [], current = '' } = {}) {
  const groups = new Map();
  const add = (label) => { if (!groups.has(label)) groups.set(label, []); return groups.get(label); };
  for (const label of order) if (notes.some(n => (n.chapter || '') === label) || label === current) add(label);
  if (current) add(current);
  for (const n of notes) add(n.chapter || '').push(n);
  // Los vacíos que no son el actual sobran.
  return [...groups.entries()]
    .filter(([label, list]) => list.length || label === current)
    .sort(([a], [b]) => (a === '' ? 1 : 0) - (b === '' ? 1 : 0))
    .map(([chapter, list]) => ({ chapter, notes: list }));
}

// ---- HQ&A → tarjeta ---------------------------------------------------------------------
// Formato de la nota: «> fragmento» + «**P:** pregunta» + «**R:** respuesta». La respuesta
// en blanco es el marcador «_(escribe tu respuesta)_» (o su traducción): sin respuesta, no
// hay tarjeta —la tarjeta es TU respuesta, no la del modelo—.
export function parseQA(content) {
  const text = String(content || '');
  const q = (text.match(/\*\*(?:P|Q):\*\*\s*([\s\S]*?)(?=\n\s*\*\*(?:R|A):\*\*|$)/) || [])[1]?.trim() || '';
  const aRaw = (text.match(/\*\*(?:R|A):\*\*\s*([\s\S]*)$/) || [])[1]?.trim() || '';
  const quote = text.split('\n').filter(l => /^>\s?/.test(l)).map(l => l.replace(/^>\s?/, '')).join(' ').trim();
  const blank = !aRaw || /^_?\((escribe tu respuesta|write your answer)\)_?$/i.test(aRaw);
  return { q, a: blank ? '' : aRaw, quote };
}

// Texto plano de una nota (sin Markdown ni anclas) para prompts y tarjetas.
export function plainText(content) {
  return String(content || '')
    .replace(/\[\[a\d+\]\]/g, '')
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
