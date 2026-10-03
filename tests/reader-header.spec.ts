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
