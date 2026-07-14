import { test, expect } from '@playwright/test';
import path from 'path';

// Studio: galería per-libro con HISTORIAL. Generar NO sobrescribe: cada resumen/mapa se conserva
// hasta que el usuario lo borra. LLM stubbeado (mismo patrón que jobs.spec).

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

async function generateSummary(page) {
  await page.waitForSelector('#ai-summary #sum-generate', { timeout: 5000 });
  await page.click('#sum-generate');
  await expect(page.locator('#ai-summary .sum-doc')).toContainText('pueblo de muertos', { timeout: 15000 });
  await page.locator('#ai-summary .ai-ob-close').click();
  await expect(page.locator('#ai-summary')).toHaveCount(0);
}

test('Studio conserva el historial: generar dos no sobrescribe; borrar uno deja el otro', async ({ page }) => {
  await setup(page);
  const studio = page.locator('#ai-view-studio');
  const summaryCards = studio.locator('.studio-card.studio-generated:has([data-kind="summary"])');

  // Studio con el resumen como invitación vacía.
  await page.click('.ai-tab[data-view="studio"]');
  await expect(studio).toBeVisible();
  await expect(studio.locator('.studio-empty [data-act="gen"][data-kind="summary"]')).toBeVisible();

  // Genera el PRIMER resumen desde Studio.
  await studio.locator('.studio-empty [data-act="gen"][data-kind="summary"]').click();
  await generateSummary(page);

  // Vuelve: 1 artefacto + botón "Nuevo".
  await page.click('.ai-tab[data-view="studio"]');
  await expect(summaryCards).toHaveCount(1);
  await expect(studio.locator('.studio-new[data-kind="summary"]')).toBeVisible();

  // Genera un SEGUNDO resumen con "Nuevo" → NO sobrescribe: ahora hay 2.
  await studio.locator('.studio-new[data-kind="summary"]').click();
  await generateSummary(page);
  await page.click('.ai-tab[data-view="studio"]');
  await expect(summaryCards).toHaveCount(2);

  // Persistidos los dos en IndexedDB.
  const persisted = await page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    return (await DB.getAll('artifacts')).filter((a: any) => a.kind === 'summary').length;
  });
  expect(persisted).toBe(2);

  // Abrir uno → resultado cacheado directo (sin setup).
  await summaryCards.first().locator('[data-act="open"]').click();
  await expect(page.locator('#ai-summary .sum-doc')).toContainText('pueblo de muertos', { timeout: 5000 });
  await expect(page.locator('#ai-summary #sum-generate')).toHaveCount(0);
  await page.locator('#ai-summary .ai-ob-close').click();

  // Borrar UNO → confirmar → queda el otro (no desaparecen todos).
  await page.click('.ai-tab[data-view="studio"]');
  await summaryCards.first().locator('.studio-del').click();
  await page.locator('.dlg-ok').click();
  await expect(summaryCards).toHaveCount(1);

  const left = await page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    return (await DB.getAll('artifacts')).filter((a: any) => a.kind === 'summary').length;
  });
  expect(left).toBe(1);
});
