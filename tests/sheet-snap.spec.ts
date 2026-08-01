// El bottom sheet del agente en móvil solo tenía una altura (92dvh): abrirlo tapaba la
// página por la que ibas a preguntar. Ahora alterna entre media y completa. El tirador tenía
// que dejar de ser un ::before —los pseudo-elementos no reciben eventos— para poder arrastrarse.
import { test, expect, Page } from '@playwright/test';
import path from 'path';

test.use({ viewport: { width: 390, height: 780 } });

// El FAB del agente solo existe con un libro abierto: el sheet se prueba en su contexto real.
async function openApp(page: Page) {
  await page.goto('/index.html');
  const fc = page.waitForEvent('filechooser');
  await page.click('.lib-empty .lib-upload');
  await (await fc).setFiles(path.join(__dirname, 'test.epub'));
  await page.waitForSelector('#epub-container iframe', { timeout: 15000 });
}

// Abre el panel y quita de en medio el onboarding (que se lleva los clics del sheet).
async function openPanel(page: Page) {
  await page.locator('#ai-fab').click();   // en móvil el punto de entrada es el FAB
  await page.locator('.ai-ob-quickchat').click().catch(() => { /* ya había conversación */ });
  await page.waitForTimeout(500);
}

const sheetH = (page: Page) => page.evaluate(() =>
  document.getElementById('ai-panel')!.getBoundingClientRect().height);

test('el tirador existe como elemento real y es tocable', async ({ page }) => {
  await openApp(page);
  const grab = page.locator('#ai-sheet-grab');
  await expect(grab).toBeVisible();
  const box = (await grab.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(24);   // objetivo de toque, no una barrita de 4px
});

test('tocar el tirador alterna entre media altura y completa, y se recuerda', async ({ page }) => {
  await openApp(page);
  await openPanel(page);
  const full = await sheetH(page);
  expect(full).toBeGreaterThan(780 * 0.8);

  await page.locator('#ai-sheet-grab').click();
  await page.waitForTimeout(400);
  const half = await sheetH(page);
  // A media altura queda página a la vista por encima: es todo el objetivo del cambio.
  expect(half).toBeLessThan(full * 0.75);
  expect(780 - half).toBeGreaterThan(200);

  // Y vuelve.
  await page.locator('#ai-sheet-grab').click();
  await page.waitForTimeout(400);
  expect(await sheetH(page)).toBeCloseTo(full, -1);

  // La preferencia sobrevive a una recarga (se guarda como el ancho del panel en escritorio).
  // Se comprueba sobre la variable que gobierna el alto: la aplica el init del panel, sin
  // depender de volver a abrir un libro.
  await page.locator('#ai-sheet-grab').click();
  await page.waitForTimeout(400);
  await page.reload();
  await page.waitForSelector('#ai-panel');
  const restored = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--ai-sheet-h').trim());
  expect(restored).toBe('52dvh');
});

test('arrastrar encaja en la altura más cercana, no en una libre', async ({ page }) => {
  await openApp(page);
  await openPanel(page);
  const before = await sheetH(page);

  const grab = page.locator('#ai-sheet-grab');
  const box = (await grab.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 180, { steps: 8 });   // arrastrar hacia abajo
  await page.mouse.up();
  await page.waitForTimeout(400);

  const after = await sheetH(page);
  expect(after).toBeLessThan(before);
  // Encajado: la altura final es uno de los dos anclajes (52% / 92% de la ventana), no
  // el punto donde se soltó (que habría dejado ~77%).
  const pct = after / 780 * 100;
  expect(Math.min(Math.abs(pct - 52), Math.abs(pct - 92))).toBeLessThan(3);
});
