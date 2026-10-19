#!/usr/bin/env node
// P43 F2 · Eval de generación de widgets (tipo matriz). Fuera de `npm test`: llama al modelo.
//
//   node evals/widgets.mjs <run> [--retry] [--model m] [--only id1,id2]
//   node evals/widgets.mjs <run> --rescore         (re-puntúa lo guardado, sin llamar al modelo)
//   node evals/widgets.mjs <run> --roundtrip [--solver m]
//
// Métrica primaria del contrato (BACKLOG · P43): widget_spec_valid = % de specs que pasan
// validateMatrix Y verifyQuotes contra el capítulo. Se mide a la PRIMERA respuesta; con --retry
// se mide además tras un reintento con los errores concretos (`valid_after_retry`).
//
// --roundtrip (Alberti 2019, secundaria): otro modelo rellena la matriz de cada spec válido solo
// con el capítulo, sin ver las respuestas. Una celda en que no coincide es dudosa: o es ambigua o
// la respuesta del generador está mal. Mide el % de celdas que coinciden.
//
// Salida: evals/runs/widgets-<run>/results.json y summary.md. Llamadas en serie (nan rechaza la
// concurrencia con la misma key).

import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, nanChat, RUNS, pct } from './lib.mjs';
import { loadWidgetBattery } from './widgets-battery.mjs';
import { matrixMessages, parseSpec, finishSpec, specErrors, retryMessages, qualityFlags, PROMPT_VERSION, CHAPTER_CHAR_CAP } from '../app/js/ai/widgets/generate.js';

loadEnv();
const args = process.argv.slice(2);
const run = args[0];
const flag = (f) => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
if (!run || run.startsWith('--')) { console.error('uso: node evals/widgets.mjs <run> [--retry] [--rescore] [--roundtrip] [--model m] [--only ids]'); process.exit(2); }

const MODEL = opt('--model', 'deepseek-v4-flash');
const SOLVER = opt('--solver', 'qwen3.8-flash');
const UI_LANG = opt('--lang', 'es');
// --no-thinking: apaga el razonamiento del generador. Con él encendido, deepseek-v4-flash agota
// los 16 384 tokens razonando en 5 de 20 capítulos y devuelve content vacío (baseline-v1).
const GEN_EXTRA = flag('--no-thinking') ? { thinking: { type: 'disabled' } } : {};
const DIR = path.join(RUNS, `widgets-${run}`);
const FILE = path.join(DIR, 'results.json');
fs.mkdirSync(DIR, { recursive: true });

const battery = loadWidgetBattery();
const only = opt('--only', '');
const chapters = only ? battery.filter((c) => only.split(',').includes(c.id)) : battery;
const textOf = new Map(battery.map((c) => [c.id, c.text]));

// Clase de fallo, para el informe: lo que decide qué tocar en el siguiente ciclo.
function classify(errors) {
  if (!errors.length) return 'ok';
  if (errors.some((e) => e.startsWith('la respuesta no contiene'))) return 'parse';
  if (errors.every((e) => e.includes('no aparece literal'))) return 'citas';
  return 'esquema';
}

function score(chapter, raw) {
  const spec = finishSpec(parseSpec(raw), { bookId: chapter.book, chapter: chapter.chapter });
  const errors = specErrors(spec, chapter.text);
  const valid = errors.length === 0;
  return { spec, errors, valid, cls: classify(errors), flags: valid ? qualityFlags(spec) : [] };
}

async function generate() {
  const prev = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : null;
  const results = prev ? prev.results.filter((r) => !chapters.some((c) => c.id === r.id)) : [];
  for (const c of chapters) {
    const messages = matrixMessages({ chapter: c.chapter, text: c.text, lang: UI_LANG });
    const t0 = Date.now();
    let raw = '', err = null;
    try { raw = await nanChat({ model: MODEL, messages, maxTokens: 8000, extra: GEN_EXTRA }); } catch (e) { err = String(e.message || e); }
    const first = { raw, ms: Date.now() - t0, callError: err, ...score(c, raw) };
    const r = { id: c.id, book: c.book, genre: c.genre, chapter: c.chapter, chars: c.text.length, truncated: c.text.length > CHAPTER_CHAR_CAP, first };
    if (flag('--retry') && !first.valid && !err) {
      const t1 = Date.now();
      let raw2 = '';
      try { raw2 = await nanChat({ model: MODEL, messages: retryMessages(messages, raw, first.errors), maxTokens: 8000, extra: GEN_EXTRA }); } catch (e) { err = String(e.message || e); }
      r.retry = { raw: raw2, ms: Date.now() - t1, callError: err, ...score(c, raw2) };
    }
    results.push(r);
    const final = r.retry || first;
    console.log(`${c.id.padEnd(18)} ${first.valid ? '✓' : '✗'} ${first.cls.padEnd(7)}${r.retry ? ` → ${r.retry.valid ? '✓' : '✗'} ${r.retry.cls}` : ''}  ${(first.ms / 1000).toFixed(0)}s  ${final.valid ? '' : final.errors.slice(0, 2).join(' · ')}`);
    save(results);
  }
  return results;
}

