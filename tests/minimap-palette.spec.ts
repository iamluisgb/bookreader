import { test, expect, Page } from '@playwright/test';
import path from 'path';

// Tipografía del libro, minimapa (ui/minimap.js) y paleta de comandos (ui/command-palette.js).
// El libro tiene índice de primer nivel (3 capítulos), así que el minimapa pinta rayas de
// capítulo además de los subrayados.
const EPUB = path.join(__dirname, 'oreilly-like.epub');

async function openBook(page: Page) {
  await page.goto('/');
  const [fc] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Subir tu primer libro' }).click(),
  ]);
  await fc.setFiles(EPUB);
  await expect(page.locator('#epub-container')).toBeVisible({ timeout: 10000 });
  // Las localizaciones (y con ellas las páginas del índice) llegan después de pintar.
  await expect.poll(() => page.evaluate(async () => (await import('/js/epub-reader.js')).getLocationsTotal()),
    { timeout: 15000 }).toBeGreaterThan(0);
}

test('el libro se compone justificado, con guiones y cifras de estilo antiguo; el ajuste lo alinea a la izquierda', async ({ page }) => {
  await openBook(page);
  const typo = () => page.evaluate(() => {
    const d = (document.querySelector('#epub-container iframe') as HTMLIFrameElement).contentDocument!;
    const cs = d.defaultView!.getComputedStyle(d.querySelector('p')!);
    return { lang: d.documentElement.lang, align: cs.textAlign, hyphens: cs.hyphens, nums: cs.fontVariantNumeric };
  });
  expect(await typo()).toEqual({ lang: 'en', align: 'justify', hyphens: 'auto', nums: 'oldstyle-nums proportional-nums' });

  await page.locator('#reading-settings').click();
  await page.locator('.align-btn[data-align="start"]').click();
  await expect.poll(async () => (await typo()).align).toBe('start');
  await expect(page.locator('.align-btn[data-align="start"]')).toHaveAttribute('aria-checked', 'true');
});

test('minimapa: un subrayado y los capítulos en el borde; el clic salta al subrayado', async ({ page }) => {
  await openBook(page);
  const target = await page.evaluate(async () => {
    const E = await import('/js/epub-reader.js');
    const H = await import('/js/highlights.js');
    await E.seekToFraction(0.8);
    await new Promise((r) => setTimeout(r, 400));
    const cfi = E.getCurrentCfi();
    H.add(cfi, 'Un pasaje subrayado al final', '#81c784', '', 'Mi nota');
    await E.seekToFraction(0);
    return cfi;
  });

  const rail = page.locator('#reader-minimap');
  await expect(rail).toBeVisible();
  await expect(rail.locator('.minimap-mark--hl')).toHaveCount(1);
  await expect(rail.locator('.minimap-mark--ch')).toHaveCount(3);

  const mark = rail.locator('.minimap-mark--hl');
  await mark.hover();
  await expect(page.locator('.minimap-tip')).toContainText('Un pasaje subrayado al final');
  await expect(page.locator('.minimap-tip')).toContainText('Mi nota');

  await mark.click();
  await expect.poll(() => page.evaluate(async () => (await import('/js/epub-reader.js')).getCurrentCfi()))
    .toBe(target);
});

test('minimapa: en táctil no se pinta (el borde es del gesto de pasar página)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'es-ES' });
  const page = await ctx.newPage();
  await openBook(page);
  await expect(page.locator('#reader-minimap')).toBeHidden();
  await ctx.close();
});

test('paleta: Ctrl+K abre, filtra sin acentos, ejecuta con Intro y Escape cierra', async ({ page }) => {
  await openBook(page);
  await page.keyboard.press('Control+k');
  const overlay = page.locator('.cmdk-overlay');
  await expect(overlay).toBeVisible();
  await expect(page.locator('.cmdk-input')).toBeFocused();

  await page.keyboard.type('oscu');
  await expect(page.locator('.cmdk-item').first()).toContainText('Tema: oscuro');
  await page.keyboard.press('Enter');
  await expect(overlay).toBeHidden();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // Los capítulos solo salen al escribir, y elegir uno navega.
  await page.keyboard.press('Control+k');
  await page.keyboard.type('value of reli');
  await expect(page.locator('.cmdk-item').first()).toContainText('Chapter 2');
  await page.keyboard.press('Enter');
  await expect(page.locator('#progress-chapter')).toContainText('Chapter 2');

  await page.keyboard.press('Control+k');
  await expect(overlay).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(overlay).toBeHidden();
});

test('paleta: también se abre con el foco dentro del libro (iframe)', async ({ page }) => {
  await openBook(page);
  await page.locator('#epub-container iframe').contentFrame().locator('body').click({ position: { x: 200, y: 200 } });
  await page.keyboard.press('Control+k');
  await expect(page.locator('.cmdk-overlay')).toBeVisible();
});
