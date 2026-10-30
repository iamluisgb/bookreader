import { test, expect } from '@playwright/test';
// Landing (plan savvia, 30-oct-2026): «Everything in the box» es un diagrama cuyas salidas
// enseñan su mini-demo; la luz de lectura, sin movimiento, son tres páginas quietas; y el
// manifiesto existe en los dos idiomas.
const BASE = 'http://localhost:8899';

test.describe('landing · diagrama, luz de lectura y manifiesto', () => {
  test.use({ locale: 'en-US' });

  test('cada salida del diagrama enseña su demo y solo la suya', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE + '/');
    await page.locator('#bmap').scrollIntoViewIfNeeded();
    await expect(page.locator('.bmap-demo[data-demo="explain"]')).toBeVisible();
    for (const k of ['zone', 'feynman', 'export']) {
      await page.locator(`.bmap-out button[data-demo="${k}"]`).click();
      await expect(page.locator(`.bmap-out button[data-demo="${k}"]`)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator(`.bmap-demo[data-demo="${k}"]`)).toBeVisible();
      await expect(page.locator('.bmap-demo:visible')).toHaveCount(1);
    }
    // las líneas: una por entrada y una por salida
    await expect(page.locator('.bmap-lines path')).toHaveCount(4 + 5);
    expect(errors).toEqual([]);
  });

  test('sin movimiento, la luz de lectura son tres páginas quietas', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(BASE + '/');
    await expect(page.locator('.night-static')).toBeVisible();
    await expect(page.locator('.night-static .night-page')).toHaveCount(3);
    await expect(page.locator('.night-stage > .night-page')).toBeHidden();
  });

  test('el manifiesto existe en inglés y en español, enlazado desde la portada', async ({ page }) => {
    await page.goto(BASE + '/');
    await expect(page.locator('footer a[href="why/"]')).toHaveCount(1);
    await page.goto(BASE + '/why/');
    await expect(page.locator('h1')).toHaveText('What you read should stay with you.');
    await page.goto(BASE + '/es/por-que/');
    await expect(page.locator('h1')).toHaveText('Lo que lees debería quedarse contigo.');
  });
});
