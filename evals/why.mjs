#!/usr/bin/env node
// P46 · Eval de «¿Por qué?» (la duda desde la tarjeta girada). Fuera de `npm test`: llama al modelo.
//
//   node evals/why.mjs <run>             genera v1 y v2 y puntúa
//   node evals/why.mjs <run> --rescore   solo vuelve a puntuar lo generado
//
// Batería: 10 tarjetas de DDIA (evals/fixtures/ddia.epub) escritas a mano sobre un párrafo real
// del libro, al estilo de las del repaso. Dos son las de las capturas del 2026-10-26 (3PC y el
// sort-merge join). El pasaje y sus vecinos se sacan del EPUB igual que la app los da: un párrafo
// por ancla.
//
// Condiciones: v1 (el prompt de la F1, con la duda vacía) contra v2 (why-prompt.js) con la duda
// vacía y con las tres preguntas de un toque. Métricas:
//   cita_ok    determinista: la respuesta empieza con una cita literal del pasaje o sus vecinos
//   palabras   determinista: palabras fuera de la cita
//   nuevo      juez: fracción de frases que dicen algo que la tarjeta no dice
//   error      juez: alguna afirmación falsa o que contradice el pasaje
// El juez es glm5.3-flash (neutral frente al generador, ver evals/judge.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadEnv, nanChat, RUNS, ROOT, pct, avg, lastJsonObject } from './lib.mjs';
import { whyMessages, quoteOk, leadingQuote, WHY_KINDS } from '../app/js/ai/why-prompt.js';

loadEnv();
const args = process.argv.slice(2);
const run = args[0];
if (!run || run.startsWith('--')) { console.error('uso: node evals/why.mjs <run> [--rescore]'); process.exit(2); }
const MODEL = 'deepseek-v4-flash';   // el DEFAULT_MODEL de la app (llm.js)
const JUDGE = process.env.EVAL_JUDGE || 'glm5.3-flash';
const NO_THINK = { thinking: { type: 'disabled' } };
const DIR = path.join(RUNS, `why-${run}`);
const FILE = path.join(DIR, 'results.json');
fs.mkdirSync(DIR, { recursive: true });

const CARDS = [
  { id: '3pc', ch: 'ch09', chapter: '9. Consistency and Consensus', find: 'However, 3PC assumes a network with bounded delay',
    front: 'Three-phase commit (3PC) can only guarantee atomicity if the network has {{c1::bounded delay}} and the nodes have {{c2::bounded response times}}; with unbounded network delay and process pauses, it cannot guarantee atomicity.',
    back: 'Real networks have unbounded delays, so a timeout is not a reliable failure detector. That is why 2PC is still used, despite its blocking problem.', type: 'cloze' },
  { id: 'smj', ch: 'ch10', chapter: '10. Batch Processing', find: 'this technique is known as a secondary sort',
    front: 'How does a sort-merge join on user ID work in MapReduce?',
    back: 'Mappers emit records from both datasets keyed by user ID; the shuffle groups them, and a secondary sort puts the user record first, then the events. Each reducer holds only one user record in memory and never makes network requests.' },
  { id: 'lin', ch: 'ch09', chapter: '9. Consistency and Consensus', find: 'linearizability is a recency guarantee',
    front: 'What kind of guarantee is linearizability?', back: 'A recency guarantee: once a write completes, every read sees that value or a newer one, never a stale copy.' },
  { id: 'wskew', ch: 'ch07', chapter: '7. Transactions', find: 'This anomaly is called write skew',
    front: 'Why is write skew neither a dirty write nor a lost update?', back: 'Because the two transactions update two different objects; the conflict is only visible through the condition both of them checked.' },
  { id: 'si', ch: 'ch07', chapter: '7. Transactions', find: 'readers never block writers',
    front: 'Key performance principle of snapshot isolation?', back: 'Readers never block writers, and writers never block readers.' },
  { id: 'ryw', ch: 'ch05', chapter: '5. Replication', find: 'read-after-write consistency, also known',
    front: 'What does read-after-write consistency guarantee, and what does it not?', back: 'You always see your own updates after reloading; it promises nothing about other users’ updates.' },
  { id: 'compact', ch: 'ch03', chapter: '3. Storage and Retrieval', find: 'Compaction means throwing away duplicate keys',
    front: 'In a log-structured store, what does compaction do?', back: 'Throws away duplicate keys in the log segments and keeps only the most recent update for each key.' },
  { id: 'hotspot', ch: 'ch06', chapter: '6. Partitioning', find: 'is called a hot spot',
    front: 'What is a hot spot in partitioning?', back: 'A partition with disproportionately high load, caused by skew.' },
  { id: 'fence', ch: 'ch08', chapter: '8. The Trouble with Distributed Systems', find: 'it also returns a fencing token',
    front: 'What is a fencing token?', back: 'A number that increases every time the lock service grants a lock; storage rejects writes carrying an older token.' },
  { id: 'logbroker', ch: 'ch11', chapter: '11. Stream Processing', find: 'more like reading from a file',
    front: 'How does consuming differ between a log-based broker and an AMQP/JMS broker?', back: 'In a log-based broker consuming is read-only and leaves the log unchanged; in AMQP/JMS, acknowledging deletes the message.' },
];

