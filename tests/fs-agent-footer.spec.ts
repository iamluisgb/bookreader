import { test, expect } from '@playwright/test';
import path from 'path';

// En pantalla completa (escritorio) cabecera y pie pasan a overlay absoluto. Con el agente
// abierto deben medirse contra el lector, que se encoge, y no contra la ventana: si no, el
// panel tapa las cifras del pie (página · % · tiempo) y el botón de página siguiente.
test('en pantalla completa el pie y la cabecera no quedan bajo el panel del agente', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', path.join(__dirname, 'test.epub'));
  await page.waitForSelector('#epub-container iframe', { timeout: 30000 });
  await page.locator('#ai-toggle').click();
  await page.evaluate(() => document.getElementById('ai-onboarding')?.remove());
  await page.evaluate(() => document.body.classList.add('fs'));     // syncFs sin requestFullscreen
  await page.waitForTimeout(600);                                     // fin del empuje del lector
  const r = await page.evaluate(() => {
    const right = (s: string) => document.querySelector(s)!.getBoundingClientRect().right;
    return {
      panel: document.getElementById('ai-panel')!.getBoundingClientRect().left,
      footer: right('#reader-footer'), header: right('.reader-header'),
      next: right('#next-btn'), meta: right('.progress-meta'),
    };
  });
  for (const k of ['footer', 'header', 'next', 'meta'] as const) expect(r[k], k).toBeLessThanOrEqual(r.panel + 1);
});
