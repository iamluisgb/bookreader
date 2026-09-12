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

// El snap bajo existía para "preguntar por una figura sin perder de vista la figura", pero
// la hoja era un OVERLAY: el lector seguía midiendo la ventana entera y paginando contra
// ella, así que lo que caía en la mitad inferior quedaba detrás y NO había gesto que lo
// trajera. Ahora el área de lectura termina donde empieza la hoja y re-pagina dentro.
test('a media altura el lector ENCOGE en vez de quedarse debajo de la hoja', async ({ page }) => {
  await openApp(page);
  await openPanel(page);

  // A altura completa no hay split: repaginar para dejar un 8% de pantalla no sirve de nada.
  expect(await page.evaluate(() => document.body.classList.contains('ai-split'))).toBe(false);
  const alturaVentana = await page.evaluate(() =>
    document.getElementById('reader-main')!.getBoundingClientRect().height);

  await page.locator('#ai-sheet-grab').click();   // → media altura
  await page.waitForTimeout(600);                 // el reflujo anclado va con rebote de 250 ms
  expect(await page.evaluate(() => document.body.classList.contains('ai-split'))).toBe(true);

  const caja = await page.evaluate(() => {
    const main = document.getElementById('reader-main')!.getBoundingClientRect();
    const hoja = document.getElementById('ai-panel')!.getBoundingClientRect();
    const frame = document.querySelector('#epub-container iframe')!.getBoundingClientRect();
    return { readerBottom: main.bottom, readerH: main.height, sheetTop: hoja.top, frameH: frame.height };
  });

  // Lo que prueba el arreglo: el lector TERMINA donde empieza la hoja.
  expect(caja.readerBottom).toBeLessThanOrEqual(caja.sheetTop + 1);
  expect(caja.readerH).toBeLessThan(alturaVentana);
  expect(caja.readerH).toBeGreaterThan(240);       // sigue siendo un lector, no una rendija
  // Y el EPUB se re-paginó a ESE alto: si siguiera midiendo la ventana, su iframe no cabría.
  expect(caja.frameH).toBeLessThanOrEqual(caja.readerH);

  // Volver a completa lo deshace.
  await page.locator('#ai-sheet-grab').click();
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => document.body.classList.contains('ai-split'))).toBe(false);
});

// Cerrar el panel devuelve la pantalla entera al lector aunque el snap guardado sea el bajo:
// el split depende de que la hoja esté ABIERTA, no solo de su altura.
test('cerrar el agente devuelve el alto completo al lector', async ({ page }) => {
  await openApp(page);
  await openPanel(page);
  await page.locator('#ai-sheet-grab').click();
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => document.body.classList.contains('ai-split'))).toBe(true);

  await page.locator('#ai-close').click();
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => document.body.classList.contains('ai-split'))).toBe(false);
  const { readerH, winH } = await page.evaluate(() => ({
    readerH: document.getElementById('reader-main')!.getBoundingClientRect().height,
    winH: window.innerHeight,
  }));
  expect(readerH).toBeCloseTo(winH, -1);
});
