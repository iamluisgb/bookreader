import { test, expect } from '@playwright/test';
import path from 'path';

const EPUB_PATH = path.join(__dirname, 'test.epub');

async function openEpub(page) {
  await page.goto('/index.html');
  const fc = page.waitForEvent('filechooser');
  await page.click('.lib-empty .lib-upload');
  await (await fc).setFiles(EPUB_PATH);
  await page.waitForSelector('#epub-container iframe', { timeout: 20000 });
}

// El selector de modo vive en la pestaña Ajustes del sidebar, cerrado por defecto.
async function openReadingSettings(page) {
  await page.click('#sidebar-toggle');
  await page.click('.tab-btn[data-tab="settings"]');
  await page.waitForSelector('.reading-mode-btn[data-mode="spread"]', { state: 'visible' });
}

// Doble página: epub.js solo abre dos columnas si el contenedor llega a
// minSpreadWidth (800 por defecto), así que el viewport tiene que ser ancho.
test.use({ viewport: { width: 1400, height: 900 } });

test('el modo "Doble" reparte el texto en dos columnas', async ({ page }) => {
  await openEpub(page);

  const single = await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    return R.getReadingMode();
  });
  expect(single).toBe('paginated');

  await openReadingSettings(page);
  await page.click('.reading-mode-btn[data-mode="spread"]');
  await page.waitForTimeout(800);   // el manager re-maqueta

  const spread = await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    // divisor 2 = dos páginas por pantalla; es lo que calcula Layout con spread.
    const rend: any = (R as any).getRendition?.() || null;
    return { mode: R.getReadingMode(), divisor: rend?._layout?.divisor ?? null };
  });
  expect(spread.mode).toBe('spread');
  if (spread.divisor !== null) expect(spread.divisor).toBe(2);
});

test('el modo de lectura se recuerda por libro', async ({ page }) => {
  await openEpub(page);
  await openReadingSettings(page);
  await page.click('.reading-mode-btn[data-mode="spread"]');
  await page.waitForTimeout(400);

  await page.reload();
  await page.waitForTimeout(1500);
  const mode = await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    return R.getReadingMode();
  });
  expect(mode).toBe('spread');
});

test('pasar el ratón por la barra muestra la página sin mover el progreso', async ({ page }) => {
  await openEpub(page);
  // Las locations tardan: sin ellas la burbuja solo puede enseñar el %.
  await page.waitForTimeout(3000);

  const bubble = page.locator('#progress-bubble');
  await expect(bubble).not.toHaveClass(/visible/);

  const pctBefore = await page.locator('#progress-text').textContent();
  const box = (await page.locator('#progress-container').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
  await page.waitForTimeout(300);

  await expect(bubble).toHaveClass(/visible/);
  expect((await bubble.textContent())!.trim()).not.toBe('');
  // Señalar no navega ni mueve el % de la fila: eso es del arrastre.
  expect(await page.locator('#progress-text').textContent()).toBe(pctBefore);

  await page.mouse.move(box.x + box.width / 2, box.y - 120);
  await page.waitForTimeout(200);
  await expect(bubble).not.toHaveClass(/visible/);
});