// Extracción mínima del EPUB (como widgets-battery.mjs), por párrafos: un párrafo ≈ un ancla.
const BLOCK = /<\/?(p|div|h[1-6]|li|br|tr|pre|blockquote|dt|dd|table|section)\b[^>]*>/gi;
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const chapterCache = new Map();
function paragraphs(ch) {
  if (!chapterCache.has(ch)) {
    const html = execFileSync('unzip', ['-p', path.join(ROOT, 'evals', 'fixtures', 'ddia.epub'), `OEBPS/${ch}.html`], { maxBuffer: 64 << 20 }).toString('utf8');
    const text = html.replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ' ').replace(BLOCK, '\n').replace(/<[^>]+>/g, '')
      .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m)
      .replace(/[ \t\r\f\v]+/g, ' ');
    chapterCache.set(ch, text.split(/\n\s*\n/).map((s) => s.replace(/\s*\n\s*/g, ' ').trim()).filter((s) => s.length > 60));
  }
  return chapterCache.get(ch);
}

function contextOf(card) {
  const ps = paragraphs(card.ch);
  const i = ps.findIndex((p) => p.includes(card.find));
  if (i < 0) throw new Error(`${card.id}: no encuentro «${card.find}» en ${card.ch}`);
  return { passage: ps[i], before: ps[i - 1] || '', after: ps[i + 1] || '' };
}

const CLOZE = /\{\{c\d+::(.*?)(?:::.*?)?\}\}/g;
const expectedOf = (c) => c.type === 'cloze' ? c.front.replace(CLOZE, '$1') + `\n${c.back}` : `${c.front}\n${c.back}`;

// El prompt de la F1 (2026-10-26, commit a7f1bd5), copiado tal cual para tener la línea base.
function v1Messages({ book, chapter, expected, passage }) {
  return [
    { role: 'system', content:
`Eres un profesor que resuelve dudas durante un repaso con tarjetas de memoria. El alumno ya ha visto la respuesta de la tarjeta; ahora no entiende algo. Resuelve SU duda en 2 a 5 frases, apoyándote en el PASAJE DEL LIBRO. Si la respuesta no está en el pasaje, dilo y contesta con lo que sabes, marcándolo. No repitas la tarjeta ni hagas preámbulos. Si su historial muestra que confunde algo de forma repetida, señálalo en una frase. Responde en el idioma de la duda; si no hay duda escrita, en español.` },
    { role: 'user', content: `LIBRO\n${book} · ${chapter}\n\nTARJETA Y RESPUESTA\n${expected}\n\nPASAJE DEL LIBRO\n${passage}\n\nDUDA\n¿Por qué es esta la respuesta? Explícamelo.` },
  ];
}

const CONDITIONS = ['v1', 'v2', 'v2:example', 'v2:alternative', 'v2:matters'];

function messagesFor(cond, card, ctx) {
  const base = { book: 'Designing Data-Intensive Applications', chapter: card.chapter, expected: expectedOf(card), passage: ctx.passage };
  if (cond === 'v1') return v1Messages(base);
  const kind = cond.split(':')[1] || '';
  return whyMessages({ ...base, before: ctx.before, after: ctx.after, kind, lang: 'español' });
}

