import { test, expect } from '@playwright/test';
import path from 'path';

const EPUB_PATH = path.join(__dirname, 'test.epub');

// IA2 · El evento `reader:chapter-changed` (que dispara el repaso al terminar capítulo)
// debe emitirse SOLO en cambios reales de capítulo, no en cada render. Ver ADR-013.
test('reader emits chapter-changed only on real chapter change', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.evaluate(() => {
    (window as any).__chapters = [];
    window.addEventListener('reader:chapter-changed', (e: any) => (window as any).__chapters.push(e.detail?.label));
  });

  const fc = page.waitForEvent('filechooser');
  await page.click('#open-file-btn');
  await (await fc).setFiles(EPUB_PATH);
  await page.waitForSelector('#epub-container iframe', { timeout: 15000 });
  await page.waitForFunction(() => {
    const f = document.querySelector('#epub-container iframe') as HTMLIFrameElement;
    return f && f.clientHeight > 100;
  });
  await page.waitForTimeout(500);

  // Avanzar varias páginas cruzando fronteras de capítulo.
  for (let i = 0; i < 12; i++) {
    await page.evaluate(async () => (await import('/js/epub-reader.js')).next());
    await page.waitForTimeout(250);
  }

  const chapters = await page.evaluate(() => (window as any).__chapters as string[]);
  // Se emitió al menos un par de capítulos…
  expect(chapters.length).toBeGreaterThanOrEqual(2);
  // …y nunca dos iguales consecutivos (solo en cambio real).
  for (let i = 1; i < chapters.length; i++) expect(chapters[i]).not.toBe(chapters[i - 1]);
});
