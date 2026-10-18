import { test, expect, Page } from '@playwright/test';
import path from 'path';

// Modo scroll: abrir/cerrar un panel lateral (cambia el ancho del lector) no debe devolver
// al principio del capítulo. Antes se re-mostraba el CFI de la vista y caía en el inicio.

const EPUB_PATH = path.join(__dirname, 'test.epub');

async function openScrollMid(page: Page) {
  await page.setViewportSize({ width: 1200, height: 600 });
  await page.goto('/');
  await page.setInputFiles('#file-input', EPUB_PATH);
  await page.waitForSelector('#epub-container iframe', { state: 'attached', timeout: 30000 });
  await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    R.setReadingMode('scroll');
    await new Promise(r => setTimeout(r, 1500));
    const sc: any = document.querySelector('#epub-container .epub-container');
    for (let i = 0; i < 40 && sc.scrollHeight < sc.clientHeight * 3; i++) {
      R.next();
      await new Promise(r => setTimeout(r, 700));
    }
  });
}

const medida = (page: Page) => page.evaluate(() => {
  const sc: any = document.querySelector('#epub-container .epub-container');
  return { top: sc.scrollTop, max: sc.scrollHeight - sc.clientHeight };
});

test('cambiar el ancho del lector en scroll conserva la posición dentro del capítulo', async ({ page }) => {
  await openScrollMid(page);
  const m0 = await medida(page);
  expect(m0.max, 'sin capítulo largo en el EPUB de prueba').toBeGreaterThan(600);
  await page.evaluate((y) => {
    (document.querySelector('#epub-container .epub-container') as any).scrollTop = y;
  }, Math.round(m0.max / 2));
  await page.waitForTimeout(800);
  const antes = await medida(page);
  const frac0 = antes.top / antes.max;
  await page.setViewportSize({ width: 900, height: 600 });   // «se abre el panel»
  await page.waitForTimeout(2500);
  const despues = await medida(page);
  const frac1 = despues.top / despues.max;
  console.log('fracción antes/después', frac0.toFixed(2), frac1.toFixed(2));
  expect(frac1).toBeGreaterThan(frac0 - 0.2);
  expect(despues.top).toBeGreaterThan(50);
});
