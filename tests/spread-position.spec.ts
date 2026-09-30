import { test, expect, Page } from '@playwright/test';
import path from 'path';

// Doble página: el inicio de una doble página cae en la costura entre columnas y epub.js,
// al volver a mostrarlo, dejaba al lector en la doble página ANTERIOR. Como el inicio de
// página es lo que se guarda como posición y lo que se usa para re-anclar al re-paginar,
// el síntoma era «el libro abre unas páginas antes» y «la ficha del subrayado me lleva y
// luego retrocede» (al cerrarse la barra lateral, que en doble página sí ocupa sitio).
// Medido en un libro real: 24 de 25 inicios retrocedían. Además, abrir sin leer no debe
// re-sellar la posición, o el LWW del sync la daría por «la más reciente».

const EPUB_PATH = path.join(__dirname, 'test.epub');

async function openSpread(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', EPUB_PATH);
  await page.waitForSelector('#epub-container iframe', { state: 'attached', timeout: 30000 });
  await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    R.setReadingMode('spread');
    await new Promise(r => setTimeout(r, 1500));
  });
}

// Avanza hasta un inicio de doble página a mitad de párrafo (offset ≠ 0), que es el caso malo.
async function midParagraphSpread(page: Page) {
  return page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    const rd = R.getRendition();
    for (let i = 0; i < 60; i++) {
      R.next();
      await new Promise(r => setTimeout(r, 300));
      const loc = rd.currentLocation();
      if (loc?.start?.cfi && !/:0\)$/.test(loc.start.cfi) && loc.start.displayed.page > 2) {
        return { cfi: loc.start.cfi, page: loc.start.displayed.page, href: loc.start.href };
      }
    }
    return null;
  });
}

const where = (page: Page) => page.evaluate(async () => {
  const R: any = await import('/js/epub-reader.js');
  const loc = R.getRendition().currentLocation();
  return { page: loc.start.displayed.page, href: loc.start.href };
});

test('re-mostrar el inicio de la doble página actual no retrocede', async ({ page }) => {
  await openSpread(page);
  const here = await midParagraphSpread(page);
  expect(here, 'no se encontró un inicio a mitad de párrafo').not.toBeNull();
  await page.evaluate(async (cfi) => { const R: any = await import('/js/epub-reader.js'); await R.goTo(cfi); }, here!.cfi);
  await page.waitForTimeout(400);
  expect(await where(page)).toEqual({ page: here!.page, href: here!.href });
});

test('saltar con la barra lateral abierta y cerrarla deja el destino a la vista', async ({ page }) => {
  await openSpread(page);
  const target = await midParagraphSpread(page);
  expect(target).not.toBeNull();
  await page.evaluate(async () => { const R: any = await import('/js/epub-reader.js'); await R.getRendition().display(1); });
  await page.evaluate(() => document.getElementById('sidebar')!.classList.add('open'));
  await page.waitForTimeout(700);
  await page.evaluate(async (cfi) => {
    const R: any = await import('/js/epub-reader.js');
    await R.goTo(cfi);
    document.getElementById('sidebar')!.classList.remove('open');
  }, target!.cfi);
  // La barra se cierra con transición y el re-paginado va con rebote: esperar a que asiente.
  await expect.poll(() => where(page), { timeout: 5000 }).toEqual({ page: target!.page, href: target!.href });
  await page.waitForTimeout(1200);
  expect(await where(page)).toEqual({ page: target!.page, href: target!.href });
});

test('abrir sin pasar página no re-sella la posición guardada', async ({ page }) => {
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', EPUB_PATH);
  await page.waitForSelector('#epub-container iframe', { state: 'attached', timeout: 30000 });
  await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    for (let i = 0; i < 4; i++) { R.next(); await new Promise(r => setTimeout(r, 300)); }
    R.flushLastPosition();
  });
  const before = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([k]) => k.includes('lastPosition'))));
  const stampKey = Object.keys(before).find(k => k.includes('lastPositionAt_'))!;
  expect(stampKey).toBeTruthy();
  // Re-emitir la MISMA posición (lo que hace abrir el libro) no cambia el sello.
  await page.waitForTimeout(50);
  await page.evaluate(async () => { const R: any = await import('/js/epub-reader.js'); R.flushLastPosition(); });
  const after = await page.evaluate((k) => localStorage.getItem(k), stampKey);
  expect(after).toBe(before[stampKey]);
});
