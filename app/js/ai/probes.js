// probes.js — Preguntas de comprobación (P55): la medida de aprendizaje que no se puede inflar.
//
// Toda la retención del repaso es recuerdo de la MISMA tarjeta, y FSRS la lleva al 90 % por
// construcción. Lo que separa «memoricé mis tarjetas» de «entendí el capítulo» es una pregunta
// que cumpla las tres condiciones de una medida de aprendizaje (docs/INVESTIGACION_METRICAS_APRENDIZAJE.md
// § 6.1): DIFERIDA (≥ 14 días después de dejar atrás el capítulo), SIN AYUDA (no hay agente ni
// pasaje hasta responder) y NUEVA (sale del capítulo, no de una tarjeta, y nunca vuelve).
//
// Flujo:
//   1. El lector deja atrás un capítulo → chapter-gate.js fecha `chaptersDoneAt[etiqueta]`.
//   2. Al abrir el repaso del día, `nextCandidate` busca un capítulo fechado hace ≥ 14 días, en el
//      que el lector hizo algo (subrayó o tiene tarjetas) y que no tenga ya su pregunta.
//   3. `generate` la escribe el agente en ese momento, sin enseñarla antes a nadie.
//      En PDF la fecha la pone app.js con el outline (chapter-gate.js · stampLeft).
//   4. El lector responde por escrito; `judge` corrige contra la respuesta esperada y el texto.
//   5. `record` deja UN intento inmutable en `attempts` con `mode: 'probe'`. Viaja por sync como
//      los demás (unión por uid) y es lo que impide repetir la pregunta en otro dispositivo.
//
// Los intentos `probe` no llevan `grade`: study-stats.js los deja fuera de la retención, de la
// calibración y del recuento de repasos. No alimentan a FSRS. Su cifra: study-stats.js · probeStats.
import * as DB from './db.js';
import * as LLM from './llm.js';
import * as Storage from '../storage.js';
import * as Store from '../library/store.js';
import * as SegmentFile from './segment-file.js';
import { canonicalOf } from '../sync/aliases.js';

export const DELAY_DAYS = 14;
export const AFTER_CARDS = 2;       // la pregunta sale tras las primeras tarjetas, no de entrada
const DAY_MS = 864e5;
const MAX_CHAPTER_CHARS = 32000;    // ~8 k tokens: de un capítulo más largo se toman muestras repartidas
const SAMPLE_WINDOWS = 8;

const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
export const probeKey = (bookId, chapter) => `${canonicalOf(bookId)}|${norm(chapter)}`;

// Capítulos ya preguntados (respondidos, «no lo sé» o saltados: los tres cierran el capítulo).
export function askedKeys(attempts) {
  const out = new Set();
  for (const a of attempts || []) if (a && a.mode === 'probe' && a.probe) out.add(probeKey(a.bookId, a.probe.chapter));
  return out;
}

// Candidatos a pregunta, del más antiguo al más reciente. PURA.
//   books:    fichas de la biblioteca (con `chaptersDoneAt`)
//   attempts: todos los intentos (para no repetir)
//   engaged:  (bookId, etiqueta) → bool — si el lector hizo algo en ese capítulo
export function candidates(books, attempts, engaged, now = Date.now()) {
  const asked = askedKeys(attempts);
  const out = [];
  for (const b of books || []) {
    if (!b || b.deleted || !b.chaptersDoneAt || typeof b.chaptersDoneAt !== 'object') continue;
    for (const [chapter, at] of Object.entries(b.chaptersDoneAt)) {
      if (!Number.isFinite(at) || now - at < DELAY_DAYS * DAY_MS) continue;
      if (asked.has(probeKey(b.id, chapter))) continue;
      if (!engaged(b.id, chapter)) continue;
      out.push({ bookId: b.id, title: b.title || '', chapter, readAt: at });
    }
  }
  return out.sort((x, y) => x.readAt - y.readAt);
}

// ¿Hizo algo el lector en ese capítulo? Subrayados (localStorage, uno por libro) o tarjetas
// (la del propio capítulo o, si no lo tiene, el ámbito del mazo). Preguntar por un capítulo que
// se leyó en diagonal mide el diagonal, no el aprendizaje.
export function engagementIndex(highlightsByKey, decks) {
  const keys = new Set();
  for (const [key, list] of Object.entries(highlightsByKey || {})) {
    if (!Array.isArray(list)) continue;
    const id = key.replace(/^highlights_/, '');
    for (const h of list) if (h && !h.deleted && h.chapter) keys.add(probeKey(id, h.chapter));
  }
  for (const d of decks || []) {
    if (!d || d.deleted) continue;
    for (const c of d.cards || []) {
      if (!c || c.deleted) continue;
      const ch = c.chapter || d.scope;
      if (ch) keys.add(probeKey(d.bookId, ch));
    }
  }
  return (bookId, chapter) => keys.has(probeKey(bookId, chapter));
}

