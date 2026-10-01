import { test, expect } from '@playwright/test';
import path from 'path';
import { seedProLicense } from './pro-license';

// Las citas de una conversación RESTAURADA. Al abrir el panel, activateConvo() →
// restoreChat() pinta los mensajes guardados ANTES de que prepareBook() segmente el libro
// y llene `anchors`. renderWithCitations() con el mapa vacío no genera chips y
// citeReplace() descarta los `[[aN]]`: las respuestas viejas quedaban sin citas
// clicables (visto en el emulador Android al recargar la app). Este test recarga la
// página —el libro y la conversación vuelven solos de IndexedDB— y exige que el chip
// reaparezca y siga navegando.
const PDF = path.join(__dirname, 'test-multipage.pdf');

async function stubChat(page: any) {
  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions') && opts?.body) {
        const body = JSON.parse(opts.body);
        const out = /respond/i.test(String(body.messages?.at(-1)?.content || ''))
          ? 'El dato está aquí. [[a5]]'
          : 'Listo.';
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

test('una conversación restaurada conserva sus chips de cita', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await page.evaluate((k) => localStorage.setItem('bookreader_ai_key', JSON.stringify(k)), 'test-key');
  await page.reload();
  await stubChat(page);

  const fc = page.waitForEvent('filechooser');
  await page.click('.lib-empty .lib-upload');
  await (await fc).setFiles(PDF);
  await page.waitForSelector('#ai-toggle:not([disabled])', { timeout: 15000 });

  await page.click('#ai-toggle');
  await page.waitForSelector('.ai-onboarding', { timeout: 5000 });
  await page.click('.ai-ob-tpl[data-tpl="hqa"]');
  await page.fill('#ai-ob-goal', 'entender el documento');
  await page.click('#ai-ob-start');
  await expect(page.locator('#ai-status')).toContainText('Listo', { timeout: 30000 });

  await page.fill('#ai-input', 'respond: donde está el dato');
  await page.click('#ai-send');
  await expect(page.locator('.ai-cite').first()).toContainText('pág. 2', { timeout: 15000 });

  // Recarga real: el libro y la conversación vuelven solos (IndexedDB). El chip debe
  // reaparecer en cuanto la segmentación termina, sin volver a preguntar nada.
  await page.reload();
  await page.waitForSelector('#pdf-container .pdf-page canvas', { timeout: 20000 });
  await page.waitForSelector('#ai-toggle:not([disabled])', { timeout: 20000 });
  await page.click('#ai-toggle');

  const cite = page.locator('.ai-cite').first();
  await expect(cite).toContainText('pág. 2', { timeout: 20000 });
  await expect(page.locator('.ai-cite')).toHaveCount(1);

  // Y sigue navegando: el chip restaurado no es decorativo.
  await page.click('#ai-close').catch(() => {});
  await cite.click({ force: true });
  await page.waitForTimeout(2000);
  const at = await page.evaluate(async () => (await import('/js/pdf-reader.js')).getCurrentPage());
  expect(at).toBe(2);
});
