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

const st = (page: Page) => page.evaluate(async () => {
  const R: any = await import('/js/epub-reader.js');
  const sc: any = document.querySelector('#epub-container .epub-container');
  return { top: sc.scrollTop, long: sc.scrollHeight > sc.clientHeight * 1.5,
    href: R.getRendition().currentLocation()?.start?.href };
});

test('tapNext() en scroll desplaza dentro del capítulo y nunca cambia de sección', async ({ page }) => {
  await openScroll(page);
  const a = await st(page);
  test.skip(!a.long, 'el primer capítulo del EPUB de prueba cabe en una pantalla');
  await page.evaluate(async () => { (await import('/js/epub-reader.js') as any).tapNext(); });
  await page.waitForTimeout(800);
  const b = await st(page);
  expect(b.top).toBeGreaterThan(a.top);
  expect(b.href).toBe(a.href);
  // Hasta el final: sigue sin cambiar de capítulo.
  for (let i = 0; i < 60; i++) {
    await page.evaluate(async () => { (await import('/js/epub-reader.js') as any).tapNext(); });
    await page.waitForTimeout(150);
  }
  expect((await st(page)).href).toBe(a.href);
});

test('el panel de fin de capítulo está al final y su botón pasa al siguiente capítulo', async ({ page }) => {
  await openScroll(page);
  const a = await st(page);
  const frame = page.frameLocator('#epub-container iframe').first();
  const btn = frame.locator('#br-end .br-end-btn');
  await expect(btn).toHaveCount(1);
  await btn.scrollIntoViewIfNeeded();
  await page.waitForTimeout(700);   // un clic pegado a un scroll se ignora (frenar la inercia)
  await btn.click();
  await page.waitForTimeout(1200);
  expect((await st(page)).href).not.toBe(a.href);
});

test('los botones del pie pasan de capítulo en scroll', async ({ page }) => {
  await openScroll(page);
  const a = await st(page);
  await expect(page.locator('#next-btn')).toHaveAttribute('aria-label', /Cap[ií]tulo siguiente|Next chapter/);
  await page.evaluate(async () => { (await import('/js/epub-reader.js') as any).next(); });
  await page.waitForTimeout(1200);
  expect((await st(page)).href).not.toBe(a.href);
});

// El caso real en tablet: se llega al final del capítulo pulsando el lateral para seguir y el
// dedo cae encima del panel. El lateral NO debe pasar de capítulo (antes el botón ocupaba todo
// el ancho y el toque lo accionaba).
test.describe('tablet', () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: true, isMobile: true });

  test('pulsar el lateral sobre el panel de fin de capítulo no cambia de capítulo', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', EPUB_PATH);
    await page.waitForSelector('#epub-container iframe', { state: 'attached', timeout: 30000 });
    await page.evaluate(async () => {
      const R: any = await import('/js/epub-reader.js');
      R.setReadingMode('scroll');
      await new Promise(r => setTimeout(r, 1500));
    });
    const a = await st(page);
    const frame = page.frameLocator('#epub-container iframe').first();
    await frame.locator('#br-end').scrollIntoViewIfNeeded();
    await page.evaluate(() => { const sc: any = document.querySelector('#epub-container .epub-container'); sc.scrollTop = sc.scrollHeight; });
    await page.waitForTimeout(800);
    const box = await frame.locator('#br-end .br-end-btn').boundingBox();
    const ifr = await page.locator('#epub-container iframe').boundingBox();
    expect(box && ifr).toBeTruthy();
    // lateral derecho de la hoja, a la altura del botón
    await page.touchscreen.tap(ifr!.x + ifr!.width - 25, box!.y + box!.height / 2);
    await page.touchscreen.tap(ifr!.x + 25, box!.y + box!.height / 2);
    await page.waitForTimeout(1200);
    expect((await st(page)).href).toBe(a.href);
    // el botón mide menos que la hoja: no alcanza las zonas laterales
    expect(box!.width).toBeLessThan(ifr!.width * 0.7);
  });
});
