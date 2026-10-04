import { test, expect, Page } from '@playwright/test';
import path from 'path';

// Ampliar el agente (ai/maximize.js): el panel ocupa la ventana menos una franja del libro,
// el libro se TAPA sin repaginarse, y se vuelve con el botón, Esc, la franja, el atajo o una
// cita. No se recuerda. En móvil no existe.
const EPUB_PATH = path.join(__dirname, 'test.epub');

async function openAgent(page: Page) {
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', EPUB_PATH);
  await page.waitForSelector('#epub-container iframe', { timeout: 30000 });
  await page.locator('#ai-toggle').click();
  await expect(page.locator('body')).toHaveClass(/ai-open/);
  await page.evaluate(() => document.getElementById('ai-onboarding')?.remove());
  await page.waitForTimeout(600);                                     // fin del empuje del lector
}

const readerBox = (page: Page) => page.evaluate(() => ({
  w: Math.round(document.getElementById('reader-main')!.getBoundingClientRect().width),
}));

test('ampliar tapa el libro sin encogerlo, y se vuelve con el botón, Esc y la franja', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAgent(page);
  const max = page.locator('#ai-max');
  const before = await readerBox(page);
  const cfi = await page.evaluate(async () => (await import('/js/epub-reader.js')).getCurrentCfi());

  await max.click();
  await expect(page.locator('body')).toHaveClass(/ai-max/);
  await expect(max).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(500);
  const panel = (await page.locator('#ai-panel').boundingBox())!;
  expect(Math.round(panel.width)).toBe(1440 - 72);
  // El lector no cambia de ancho (no repagina) y la posición sigue.
  expect((await readerBox(page)).w).toBe(before.w);
  expect(await page.evaluate(async () => (await import('/js/epub-reader.js')).getCurrentCfi())).toBe(cfi);
  // El contenido se centra a ancho de lectura.
  const composer = (await page.locator('.ai-compose-box').boundingBox())!;
  expect(composer.width).toBeLessThanOrEqual(762);

  await page.keyboard.press('Escape');
  await expect(page.locator('body')).not.toHaveClass(/ai-max/);
  await expect(page.locator('body')).toHaveClass(/ai-open/);         // Esc no cierra el agente

  await max.click();
  await page.locator('.ai-max-strip').click();
  await expect(page.locator('body')).not.toHaveClass(/ai-max/);

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+Period' : 'Control+Shift+Period');
  await expect(page.locator('body')).toHaveClass(/ai-max/);
  await max.click();
  await expect(page.locator('body')).not.toHaveClass(/ai-max/);
});

test('no se recuerda: cerrar el agente lo devuelve a su ancho', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAgent(page);
  await page.locator('#ai-max').click();
  await page.locator('#ai-toggle').click();                           // cerrar (✦)
  await expect(page.locator('body')).not.toHaveClass(/ai-max/);
  await page.locator('#ai-toggle').click();
  await expect(page.locator('body')).toHaveClass(/ai-open/);
  await expect(page.locator('body')).not.toHaveClass(/ai-max/);
  await expect(page.locator('.ai-max-strip')).toHaveCount(0);
});

test('una cita devuelve al libro', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openAgent(page);
  await page.locator('#ai-max').click();
  await expect(page.locator('body')).toHaveClass(/ai-max/);
  // «Ir al pasaje» de la Libreta: pasa por el mismo onCite que las citas del chat.
  await page.evaluate(async () => {
    const cfi = (await import('/js/epub-reader.js')).getCurrentCfi();
    const b = document.createElement('button');
    b.className = 'ai-nb-goto'; b.dataset.cfi = cfi; b.textContent = 'ir';
    document.getElementById('ai-view-notebook')!.appendChild(b);
  });
  await page.evaluate(() => (document.querySelector('.ai-nb-goto') as HTMLElement).click());
  await expect(page.locator('body')).not.toHaveClass(/ai-max/);
  await expect(page.locator('body')).toHaveClass(/ai-open/);
});

test('en móvil no hay botón de ampliar', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', EPUB_PATH);
  await page.waitForSelector('#epub-container iframe', { timeout: 30000 });
  await page.evaluate(() => document.body.classList.remove('immersive'));
  await page.locator('.ai-fab').click();
  await expect(page.locator('body')).toHaveClass(/ai-open/);
  await page.evaluate(async () => {
    const M: any = await import('/js/ai/maximize.js');
    document.body.classList.add('ai-open');
    M.setAiMax(true);
  });
  await expect(page.locator('body')).not.toHaveClass(/ai-max/);
  await expect(page.locator('#ai-max')).toBeHidden();
});
