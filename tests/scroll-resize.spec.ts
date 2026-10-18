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

// Tras un SALTO (índice, posición restaurada) el reflujo se ancla al destino del salto. Si el
// lector luego se desplaza, ese ancla debe caducar: abrir un panel no puede devolverlo al punto
// al que saltó.
test.describe('tras un salto', () => {
  test.use({ viewport: { width: 1000, height: 700 }, hasTouch: true, isMobile: true });

  test('desplazarse con el dedo invalida el ancla del salto al abrir un panel', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', EPUB_PATH);
    await page.waitForSelector('#epub-container iframe', { state: 'attached', timeout: 30000 });
    await page.evaluate(async () => {
      const R: any = await import('/js/epub-reader.js');
      R.setReadingMode('scroll');
      await new Promise(r => setTimeout(r, 1500));
      const sc: any = document.querySelector('#epub-container .epub-container');
      for (let i = 0; i < 40 && sc.scrollHeight < sc.clientHeight * 3; i++) { R.next(); await new Promise(r => setTimeout(r, 700)); }
      // Salto al principio de la sección (como hace el índice o abrir con posición guardada).
      await R.goTo(R.getRendition().currentLocation().start.cfi);
      await new Promise(r => setTimeout(r, 1500));
    });
    const top = () => page.evaluate(() => (document.querySelector('#epub-container .epub-container') as any).scrollTop);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 500, y: 600 }] });
    for (let i = 1; i <= 15; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 500, y: 600 - i * 20 }] }); await page.waitForTimeout(16); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(1200);
    const leido = await top();
    expect(leido).toBeGreaterThan(150);
    await page.setViewportSize({ width: 800, height: 700 });   // «se abre el panel»
    await page.waitForTimeout(2500);
    expect(await top(), 'volvió al punto del salto').toBeGreaterThan(leido * 0.8);
  });
});
