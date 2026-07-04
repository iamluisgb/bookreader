import { test, expect } from '@playwright/test';

// Fase 2 · Tipografía self-hosted. Inter para la UI (por defecto); Source Serif 4 como opción
// de lectura (NO por defecto). Verificamos que los woff2 se sirven y cargan.

test('Inter (UI) y Source Serif 4 (opción) cargan desde el propio origen', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async () => {
    // Si el woff2 no se sirviera (404), load() resolvería sin caras y check() sería false.
    await document.fonts.load("400 16px 'Inter'");
    await document.fonts.load("600 16px 'Inter'");
    await document.fonts.load("400 18px 'Source Serif 4'");
    return {
      inter400: document.fonts.check("400 16px 'Inter'"),
      inter600: document.fonts.check("600 16px 'Inter'"),
      serif: document.fonts.check("400 18px 'Source Serif 4'"),
      bodyFont: getComputedStyle(document.body).fontFamily,
    };
  });
  expect(r.inter400).toBe(true);
  expect(r.inter600).toBe(true);
  expect(r.serif).toBe(true);
  // La UI usa Inter como primera opción de la pila.
  expect(r.bodyFont.replace(/["']/g, '').toLowerCase()).toContain('inter');
});

test('la fuente de lectura por defecto NO es Source Serif 4 (sigue siendo la serif actual)', async ({ page }) => {
  await page.goto('/index.html');
  const def = await page.evaluate(async () => {
    const S = await import('/js/settings.js');
    return S.getAll().fontFamily;
  });
  expect(def).toBe('serif');   // por defecto la de siempre; Source Serif 4 es opt-in
  // Y la opción existe en el selector.
  await expect(page.locator('#font-family-select option[value="source-serif"]')).toHaveCount(1);
});
