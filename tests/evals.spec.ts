import { test, expect } from '@playwright/test';
import { seedProLicense } from './pro-license';
import { BATTERIES } from '../evals/batteries.mjs';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// EV1 · Runner de GENERACIÓN de las baterías de evals (docs/EVALS.md). Tag @eval:
// fuera del `npm test` determinista y del `test:ai` (@live) — se lanza con
// `npm run eval:gen`. Genera los artefactos con la app REAL contra la API REAL
// (mismos prompts, retrieval y parsing que producción) y vuelca cada salida +
// pasajes fuente a evals/runs/<run>/<batería>.json; puntúan después
// evals/check.mjs (determinista) y evals/judge.mjs (juez LLM). Ver npm run eval.
//
// Env: NAN_API_KEY (obligatoria) · EVAL_MODEL (modelo principal a evaluar; default
// deepseek-v4-flash) · EVAL_PHASE (1|2; default 1) · EVAL_RUN (nombre del run).

const KEY = process.env.NAN_API_KEY;
const MODEL = process.env.EVAL_MODEL || 'deepseek-v4-flash';
const PHASE = Number(process.env.EVAL_PHASE || 1);
const RUN = process.env.EVAL_RUN
  || `${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}-${MODEL.replace(/[^\w.-]+/g, '_')}`;
const RUN_DIR = path.resolve(__dirname, '..', 'evals', 'runs', RUN);

// Las llamadas van serializadas contra nan (misma key): mismo fichero = mismo worker,
// y cada batería es un test que corre tras el anterior.
test.describe('EV1 · generación de artefactos @eval', () => {
  test.skip(!KEY, 'NAN_API_KEY no definido (crea .env a partir de .env.example)');

  for (const battery of BATTERIES.filter(b => b.phase <= PHASE)) {
    test(`batería ${battery.id}: flashcards + resumen @eval`, async ({ page }) => {
      test.setTimeout(900000);   // API real sobre un libro real: minutos, no segundos

      const fixture = path.resolve(__dirname, '..', battery.fixture);
      test.skip(!fs.existsSync(fixture), `falta ${battery.fixture} — ejecuta: node evals/fetch-fixtures.mjs`);

      const timings: Record<string, number> = {};
      const t0 = Date.now();

      await page.goto('/index.html');
      await seedProLicense(page);   // flashcards/resumen son Pro (MON2)
      await page.evaluate(({ k, m }) => {
        localStorage.setItem('bookreader_ai_key', JSON.stringify(k));
        localStorage.setItem('bookreader_ai_model', JSON.stringify(m));
        localStorage.setItem('bookreader_flashcards_hint_seen', 'true');
      }, { k: KEY, m: MODEL });
      await page.reload();

      // Abrir el fixture y pasar el onboarding con el objetivo de la persona.
      const fc = page.waitForEvent('filechooser');
      await page.click('#open-file-btn');
      await (await fc).setFiles(fixture);
      await page.waitForSelector('#ai-toggle:not([disabled])', { timeout: 120000 });
      timings.load = Date.now() - t0;

      await page.click('#ai-toggle');
      await page.waitForSelector('.ai-onboarding', { timeout: 10000 });
      await page.click('.ai-ob-tpl[data-tpl="hqa"]');
      await page.fill('#ai-ob-goal', battery.goal);
      const tOb = Date.now();
      await page.click('#ai-ob-start');
      // 'Listo' incluye segmentación y, en vivo, la atenuación del TOC (modelo lite).
      await expect(page.locator('#ai-status')).toContainText('Listo', { timeout: 240000 });
      timings.onboarding = Date.now() - tOb;

      // Flashcards (alcance y nº por defecto de la UI — lo que vería el usuario).
      const tCards = Date.now();
      await page.click('#ai-convo-cards');
      await page.waitForSelector('#ai-flashcards', { timeout: 10000 });
      await page.click('#fc-generate');
      await expect(page.locator('#ai-flashcards h2')).toContainText('tarjetas', { timeout: 420000 });
      timings.flashcards = Date.now() - tCards;
      await page.click('#ai-flashcards .ai-ob-close');

      // Resumen (profundidad por defecto: Estándar).
      // Un artefacto que falla en vivo es un RESULTADO del eval (gate 'resumen generado'
      // en rojo → capa la nota), no un crash del arnés: se registra el error visible y
      // se sigue, para no perder las tarjetas ya generadas de la batería.
      const tSum = Date.now();
      let summaryError = '';
      await page.click('#ai-convo-summary');
      await page.waitForSelector('#ai-summary', { timeout: 10000 });
      await page.click('#sum-generate');
      try {
        await expect(page.locator('#ai-summary .sum-doc')).toBeVisible({ timeout: 420000 });
      } catch {
        summaryError = (await page.locator('#ai-summary').innerText().catch(() => ''))
          .split('\n').map(s => s.trim()).filter(Boolean).slice(0, 4).join(' · ').slice(0, 300) || 'timeout sin error visible';
        console.warn(`[eval] ${battery.id}: el resumen NO se generó — ${summaryError}`);
      }
      timings.summary = Date.now() - tSum;

      // Captura: artefactos persistidos + pasajes fuente (anclas [[aN]] → texto).
      const data = await page.evaluate(async () => {
        const DB = await import('/js/ai/db.js');
        const Retrieval = await import('/js/ai/retrieval.js');
        const decks = await DB.getAll('decks');
        const artifacts = await DB.getAll('artifacts');
        const ratings = await DB.getAll('ratings');
        const passages = Retrieval.allPassages().map((p: any) => ({ id: p.id, chapter: p.chapter, text: p.text }));
        return { decks, artifacts, ratings, passages };
      });
      expect(data.decks.length, 'debe haber un mazo generado').toBeGreaterThan(0);
      if (!summaryError) expect(data.artifacts.some((a: any) => a.kind === 'summary'), 'debe haber un resumen').toBe(true);
      expect(data.passages.length, 'el índice de pasajes debe estar poblado').toBeGreaterThan(10);

      fs.mkdirSync(RUN_DIR, { recursive: true });
      let sha = '';
      try { sha = execSync('git rev-parse --short HEAD', { cwd: path.resolve(__dirname, '..') }).toString().trim(); } catch { /* sin git */ }
      fs.writeFileSync(path.join(RUN_DIR, `${battery.id}.json`), JSON.stringify({
        battery: { id: battery.id, persona: battery.persona, goal: battery.goal, lang: battery.lang, goldenConcepts: battery.goldenConcepts },
        // uiLang: los prompts del RESUMEN siguen el idioma de la UI (P15), no el del libro;
        // las tarjetas salen en el idioma del libro. El scoring compara cada cosa con lo suyo.
        meta: { model: MODEL, sha, date: new Date().toISOString(), fixture: battery.fixture, timings, uiLang: 'es', summaryError: summaryError || undefined },
        ...data,
      }, null, 1));
      console.log(`[eval] ${battery.id} → ${path.relative(process.cwd(), RUN_DIR)}/${battery.id}.json`
        + ` (${data.decks.reduce((n: number, d: any) => n + (d.cards?.length || 0), 0)} tarjetas,`
        + ` ${data.passages.length} pasajes, ${Math.round((Date.now() - t0) / 1000)}s)`);
    });
  }
});
