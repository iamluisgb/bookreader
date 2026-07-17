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
// EV2 · Modo SMOKE (npm run eval:smoke): 1 batería (P4, el fixture pequeño del repo),
// 10 tarjetas, resumen breve, sin mindmap/chat/atenuación. ~2 min por ciclo, para
// iterar prompts sin pagar el run completo. Se puntúa igual (evalVersion 1: los gates
// de F2 no aplican).
const SMOKE = process.env.EVAL_SMOKE === '1';
const RUN = process.env.EVAL_RUN
  || `${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}${SMOKE ? '-smoke' : ''}-${MODEL.replace(/[^\w.-]+/g, '_')}`;
const RUN_DIR = path.resolve(__dirname, '..', 'evals', 'runs', RUN);

// Las llamadas van serializadas contra nan (misma key): mismo fichero = mismo worker,
// y cada batería es un test que corre tras el anterior.
test.describe('EV1 · generación de artefactos @eval', () => {
  test.skip(!KEY, 'NAN_API_KEY no definido (crea .env a partir de .env.example)');
  // Un clic bloqueado (p. ej. un modal sin cerrar tapando el toolbar) debe fallar en
  // segundos, no comerse el timeout del test entero. Los waits largos de generación
  // llevan su timeout explícito y no se ven afectados.
  test.use({ actionTimeout: 30000 });

  const selected = SMOKE ? BATTERIES.filter(b => b.id === 'p4-noficcion')
    : BATTERIES.filter(b => b.phase <= PHASE);
  for (const battery of selected) {
    test(`batería ${battery.id}: flashcards + resumen @eval`, async ({ page }) => {
      test.setTimeout(1800000);  // API real sobre un libro real, 6 artefactos: minutos, no segundos

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
      await expect(page.locator('#ai-status')).toContainText('Listo', { timeout: 240000 });
      timings.onboarding = Date.now() - tOb;

      // Atenuación del TOC (F2): solo se dispara con el sidebar abierto (ahí vive el
      // índice). Corre con el modelo LITE (ADR-022). Best-effort: sin TOC (PDF plano)
      // no hay ratings y no es fallo.
      const tAtt = Date.now();
      if (!SMOKE) {
        await page.click('#sidebar-toggle');
        await page.waitForFunction(async () => {
          const DB = await import('/js/ai/db.js');
          return (await DB.getAll('ratings')).length > 0;
        }, undefined, { timeout: 120000 }).catch(() => console.warn(`[eval] ${battery.id}: sin atenuación (¿sin TOC?)`));
        await page.click('#sidebar-toggle');   // cerrar: que no tape el panel
      }
      timings.attenuation = Date.now() - tAtt;

      // Flashcards (alcance y nº por defecto de la UI — lo que vería el usuario; smoke: 10).
      const tCards = Date.now();
      await page.click('#ai-convo-cards');
      await page.waitForSelector('#ai-flashcards', { timeout: 10000 });
      if (SMOKE) await page.selectOption('#fc-count', '10');
      await page.click('#fc-generate');
      await expect(page.locator('#ai-flashcards h2')).toContainText('tarjetas', { timeout: 600000 });   // nan tiene ventanas lentas: 420s se quedaba corto
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
      if (SMOKE) await page.selectOption('#sum-depth', 'breve');
      await page.click('#sum-generate');
      try {
        await expect(page.locator('#ai-summary .sum-doc')).toBeVisible({ timeout: 420000 });
      } catch {
        summaryError = (await page.locator('#ai-summary').innerText().catch(() => ''))
          .split('\n').map(s => s.trim()).filter(Boolean).slice(0, 4).join(' · ').slice(0, 300) || 'timeout sin error visible';
        console.warn(`[eval] ${battery.id}: el resumen NO se generó — ${summaryError}`);
      }
      timings.summary = Date.now() - tSum;
      // Cerrar el modal del resumen: si queda abierto, el overlay tapa el toolbar y el
      // siguiente clic espera para siempre (F2 se comió 30 min por esto).
      await page.click('#ai-summary .ai-ob-close');

      // Mindmap (F2), mismo trato tolerante que el resumen.
      const tMm = Date.now();
      let mindmapError = '';
      if (!SMOKE) {
        await page.click('#ai-convo-mindmap');
        await page.click('#mm-generate');
        try {
          await expect(page.locator('#mm-png')).toBeVisible({ timeout: 420000 });
        } catch {
          mindmapError = (await page.locator('#ai-mindmap, .ai-onboarding').last().innerText().catch(() => ''))
            .split('\n').map(s => s.trim()).filter(Boolean).slice(0, 4).join(' · ').slice(0, 300) || 'timeout sin error visible';
          console.warn(`[eval] ${battery.id}: el mindmap NO se generó — ${mindmapError}`);
        }
        await page.click('#ai-mindmap .ai-ob-close');   // cerrar: el overlay taparía el chat
      }
      timings.mindmap = Date.now() - tMm;

      // Chat (F2): 2 preguntas con respuesta en el libro + 1 trampa (no está en el
      // libro; responderla "de memoria" es el fallo que mide la rúbrica de honestidad).
      const tChat = Date.now();
      const chat: any[] = [];
      for (const { q, trap } of SMOKE ? [] : (battery.questions || [])) {
        const before = await page.locator('.ai-msg-assistant .ai-bubble-text').count();
        await page.fill('#ai-input', q);
        await page.click('#ai-send');
        try {
          // El botón se deshabilita durante el turno y se re-habilita al terminar.
          await expect(page.locator('#ai-send')).toBeDisabled({ timeout: 10000 });
          await expect(page.locator('#ai-send')).toBeEnabled({ timeout: 300000 });
          await expect(page.locator('.ai-msg-assistant .ai-bubble-text')).toHaveCount(before + 1, { timeout: 10000 });
          const answer = (await page.locator('.ai-msg-assistant .ai-bubble-text').last().innerText()).slice(0, 4000);
          chat.push({ q, trap: !!trap, answer });
        } catch {
          chat.push({ q, trap: !!trap, answer: '', error: 'el turno no terminó' });
          console.warn(`[eval] ${battery.id}: turno de chat fallido — ${q.slice(0, 60)}…`);
        }
      }
      timings.chat = Date.now() - tChat;

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
        battery: {
          id: battery.id, persona: battery.persona, goal: battery.goal, lang: battery.lang,
          goldenConcepts: battery.goldenConcepts, goldenChapters: battery.goldenChapters,
        },
        // uiLang: los prompts del RESUMEN siguen el idioma de la UI (P15), no el del libro;
        // las tarjetas salen en el idioma del libro. El scoring compara cada cosa con lo suyo.
        // evalVersion 2 = F2 (mindmap + chat + atenuación); el scoring salta lo nuevo en runs viejos.
        meta: {
          model: MODEL, sha, date: new Date().toISOString(), fixture: battery.fixture, timings,
          // Smoke = evalVersion 1: solo tarjetas+resumen, los gates de F2 no aplican.
          uiLang: 'es', evalVersion: SMOKE ? 1 : 2, smoke: SMOKE || undefined,
          summaryError: summaryError || undefined, mindmapError: mindmapError || undefined,
        },
        chat,
        ...data,
      }, null, 1));
      console.log(`[eval] ${battery.id} → ${path.relative(process.cwd(), RUN_DIR)}/${battery.id}.json`
        + ` (${data.decks.reduce((n: number, d: any) => n + (d.cards?.length || 0), 0)} tarjetas,`
        + ` ${data.passages.length} pasajes, ${Math.round((Date.now() - t0) / 1000)}s)`);
    });
  }
});