function rescore(results) {
  for (const r of results) {
    const c = { ...battery.find((b) => b.id === r.id) };
    Object.assign(r.first, score(c, r.first.raw));
    if (r.retry) Object.assign(r.retry, score(c, r.retry.raw));
  }
  return results;
}

// El solver ve lo mismo que el lector (filas, columnas, opciones y las celdas dadas), nunca las
// respuestas ni las citas. Dos pasadas:
//   roundtrip: con el capítulo. Si no coincide, la celda es ambigua o el generador se equivoca.
//   blind: SIN el capítulo. Si acierta, la celda se responde sin haber leído: fuga en la etiqueta
//   o cultura general. Una matriz que se acierta a ciegas no hace trabajar.
async function solve(r, s, withText) {
  const shown = { rows: s.rows, columns: s.columns, given: s.cells.filter((x) => x.given).map(({ row, col, answer }) => ({ row, col, answer })), fill: s.cells.filter((x) => !x.given).map(({ row, col }) => ({ row, col })) };
  const sys = withText
    ? 'Rellenas una matriz de práctica sobre un capítulo. Para cada celda de `fill` (fila × columna) eliges UNA de las opciones de su columna, la que sostiene el capítulo.'
    : 'Rellenas una matriz de práctica sin tener el capítulo delante. Para cada celda de `fill` (fila × columna) eliges UNA de las opciones de su columna, la que te parezca más probable. Responde siempre, aunque no estés seguro.';
  const messages = [
    { role: 'system', content: `${sys} Responde SOLO con JSON: {"answers": [{"row": "...", "col": "...", "answer": "..."}]}. El texto de answer, exactamente como en options.` },
    { role: 'user', content: `${withText ? `<capitulo>\n${textOf.get(r.id).slice(0, CHAPTER_CHAR_CAP)}\n</capitulo>\n\n` : ''}Matriz:\n${JSON.stringify(shown)}` },
  ];
  // Si no devuelve respuestas (le pasa en los capítulos largos: agota el presupuesto razonando),
  // un segundo intento sin razonamiento. Lo que siga sin respuesta se cuenta aparte.
  let got = null;
  for (const extra of [{}, { thinking: { type: 'disabled' } }]) {
    let raw = '';
    try { raw = await nanChat({ model: SOLVER, messages, maxTokens: 8000, extra }); } catch { raw = ''; }
    got = parseSpec(raw);
    if (got && Array.isArray(got.answers) && got.answers.length) break;
  }
  const byKey = new Map(((got && got.answers) || []).map((a) => [`${a.row}|${a.col}`, a.answer]));
  const cells = s.cells.filter((x) => !x.given).map((x) => ({ row: x.row, col: x.col, answer: x.answer, solver: byKey.get(`${x.row}|${x.col}`) ?? null }));
  return { solver: SOLVER, agree: cells.filter((x) => x.solver === x.answer).length, total: cells.length, cells };
}

async function roundtrip(results) {
  for (const r of results) {
    const best = r.retry && r.retry.valid ? r.retry : r.first;
    if (!best.valid) continue;
    r.roundtrip = await solve(r, best.spec, true);
    r.blind = await solve(r, best.spec, false);
    console.log(`${r.id.padEnd(18)} con capítulo ${r.roundtrip.agree}/${r.roundtrip.total} · a ciegas ${r.blind.agree}/${r.blind.total}`);
    save(results);
  }
  return results;
}

