import { test, expect } from '@playwright/test';

// ADR-055 · El tema tiñe toda la app, así que también se cambia desde Ajustes generales
// → Aplicación, SIN libro abierto (antes solo estaba en los ajustes de lectura, que no
// existen fuera del lector). Fuente de verdad única: settings.js — set() persiste y
// applySettings() sincroniza el swatch activo de todos los .theme-btn.

async function openAppSettingsAppSection(page: import('@playwright/test').Page) {
  await page.goto('/index.html');
  // Tema previo guardado para no depender del sistema del runner.
  await page.evaluate(() => {
    localStorage.setItem('bookreader_settings', JSON.stringify({ theme: 'light' }));
  });
  await page.reload();

  // Desde la estantería: engranaje del raíl → Ajustes generales (sección Agente por defecto).
  await page.click('.lib-rail-settings');
  await page.waitForSelector('#app-settings .appset-nav-item');
  await page.click('.appset-nav-item[data-section="app"]');
  await page.waitForSelector('#app-settings .theme-selector');
}

test('el tema se cambia desde la estantería y persiste tras recargar', async ({ page }) => {
  await openAppSettingsAppSection(page);

  // El estado activo llega sincronizado desde settings (light, sembrado arriba).
  await expect(page.locator('#app-settings .theme-swatch.swatch-light')).toHaveClass(/active/);

  // Cambiar a oscuro: atributo global + persistencia.
  await page.click('#app-settings .theme-swatch.swatch-dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('#app-settings .theme-swatch.swatch-dark')).toHaveClass(/active/);
  await expect(page.locator('#app-settings .theme-swatch.swatch-light')).not.toHaveClass(/active/);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('bookreader_settings') || '{}'));
  expect(stored.theme).toBe('dark');

  // Persiste: recarga en frío y el tema sigue.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
