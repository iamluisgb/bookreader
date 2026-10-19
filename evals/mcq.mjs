#!/usr/bin/env node
// P43 F4 · Eval del tipo 5 (preguntas con distractores que enseñan). Fuera de `npm test`: llama
// al modelo. Misma batería que la matriz (evals/widgets-battery.mjs).
//
//   node evals/mcq.mjs <run> [--retry] [--thinking] [--model m] [--only id1,id2]
//   node evals/mcq.mjs <run> --rescore
//   node evals/mcq.mjs <run> --roundtrip [--solver m]
//
// Métrica primaria del contrato (BACKLOG · P43 F4): mcq_item_valid = preguntas que pasan
// validateMcqItem Y verifyQuotes a la PRIMERA respuesta / preguntas pedidas (MCQ_COUNT por
// capítulo). Sin razonamiento por defecto, como la app (--thinking lo enciende).
//
// --roundtrip: otro modelo responde cada pregunta válida viendo enunciado y opciones (nunca la
// clave ni el feedback). Con el capítulo: si no elige la clave, la pregunta es dudosa. Sin el
// capítulo (a ciegas): si acierta, la pregunta no hace trabajar.

import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, nanChat, RUNS, pct } from './lib.mjs';
import { loadWidgetBattery } from './widgets-battery.mjs';
import { parseSpec, retryMessages } from '../app/js/ai/widgets/generate.js';
import { mcqMessages, finishMcq, itemResults, mcqSpecErrors, retryMcqMessages, mergeRetry, MCQ_PROMPT_VERSION, MCQ_COUNT, CHAPTER_CHAR_CAP } from '../app/js/ai/widgets/generate-mcq.js';
import { mcqItemFlags } from '../app/js/ai/widgets/mcq.js';

loadEnv();
const args = process.argv.slice(2);
const run = args[0];
const flag = (f) => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
if (!run || run.startsWith('--')) { console.error('uso: node evals/mcq.mjs <run> [--retry] [--thinking] [--rescore] [--roundtrip] [--model m] [--only ids]'); process.exit(2); }

const MODEL = opt('--model', 'deepseek-v4-flash');
const SOLVER = opt('--solver', 'qwen3.8-flash');
const UI_LANG = opt('--lang', 'es');
const THINKING = flag('--thinking');
const GEN_EXTRA = THINKING ? {} : { thinking: { type: 'disabled' } };
const DIR = path.join(RUNS, `mcq-${run}`);
const FILE = path.join(DIR, 'results.json');
fs.mkdirSync(DIR, { recursive: true });

const battery = loadWidgetBattery();
const only = opt('--only', '');
const chapters = only ? battery.filter((c) => only.split(',').includes(c.id)) : battery;
const textOf = new Map(battery.map((c) => [c.id, c.text]));

function score(chapter, spec) {
  const specErrors = mcqSpecErrors(spec);
  const items = specErrors.length ? [] : itemResults(spec, chapter.text);
  const valid = items.filter((r) => !r.errors.length).map((r) => r.id);
  const flags = valid.map((id) => ({ id, flags: mcqItemFlags(spec.items.find((it) => it.id === id)) }));
  return { spec, specErrors, items, valid: valid.length, flags };
}

const callModel = (messages) => nanChat({ model: MODEL, messages, maxTokens: 8000, extra: GEN_EXTRA });

