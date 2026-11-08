import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';

// Idioma y tema de las páginas públicas (assets/landing/prefs.js).
const BASE = 'http://localhost:8899';

// Cada página pública con su gemela en el otro idioma. El selector de la barra lleva a la gemela
// y fija la preferencia con ?lang=, para que volver a la portada no deshaga la elección.
const PAIRS: [string, string][] = [
  ['/', '/es/'],
  ['/why/', '/es/por-que/'],
  ['/blog/', '/es/blog/'],
  ['/blog/science-of-learning/', '/es/blog/ciencia-del-aprendizaje/'],
  ['/privacy/', '/es/privacidad/'],
  ['/anki/', '/es/anki/'],
];
const file = (u: string) => join(__dirname, '..', u.replace(/^\//, ''), 'index.html');

test('cada página pública lleva en la barra a su gemela, con ?lang=, y declara las dos en hreflang', () => {
  const bad: string[] = [];
  for (const [en, es] of PAIRS) {
    for (const [u, other, ol] of [[en, es, 'es'], [es, en, 'en']]) {
      const src = readFileSync(file(u), 'utf8');
      const m = src.match(/<a class="nav-lang"[^>]*href="([^"]+)"/);
      if (!m) { bad.push(`${u}: sin selector de idioma`); continue; }
      const target = new URL(m[1], 'https://x' + u);
      if (target.pathname !== other) bad.push(`${u}: el selector va a ${target.pathname}, no a ${other}`);
      if (target.searchParams.get('lang') !== ol) bad.push(`${u}: el selector no fija ?lang=${ol}`);
      if (u !== '/' && u !== '/es/' && !src.includes(`hreflang="${ol}" href="https://bookreader.raiatech.com${other}"`)) bad.push(`${u}: falta el hreflang de ${other}`);
      if (!src.includes('assets/landing/prefs.js?v=')) bad.push(`${u}: no carga prefs.js`);
      if (!src.includes('class="theme-pick"')) bad.push(`${u}: sin selector de tema`);
    }
  }
  expect(bad).toEqual([]);
});

test.describe('con el navegador en español', () => {
  test.use({ locale: 'es-ES' });

  test('elegir English en el blog se recuerda al volver a la portada', async ({ page }) => {
    await page.goto(BASE + '/es/blog/ciencia-del-aprendizaje/');
    await page.locator('nav .nav-lang').click();
    await expect(page).toHaveURL(/\/blog\/science-of-learning\/\?lang=en$/);
    await page.locator('footer.foot a', { hasText: 'Home' }).click();
    await expect(page).toHaveURL(BASE + '/');
    await expect(page.locator('h1').first()).not.toHaveText(/Lo que lees/);
  });
});

test.describe('tema', () => {
  test.use({ colorScheme: 'light' });

  test('el selector del pie guarda el tema en el ajuste de la app sin pisar el resto', async ({ page }) => {
    await page.goto(BASE + '/why/');
    await page.evaluate(() => localStorage.setItem('bookreader_settings', JSON.stringify({ fontSize: 19, theme: 'system' })));
    await page.reload();
    await expect(page.locator('.theme-pick [data-pick="system"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.theme-pick [data-pick="dark"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('bookreader_settings') || '{}'));
    expect(saved).toEqual({ fontSize: 19, theme: 'dark' });
    // Fondo realmente oscuro, no solo el atributo.
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe('rgb(18, 18, 20)');
  });

  test('el tema elegido en la app se aplica antes de pintar, y sepia se ve en claro', async ({ page }) => {
    await page.goto(BASE + '/es/privacidad/');
    await page.evaluate(() => localStorage.setItem('bookreader_settings', JSON.stringify({ theme: 'dark' })));
    await page.goto(BASE + '/es/');
    // Se lee en el primer script del <head>: el atributo ya está cuando llega DOMContentLoaded.
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
    const bar = await page.locator('meta[name="theme-color"]').evaluateAll((ms) => ms.map((m) => m.getAttribute('content')));
    expect(bar).toEqual(['#121214', '#121214']);
    await page.evaluate(() => localStorage.setItem('bookreader_settings', JSON.stringify({ theme: 'sepia' })));
    await page.goto(BASE + '/es/anki/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('.theme-pick [data-pick="light"]')).toHaveAttribute('aria-pressed', 'true');
  });
});
