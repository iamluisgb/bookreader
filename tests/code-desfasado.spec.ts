import { test, expect, devices } from '@playwright/test';

// Despliegue con la app abierta: la página conserva los módulos que cargó al arrancar, pero los
// que se cargan al pulsar algo llegan nuevos. Si el nuevo importa algo que el viejo no exporta,
// la importación falla. Antes el botón no hacía nada (el error solo iba a la consola: así dejó
// de abrirse Análisis en el móvil tras desplegar P44); ahora avisa para actualizar.
// Se simula sirviendo un analysis.js «nuevo» que pide a srs.js una exportación que no existe.

const { defaultBrowserType, ...pixel } = devices['Pixel 7'] as any;
test.use(pixel);

test('una carga diferida desfasada avisa con «Actualizar» en vez de no hacer nada', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('[data-act="more"]').first()).toBeVisible();
  await page.route('**/js/analysis.js', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: "import { exportacionDeOtraVersion } from './ai/srs.js';\nexport function open() { exportacionDeOtraVersion(); }\n",
  }));
  await page.locator('[data-act="more"]').first().click();
  await page.locator('.lib-sheet-row[data-act="analysis"]').click();
  const aviso = page.locator('.ai-toast, [role="status"]', { hasText: 'Hay una versión nueva' });
  await expect(aviso).toBeVisible();
  await expect(aviso.getByRole('button', { name: 'Actualizar' })).toBeVisible();
});

test('lo mismo para un `await import()` dentro de un manejador (sin `cargar`)', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('[data-act="more"]').first()).toBeVisible();
  await page.evaluate(() => {
    // Rechazo sin capturar con el error de enlazado de Chromium.
    Promise.reject(new SyntaxError("The requested module './srs.js' does not provide an export named 'x'"));
  });
  await expect(page.locator('.ai-toast, [role="status"]', { hasText: 'Hay una versión nueva' })).toBeVisible();
});
