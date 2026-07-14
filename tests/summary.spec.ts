import { test, expect } from '@playwright/test';
import path from 'path';

// P13 · Resumen citado: map-reduce (viñetas citadas por trozo + TL;DR) y render con
// citas [[aN]] clicables. LLM stubbeado (determinista, sin API).

const EPUB_PATH = path.join(__dirname, 'test.epub');

// Stub: las llamadas del MAP (prompt con "PUNTOS CLAVE") devuelven viñetas citadas;
// la del REDUCE (prompt con "TL;DR") devuelve el párrafo resumen.
async function stubLLM(page) {
  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions') && opts?.body) {
        const body = JSON.parse(opts.body);
        const sys = (body.messages || []).find((m: any) => m.role === 'system')?.content || '';
        const out = /TL;DR/.test(sys)
          ? 'La novela retrata un pueblo de muertos que hablan.'
          : '- Juan Preciado llega a Comala buscando a su padre [[a0]]\n- El pueblo está poblado de ánimas [[a1]]';
        const chunks = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: out }, finish_reason: null }] })}\n\n`,
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ];
        const s = new ReadableStream({ start(c) { const e = new TextEncoder(); chunks.forEach(x => c.enqueue(e.encode(x))); c.close(); } });
        return new Response(s, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return real(url, opts);
    };
  });
}

async function setup(page) {
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
  await page.click('.ai-ob-tpl[data-tpl="hqa"]');
  await page.fill('#ai-ob-goal', 'entender la novela');
  await page.click('#ai-ob-start');
  await expect(page.locator('#ai-status')).toContainText('Listo', { timeout: 30000 });
}

test('genera un resumen con TL;DR y puntos clave citados y clicables', async ({ page }) => {
  await setup(page);
  await page.click('#ai-convo-summary');
  await page.waitForSelector('#ai-summary', { timeout: 5000 });
  await page.click('#sum-generate');

  // Resultado: TL;DR + puntos clave con citas .ai-cite (las [[aN]] mapeadas a anclas reales).
  await expect(page.locator('.sum-tldr')).toContainText('pueblo de muertos', { timeout: 20000 });
  await expect(page.locator('.sum-points')).toContainText('Juan Preciado');
  const cites = page.locator('.sum-points .ai-cite');
  expect(await cites.count()).toBeGreaterThanOrEqual(1);   // [[a0]]/[[a1]] existen → clicables

  // Exportar Markdown está disponible.
  await expect(page.locator('#sum-md')).toBeVisible();
});

test('clic en una cita del resumen salta al libro y cierra el modal', async ({ page }) => {
  await setup(page);
  await page.click('#ai-convo-summary');
  await page.waitForSelector('#ai-summary', { timeout: 5000 });
  await page.click('#sum-generate');
  await page.waitForSelector('.sum-points .ai-cite', { timeout: 20000 });
  await page.locator('.sum-points .ai-cite').first().click();
  await expect(page.locator('#ai-summary')).toHaveCount(0);   // el modal se cierra al navegar
});
