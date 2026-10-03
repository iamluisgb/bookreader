import { test, expect, Page } from '@playwright/test';
import path from 'path';

// Cabecera del lector (docs/AUDITORIA_CABECERA_LECTOR.md). La queja de partida: el botón del
// índice estaba arriba a la izquierda y, al abrir el panel, saltaba 320 px a la derecha; el
// título se montaba sobre los iconos en móvil; y la marca salía dos veces.
const EPUB_PATH = path.join(__dirname, 'test.epub');

async function openBook(page: Page) {
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', EPUB_PATH);
  await page.waitForSelector('#epub-container iframe', { timeout: 30000 });
}

test('F1: el botón del índice no se mueve al abrir el panel, y él mismo lo cierra', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBook(page);
  const toggle = page.locator('#sidebar-toggle');
  const before = (await toggle.boundingBox())!;
  await toggle.click();
  await expect(page.locator('#sidebar')).toHaveClass(/open/);
  await page.waitForTimeout(500);                       // fin de la transición del panel
  const after = (await toggle.boundingBox())!;
  expect(Math.abs(after.x - before.x)).toBeLessThan(1);
  expect(Math.abs(after.y - before.y)).toBeLessThan(1);
  // En escritorio no hay ✕: el botón del carril (en acento) es el cierre.
  await expect(page.locator('#sidebar-close')).toBeHidden();
  await toggle.click();
  await expect(page.locator('#sidebar')).not.toHaveClass(/open/);
});

test('F1: en cajón (< 1024) la ✕ sigue dentro del panel', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await openBook(page);
  await page.locator('#sidebar-toggle').click();
  await expect(page.locator('#sidebar-close')).toBeVisible();
  await page.locator('#sidebar-close').click();
  await expect(page.locator('#sidebar')).not.toHaveClass(/open/);
});

test('Q1: el título no pisa los iconos', async ({ page }) => {
  for (const width of [1440, 1100, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await openBook(page);
    const overlap = await page.evaluate(() => {
      const t = document.getElementById('reader-title')!;
      if (getComputedStyle(t).visibility === 'hidden') return 0;
      const r = t.getBoundingClientRect();
      const boxes = [...document.querySelectorAll('.reader-nav button, .header-actions button')]
        .map(b => b.getBoundingClientRect()).filter(b => b.width);
      return Math.max(0, ...boxes.map(b => Math.min(r.right, b.right) - Math.max(r.left, b.left)));
    });
    expect(overlap, `ancho ${width}`).toBe(0);
  }
});

test('Q3: la cabecera del panel muestra el libro, no la marca', async ({ page }) => {
  await openBook(page);
  await page.locator('#sidebar-toggle').click();
  await expect(page.locator('#sidebar-book-title')).not.toHaveText('BookReader');
  await expect(page.locator('#sidebar-book-title')).toHaveText(await page.locator('#reader-title').textContent() as string);
});

test('F2: «Aa» abre los ajustes de lectura sobre la página, sin abrir el índice', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBook(page);
  const aa = page.getByRole('button', { name: 'Ajustes de lectura' });
  const pop = page.locator('#reading-pop');
  await aa.click();
  await expect(pop).toBeVisible();
  await expect(aa).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#sidebar')).not.toHaveClass(/open/);
  // Anclado bajo el botón, por la derecha.
  const [b, p] = [(await aa.boundingBox())!, (await pop.boundingBox())!];
  expect(p.y).toBeGreaterThan(b.y + b.height - 1);
  expect(Math.abs((p.x + p.width) - (b.x + b.width))).toBeLessThan(2);
  // Cambiar el tema no lo cierra (se ve el efecto sobre la página).
  await pop.locator('[data-theme="sepia"]').click();
  await expect(pop).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
  await expect(aa).toBeFocused();
  // Ni en el panel ni en «Más».
  await expect(page.locator('#sidebar #reading-settings, #sidebar #tab-settings')).toHaveCount(0);
  await page.locator('#reader-more').click();
  await expect(page.locator('.reader-more-menu')).not.toContainText('Ajustes de lectura');
});

test('F2: en móvil es una hoja inferior', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openBook(page);
  await page.locator('#reading-settings').click();
  const box = (await page.locator('#reading-pop').boundingBox())!;
  expect(Math.round(box.y + box.height)).toBe(844);
  expect(box.width).toBe(390);
});