async function generate() {
  const prev = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : null;
  const results = prev ? prev.results.filter((r) => !chapters.some((c) => c.id === r.id)) : [];
  for (const c of chapters) {
    const messages = mcqMessages({ chapter: c.chapter, text: c.text, lang: UI_LANG });
    const t0 = Date.now();
    let raw = '', err = null;
    try { raw = await callModel(messages); } catch (e) { err = String(e.message || e); }
    const spec = finishMcq(parseSpec(raw), { bookId: c.book, chapter: c.chapter });
    const first = { raw, ms: Date.now() - t0, callError: err, ...score(c, spec) };
    const r = { id: c.id, book: c.book, chapter: c.chapter, chars: c.text.length, first };
    const failed = first.items.filter((x) => x.errors.length);
    // Sin spec usable (JSON roto, sin items): se pide entero otra vez, como en la matriz.
    if (flag('--retry') && !err && first.specErrors.length) {
      const t1 = Date.now();
      let raw2 = '';
      try { raw2 = await callModel(retryMessages(messages, raw, first.specErrors)); } catch (e) { err = String(e.message || e); }
      r.retry = { raw: raw2, whole: true, ms: Date.now() - t1, callError: err, ...score(c, finishMcq(parseSpec(raw2), { bookId: c.book, chapter: c.chapter })) };
    } else if (flag('--retry') && !err && failed.length) {
      const t1 = Date.now();
      let raw2 = '';
      try { raw2 = await callModel(retryMcqMessages(messages, raw, failed)); } catch (e) { err = String(e.message || e); }
      const merged = mergeRetry(first.spec, finishMcq(parseSpec(raw2) || {}, {}));
      r.retry = { raw: raw2, ms: Date.now() - t1, callError: err, ...score(c, merged) };
    }
    results.push(r);
    const fin = r.retry || first;
    console.log(`${c.id.padEnd(18)} ${first.valid}/${MCQ_COUNT}${r.retry ? ` → ${fin.valid}` : ''}  ${(first.ms / 1000).toFixed(0)}s  ${first.specErrors[0] || failed.map((x) => x.errors[0]).slice(0, 2).join(' · ')}`);
    save(results);
  }
  return results;
}

function rescore(results) {
  for (const r of results) {
    const c = battery.find((b) => b.id === r.id);
    Object.assign(r.first, score(c, finishMcq(parseSpec(r.first.raw), { bookId: c.book, chapter: c.chapter })));
    if (r.retry && r.retry.whole) Object.assign(r.retry, score(c, finishMcq(parseSpec(r.retry.raw), { bookId: c.book, chapter: c.chapter })));
    else if (r.retry) {
      const merged = mergeRetry(r.first.spec, finishMcq(parseSpec(r.retry.raw) || {}, {}));
      Object.assign(r.retry, score(c, merged));
    }
  }
  return results;
}

async function solve(r, spec, withText) {
  const ok = new Set((r.retry || r.first).items.filter((x) => !x.errors.length).map((x) => x.id));
  const shown = spec.items.filter((it) => ok.has(it.id)).map((it) => ({ id: it.id, stem: it.stem, options: it.options.map((o) => ({ id: o.id, text: o.text })) }));
  const sys = withText
    ? 'Respondes preguntas de práctica sobre un capítulo. Para cada pregunta eliges la ÚNICA opción que sostiene el capítulo.'
    : 'Respondes preguntas de práctica sin tener el capítulo delante. Para cada pregunta eliges la opción que te parezca más probable. Responde siempre, aunque no estés seguro.';
  const messages = [
    { role: 'system', content: `${sys} Responde SOLO con JSON: {"answers": [{"id": "q1", "option": "b"}]}.` },
    { role: 'user', content: `${withText ? `<capitulo>\n${textOf.get(r.id).slice(0, CHAPTER_CHAR_CAP)}\n</capitulo>\n\n` : ''}Preguntas:\n${JSON.stringify(shown)}` },
  ];
  let got = null;
  for (const extra of [{ thinking: { type: 'disabled' } }, {}]) {
    let raw = '';
    try { raw = await nanChat({ model: SOLVER, messages, maxTokens: 8000, extra }); } catch { raw = ''; }
    got = parseSpec(raw);
    if (got && Array.isArray(got.answers) && got.answers.length) break;
  }
  const byId = new Map(((got && got.answers) || []).map((a) => [a.id, a.option]));
  const items = shown.map((s) => {
    const key = spec.items.find((it) => it.id === s.id).options.find((o) => o.correct).id;
    return { id: s.id, answer: key, solver: byId.get(s.id) ?? null, options: s.options.length };
  });
  return { solver: SOLVER, agree: items.filter((x) => x.solver === x.answer).length, total: items.length, items };
}

async function roundtrip(results) {
  for (const r of results) {
    const best = r.retry || r.first;
    if (!best.valid) continue;
    r.roundtrip = await solve(r, best.spec, true);
    r.blind = await solve(r, best.spec, false);
    console.log(`${r.id.padEnd(18)} con capítulo ${r.roundtrip.agree}/${r.roundtrip.total} · a ciegas ${r.blind.agree}/${r.blind.total}`);
    save(results);
  }
  return results;
}

function save(results) {
  fs.writeFileSync(FILE, JSON.stringify({ run, promptVersion: MCQ_PROMPT_VERSION, model: MODEL, thinking: THINKING, uiLang: UI_LANG, date: new Date().toISOString(), results }, null, 1));
}

