import { test, expect } from '@playwright/test';
const BASE = 'http://localhost:8899';

test.describe('navegador es-ES', () => {
  test.use({ locale: 'es-ES' });
  test('la raíz redirige a /es/ la primera visita', async ({ page }) => {
    await page.goto(BASE + '/');
    await expect(page).toHaveURL(BASE + '/es/');
    await expect(page.locator('h1')).toContainText('Lo que lees');
  });
  test('elegir English se recuerda: la raíz ya no redirige', async ({ page }) => {
    await page.goto(BASE + '/es/');
    await page.locator('nav .nav-lang').click();          // → ../?lang=en
    await expect(page.locator('h1')).toContainText('What you read');
    await page.goto(BASE + '/');                          // visita directa posterior
    await expect(page).toHaveURL(BASE + '/');
    await expect(page.locator('h1')).toContainText('What you read');
  });
});

test.describe('navegador en-US', () => {
  test.use({ locale: 'en-US' });
  test('la raíz NO redirige y el conmutador Español fija la preferencia', async ({ page }) => {
    await page.goto(BASE + '/');
    await expect(page).toHaveURL(BASE + '/');
    await page.locator('nav .nav-lang').click();          // → es/?lang=es
    await expect(page.locator('h1')).toContainText('Lo que lees');
    await page.goto(BASE + '/');                          // ahora la preferencia es 'es'
    await expect(page).toHaveURL(BASE + '/es/');
    // y la app comparte la clave → arranca en español
    const lang = await page.evaluate(() => localStorage.getItem('bookreader_lang'));
    expect(lang).toBe('es');
  });
});
