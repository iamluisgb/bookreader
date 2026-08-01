import { test, expect } from '@playwright/test';
import path from 'path';

// test.pdf tiene UNA página: al abrirlo ya estás al 100% y no hay progreso que
// medir. Este fixture son 8 páginas con texto (generado, ~15 KB).
const PDF_PATH = path.join(__dirname, 'test-multipage.pdf');

// El progreso de lectura era EPUB-only: `saveProgress`/`updateProgressDetail` solo
// se cableaban en loadEpub, así que un PDF salía siempre al 0% en la barra bajo la
// portada de la biblioteca y sin tiempo restante en el pie.

async function openPdf(page) {
  await page.goto('/index.html');
  const fc = page.waitForEvent('filechooser');
  await page.click('.lib-empty .lib-upload');
  await (await fc).setFiles(PDF_PATH);
  await page.waitForSelector('#pdf-container canvas', { timeout: 15000 });
}

test('el pie de un PDF estima el tiempo restante', async ({ page }) => {
  await openPdf(page);
  // countPdfWords() muestrea páginas: no es instantáneo.
  await expect(page.locator('#progress-time')).not.toBeEmpty({ timeout: 15000 });
  expect(await page.locator('#progress-time').textContent()).toMatch(/~\d+\s*(min|h)/);
});

test('avanzar en un PDF persiste el progreso en la biblioteca', async ({ page }) => {
  await openPdf(page);
  await page.click('#next-btn');
  await page.waitForTimeout(1500);   // rebote de saveProgress (800 ms) + margen

  const rec = await page.evaluate(async () => {
    const Store: any = await import('/js/library/store.js');
    const books = await Store.getAllBooks();
    const meta = (books || []).find((b: any) => b.format === 'pdf');
    return meta ? { progress: meta.progress, status: meta.status, lastCfi: meta.lastCfi } : null;
  });

  expect(rec).not.toBeNull();
  expect(rec!.progress).toBeGreaterThan(0);
  expect(rec!.status).toBe('reading');
  // Un PDF no tiene CFI: si se colara el del último EPUB abierto, al reabrirlo
  // saltaría a una posición de otro libro.
  expect(rec!.lastCfi).toBeFalsy();
});
