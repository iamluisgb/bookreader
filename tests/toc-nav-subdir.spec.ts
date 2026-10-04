import { test, expect } from '@playwright/test';
import path from 'path';

// Índice con el nav en una SUBCARPETA (`text/nav.xhtml`) y agrupado (años sin enlace), como
// «El Turrero Post». El EPUB 3 resuelve los href del nav respecto al propio nav; epub.js los
// deja tal cual, así que el índice pedía `dos.xhtml` y el capítulo era `text/dos.xhtml`: el
// clic no hacía nada, y tampoco se marcaba el capítulo actual ni salía en el pie.
const EPUB = path.join(__dirname, 'nav-subdir.epub');

test('el índice navega, marca el capítulo y lo pone en el pie', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', EPUB);
  await page.waitForSelector('#epub-container iframe', { timeout: 30000 });
  await page.locator('#sidebar-toggle').click();
  const hrefs = await page.locator('#toc-list a').evaluateAll(as => as.map(a => (a as HTMLElement).dataset.tocHref));
  expect(hrefs).toEqual(['', 'text/uno.xhtml', 'text/dos.xhtml', '', 'text/tres.xhtml']);

  await page.locator('#toc-list a', { hasText: 'Tercera turra' }).click();
  await expect.poll(() => page.evaluate(async () => (await import('/js/epub-reader.js')).getCurrentTocHref())).toBe('text/tres.xhtml');
  await expect(page.locator('#toc-list a.current .toc-label')).toHaveText('Tercera turra');
  await expect(page.locator('#progress-chapter')).toHaveText('Tercera turra');
});
