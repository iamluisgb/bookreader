import { test, expect } from '@playwright/test';
import path from 'path';

// Scroll continuo en un PDF: una página que se libera por alejarse deja una
// MINIATURA de lo que ya se había pintado, y al volver se ve esa —borrosa— en
// vez de un hueco en blanco.
//
// Por qué importa: rasterizar una página de revista cuesta ~350 ms y ese coste
// es el decodificado de sus imágenes, no el tamaño al que se pinta (medido: la
// misma página en miniatura tarda lo mismo que entera). O sea que no hay
// "versión rápida" que pintar mientras llega la buena; lo único gratis es lo que
// YA se pintó una vez.

const PDF_PATH = path.join(__dirname, 'test-multipage.pdf');

async function abrirEnScroll(page) {
  await page.goto('/index.html');
  const fc = page.waitForEvent('filechooser');
  await page.click('.lib-empty .lib-upload');
  await (await fc).setFiles(PDF_PATH);
  await page.waitForSelector('#pdf-container canvas', { timeout: 30000 });
  await page.evaluate(async () => {
    const P: any = await import('/js/pdf-reader.js');
    await P.setReadingMode('scroll');
    // Con las páginas ampliadas caben menos en el margen del observer, así que
    // alejarse libera de verdad — que es la situación que se quiere probar.
    P.setZoom(3);
  });
  await page.waitForTimeout(500);
}

const estadoDe = (page, n: number) => page.evaluate((n) => {
  const w = document.querySelector(`.pdf-page[data-page="${n}"]`) as HTMLElement;
  if (!w) return 'no-existe';
  const cv = w.querySelector('canvas:not(.pdf-detail)') as HTMLCanvasElement;
  if (cv && cv.width > 1) return 'pintada';
  const sc = w.querySelector('.pdf-scaler') as HTMLElement;
  return sc && sc.style.backgroundImage ? 'miniatura' : 'blanco';
}, n);

const irA = (page, n: number) => page.evaluate((n) => {
  const c = document.getElementById('pdf-container')!;
  const w = document.querySelector(`.pdf-page[data-page="${n}"]`) as HTMLElement;
  c.scrollTop += w.getBoundingClientRect().top - c.getBoundingClientRect().top;
}, n);

test('al volver a una página ya leída se ve su miniatura, no un hueco en blanco', async ({ page }) => {
  await abrirEnScroll(page);

  await irA(page, 1);
  await expect.poll(() => estadoDe(page, 1), { timeout: 30000 }).toBe('pintada');

  // Alejarse hasta que la 1 se libere: sin canvas, pero con su miniatura puesta.
  await irA(page, 8);
  await expect.poll(() => estadoDe(page, 8), { timeout: 30000 }).toBe('pintada');
  await expect.poll(() => estadoDe(page, 1), { timeout: 30000 }).toBe('miniatura');

  // Y al volver, lo que se ve NO es un hueco: es la miniatura, hasta que el
  // render de verdad la sustituye.
  await irA(page, 1);
  expect(await estadoDe(page, 1)).toBe('miniatura');
  await expect.poll(() => estadoDe(page, 1), { timeout: 30000 }).toBe('pintada');
});
