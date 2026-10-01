import { test, expect, Page } from '@playwright/test';

// Regresión del testeo en móvil: en Ajustes → Aplicación la etiqueta de idioma era
// `${t('Idioma')} · Language` — el sufijo «· Language» existe como pista bilingüe para
// quien tiene la UI en español, pero con la UI en inglés quedaba «Language · Language».
async function abrirApp(page: Page, lang: 'es' | 'en') {
  // Ojo: i18n lee `bookreader_lang` CRUDO (no JSON como el resto de ajustes).
  await page.addInitScript((l) => localStorage.setItem('bookreader_lang', l), lang);
  await page.goto('/');
  await page.locator('.lib-rail-settings').click();
  await page.locator('.appset-nav-item[data-section="app"]').click();
}

test('con la UI en inglés, la etiqueta de idioma no se duplica', async ({ page }) => {
  await abrirApp(page, 'en');
  await expect(page.locator('label[for="appset-lang"]')).toHaveText('Language');
});

test('con la UI en español, la etiqueta conserva la pista bilingüe', async ({ page }) => {
  await abrirApp(page, 'es');
  await expect(page.locator('label[for="appset-lang"]')).toHaveText('Idioma · Language');
});