async function generate() {
  const results = [];
  for (const card of CARDS) {
    const ctx = contextOf(card);
    for (const cond of CONDITIONS) {
      const t0 = Date.now();
      // v1, como está desplegada (con razonamiento); v2 sin él, como la app nueva (askWhy, thinking: false). Con él, el primer run
      // salió con 18 de 50 respuestas vacías o cortadas: el razonamiento gastaba los 600 tokens.
      const answer = await nanChat({ model: MODEL, messages: messagesFor(cond, card, ctx), maxTokens: 600, temperature: 0.3, extra: cond === 'v1' ? {} : NO_THINK });
      results.push({ id: card.id, cond, answer, ms: Date.now() - t0 });
      process.stdout.write(`${card.id}/${cond} `);
    }
  }
  console.log();
  return results;
}

const words = (s) => s.split(/\s+/).filter(Boolean).length;

async function judge(card, ctx, r) {
  const quote = leadingQuote(r.answer);
  const body = quote ? r.answer.replace(/^[\s\S]*?(\n\s*\n|$)/, '') : r.answer;   // sin la cita
  if (!body.trim()) return { frases: 0, nuevas: 0, error: false, nota: 'vacía', vacia: true };
  const raw = await nanChat({
    model: JUDGE, maxTokens: 3000, temperature: 0,
    messages: [
      { role: 'system', content:
`Evalúas la explicación que un profesor dio a un alumno que repasa una tarjeta de memoria. Tienes la tarjeta, el pasaje del libro y su contexto, y la explicación.
1. Divide la explicación en frases (o puntos de lista). Para cada una, decide si dice algo que la TARJETA no dice ya (un mecanismo, un ejemplo, una consecuencia, una alternativa…) o si solo repite o parafrasea la tarjeta.
2. Decide si alguna afirmación es falsa o contradice el pasaje. Las simplificaciones razonables no son errores.
Devuelve SOLO un JSON: {"frases": n, "nuevas": n, "error": true|false, "nota": "si hay error, cuál, en una frase"}` },
      { role: 'user', content: `TARJETA\n${expectedOf(card)}\n\nPASAJE\n${ctx.passage}\n\nCONTEXTO\nAntes: ${ctx.before}\nDespués: ${ctx.after}\n\nEXPLICACIÓN\n${body}` },
    ],
  });
  const j = lastJsonObject(raw);
  // Sin JSON legible, o con 0 frases para un texto que las tiene: el juez falló, no la respuesta.
  if (!j || !(Number(j.frases) > 0)) return { frases: 0, nuevas: 0, error: false, nota: 'juez sin dato', sinDato: true, raw: String(raw).slice(-300) };
  return { frases: Number(j.frases), nuevas: Math.min(Number(j.nuevas) || 0, Number(j.frases)), error: j.error === true, nota: j.nota || '' };
}

async function score(results) {
  const byId = new Map(CARDS.map((c) => [c.id, c]));
  for (const r of results) {
    const card = byId.get(r.id);
    const ctx = contextOf(card);
    r.cita_ok = quoteOk(r.answer, ctx.passage, ctx.before, ctx.after);
    const q = leadingQuote(r.answer);
    r.palabras = words(r.answer) - (q ? words(q) : 0);
    r.juez = await judge(card, ctx, r);
    process.stdout.write('.');
  }
  console.log();
}

function report(results) {
  const rows = [];
  for (const cond of CONDITIONS) {
    const rs = results.filter((r) => r.cond === cond);
    rows.push({
      cond,
      n: rs.length,
      cita_ok: `${pct(rs.filter((r) => r.cita_ok).length, rs.length)} %`,
      vacias: rs.filter((r) => r.juez.vacia).length,
      sin_juez: rs.filter((r) => r.juez.sinDato).length,
      palabras: Math.round(avg(rs.map((r) => r.palabras))),
      nuevo: `${pct(rs.reduce((a, r) => a + r.juez.nuevas, 0), rs.reduce((a, r) => a + r.juez.frases, 0))} %`,
      error: rs.filter((r) => r.juez.error).length,
    });
  }
  console.table(rows);
  for (const r of results.filter((x) => x.juez.error)) console.log(`  error · ${r.id}/${r.cond}: ${r.juez.nota}`);
  return rows;
}

const prev = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : null;
const results = args.includes('--rescore') && prev ? prev.results : await generate();
await score(results);
const summary = report(results);
fs.writeFileSync(FILE, JSON.stringify({ meta: { model: MODEL, judge: JUDGE, kinds: Object.keys(WHY_KINDS), at: new Date().toISOString() }, summary, results }, null, 2));
console.log(`→ ${path.relative(ROOT, FILE)}`);
