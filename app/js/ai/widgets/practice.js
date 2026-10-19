// P43 F3 · La práctica en la app: generar la matriz de un capítulo y hacerla.
//
// La matriz es un EJERCICIO del mazo (`deck.exercises`, ver db.js), no una tarjeta: tiene muchas
// respuestas y lleva minutos, y FSRS programa preguntas sueltas. Se hace, se corrige celda a
// celda, el intento va al store `attempts` (mode 'widget') y lo fallado o dudado entra al mazo
// como tarjetas básicas, que sí vuelven con FSRS (ADR-057).
//
//   generateMatrix({ chapter, text, bookId, lang, signal, background }) → exercise
//   open({ deck, exercise, onClose })                                   → overlay
import { t, getLang } from '../../i18n.js';
import * as LLM from '../llm.js';
import * as DB from '../db.js';
import { icon } from '../../ui/icons.js';
import { escapeHtml } from '../../ui/escape.js';
import { widgetAttempt } from './core.js';
import { renderMatrix, matrixCards } from './matrix.js';
import { matrixMessages, parseSpec, finishSpec, specErrors, retryMessages } from './generate.js';
import { mcqMessages, finishMcq, itemResults, mcqSpecErrors, retryMcqMessages, mergeRetry } from './generate-mcq.js';

// Sin razonamiento: con él, deepseek-v4-flash gasta todo el cupo pensando y no escribe el JSON
// (medido en la app el 19-oct: 45 000 caracteres de razonamiento y content vacío, con 12 000
// tokens). Sin él, el eval c1-nothink dio 90 % a la primera. 8000 cabe bajo el techo del gateway.
const MAX_TOKENS = 8000;

// Una llamada y, si el spec no vale, un reintento con los errores concretos (el mismo ciclo que
// mide evals/widgets.mjs). Si tampoco vale, falla: un spec que no pasa no se enseña.
export async function generateMatrix({ chapter, text, bookId, lang = getLang(), signal, background = false }) {
  const messages = matrixMessages({ chapter, text, lang });
  const ask = (msgs) => LLM.chatStream({ messages: msgs, maxTokens: MAX_TOKENS, thinking: false, signal, background });
  const check = (raw) => {
    const spec = finishSpec(parseSpec(raw), { bookId, chapter });
    return { spec, errors: specErrors(spec, text) };
  };
  const raw = await ask(messages);
  let res = check(raw);
  if (res.errors.length) res = check(await ask(retryMessages(messages, raw, res.errors)));
  if (res.errors.length) {
    console.warn(`practice: la matriz no pasó la validación: ${res.errors.slice(0, 8).join(' · ')}`);
    throw new Error(t('La matriz no salió bien (citas o formato). Vuelve a intentarlo.'));
  }
  const now = Date.now();
  return { type: 'matrix', spec: res.spec, createdAt: now, last: null };
}

// P43 F4b · Preguntas con distractores de un capítulo → tarjetas `mcq` del mazo (atómicas, con
// FSRS). Mismo ciclo que el eval (evals/mcq.mjs): sin razonamiento; si el spec entero no vale, se
// pide entero otra vez; si fallan preguntas sueltas, solo esas. Las que sigan mal se descartan.
export async function generateMcqCards({ chapter, text, lang = getLang(), signal, background = false }) {
  const messages = mcqMessages({ chapter, text, lang });
  const ask = (msgs) => LLM.chatStream({ messages: msgs, maxTokens: MAX_TOKENS, thinking: false, signal, background });
  const raw = await ask(messages);
  let spec = finishMcq(parseSpec(raw), { chapter });
  const whole = mcqSpecErrors(spec);
  if (whole.length) {
    spec = finishMcq(parseSpec(await ask(retryMessages(messages, raw, whole))), { chapter });
    if (mcqSpecErrors(spec).length) throw new Error(t('Las preguntas no salieron bien. Vuelve a intentarlo.'));
  } else {
    const failed = itemResults(spec, text).filter((r) => r.errors.length);
    if (failed.length) spec = mergeRetry(spec, finishMcq(parseSpec(await ask(retryMcqMessages(messages, raw, failed))) || {}, {}));
  }
  const ok = new Set(itemResults(spec, text).filter((r) => !r.errors.length).map((r) => r.id));
  const cards = spec.items.filter((it) => it && ok.has(it.id)).map((it) => mcqCard(it, chapter));
  if (!cards.length) throw new Error(t('Las preguntas no salieron bien. Vuelve a intentarlo.'));
  return cards;
}

