#!/usr/bin/env node
// EV1 · Comparativo entre runs (p. ej. mismo arnés con distinto EVAL_MODEL): una fila
// por run × batería con nota, criterios y latencias. Sin argumentos compara TODOS los
// runs puntuados; con argumentos, solo esos. Escribe evals/runs/COMPARE.md.
// Uso: node evals/compare.mjs [run1 run2 …]
import fs from 'node:fs';
import path from 'node:path';
import { RUNS, loadBatteries, avg } from './lib.mjs';

const names = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync(RUNS).filter(d => fs.existsSync(path.join(RUNS, d, 'judge.json'))).sort();
if (!names.length) { console.error('no hay runs puntuados (falta judge.json) — npm run eval'); process.exit(1); }

const f1 = n => Number.isFinite(n) ? n.toFixed(1) : '—';
const secs = ms => Number.isFinite(ms) ? `${Math.round(ms / 1000)}s` : '—';

let md = `# Comparativo de runs — ${new Date().toISOString().slice(0, 10)}\n\n`
  + `| Run | Juez | Batería | Nota | Tarjetas fid/atom/util | Cobertura | Resumen fid/citas/cob/conc | Chat fund/hon | MM jer/cob/inv | Gates | t·cards | t·resumen |\n`
  + `|---|---|---|---|---|---|---|---|---|---|---|---|\n`;

for (const name of names) {
  const dir = path.join(RUNS, name);
  const judge = JSON.parse(fs.readFileSync(path.join(dir, 'judge.json'), 'utf8'));
  const checks = JSON.parse(fs.readFileSync(path.join(dir, 'checks.json'), 'utf8'));
  for (const b of loadBatteries(dir)) {
    const id = b.battery.id;
    const j = judge.batteries[id] || {}, c = checks[id] || {}, s = j.summary || {};
    const gatesFailed = Object.values(c.gates || {}).filter(ok => !ok).length;
    let nota = avg([
      j.cards_avg?.fidelidad, j.cards_avg?.atomicidad, j.cards_avg?.utilidad,
      j.coverage_ratio != null ? 1 + 4 * j.coverage_ratio : NaN,
      s.fidelidad, s.pertinencia_citas, s.cobertura, s.concision,
      j.chat_avg?.fundamento, j.chat_avg?.honestidad, j.chat_avg?.claridad,
      j.mindmap?.jerarquia, j.mindmap?.cobertura, j.mindmap?.no_invencion,
    ]);
    if (gatesFailed) nota = Math.min(nota, 2);
    md += `| \`${b.meta?.model}\` | \`${judge.judge}\` | ${id} | **${f1(nota)}** `
      + `| ${f1(j.cards_avg?.fidelidad)} / ${f1(j.cards_avg?.atomicidad)} / ${f1(j.cards_avg?.utilidad)} `
      + `| ${(j.coverage || []).filter(x => x.cubierto).length}/${b.battery.goldenConcepts?.length} `
      + `| ${f1(s.fidelidad)} / ${f1(s.pertinencia_citas)} / ${f1(s.cobertura)} / ${f1(s.concision)} `
      + `| ${j.chat_avg ? `${f1(j.chat_avg.fundamento)} / ${f1(j.chat_avg.honestidad)}` : '—'} `
      + `| ${j.mindmap ? `${f1(j.mindmap.jerarquia)} / ${f1(j.mindmap.cobertura)} / ${f1(j.mindmap.no_invencion)}` : '—'} `
      + `| ${gatesFailed ? `✗ ${gatesFailed}` : '✓'} | ${secs(b.meta?.timings?.flashcards)} | ${secs(b.meta?.timings?.summary)} |\n`;
  }
}
md += `\nOjo: notas de jueces DISTINTOS no son directamente comparables (severidad propia de cada juez);\n`
  + `compara filas con el mismo juez, y usa el juez cruzado solo como control de auto-preferencia.\n`;

fs.writeFileSync(path.join(RUNS, 'COMPARE.md'), md);
console.log(md);
