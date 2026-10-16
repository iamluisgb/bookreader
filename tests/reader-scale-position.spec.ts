import { test, expect, Page } from '@playwright/test';
import path from 'path';

// Móvil con las barras a la vista: el lector encoge el viewport con `transform: scale`
// (updateReaderScale) para que la página quepa entre las barras. epub.js mezclaba entonces
// rectángulos encogidos (contenedor, vistas) con los del iframe (sin encoger) y se
// equivocaba de página: cada salto a un subrayado o marcador aterrizaba antes del pasaje, y
// abrir la barra lateral —que obliga a mostrar las barras— movía la lectura hacia atrás
// (se reprodujo así con el libro real; el EPUB de prueba es demasiado corto para eso).
// Medido en un Pixel 7 en horizontal con «El pez en el agua»: 0 de 4 saltos a la vista con
// las barras visibles, 4 de 4 con ellas ocultas.

test.use({ viewport: { width: 915, height: 412 }, deviceScaleFactor: 2.625, hasTouch: true, isMobile: true });

const EPUB_PATH = path.join(__dirname, 'test.epub');

async function open(page: Page) {
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', EPUB_PATH);
  await page.waitForSelector('#epub-container iframe', { state: 'attached', timeout: 30000 });
  await page.waitForTimeout(1500);
}

// Un CFI a mitad de párrafo bien adentro del libro, tomado de la propia posición.
async function midBookCfi(page: Page) {
  return page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    const rd = R.getRendition();
    for (let i = 0; i < 40; i++) {
      R.next();
      await new Promise(r => setTimeout(r, 250));
      const loc = rd.currentLocation();
      if (loc?.start?.cfi && !/:0\)$/.test(loc.start.cfi) && loc.start.displayed.page > 3) return loc.start.cfi as string;
    }
    return null;
  });
}

const inView = (page: Page, cfi: string) => page.evaluate(async (c) => {
  const R: any = await import('/js/epub-reader.js');
  const rd = R.getRendition();
  const b = rd.getRange(c).getBoundingClientRect();
  const left = b.left - rd.manager.container.scrollLeft;
  return left >= -2 && left < rd.manager.container.clientWidth;
}, cfi);

test('con las barras a la vista, saltar a un CFI lo deja a la vista', async ({ page }) => {
  await open(page);
  const cfi = await midBookCfi(page);
  expect(cfi).not.toBeNull();
  await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    await R.getRendition().display(1);
    document.body.classList.remove('immersive');
    R.updateReaderScale();
  });
  expect(await page.evaluate(() => document.getElementById('reader-viewport')!.style.transform)).toContain('scale');
  await page.evaluate(async (c) => { const R: any = await import('/js/epub-reader.js'); await R.goTo(c); }, cfi!);
  await page.waitForTimeout(1500);
  expect(await inView(page, cfi!)).toBe(true);
});