function summary(results) {
  const n = results.length;
  const asked = n * MCQ_COUNT;
  const v1 = results.reduce((a, r) => a + Math.min(r.first.valid, MCQ_COUNT), 0);
  const vf = results.reduce((a, r) => a + Math.min((r.retry || r.first).valid, MCQ_COUNT), 0);
  const specFail = results.filter((r) => r.first.specErrors.length).length;
  const errKinds = {};
  for (const r of results) for (const it of r.first.items) for (const e of it.errors) {
    const k = e.includes('no aparece literal') ? 'cita' : e.includes('exactamente una') ? 'clave' : e.includes('feedback') ? 'feedback' : e.includes('pasa de') ? 'largo' : 'forma';
    errKinds[k] = (errKinds[k] || 0) + 1;
  }
  const allFlags = results.flatMap((r) => (r.retry || r.first).flags || []);
  const fc = (k) => allFlags.filter((f) => f.flags.includes(k)).length;
  const rt = results.filter((r) => r.roundtrip);
  const ans = (x) => x.items.filter((i) => i.solver != null);
  const agree = rt.reduce((a, r) => a + r.roundtrip.agree, 0), tot = rt.reduce((a, r) => a + ans(r.roundtrip).length, 0);
  const blind = rt.reduce((a, r) => a + (r.blind ? r.blind.agree : 0), 0), btot = rt.reduce((a, r) => a + (r.blind ? ans(r.blind).length : 0), 0);
  const chance = rt.reduce((a, r) => a + (r.blind ? ans(r.blind).reduce((b, i) => b + 1 / i.options, 0) : 0), 0);
  const books = [...new Set(results.map((r) => r.book))];
  const lines = [
    `# mcq-${run}`, '',
    `Prompt ${MCQ_PROMPT_VERSION} · modelo ${MODEL} · razonamiento ${THINKING ? 'sí' : 'no'} · ${n} capítulos × ${MCQ_COUNT} preguntas`, '',
    `- **mcq_item_valid (1.ª respuesta): ${pct(v1, asked)} %** (${v1}/${asked}) · objetivo ≥ 85 %`,
    results.some((r) => r.retry) ? `- tras un reintento de las que fallan: ${pct(vf, asked)} % (${vf}/${asked})` : null,
    `- capítulos sin spec usable a la 1.ª: ${specFail}/${n}`,
    `- errores por pregunta a la 1.ª: ${Object.entries(errKinds).map(([k, v]) => `${k} ${v}`).join(', ') || 'ninguno'}`,
    allFlags.length ? `- señales en las válidas: correcta más larga en ${fc('larga')}/${allFlags.length}, comodín en ${fc('comodin')}/${allFlags.length}, eco del enunciado en ${fc('eco')}/${allFlags.length}, falsas absolutas y correcta matizada en ${fc('absolutas')}/${allFlags.length}` : null,
    rt.length ? `- ida y vuelta (${SOLVER}): con el capítulo elige la clave en el ${pct(agree, tot)} % (${agree}/${tot}); a ciegas acierta el ${pct(blind, btot)} % (al azar: ${pct(chance, btot)} %)` : null,
    '', '| Libro | 1.ª | Tras reintento |', '|---|---|---|',
    ...books.map((b) => { const rs = results.filter((r) => r.book === b); return `| ${b} | ${rs.reduce((a, r) => a + r.first.valid, 0)}/${rs.length * MCQ_COUNT} | ${rs.reduce((a, r) => a + (r.retry || r.first).valid, 0)}/${rs.length * MCQ_COUNT} |`; }),
    '', '## Fallos a la 1.ª', '',
    ...results.flatMap((r) => [
      ...r.first.specErrors.map((e) => `- ${r.id}: ${e}`),
      ...r.first.items.filter((i) => i.errors.length).map((i) => `- ${r.id} ${i.id}: ${i.errors.slice(0, 2).join(' · ')}`),
    ]),
  ].filter((l) => l != null);
  fs.writeFileSync(path.join(DIR, 'summary.md'), lines.join('\n') + '\n');
  console.log('\n' + lines.slice(0, 10).join('\n'));
}

let results;
if (flag('--rescore') || flag('--roundtrip')) {
  results = JSON.parse(fs.readFileSync(FILE, 'utf8')).results;
  if (flag('--rescore')) rescore(results);
  if (flag('--roundtrip')) await roundtrip(results);
  save(results);
} else {
  results = await generate();
}
summary(results);
