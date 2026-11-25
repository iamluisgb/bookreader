import { test, expect, type Page } from '@playwright/test';
const BASE = 'http://localhost:8899';

// Los filtros de la biblioteca libre: dos niveles de materia (letra de la Library of Congress y su
// subclase) y contadores que dicen la verdad. El fallo que vigila la segunda prueba era real: los
// contadores se calculaban sobre todo el catálogo, así que fijar el idioma dejaba los números iguales
// y el lector filtraba a ciegas.
async function cargarFondo(page: Page) {
  // El fondo (3,5 MB) se pide solo en segundo plano; se pulsa el botón por si aún no ha arrancado y
  // se espera al recuento real en vez de a un tiempo fijo.
  const boton = page.locator('.lib-fondo');
  if (await boton.count()) await boton.click({ timeout: 5000 }).catch(() => {});
  await expect
    .poll(async () => Number(((await page.locator('.lib-status').textContent()) || '').replace(/\D/g, '')), { timeout: 90000 })
    .toBeGreaterThan(40000);
}

const materia = (page: Page) => page.locator('.lib-facets select').nth(1);
const idioma = (page: Page) => page.locator('.lib-facets select').nth(0);
const cuentaPA = async (page: Page) =>
  Number(((await materia(page).locator('option[value="PA"]').textContent()) || '').match(/\(([\d.]+)\)/)![1].replace(/\./g, ''));

test.describe('biblioteca libre: filtros', () => {
  test.use({ locale: 'es-ES' });

  test('la materia se agrupa por letra y ofrece la subclase de clásicos grecorromanos', async ({ page }) => {
    await page.goto(BASE + '/es/muestra/');
    await cargarFondo(page);
    // Un <optgroup> no es «visible» para Playwright (no es una caja); lo que se comprueba es que
    // exista y que dentro esté la subclase griega y latina.
    await expect(materia(page).locator('optgroup')).not.toHaveCount(0);
    await expect(materia(page).locator('option[value="PA"]')).toHaveCount(1);
    // Y las obras de esa subclase se anuncian como lo que son, no como «Literatura» a secas.
    await materia(page).selectOption('PA');
    await expect(page.locator('.lib-row').first()).toContainText(/griega y latina/i);
  });

  test('los contadores de una faceta respetan las demás', async ({ page }) => {
    await page.goto(BASE + '/es/muestra/');
    await cargarFondo(page);
    const todas = await cuentaPA(page);
    expect(todas).toBeGreaterThan(100);

    // En inglés hay menos clásicos grecorromanos que en todo el fondo: el número tiene que bajar.
    await idioma(page).selectOption('en');
    await expect.poll(() => cuentaPA(page), { timeout: 15000 }).toBeLessThan(todas);

    // Y al quitar el idioma vuelve el total: el contador no se queda pegado.
    await idioma(page).selectOption('');
    await expect.poll(() => cuentaPA(page), { timeout: 15000 }).toBe(todas);
  });
});
