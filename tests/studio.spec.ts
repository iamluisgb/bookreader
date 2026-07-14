import { test, expect } from '@playwright/test';
import path from 'path';

// Studio: galería per-libro de artefactos. Estados vacío → generar → generado (Abrir) → borrar.
// LLM stubbeado (mismo patrón que jobs.spec).

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
          ? '- Juan Preciado llega a Comala [[a0]]\n- El pueblo está poblado de ánimas [[a1]]'
          : /Ideas principales/.test(sys)
            ? 'TL;DR: Un pueblo de muertos que hablan.\n\n## Ideas principales\nComala es un pueblo de ánimas [[a0]].\n\n## Qué llevarte\n- Los muertos hablan [[a1]]'
            : 'Un pueblo de muertos que hablan.';
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

test('Studio: vacío → generar → generado → abrir → borrar', async ({ page }) => {
  await setup(page);

  // Abre la pestaña Studio.
  await page.click('.ai-tab[data-view="studio"]');
  const studio = page.locator('#ai-view-studio');
  await expect(studio).toBeVisible();

  // Los tres tipos aparecen; resumen y mapa como invitación vacía.
  await expect(studio).toContainText('Resumen');
  await expect(studio).toContainText('Mapa mental');
  await expect(studio).toContainText('Flashcards');
  await expect(studio.locator('.studio-card[data-kind="summary"], .studio-empty')).not.toHaveCount(0);
  const genSummary = studio.locator('.studio-empty:has-text("Resumen") [data-act="gen"]');
  await expect(genSummary).toBeVisible();

  // Generar resumen desde Studio → abre el modal en setup → generar.
  await genSummary.click();
  await page.waitForSelector('#ai-summary #sum-generate', { timeout: 5000 });
  await page.click('#sum-generate');
  await expect(page.locator('#ai-summary .sum-doc')).toContainText('pueblo de muertos', { timeout: 15000 });
  await page.locator('#ai-summary .ai-ob-close').click();

  // De vuelta en Studio: el resumen es ahora un artefacto GENERADO con "Abrir" y kebab.
  await page.click('.ai-tab[data-view="studio"]');
  const card = studio.locator('.studio-generated:has-text("Resumen")');
  await expect(card).toBeVisible();
  await expect(card.locator('[data-act="open"]')).toBeVisible();
  await expect(card).toContainText('citas');   // metadatos: cuenta de citas

  // Abrir desde Studio → resultado cacheado directo (sin setup).
  await card.locator('[data-act="open"]').click();
  await expect(page.locator('#ai-summary .sum-doc')).toContainText('pueblo de muertos', { timeout: 5000 });
  await expect(page.locator('#ai-summary #sum-generate')).toHaveCount(0);
  await page.locator('#ai-summary .ai-ob-close').click();

  // Borrar desde el kebab → confirmar → vuelve a estar vacío.
  await page.click('.ai-tab[data-view="studio"]');
  await studio.locator('.studio-generated:has-text("Resumen") [data-act="kebab"]').click();
  await studio.locator('[data-act="del"]').click();
  await page.locator('.dlg-ok').click();
  await expect(studio.locator('.studio-empty:has-text("Resumen") [data-act="gen"]')).toBeVisible({ timeout: 5000 });

  // Y persistió el borrado en IndexedDB.
  const stillThere = await page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    const arts = await DB.getAll('artifacts');
    return arts.some((a: any) => a.kind === 'summary');
  });
  expect(stillThere).toBe(false);
});