// El siguiente capítulo por el que preguntar, o null.
export async function nextCandidate(now = Date.now()) {
  const [books, attempts, decks] = await Promise.all([
    Store.getAllBooks(), DB.getAll('attempts'), DB.getAllDecks(),
  ]);
  const engaged = engagementIndex(Storage.getAll('highlights_'), decks);
  return candidates(books, attempts, engaged, now)[0] || null;
}

// Texto del capítulo, en pasajes `[[aN]] …`, a partir del libro segmentado de este dispositivo.
async function chapterPassages(bookId, chapter) {
  const read = async () => {
    const [anchors, text] = await Promise.all([DB.get('anchors', bookId), DB.get('bookText', bookId)]);
    if (!anchors || !text) return null;
    const inChapter = new Set();
    for (const [id, a] of anchors.entries || []) if (a && norm(a.chapter) === norm(chapter)) inChapter.add(id);
    const lines = [];
    for (const line of (text.annotatedText || '').split('\n')) {
      const m = /^\[\[(a\d+)\]\]\s*(.*)$/.exec(line);
      if (m && inChapter.has(m[1])) lines.push(line);
    }
    return lines;
  };
  let lines = await read();
  if (!lines && await SegmentFile.ensureSegmented(bookId)) lines = await read();
  if (!lines || !lines.length) return null;
  return sampleLines(lines, MAX_CHAPTER_CHARS);
}

// Si el capítulo no cabe, se toman tramos SEGUIDOS de varias partes (inicio, medio, final), en
// orden: cortar por el final dejaba la pregunta siempre sobre el arranque del capítulo. PURA.
export function sampleLines(lines, cap, windows = SAMPLE_WINDOWS) {
  const total = lines.reduce((n, l) => n + l.length + 1, 0);
  if (total <= cap) return lines.join('\n') + '\n';
  const per = Math.floor(cap / windows);
  const size = Math.ceil(lines.length / windows);
  let out = '';
  for (let w = 0; w < windows; w++) {
    let used = 0;
    for (const l of lines.slice(w * size, (w + 1) * size)) {
      if (used + l.length + 1 > per) break;
      out += l + '\n';
      used += l.length + 1;
    }
  }
  return out;
}

function parseJson(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}

// Escribe la pregunta. Devuelve {question, expected, keyIdeas, src, passages} o null si no hay
// texto del capítulo en este dispositivo o el modelo no devuelve algo usable.
export async function generate(cand, { signal } = {}) {
  const passages = await chapterPassages(cand.bookId, cand.chapter);
  if (!passages) return null;
  const raw = await LLM.chatStream({
    signal,
    maxTokens: 700,
    messages: [
      { role: 'system', content:
`Escribes UNA pregunta para comprobar si un lector ENTENDIÓ un capítulo que leyó hace dos semanas. No es un examen de memoria literal.
Reglas:
- Pregunta por la idea central del capítulo o por cómo se aplica: un caso nuevo, una consecuencia, un «¿por qué…?». Nunca una definición que se responda copiando una frase.
- Que se pueda responder en 2-4 frases sin el libro delante, si se entendió.
- No cites ni reproduzcas el texto en la pregunta. No uses nombres propios secundarios que solo sirven para recordar el detalle.
- Escribe en el idioma del capítulo.
Devuelve SOLO un JSON: {"pregunta": "…", "respuesta_esperada": "2-4 frases", "ideas_clave": ["2-4 ideas que una buena respuesta debe contener"], "src": ["aN de los pasajes que la respaldan"]}` },
      { role: 'user', content: `CAPÍTULO «${cand.chapter}»\n\n${passages}` },
    ],
  });
  const j = parseJson(raw);
  const question = String(j?.pregunta || '').trim();
  const expected = String(j?.respuesta_esperada || '').trim();
  if (!question || !expected) return null;
  const keyIdeas = Array.isArray(j.ideas_clave) ? j.ideas_clave.map(String).filter(Boolean).slice(0, 4) : [];
  const src = Array.isArray(j.src) ? j.src.map(String).filter((s) => /^a\d+$/.test(s)).slice(0, 6) : [];
  const support = src.length
    ? passages.split('\n').filter((l) => src.some((s) => l.startsWith(`[[${s}]]`))).map((l) => l.replace(/^\[\[a\d+\]\]\s*/, '')).join('\n\n')
    : '';
  return { question, expected, keyIdeas, src, passages: support };
}

// Veredicto para el registro: 'good' | 'partial' | 'wrong' | null (respuesta ilegible del modelo:
// no es un fallo del lector y no se cuenta como tal).
export function verdictOf(raw) {
  try {
    const v = String(parseJson(raw)?.veredicto || '').toLowerCase().trim();
    if (v.startsWith('bien')) return 'good';
    if (v.includes('medias')) return 'partial';
    if (v.startsWith('mal')) return 'wrong';
  } catch { /* JSON roto */ }
  return null;
}

