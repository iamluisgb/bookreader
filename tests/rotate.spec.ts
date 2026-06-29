import { test, expect } from '@playwright/test';
import path from 'path';

const EPUB_PATH = path.join(__dirname, 'test.epub');

// Helper: dimensions of the epub.js iframe vs its container.
async function dims(page) {
  return await page.evaluate(() => {
    const c = document.getElementById('epub-container')!;
    const f = c.querySelector('iframe');
    return {
      cw: c.clientWidth,
      ch: c.clientHeight,
      fw: f ? f.clientWidth : 0,
      fh: f ? f.clientHeight : 0,
    };
  });
}

test('epub re-paginates on rotation (no cut-off)', async ({ page }) => {
  // Empezamos en móvil vertical.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const fc = page.waitForEvent('filechooser');
  await page.click('#open-file-btn');
  await (await fc).setFiles(EPUB_PATH);

  // Esperar a que el iframe del libro exista y tenga tamaño.
  await page.waitForSelector('#epub-container iframe', { timeout: 15000 });
  await page.waitForFunction(() => {
    const f = document.querySelector('#epub-container iframe') as HTMLIFrameElement;
    return f && f.clientHeight > 100;
  });

  // Esperar al re-ajuste diferido tras mostrarse el footer.
  await page.waitForTimeout(400);
  const portrait = await dims(page);
  console.log('PORTRAIT', portrait);
  // En vertical, el iframe debe coincidir con el contenedor (no cortado).
  expect(Math.abs(portrait.fh - portrait.ch)).toBeLessThanOrEqual(4);
  expect(portrait.fw).toBeLessThanOrEqual(portrait.cw + 4);

  // Rotar a horizontal.
  await page.setViewportSize({ width: 844, height: 390 });
  // Esperar al debounce (150ms) + repaginado.
  await page.waitForTimeout(500);
  await page.waitForFunction((prevH) => {
    const f = document.querySelector('#epub-container iframe') as HTMLIFrameElement;
    return f && Math.abs(f.clientHeight - prevH) > 20; // la altura cambió tras rotar
  }, portrait.fh, { timeout: 5000 }).catch(() => {});

  const landscape = await dims(page);
  console.log('LANDSCAPE', landscape);
  // Tras rotar, el iframe debe haberse re-dimensionado a la nueva altura del contenedor.
  expect(Math.abs(landscape.fh - landscape.ch)).toBeLessThanOrEqual(4);
  expect(landscape.fw).toBeLessThanOrEqual(landscape.cw + 4);
  // Y la altura realmente cambió respecto al modo vertical.
  expect(landscape.fh).toBeLessThan(portrait.fh - 50);

  // En horizontal: UNA sola columna que aprovecha el ancho de la pantalla.
  // El contenedor debe llenar casi todo el viewport (no una columna estrecha
  // centrada) y la columna del contenido ocupa prácticamente todo el ancho.
  expect(landscape.cw).toBeGreaterThan(700); // llena los ~844 disponibles
  const colW = await page.evaluate(() => {
    const f = document.querySelector('#epub-container iframe') as HTMLIFrameElement;
    const body = f.contentDocument?.body;
    return body ? parseFloat(getComputedStyle(body).columnWidth) : 0;
  });
  console.log('LANDSCAPE columnWidth', colW);
  expect(colW).toBeGreaterThan(landscape.cw * 0.6); // una sola columna ancha

  // Volver a vertical y comprobar que también se re-ajusta.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  const portrait2 = await dims(page);
  console.log('PORTRAIT2', portrait2);
  expect(Math.abs(portrait2.fh - portrait2.ch)).toBeLessThanOrEqual(4);
});
