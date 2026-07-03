import { test, expect } from '@playwright/test';
import path from 'path';

const EPUB_PATH = path.join(__dirname, 'test.epub');

// TEC2 · Tests de caracterización del panel IA — DETERMINISTAS (a diferencia de ai.spec.ts
// @live). Se conduce el panel real por la UI pero con `fetch` stubbeado: respuestas canned.
// Fijan el comportamiento del núcleo (onboarding, envío, y el gating del retrieval agéntico
// de la Fase 1b) como red de regresión.

// Instala el stub del endpoint del LLM y registra cada llamada (stream? qué herramientas).
async function stubLLM(page) {
  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    (window as any).__llm = { calls: [] as any[] };
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions') && opts?.body) {
        const body = JSON.parse(opts.body);
        (window as any).__llm.calls.push({ stream: !!body.stream, tools: (body.tools || []).map((t: any) => t.function?.name) });
        if (body.stream) {
          const chunks = [
            'data: {"choices":[{"delta":{"content":"Respuesta de prueba."},"finish_reason":null}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n',
          ];
          const s = new ReadableStream({ start(c) { const e = new TextEncoder(); chunks.forEach(x => c.enqueue(e.encode(x))); c.close(); } });
          return new Response(s, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        // No-streaming (tools): sin tool_calls → cierra cualquier bucle (agéntico/atenuación).
        return new Response(JSON.stringify({ choices: [{ message: { content: 'LISTO' } }] }), { status: 200 });
      }
      return real(url, opts);
    };
  });
}

async function setup(page, { template = 't3-juicio', goal = 'probar el panel' } = {}) {
  await page.goto('/index.html');
  await page.evaluate((k) => localStorage.setItem('bookreader_ai_key', JSON.stringify(k)), 'test-key');
  await page.reload();
  await stubLLM(page);

  const fc = page.waitForEvent('filechooser');
  await page.click('#open-file-btn');
  await (await fc).setFiles(EPUB_PATH);

  await page.waitForSelector('#ai-toggle:not([disabled])', { timeout: 15000 });
  await page.click('#ai-toggle');
  await page.waitForSelector('.ai-onboarding', { timeout: 5000 });
  await page.click(`.ai-ob-tpl[data-tpl="${template}"]`);
  await page.fill('#ai-ob-goal', goal);
  await page.click('#ai-ob-start');
  await expect(page.locator('#ai-tabs')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#ai-status')).toContainText('Listo', { timeout: 30000 });
}

const answerBubble = (page) => page.locator('.ai-msg-assistant .ai-bubble-text').last();

async function ask(page, q: string) {
  await page.evaluate(() => ((window as any).__llm.calls = []));   // limpiar (onboarding ya llamó)
  await page.fill('#ai-input', q);
  await page.click('#ai-send');
  await expect(answerBubble(page)).toContainText('Respuesta de prueba', { timeout: 15000 });
}

test('onboarding deja la sesión lista y una pregunta obtiene respuesta', async ({ page }) => {
  await setup(page);
  await ask(page, 'Comala Pedro Páramo madre pueblo muerte almas');
  await expect(answerBubble(page)).toBeVisible();
});

test('pregunta con buen match NO dispara retrieval agéntico', async ({ page }) => {
  await setup(page);
  await ask(page, 'Comala Pedro Páramo madre padre pueblo muerte almas caballo');
  const calls = await page.evaluate(() => (window as any).__llm.calls);
  const agentic = calls.filter((c: any) => (c.tools || []).includes('search_book'));
  expect(agentic.length).toBe(0);                            // sin recolección agéntica
  expect(calls.some((c: any) => c.stream)).toBe(true);       // sí hubo respuesta en streaming
});

test('pregunta vaga (sin match léxico) dispara retrieval agéntico', async ({ page }) => {
  await setup(page);
  await ask(page, 'zxcvbnm qwertyui asdfghj');               // términos inexistentes en el libro
  const calls = await page.evaluate(() => (window as any).__llm.calls);
  const agentic = calls.filter((c: any) => (c.tools || []).includes('search_book'));
  expect(agentic.length).toBeGreaterThan(0);                 // sí hubo recolección agéntica
});