// Tarjeta del mazo: `front` el enunciado, `back` la correcta y su porqué (lo que viaja a Anki y lo
// que ve el editor), `options` con el feedback de cada una y `quote` la cita literal, que el repaso
// enseña como «Ver el pasaje del libro».
export function mcqCard(item, chapter) {
  const right = item.options.find((o) => o.correct);
  return {
    type: 'mcq',
    front: item.stem.trim(),
    back: [right.text, right.feedback].filter(Boolean).join('\n\n'),
    options: item.options.map(({ id, text, correct, feedback }) => ({ id, text, correct, feedback })),
    quote: item.cite.quote.trim(),
    chapter: chapter || '',
    src: '',
  };
}

// El ejercicio que se ofrece al pulsar «Practicar»: el más reciente.
export function latestExercise(deck) {
  return DB.exercisesOf(deck).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0] || null;
}

const normFront = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

let overlay = null;
let onCloseCb = null;

export function isOpen() { return !!overlay; }

export function open({ deck, exercise, onClose } = {}) {
  close();
  if (!deck || !exercise) return;
  onCloseCb = onClose || null;
  const spec = exercise.spec;
  const startedAt = Date.now();
  overlay = document.createElement('div');
  overlay.id = 'ai-practice';
  overlay.className = 'ai-onboarding';
  overlay.innerHTML = `
    <div class="ai-ob-card wgt-practice-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(t('Practicar'))}">
      <button class="ai-ob-close" title="${t('Cerrar')}" aria-label="${t('Cerrar')}">${icon('xmark', { size: 'lg' })}</button>
      <div class="ai-ob-body">
        <p class="ai-ob-sub wgt-practice-ctx">${escapeHtml(spec.chapter || '')}${exercise.last ? ` · ${escapeHtml(t('La última vez: {n} de {total}', { n: exercise.last.correct, total: exercise.last.total }))}` : ''}</p>
        <div class="wgt-practice-root"></div>
        <p class="ai-ob-sub wgt-practice-note" hidden></p>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.ai-ob-close').addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  const note = overlay.querySelector('.wgt-practice-note');
  renderMatrix(overlay.querySelector('.wgt-practice-root'), spec, {
    onCommit: async (result, answers) => {
      const ts = Date.now();
      try {
        const added = await saveResult({ deck, exercise, result, answers, ts, latencyMs: ts - startedAt });
        if (!note.isConnected) return;
        note.textContent = added
          ? t('{n} tarjetas al mazo con lo que fallaste o dudaste: vuelven en el repaso.', { n: added })
          : t('Nada nuevo para el mazo.');
        note.hidden = false;
      } catch (e) {
        console.warn('practice: no se pudo guardar el resultado', e);
      }
    },
  });
}

// ESC cierra la práctica antes que el modal de flashcards que hay debajo.
function onKey(e) {
  if (e.key !== 'Escape' || !overlay) return;
  e.stopPropagation();
  close();
}

export function close() {
  document.removeEventListener('keydown', onKey, true);
  if (!overlay) return;
  overlay.remove();
  overlay = null;
  const cb = onCloseCb;
  onCloseCb = null;
  if (cb) cb();
}

// Intento al store de P42 y tarjetas de lo fallado al mazo, sin repetir frentes que ya estén.
// Devuelve cuántas tarjetas entraron. Lee el mazo de nuevo: puede haber cambiado (sync, edición)
// mientras se hacía la matriz.
export async function saveResult({ deck, exercise, result, answers, ts, latencyMs }) {
  await DB.addAttempt(widgetAttempt({
    uid: crypto.randomUUID(), spec: exercise.spec, bookId: deck.bookId, ts, latencyMs, result, answer: answers,
  }));
  const cur = (await DB.getDecks(deck.bookId)).find((d) => d.id === deck.id);
  if (!cur) return 0;
  const have = new Set(DB.cardsOf(cur).map((c) => normFront(c.front)));
  const fresh = matrixCards(exercise.spec, result).filter((c) => {
    const k = normFront(c.front);
    if (!k || have.has(k)) return false;
    have.add(k);
    return true;
  });
  const last = { correct: result.correct, total: result.total, ts };
  const exercises = DB.exercisesOf(cur).map((e) => (e.uid === exercise.uid ? { ...e, last } : e));
  const patch = { exercises };
  if (fresh.length) {
    patch.cards = DB.cardsOf(cur).concat(fresh);
    if (cur.cardType !== 'basic') patch.cardType = 'mixed';
  }
  await DB.updateDeck(cur.id, patch);
  exercise.last = last;
  return fresh.length;
}
