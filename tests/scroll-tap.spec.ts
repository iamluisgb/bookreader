import { test, expect, Page } from '@playwright/test';
import path from 'path';

// Modo scroll: un toque lateral (o flecha) desplaza una pantalla DENTRO del capítulo y solo
// pasa de capítulo al llegar al final. Antes epub.js saltaba de sección en el primer toque
// y se perdía el resto del capítulo (código y diagramas incluidos).

const EPUB_PATH = path.join(__dirname, 'test.epub');

async function openScroll(page: Page) {
  await page.setViewportSize({ width: 1000, height: 500 });
  await page.goto('/');
  await page.setInputFiles('#file-input', EPUB_PATH);
  await page.waitForSelector('#epub-container iframe', { state: 'attached', timeout: 30000 });
  await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    R.setReadingMode('scroll');
    await new Promise(r => setTimeout(r, 1500));
  });
}

test('next() en scroll desplaza dentro del capítulo antes de cambiar de sección', async ({ page }) => {
  await openScroll(page);
  const st = () => page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    const sc: any = document.querySelector('#epub-container .epub-container');
    return { top: sc.scrollTop, long: sc.scrollHeight > sc.clientHeight * 1.5,
      href: R.getRendition().currentLocation()?.start?.href };
  });
  const a = await st();
  test.skip(!a.long, 'el primer capítulo del EPUB de prueba cabe en una pantalla');
  await page.evaluate(async () => { (await import('/js/epub-reader.js') as any).next(); });
  await page.waitForTimeout(800);
  const b = await st();
  expect(b.top).toBeGreaterThan(a.top);
  expect(b.href).toBe(a.href);
});