function save(results) {
  fs.writeFileSync(FILE, JSON.stringify({ run, promptVersion: PROMPT_VERSION, model: MODEL, thinking: !GEN_EXTRA.thinking, uiLang: UI_LANG, date: new Date().toISOString(), results }, null, 1));
}

function summary(results) {
  const n = results.length;
  const v1 = results.filter((r) => r.first.valid).length;
  const vf = results.filter((r) => (r.retry || r.first).valid).length;
  const cls = {};
  for (const r of results) cls[r.first.cls] = (cls[r.first.cls] || 0) + 1;
  const books = [...new Set(results.map((r) => r.book))];
  const rt = results.filter((r) => r.roundtrip);
  // Celdas que el solver no devolvió (llamada fallida o JSON roto): fuera del denominador, que no
  // son un desacuerdo con el generador sino un fallo del medidor. Se cuentan aparte.
  const answered = (x) => x.cells.filter((c) => c.solver != null);
  const agree = rt.reduce((a, r) => a + r.roundtrip.agree, 0), tot = rt.reduce((a, r) => a + answered(r.roundtrip).length, 0);
  const lost = rt.reduce((a, r) => a + r.roundtrip.total - answered(r.roundtrip).length, 0);
  const blindTot = rt.reduce((a, r) => a + (r.blind ? answered(r.blind).length : 0), 0);
  const blind = rt.reduce((a, r) => a + (r.blind ? r.blind.agree : 0), 0);
  // Acierto esperado al azar: 1/opciones de su columna, celda a celda.
  const chance = rt.reduce((a, r) => { const s = (r.retry && r.retry.valid ? r.retry : r.first).spec; return a + (r.blind ? answered(r.blind) : []).reduce((b, c) => b + 1 / s.columns.find((k) => k.id === c.col).options.length, 0); }, 0);
  const okSpecs = results.map((r) => (r.retry && r.retry.valid ? r.retry : r.first)).filter((x) => x.valid);
  const flagCount = (k) => okSpecs.filter((x) => (x.flags || []).some((f) => f.kind === k)).length;
  const lines = [
    `# widgets-${run}`, '',
    `Prompt ${PROMPT_VERSION} · modelo ${MODEL} · ${n} capítulos`, '',
    `- **widget_spec_valid (1.ª respuesta): ${pct(v1, n)} %** (${v1}/${n}) · objetivo ≥ 85 %`,
    results.some((r) => r.retry) ? `- tras un reintento: ${pct(vf, n)} % (${vf}/${n})` : null,
    `- fallos a la 1.ª: ${Object.entries(cls).filter(([k]) => k !== 'ok').map(([k, v]) => `${k} ${v}`).join(', ') || 'ninguno'}`,
    okSpecs.length ? `- señales en los válidos: columna constante en ${flagCount('constante')}/${okSpecs.length}, respuesta en la etiqueta en ${flagCount('fuga')}/${okSpecs.length}, columna de emparejar en ${flagCount('emparejar')}/${okSpecs.length}, opciones largas en ${flagCount('larga')}/${okSpecs.length}` : null,
    rt.length ? `- ida y vuelta (${SOLVER}): ${pct(agree, tot)} % de celdas coinciden con el capítulo (${agree}/${tot}, ${rt.length} specs${lost ? `; ${lost} sin respuesta del solver, fuera` : ''}); a ciegas, sin el capítulo, acierta el ${pct(blind, blindTot)} % (al azar: ${pct(chance, blindTot)} %)` : null,
    '', '| Libro | 1.ª | Tras reintento |', '|---|---|---|',
    ...books.map((b) => { const rs = results.filter((r) => r.book === b); return `| ${b} | ${rs.filter((r) => r.first.valid).length}/${rs.length} | ${rs.filter((r) => (r.retry || r.first).valid).length}/${rs.length} |`; }),
    '', '## Fallos', '',
    ...results.filter((r) => !r.first.valid).map((r) => `- ${r.id} (${r.first.cls}${r.retry ? ` → ${r.retry.valid ? 'ok' : r.retry.cls}` : ''}): ${r.first.errors.slice(0, 3).join(' · ')}`),
  ].filter((l) => l != null);
  fs.writeFileSync(path.join(DIR, 'summary.md'), lines.join('\n') + '\n');
  console.log('\n' + lines.slice(0, 12).join('\n'));
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
