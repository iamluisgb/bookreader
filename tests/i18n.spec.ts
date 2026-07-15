import { test, expect } from '@playwright/test';

// P15 · i18n EN/ES. El idioma sale de localStorage 'bookreader_lang' o, la primera vez,
// de navigator.language (es* → español; resto → inglés, el idioma de lanzamiento).
// La config global de tests usa locale es-ES (los specs históricos asertan español);
// aquí forzamos en-US por contexto para cubrir el camino inglés.

test.describe('inglés por defecto (locale en-US)', () => {
  test.use({ locale: 'en-US' });

  test('el chrome estático se traduce y <html lang> refleja el idioma', async ({ page }) => {
    await page.goto('/index.html');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    // data-i18n (texto) y data-i18n-attrs (atributos) aplicados en el arranque.
    await expect(page.locator('.tab-btn[data-tab="contents"]')).toHaveText('Contents');
    await expect(page.locator('#open-file-btn')).toHaveText('Open file');
    // El footer está oculto hasta abrir un libro → se comprueba el atributo, no el rol.
    await expect(page.locator('#next-btn')).toHaveAttribute('aria-label', 'Next page');
  });

  test('t() traduce, interpola y cae al español sin traducción', async ({ page }) => {
    await page.goto('/index.html');
    const r = await page.evaluate(async () => {
      const { t, getLang } = await import('/js/i18n.js');
      return {
        lang: getLang(),
        simple: t('Terminado'),
        params: t('Página {n}', { n: 7 }),
        fallback: t('cadena-sin-traducción'),
      };
    });
    expect(r.lang).toBe('en');
    expect(r.simple).toBe('Finished');
    expect(r.params).toBe('Page 7');
    expect(r.fallback).toBe('cadena-sin-traducción');
  });

  test('bookreader_lang=es fuerza español aunque el navegador sea en-US', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('bookreader_lang', 'es'));
    await page.goto('/index.html');
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await expect(page.locator('.tab-btn[data-tab="contents"]')).toHaveText('Contenido');
  });
});

test('con locale es-ES la UI queda en español (los specs históricos dependen de esto)', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.locator('.tab-btn[data-tab="contents"]')).toHaveText('Contenido');
  await expect(page.locator('#next-btn')).toHaveAttribute('aria-label', 'Página siguiente');
});
