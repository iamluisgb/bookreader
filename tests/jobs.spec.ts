import { test, expect } from '@playwright/test';
import path from 'path';

// Trabajos de IA en segundo plano: "Generar" → "Seguir leyendo" (suelta el modal, sigue) →
// chip flotante de progreso → toast "listo" → reabrir el resultado (y desde caché, instantáneo).
// LLM stubbeado CON RETARDO para poder interactuar mientras genera.

const EPUB_PATH = path.join(__dirname, 'test.epub');

async function stubLLM(page) {
  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions') && opts?.body) {
        const body = JSON.parse(opts.body);
        const sys = (body.messages || []).find((m: any) => m.role === 'system')?.content || '';
        const out = /PUNTOS CLAVE/.test(sys)
          ? '- Juan Preciado llega a Comala buscando a su padre [[a0]]\n- El pueblo está poblado de ánimas [[a1]]'
          : /Ideas principales/.test(sys)
            ? 'TL;DR: La novela retrata un pueblo de muertos que hablan.\n\n## Ideas principales\nComala es un pueblo de ánimas.\n\n## Qué llevarte\n- Los muertos hablan'
            : 'La novela retrata un pueblo de muertos que hablan.';
        await new Promise(r => setTimeout(r, 500));   // retardo: deja ver la vista "en curso"
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

test('seguir leyendo mientras genera, aviso al terminar y reabrir', async ({ page }) => {
  await setup(page);
  await page.click('#ai-convo-summary');
  await page.waitForSelector('#ai-summary', { timeout: 5000 });
  await page.click('#sum-generate');

  // Vista "en curso" con "Seguir leyendo".
  await expect(page.locator('#ai-summary')).toContainText('Generando resumen', { timeout: 5000 });
  await page.click('#sum-keep');                                  // suelta el modal
  await expect(page.locator('#ai-summary')).toHaveCount(0);       // modal cerrado

  // Chip flotante de progreso mientras sigue en segundo plano.
  await expect(page.locator('.ai-taskchip')).toBeVisible({ timeout: 3000 });

  // Toast de aviso al terminar, con acción "Ver resumen".
  const toast = page.locator('.ai-toast');
  await expect(toast).toContainText('Resumen listo', { timeout: 15000 });
  await toast.locator('.ai-toast-action').click();

  // Reabre directo en el resultado (no en la configuración).
  await expect(page.locator('#ai-summary .sum-doc')).toContainText('pueblo de muertos', { timeout: 5000 });

  // Cerrar y reabrir desde el lanzador → resultado desde caché, sin re-generar (instantáneo).
  await page.locator('#ai-summary .ai-ob-close').click();
  await expect(page.locator('#ai-summary')).toHaveCount(0);
  await page.click('#ai-convo-summary');
  await expect(page.locator('#ai-summary .sum-doc')).toContainText('pueblo de muertos', { timeout: 3000 });
  await expect(page.locator('#ai-summary #sum-generate')).toHaveCount(0);   // no es la vista de setup
});

test('el resumen se persiste en IndexedDB y se restaura al reabrir el libro', async ({ page }) => {
  await setup(page);
  await page.click('#ai-convo-summary');
  await page.waitForSelector('#ai-summary', { timeout: 5000 });
  await page.click('#sum-generate');
  await expect(page.locator('#ai-summary .sum-doc')).toContainText('pueblo de muertos', { timeout: 15000 });

  // Está escrito en el store `artifacts` (sobrevive a recargas/cierres).
  const persisted = await page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    const arts = await DB.getAll('artifacts');
    return arts.map((a: any) => ({ kind: a.kind, has: String(a.result).includes('pueblo de muertos'), bookId: a.bookId }));
  });
  expect(persisted.some((a: any) => a.kind === 'summary' && a.has)).toBe(true);

  // loadForBook (que corre al abrir un libro) rellena el caché desde IndexedDB → reabrir instantáneo.
  const restored = await page.evaluate(async (bookId: string) => {
    const Jobs: any = await import('/js/ai/jobs.js');
    await Jobs.loadForBook(bookId);
    return !!Jobs.cached(bookId, 'summary');
  }, persisted.find((a: any) => a.kind === 'summary').bookId);
  expect(restored).toBe(true);
});

test('cancelar desde el chip detiene la generación', async ({ page }) => {
  await setup(page);
  await page.click('#ai-convo-summary');
  await page.waitForSelector('#ai-summary', { timeout: 5000 });
  await page.click('#sum-generate');
  await expect(page.locator('#ai-summary')).toContainText('Generando resumen', { timeout: 5000 });
  await page.click('#sum-keep');
  const chip = page.locator('.ai-taskchip');
  await expect(chip).toBeVisible({ timeout: 3000 });
  await chip.locator('.ai-taskchip-x').click();          // cancelar
  await expect(chip).toHaveCount(0, { timeout: 3000 });   // chip desaparece
});
