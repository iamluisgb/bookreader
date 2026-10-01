import { test, expect } from '@playwright/test';
import path from 'path';

// Regresión del deep-link de PDF (`#book=<id>&loc=<página>`): el salto que usan las
// tarjetas de estudio («Ver en el libro»), el índice y el router. En modo SCROLL, tras el
// salto instantáneo el handler de scroll derivaba la página centrada del lote VIEJO del
// IntersectionObserver (cercanas, aún en la posición de origen) y "corregía" el salto a
// una página vecina — en un libro grande, de vuelta a la primera página. La guardia de
// pdf-reader.js (jumpGuardUntil) ignora esos frames hasta que llega el lote nuevo.
const PDF = path.join(__dirname, 'test-multipage.pdf');

async function openPdf(page: any) {
  await page.goto('/index.html');
  const fc = page.waitForEvent('filechooser');
  await page.click('.lib-empty .lib-upload');
  await (await fc).setFiles(PDF);
  await page.waitForSelector('#pdf-container .pdf-page canvas', { timeout: 20000 });
  const bookId = await page.evaluate(async () => {
    const Store: any = await import('/js/library/store.js');
    const books = await Store.getAllBooks();
    return books[0].id;
  });
  return bookId;
}

test('hash route: paginado salta a la página 3', async ({ page }) => {
  const bookId = await openPdf(page);
  await page.evaluate((id) => { location.hash = `book=${id}&loc=3`; }, bookId);
  await page.waitForTimeout(2500);
  const at = await page.evaluate(async () => (await import('/js/pdf-reader.js')).getCurrentPage());
  console.log('PAGINADO: página =', at, '(esperada: 3)');
  expect(at).toBe(3);
});

test('hash route: scroll salta a la página 3', async ({ page }) => {
  const bookId = await openPdf(page);
  // Modo scroll real: preferencia POR LIBRO, persistida por setReadingMode (toolbar).
  await page.evaluate(async () => {
    const Pdf: any = await import('/js/pdf-reader.js');
    await Pdf.setReadingMode('scroll');
  });
  await page.reload();
  await page.waitForSelector('#pdf-container .pdf-page canvas', { timeout: 20000 });
  const scrollOn = await page.evaluate(() => document.getElementById('pdf-container')?.classList.contains('pdf-scroll'));
  console.log('scroll activo:', scrollOn);
  await page.evaluate((id) => { location.hash = `book=${id}&loc=3`; }, bookId);
  await page.waitForTimeout(3000);
  const at = await page.evaluate(async () => (await import('/js/pdf-reader.js')).getCurrentPage());
  console.log('SCROLL: página =', at, '(esperada: 3)');
  expect(at).toBe(3);
});
