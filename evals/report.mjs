#!/usr/bin/env node
// EV1 · Informe de un run de evals: fusiona checks.json (determinista) + judge.json
// (juez LLM) en REPORT.md — tabla por batería, gates, nota final (capada si fallan
// gates duros) y los peores ejemplos, que son el material de mejora.
// Uso: node evals/report.mjs [run]
import fs from 'node:fs';
import path from 'node:path';
import { resolveRunDir, loadBatteries, cardsOf, avg, pct } from './lib.mjs';

const runDir = resolveRunDir();
const read = f => { try { return JSON.parse(fs.readFileSync(path.join(runDir, f), 'utf8')); } catch { return null; } };
const checks = read('checks.json');
const judge = read('judge.json');
if (!checks || !judge) { console.error('faltan checks.json/judge.json — ejecuta npm run eval:score'); process.exit(1); }

const batteries = loadBatteries(runDir);
const meta = batteries[0]?.meta || {};
const f1 = n => Number.isFinite(n) ? n.toFixed(1) : '—';

let md = `# Informe de evals — ${path.basename(runDir)}

Modelo evaluado: \`${meta.model}\` · juez: \`${judge.judge}\` · commit \`${meta.sha}\` · ${meta.date?.slice(0, 10)}
(rúbricas y método: [docs/EVALS.md](../../docs/EVALS.md))

| Batería | Nota | Tarjetas (fid/atom/util) | Cobertura dorada | Resumen (fid/citas/cob/conc) | Gates |
|---|---|---|---|---|---|
`;

for (const b of batteries) {
  const id = b.battery.id;
  const c = checks[id] || {}, j = judge.batteries[id] || {};
  const gatesFailed = Object.entries(c.gates || {}).filter(([, ok]) => !ok).map(([k]) => k);
  const s = j.summary || {};
  const scores = [
    j.cards_avg?.fidelidad, j.cards_avg?.atomicidad, j.cards_avg?.utilidad,
    j.coverage_ratio != null ? 1 + 4 * j.coverage_ratio : NaN,   // ratio 0..1 → escala 1..5
    s.fidelidad, s.pertinencia_citas, s.cobertura, s.concision,
    j.chat_avg?.fundamento, j.chat_avg?.honestidad, j.chat_avg?.claridad,
    j.mindmap?.jerarquia, j.mindmap?.cobertura, j.mindmap?.no_invencion,
  ];
  let nota = avg(scores);
  if (gatesFailed.length) nota = Math.min(nota, 2);   // gate duro fallido capa la nota
  md += `| ${id} | **${f1(nota)}** | ${f1(j.cards_avg?.fidelidad)} / ${f1(j.cards_avg?.atomicidad)} / ${f1(j.cards_avg?.utilidad)} `
    + `| ${(j.coverage || []).filter(x => x.cubierto).length}/${b.battery.goldenConcepts.length} `
    + `| ${f1(s.fidelidad)} / ${f1(s.pertinencia_citas)} / ${f1(s.cobertura)} / ${f1(s.concision)} `
    + `| ${gatesFailed.length ? '✗ ' + gatesFailed.length : '✓'} |\n`;
}

md += `\nEscala 1-5 (juez exigente; 5 = excepcional). La nota se CAPA a 2 si falla un gate determinista.\n`;

for (const b of batteries) {
  const id = b.battery.id;
  const c = checks[id] || {}, j = judge.batteries[id] || {};
  md += `\n## ${id} — ${b.battery.persona}\n\n`;
  md += `**Deterministas:** ${c.cards_total} tarjetas, anclas válidas ${pct(c.cards_src_valid, c.cards_total)}%, `
    + `${c.cards_dupes} duplicadas · resumen ${c.summary_chars} chars, ${c.summary_cites} citas (${c.summary_cites_valid} válidas)\n`;
  const failed = Object.entries(c.gates || {}).filter(([, ok]) => !ok).map(([k]) => k);
  if (failed.length) md += `\n**✗ Gates fallidos:** ${failed.join(' · ')}\n`;
  if (b.meta?.summaryError) md += `\n**✗ El resumen no se generó:** ${b.meta.summaryError}\n`;
  md += `**Tiempos** (ms): ${JSON.stringify(b.meta?.timings || {})}\n`;

  const worst = (j.cards || []).filter(x => Math.min(x.fidelidad, x.atomicidad, x.utilidad) <= 2)
    .sort((a, z) => (a.fidelidad + a.atomicidad + a.utilidad) - (z.fidelidad + z.atomicidad + z.utilidad)).slice(0, 5);
  if (worst.length) {
    md += `\n**Peores tarjetas (material de mejora):**\n`;
    const all = cardsOf(b);
    for (const w of worst) {
      const card = all[w.n - 1] || {};
      md += `- [fid ${w.fidelidad} · atom ${w.atomicidad} · util ${w.utilidad}] "${(card.front || '').slice(0, 120)}" — ${w.nota}\n`;
    }
  }
  const missing = (j.coverage || []).filter(x => !x.cubierto).map(x => x.concepto);
  if (missing.length) md += `\n**Conceptos dorados sin cubrir:** ${missing.join(' · ')}\n`;
  if (j.summary?.peores_puntos?.length) md += `\n**Puntos débiles del resumen:** ${j.summary.peores_puntos.map(p => `«${p}»`).join(' · ')}\n`;

  // F2 · chat, mindmap y atenuación
  if (j.chat_avg) {
    md += `\n**Chat:** fundamento ${f1(j.chat_avg.fundamento)} · claridad ${f1(j.chat_avg.claridad)}`
      + ` · honestidad ante trampa ${f1(j.chat_avg.honestidad)}\n`;
    for (const [i, turno] of (j.chat || []).entries()) {
      const q = (b.chat || [])[i] || {};
      if (q.trap || Math.min(turno.fundamento || 5, turno.claridad || 5) <= 2) {
        md += `- ${q.trap ? '🪤 ' : ''}«${(q.q || '').slice(0, 90)}» — fund ${turno.fundamento}`
          + `${q.trap ? ` · honestidad ${turno.honestidad}` : ''} — ${turno.nota || ''}\n`;
      }
    }
  }
  if (j.mindmap) md += `\n**Mindmap:** jerarquía ${j.mindmap.jerarquia} · cobertura ${j.mindmap.cobertura} · no-invención ${j.mindmap.no_invencion} — ${j.mindmap.nota || ''}\n`;
  if (c.attenuation_separation != null) md += `\n**Atenuación (Δ oro − resto):** ${c.attenuation_separation} (positivo = distingue los capítulos relevantes)\n`;
}

fs.writeFileSync(path.join(runDir, 'REPORT.md'), md);
console.log(md);
console.log(`→ ${path.relative(process.cwd(), path.join(runDir, 'REPORT.md'))}`);
