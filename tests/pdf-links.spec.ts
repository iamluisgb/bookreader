import { test, expect } from '@playwright/test';
import path from 'path';

// Los enlaces del PDF no hacían nada: el lector pintaba canvas + capa de texto y nunca
// leía las anotaciones /Link. test-links.pdf (3 págs.) trae en la 1: un enlace interno
// a un destino CON NOMBRE (como los de O'Reilly), una URL anotada y una URL en texto
// plano sin anotación.
const PDF_PATH = path.join(__dirname, 'test-links.pdf');

async function openPdf(page) {
  await page.goto('/index.html');
  const fc = page.waitForEvent('filechooser');
  await page.click('.lib-empty .lib-upload');
  await (await fc).setFiles(PDF_PATH);
  await page.waitForSelector('#pdf-container .pdf-link', { timeout: 15000 });
}

const current = (page) => page.evaluate(async () => (await import('/js/pdf-reader.js')).getCurrentPage());

test('un enlace interno salta a su página y deja volver', async ({ page }) => {
  await openPdf(page);
  expect(await current(page)).toBe(1);
  await page.locator('.pdf-page[data-page="1"] .pdf-link:not([target])').first().click();
  await expect.poll(() => current(page)).toBe(3);
  await page.locator('.ai-toast-action').click();
  await expect.poll(() => current(page)).toBe(1);
});

test('una URL anotada se abre en otra pestaña', async ({ page, context }) => {
  await openPdf(page);
  await context.route('https://example.com/**', r => r.fulfill({ body: 'ok' }));
  const popup = context.waitForEvent('page');
  await page.locator('.pdf-page[data-page="1"] .pdf-link[target="_blank"]').first().click();
  expect((await popup).url()).toBe('https://example.com/annotated');
});

test('una URL escrita como texto también se abre', async ({ page, context }) => {
  await openPdf(page);
  await context.route('https://example.org/**', r => r.fulfill({ body: 'ok' }));
  const span = page.locator('.pdf-page[data-page="1"] .textLayer span', { hasText: 'example.org' }).first();
  const box = (await span.boundingBox())!;
  const text = (await span.textContent())!;
  // Pinchar sobre la URL, no sobre "Plain:" del principio del span.
  const frac = (text.indexOf('example.org') + 4) / text.length;
  const popup = context.waitForEvent('page');
  await page.mouse.click(box.x + box.width * frac, box.y + box.height / 2);
  expect((await popup).url()).toBe('https://example.org/plain-url');
});

test.describe('táctil', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('tocar un enlace interno lo sigue y no alterna las barras', async ({ page }) => {
    await openPdf(page);
    const immersiveAntes = await page.evaluate(() => document.body.classList.contains('immersive'));
    await page.locator('.pdf-page[data-page="1"] .pdf-link:not([target])').first().tap();
    await expect.poll(() => current(page)).toBe(3);
    expect(await page.evaluate(() => document.body.classList.contains('immersive'))).toBe(immersiveAntes);
  });
});
