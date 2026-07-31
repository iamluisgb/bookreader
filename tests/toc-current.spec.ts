import { test, expect } from '@playwright/test';
import path from 'path';

const EPUB_PATH = path.join(__dirname, 'test.epub');

// El índice tiene que decir dónde se está leyendo: al abrir la pestaña Contenido, la
// sección actual va marcada (`a.current`), y solo una.
test.describe('Índice — sección actual', () => {
  async function loadEpub(page) {
    await page.goto('/');
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: 'Abrir archivo' }).click(),
    ]);
    await fileChooser.setFiles(EPUB_PATH);
    await page.waitForTimeout(3000);
  }

  test('al abrir el sidebar hay exactamente una entrada marcada', async ({ page }) => {
    await loadEpub(page);
    await page.getByRole('button', { name: 'Abrir sidebar' }).click();

    const current = page.locator('#toc-list a.current');
    await expect(current).toHaveCount(1, { timeout: 5000 });
    await expect(current).toHaveAttribute('aria-current', 'location');
  });

  test('saltar a otra sección mueve la marca', async ({ page }) => {
    await loadEpub(page);
    await page.getByRole('button', { name: 'Abrir sidebar' }).click();

    const links = page.locator('#toc-list a');
    await expect(links.first()).toBeVisible({ timeout: 5000 });
    const target = links.nth(await links.count() - 1);
    const label = (await target.textContent())?.trim();

    await target.click();
    await page.waitForTimeout(1500);
    // Volver a Contenido re-marca (por si la lectura avanzó con el sidebar abierto).
    await page.locator('.tab-btn[data-tab="contents"]').click();

    const current = page.locator('#toc-list a.current');
    await expect(current).toHaveCount(1);
    expect((await current.textContent())?.trim()).toBe(label);
  });
});
