// Redimensionado de paneles (escritorio). Dos regresiones que se colaron juntas:
//
//  1. El tirador del panel del agente (`.ai-resizer`) DESAPARECÍA. El panel no trae su
//     markup en el index: `AiPanel.init()` lo monta con `innerHTML = TEMPLATE()`, y como
//     ese init es perezoso (import dinámico) borraba el tirador que `initPanelResize()`
//     había añadido en el arranque. El del sidebar, que no se re-monta, sobrevivía — de
//     ahí que solo fallara el derecho.
//  2. El PDF no re-ajustaba. Su `refit` solo escucha el `resize` de la ventana; mover el
//     margen del lector (drag) o abrir/cerrar una barra cambia el ancho del contenedor
//     SIN ese evento, así que la página se quedaba a la escala vieja y se salía del lector.
import { test, expect } from '@playwright/test';
import path from 'path';

const PDF_PATH = path.join(__dirname, 'test-multipage.pdf');

// El test-multipage tiene páginas de 612pt: por encima del tope de ajuste (FIT_MAX 1.5)
// cuando el panel está cerrado, y por debajo cuando se abre a 380px en una ventana de
// 1024. Ese cruce es lo que hace observable el re-ajuste.
async function openPdf(page) {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto('/index.html');
  const fc = page.waitForEvent('filechooser');
  await page.click('.lib-empty .lib-upload');
  await (await fc).setFiles(PDF_PATH);
  await page.waitForSelector('#pdf-container canvas', { timeout: 15000 });
  await page.waitForTimeout(800);
}

const snap = (page) => page.evaluate(() => {
  const c = document.getElementById('pdf-container');
  const w = document.querySelector('.pdf-page') as HTMLElement;
  return { cw: c.clientWidth, pw: Math.round(w.getBoundingClientRect().width) };
});

test('el tirador del panel del agente existe (no lo borra el init perezoso)', async ({ page }) => {
  await openPdf(page);
  await page.evaluate(() => document.body.classList.add('ai-open'));
  await expect(page.locator('.ai-resizer')).toBeVisible();
  // Sin duplicados: el re-montaje del panel no debe dejar dos tiradores.
  expect(await page.locator('.ai-resizer').count()).toBe(1);
});

test('abrir el panel del agente re-ajusta el PDF', async ({ page }) => {
  await openPdf(page);
  const cerrado = await snap(page);
  await page.evaluate(() => {
    document.body.classList.add('ai-open');
    document.documentElement.style.setProperty('--ai-panel-width', '380px');
  });
  // Refit con debounce de 150 ms.
  await expect.poll(async () => (await snap(page)).pw, { timeout: 5000 }).toBeLessThan(cerrado.pw);
  const abierto = await snap(page);
  expect(abierto.cw).toBeLessThan(cerrado.cw);
});

test('arrastrar el tirador re-ajusta el PDF en vivo', async ({ page }) => {
  await openPdf(page);
  await page.evaluate(() => {
    document.body.classList.add('ai-open');
    document.documentElement.style.setProperty('--ai-panel-width', '380px');
  });
  const handle = page.locator('.ai-resizer');
  await expect(handle).toBeVisible();
  await expect.poll(async () => (await snap(page)).pw, { timeout: 5000 }).toBeLessThan(900);

  const antes = await snap(page);
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 120, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => (await snap(page)).pw, { timeout: 5000 }).toBeLessThan(antes.pw);
});
