import { test, expect, type Page } from '@playwright/test';

// Los filtros de la biblioteca libre. Se puede apuntar a producción con
//   SMOKE_BASE=https://bookreader.raiatech.com npx playwright test tests/samples-landing.spec.ts --config playwright.local.config.ts
// El fallo que vigila la prueba de contadores era real: se calculaban sobre todo el catálogo, así que
// fijar un filtro dejaba los números de los demás iguales y el lector filtraba a ciegas.
const BASE = process.env.SMOKE_BASE || 'http://localhost:8899';
const ES = !BASE.includes('raiatech.com') || BASE.includes('/es');
const INICIO = BASE + (ES ? '/es/muestra/' : '/samples/');

// El fondo (3,5 MB) se pide solo en segundo plano; se pulsa el botón por si aún no ha arrancado y se
// espera al recuento real en vez de a un tiempo fijo.
async function cargarFondo(page: Page) {
  const boton = page.locator('.lib-fondo');
  if (await boton.count()) await boton.click({ timeout: 5000 }).catch(() => {});
  await expect
    .poll(async () => Number(((await page.locator('.lib-status').textContent()) || '').replace(/\D/g, '')), { timeout: 120000 })
    .toBeGreaterThan(40000);
}

const sel = (page: Page, i: number) => page.locator('.lib-facets select').nth(i);
const idioma = (page: Page) => sel(page, 0);
const materia = (page: Page) => sel(page, 1);
const total = async (page: Page) => Number(((await page.locator('.lib-status').textContent()) || '').replace(/\D/g, ''));
const filas = (page: Page) => page.locator('.lib-row');

// Suma de una faceta: para Materia solo las opciones de letra (cada obra cae en una sola materia),
// porque el desplegable repite el total de cada grupo.
async function suma(page: Page, i: number, soloLetras = false) {
  return page.evaluate(
    ([idx, filtro]) => {
      const s = document.querySelectorAll('.lib-facets select')[idx] as HTMLSelectElement;
      let t = 0;
      for (const o of Array.from(s.options)) {
        if (!o.value) continue;
        if (filtro && o.value.length !== 1) continue;
        const m = o.textContent && o.textContent.match(/\(([\d.]+)\)/);
        if (m) t += Number(m[1].replace(/\./g, ''));
      }
      return t;
    },
    [i, soloLetras] as [number, boolean],
  );
}

test.describe('biblioteca libre: filtros', () => {
  if (ES) test.use({ locale: 'es-ES' });

  test('los contadores de cada faceta cuadran con el total filtrado', async ({ page }) => {
    await page.goto(INICIO);
    await cargarFondo(page);
    const n = await total(page);
    expect(n).toBeGreaterThan(40000);

    // Sin filtros, las cuatro facetas suman lo mismo que el total.
    for (const i of [0, 2, 3]) expect(await suma(page, i)).toBe(n);
    expect(await suma(page, 1, true)).toBe(n);

    // Con un filtro puesto, las OTRAS facetas siguen cuadrando con el total y la suya propia muestra el
    // reparto global, para poder cambiar de valor sin quedarse a ciegas.
    await idioma(page).selectOption('es');
    const es = await total(page);
    expect(es).toBeGreaterThan(100);
    expect(await suma(page, 1, true)).toBe(es);
    expect(await suma(page, 2)).toBe(es);
    expect(await suma(page, 3)).toBe(es);
    expect(await suma(page, 0)).toBe(n);

    // Con dos ejes a la vez cada faceta tiene su propia referencia: Idioma se cuenta dentro de la
    // materia elegida (sin aplicar el idioma) y Materia dentro del idioma elegido (sin aplicar la
    // materia). Se comprueba que la referencia cuadra al quitar el filtro correspondiente.
    await materia(page).selectOption('PA');
    const paEs = await total(page);
    expect(paEs).toBeGreaterThan(0);
    expect(paEs).toBeLessThan(es);
    const sumaIdioma = await suma(page, 0); // reparto por idioma dentro de PA
    expect(sumaIdioma).toBeGreaterThanOrEqual(paEs);
    expect(await suma(page, 1, true)).toBe(es); // reparto por materia dentro del español
    await idioma(page).selectOption('');
    expect(await total(page)).toBe(sumaIdioma);
  });

  test('la materia se agrupa por letra y la subclase filtra de verdad', async ({ page }) => {
    await page.goto(INICIO);
    await cargarFondo(page);
    // Un <optgroup> no es «visible» para Playwright (no es una caja); lo que se comprueba es que exista.
    await expect(materia(page).locator('optgroup')).not.toHaveCount(0);
    await expect(materia(page).locator('option[value="PA"]')).toHaveCount(1);
    await materia(page).selectOption('PA');
    const n = await total(page);
    expect(n).toBeGreaterThan(50);
    // Ninguna fila se escapa de la subclase: todas se anuncian como griega y latina.
    const metas = await filas(page).locator('.lib-meta').allTextContents();
    expect(metas.length).toBeGreaterThan(10);
    for (const m of metas) expect(m.toLowerCase()).toContain(ES ? 'griega y latina' : 'greek and latin');
  });

  test('la búsqueda se combina con los filtros y el vacío se dice', async ({ page }) => {
    await page.goto(INICIO);
    await cargarFondo(page);
    await materia(page).selectOption('PQ');
    const conFiltro = await total(page);
    await page.locator('input[type="search"]').fill('quijote');
    await expect.poll(() => total(page), { timeout: 10000 }).toBeLessThan(conFiltro);
    const titulos = await filas(page).locator('.lib-title').allTextContents();
    for (const t of titulos) expect(t.toLowerCase()).toContain('quijote');

    // Sin resultados no se queda en blanco: lo dice y no deja filas.
    await page.locator('input[type="search"]').fill('zzzzqqq');
    await expect.poll(() => filas(page).count(), { timeout: 10000 }).toBe(0);
    await expect(page.locator('.lib-status')).not.toHaveText(/\d/);
  });

  test('ordenar por más antiguos funciona y no rompe el filtro', async ({ page }) => {
    await page.goto(INICIO);
    await cargarFondo(page);
    await materia(page).selectOption('PA');
    await page.locator('.lib-sort').selectOption('year');
    await expect(page.locator('.lib-sort')).toHaveValue('year');
    await expect(filas(page).first()).toContainText(ES ? /griega y latina/i : /greek and latin/i);
  });
});
