import { test, expect } from '@playwright/test';
import path from 'path';
import { seedProLicense } from './pro-license';

const EPUB_PATH = path.join(__dirname, 'test.epub');

// UI3 · El composer del agente crece con lo que escribes (hasta su tope) y vuelve a una
// línea al vaciarse. Regresión: la cápsula del composer (modern.css) dejó el textarea como
// ítem flex con `flex: 1`; el flex-basis 0% pisa la altura inline que fija fitInput() y el
// campo se queda en una sola línea visible aunque lleves seis escritas.

async function setup(page: import('@playwright/test').Page) {
  await page.goto('/index.html');
  await seedProLicense(page);
  await page.evaluate(() => {
    localStorage.setItem('bookreader_ai_key', JSON.stringify('test-key'));
  });
  await page.reload();

  const fc = page.waitForEvent('filechooser');
  await page.click('.lib-empty .lib-upload');
  await (await fc).setFiles(EPUB_PATH);
  await page.waitForSelector('#ai-toggle:not([disabled])', { timeout: 15000 });
  await page.click('#ai-toggle');
  await page.waitForTimeout(1500);
  const ob = await page.$('.ai-ob-start');
  if (ob) {
    await page.fill('#ai-ob-goal', 'probar el composer');
    await page.click('#ai-ob-start');
    await page.waitForTimeout(1000);
  }
}

test('el composer crece al escribir varias líneas y vuelve al vaciarse', async ({ page }) => {
  await setup(page);
  const ta = page.locator('#ai-input');
  const rendered = () => ta.evaluate((el) => el.getBoundingClientRect().height);

  // Seis líneas escritas: el campo debe mostrarlas (no una sola con scroll interno).
  await ta.fill('línea 1\nlínea 2\nlínea 3\nlínea 4\nlínea 5\nlínea 6');
  expect(await rendered()).toBeGreaterThan(110);

  // Vacío: vuelve a la altura de una línea.
  await ta.fill('');
  expect(await rendered()).toBeLessThan(50);
});
