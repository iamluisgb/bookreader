#!/usr/bin/env node
// EV1 · Checks DETERMINISTAS sobre un run de evals (docs/EVALS.md). Sin API: todo lo
// que se puede comprobar con código, se comprueba aquí — y los fallos duros CAPAN la
// nota final en el informe (report.mjs). Uso: node evals/check.mjs [run]
import fs from 'node:fs';
import path from 'node:path';
import { resolveRunDir, loadBatteries, summaryOf, cardsOf, citesOf, pct } from './lib.mjs';

// Idioma por stopwords (suficiente para distinguir es/en, los dos idiomas soportados).
const STOP = {
  es: /\b(el|la|los|las|de|del|que|una?|es|por|para|con|se|su)\b/gi,
  en: /\b(the|of|and|to|is|in|that|for|with|as|its?|are)\b/gi,
};
function langOf(text) {
  const es = (String(text).match(STOP.es) || []).length;
  const en = (String(text).match(STOP.en) || []).length;
  return es === en ? null : (es > en ? 'es' : 'en');
}

const normalize = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();

const runDir = resolveRunDir();
const out = {};
for (const b of loadBatteries(runDir)) {
  const ids = new Set((b.passages || []).map(p => p.id));
  const cards = cardsOf(b);
  const cloze = cards.filter(c => c.type === 'cloze');
  const seen = new Map();
  let dupes = 0;
  for (const c of cards) {
    const k = normalize(c.front);
    if (seen.has(k)) dupes++; else seen.set(k, c);
  }
  const langBad = cards.filter(c => {
    const l = langOf(`${c.front} ${c.back}`);
    return l && l !== b.battery.lang;
  });
  const summary = summaryOf(b) || '';
  const cites = citesOf(summary);
  const v2 = (b.meta?.evalVersion || 1) >= 2;

  // F2 · Mindmap: árbol persistido con ramas no vacías.
  const mmArt = (b.artifacts || []).filter(a => a.kind === 'mindmap').pop();
  const mmBranches = Array.isArray(mmArt?.result?.branches) ? mmArt.result.branches : [];

  // F2 · Atenuación vs oro: separación entre la media de score de los capítulos dorados
  // (deberían ser relevantes para el objetivo) y el resto. Sin ratings (PDF sin TOC) o
  // sin oro, queda null (informativo, no gate).
  let attSeparation = null;
  const scores = (b.ratings || [])[0]?.scores;
  if (scores && b.battery.goldenChapters?.length) {
    const gold = [], rest = [];
    const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    for (const [ch, sc] of Object.entries(scores)) {
      (b.battery.goldenChapters.some(g => norm(ch).includes(norm(g))) ? gold : rest).push(sc);
    }
    const mean = xs => xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null;
    if (gold.length && rest.length) attSeparation = +(mean(gold) - mean(rest)).toFixed(2);
  }

  const checks = {
    cards_total: cards.length,
    cards_src_valid: cards.filter(c => c.src && ids.has(c.src)).length,
    cards_cloze_total: cloze.length,
    cards_cloze_ok: cloze.filter(c => /\{\{c\d+::[^}]+\}\}/.test(c.front)).length,
    cards_dupes: dupes,
    cards_lang_bad: langBad.length,
    summary_exists: !!summary,
    summary_chars: summary.length,
    summary_cites: cites.length,
    summary_cites_valid: cites.filter(id => ids.has(id)).length,
    // El resumen sigue el idioma de la UI (P15), no el del libro (caso cross-lingüe).
    summary_lang_ok: !summary || langOf(summary.replace(/\[\[a\d+\]\]/g, '')) !== ((b.meta?.uiLang || 'es') === 'es' ? 'en' : 'es'),
    mindmap_exists: !!mmArt,
    mindmap_branches: mmBranches.length,
    attenuation_separation: attSeparation,
    chat_answered: (b.chat || []).filter(c => c.answer).length,
    chat_total: (b.chat || []).length,
  };
  // Gates: fallar cualquiera capa la nota del artefacto en el informe.
  // Tras la validación semántica de anclas (EV1), una tarjeta puede quedar SIN ancla
  // honestamente. Dos gates: toda ancla presente debe existir (100%) y la mayoría de
  // tarjetas deben seguir ancladas (≥70% — si cae, la validación está vetando de más
  // o el modelo declara src inservibles).
  const withSrc = cards.filter(c => c.src);
  checks.gates = {
    'tarjetas generadas': checks.cards_total > 0,
    'anclas presentes 100% válidas': withSrc.every(c => ids.has(c.src)),
    'tarjetas con ancla ≥70%': pct(withSrc.length, checks.cards_total) >= 70,
    'cloze bien formado': checks.cards_cloze_total === checks.cards_cloze_ok,
    'sin tarjetas duplicadas': checks.cards_dupes === 0,
    'idioma de tarjetas correcto ≥90%': pct(checks.cards_total - checks.cards_lang_bad, checks.cards_total) >= 90,
    'resumen generado': checks.summary_exists,
    'resumen con ≥3 citas': checks.summary_cites >= 3,
    'citas del resumen 100% válidas': checks.summary_cites > 0 && checks.summary_cites_valid === checks.summary_cites,
    'idioma del resumen correcto': checks.summary_lang_ok,
    ...(v2 ? {
      'mindmap generado con ramas': !!mmArt && mmBranches.length >= 2,
      'chat respondió todas': checks.chat_total > 0 && checks.chat_answered === checks.chat_total,
    } : {}),
  };
  out[b.battery.id] = checks;

  const failed = Object.entries(checks.gates).filter(([, ok]) => !ok).map(([k]) => k);
  console.log(`\n${b.battery.id} — ${cards.length} tarjetas (${checks.cards_src_valid} con ancla válida, ${dupes} dupes), `
    + `resumen ${summary.length} chars con ${cites.length} citas (${checks.summary_cites_valid} válidas)`
    + (v2 ? `, mindmap ${mmBranches.length} ramas, chat ${checks.chat_answered}/${checks.chat_total}`
      + (attSeparation != null ? `, atenuación Δ${attSeparation}` : ', atenuación n/a') : ''));
  console.log(failed.length ? `  ✗ gates fallidos: ${failed.join(' · ')}` : '  ✓ todos los gates pasan');
}
fs.writeFileSync(path.join(runDir, 'checks.json'), JSON.stringify(out, null, 1));
console.log(`\n→ ${path.relative(process.cwd(), path.join(runDir, 'checks.json'))}`);
