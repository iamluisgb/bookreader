import { test, expect } from '@playwright/test';
import path from 'path';

// El menú del libro lista todas las estanterías manuales. Con quince o veinte, en un móvil
// es más alto que la pantalla: sin tope ni scroll propio, «Eliminar» (lo último) quedaba
// fuera e inalcanzable. Tiene que caber en el viewport y desplazarse por dentro.
const EPUB_PATH = path.join(__dirname, 'test.epub');

test.use({ viewport: { width: 390, height: 700 } });

test('menú del libro con muchas estanterías: cabe en pantalla y se llega a «Eliminar»', async ({ page }) => {
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', EPUB_PATH);
  await page.waitForSelector('#epub-container iframe', { timeout: 30000 });
  await page.evaluate(async () => {
    document.body.classList.remove('immersive');
    const Store: any = await import('/js/library/store.js');
    for (let i = 1; i <= 20; i++) await Store.addShelf('Estantería ' + i);
  });
  await page.locator('#library-btn').click();
  await expect(page.locator('.lib-h1')).toBeVisible();

  await page.locator('.lib-kebab').first().click();
  const menu = page.locator('.lib-menu');
  await expect(menu).toBeVisible();
  const box = await menu.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, vh: window.innerHeight, scrolls: el.scrollHeight > el.clientHeight };
  });
  expect(box.top).toBeGreaterThanOrEqual(0);
  expect(box.bottom).toBeLessThanOrEqual(box.vh);
  expect(box.scrolls).toBe(true);

  const del = menu.locator('[data-act="delete"]');
  await del.scrollIntoViewIfNeeded();
  await expect(del).toBeInViewport();
  await del.click();
  await expect(page.locator('.dlg-card')).toBeVisible();
});