// Corrige la respuesta. Devuelve {verdict, comment}.
export async function judge(probe, answer, { signal } = {}) {
  const raw = await LLM.chatStream({
    signal,
    maxTokens: 300,
    messages: [
      { role: 'system', content:
`Corriges la respuesta de un lector a una pregunta de comprensión sobre un capítulo que leyó hace semanas. Corrige el CONTENIDO, no la redacción ni el vocabulario: decirlo con otras palabras vale.
- "bien": contiene la idea central (casi todas las ideas clave), sin errores de fondo.
- "a medias": acierta una parte o va bien encaminado pero le falta lo esencial.
- "mal": no responde a lo que se pregunta, o lo que dice es incorrecto.
Devuelve SOLO un JSON: {"veredicto": "bien" | "a medias" | "mal", "comentario": "una o dos frases, en el idioma del lector: qué acertó y qué le falta"}` },
      { role: 'user', content:
`PREGUNTA\n${probe.question}\n\nRESPUESTA ESPERADA\n${probe.expected}\n\nIDEAS CLAVE\n${probe.keyIdeas.map((k) => `- ${k}`).join('\n') || '(sin lista)'}\n\nPASAJES DEL LIBRO\n${probe.passages || '(no disponibles)'}\n\nRESPUESTA DEL LECTOR\n${answer}` },
    ],
  });
  let comment = '';
  try { comment = String(parseJson(raw)?.comentario || ''); } catch { /* sin comentario */ }
  return { verdict: verdictOf(raw), comment };
}

// Registro inmutable del resultado. `outcome`: 'answered' | 'dontknow' | 'skipped'.
// `disputed`: el lector marcó la corrección como injusta (la única validación del juez que cabe
// on-device; se cuenta al lado de la cifra).
export function recordOf({ cand, probe, outcome, answer = null, verdict = null, disputed = false, latencyMs = null, now = Date.now() }) {
  return {
    uid: crypto.randomUUID(),
    cardUid: null, deckUid: null,
    bookId: cand.bookId,
    ts: now,
    mode: 'probe',
    verdict: outcome === 'dontknow' ? 'wrong' : outcome === 'skipped' ? null : (verdict ?? null),
    exact: null, grade: null, prevInterval: null, arm: null, cardHash: null, asked: false,
    latencyMs,
    answer: outcome === 'answered' ? String(answer || '').slice(0, 2000) : null,
    probe: {
      chapter: cand.chapter,
      readAt: cand.readAt,
      delayDays: Math.floor((now - cand.readAt) / DAY_MS),
      question: probe?.question || null,
      expected: probe?.expected || null,
      keyIdeas: probe?.keyIdeas || [],
      src: probe?.src || [],
      outcome,
      disputed: !!disputed,
    },
  };
}

export function record(rec) {
  return DB.addAttempt(rec);
}

// ---- Prueba: programar ya las preguntas de un libro ----------------------------------------
// `?probes-test=<parte del título o del id>` (app.js) fecha hace 14 días los capítulos que ya
// quedaron atrás de un libro, para no esperar dos semanas a ver la primera pregunta. Solo los que
// no tenían fecha. Detrás quiere decir: EPUB → `chaptersDone`; PDF → capítulos cuyo texto termina
// antes de la posición de lectura (`progress`), con las páginas del libro segmentado.
export function behindPdf(anchorEntries, progress) {
  const last = new Map();
  let maxPage = 0;
  for (const [, a] of anchorEntries || []) {
    if (!a || !a.chapter || !Number.isFinite(a.page)) continue;
    last.set(a.chapter, Math.max(last.get(a.chapter) || 0, a.page));
    maxPage = Math.max(maxPage, a.page);
  }
  const cut = (Number(progress) || 0) / 100 * maxPage;
  return [...last.entries()].filter(([, p]) => p < cut).map(([ch]) => ch);
}

export async function backfillForTest(query, now = Date.now()) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  const books = await Store.getAllBooks();
  const book = books.find((b) => b && !b.deleted && (String(b.id).startsWith(q) || String(b.title || '').toLowerCase().includes(q)));
  if (!book) return { found: false };
  let left;
  if (book.format === 'pdf') {
    let anchors = await DB.get('anchors', book.id);
    if (!anchors && await SegmentFile.ensureSegmented(book.id)) anchors = await DB.get('anchors', book.id);
    left = behindPdf(anchors?.entries, book.progress);
  } else {
    left = Array.isArray(book.chaptersDone) ? book.chaptersDone : [];
  }
  const readAt = now - DELAY_DAYS * DAY_MS - 3600e3;
  let added = 0;
  await Store.patchBook(book.id, (prev) => {
    const at = { ...(prev.chaptersDoneAt && typeof prev.chaptersDoneAt === 'object' ? prev.chaptersDoneAt : {}) };
    const have = new Set(Object.keys(at).map(norm));
    for (const l of left) if (!have.has(norm(l))) { at[l] = readAt; added++; }
    return added ? { chaptersDoneAt: at } : {};
  });
  const decks = await DB.getAllDecks();
  const engaged = engagementIndex(Storage.getAll('highlights_'), decks);
  const ready = candidates([{ ...book, chaptersDoneAt: Object.fromEntries(left.map((l) => [l, readAt])) }],
    await DB.getAll('attempts'), engaged, now).length;
  return { found: true, title: book.title || '', behind: left.length, added, ready };
}

