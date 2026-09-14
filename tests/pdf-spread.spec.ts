import { test, expect } from '@playwright/test';
import path from 'path';

// Doble página en PDF (revistas). El modo existía para EPUB y estaba vetado en
// PDF con el argumento de que la doble página es cosa de contenido reflowable:
// cierto para un libro, falso para una revista, que está maquetada para verse
// abierta y trae dobles páginas de foto que de una en una salen partidas.
//
// El emparejado es el de la revista física: portada sola, y a partir de ahí
// par-impar (2-3, 4-5…).

const PDF_PATH = path.join(__dirname, 'test-multipage.pdf');   // 8 páginas

test.use({ viewport: { width: 1400, height: 900 } });

async function abrirPdf(page) {
  await page.goto('/index.html');
  const fc = page.waitForEvent('filechooser');
  await page.click('.lib-empty .lib-upload');
  await (await fc).setFiles(PDF_PATH);
  await page.waitForSelector('#pdf-container canvas', { timeout: 30000 });
}

const modo = (page, m: string) => page.evaluate(async (m) => {
  const P: any = await import('/js/pdf-reader.js');
  await P.setReadingMode(m);
}, m);

const paso = (page, dir: 'next' | 'prev') => page.evaluate(async (dir) => {
  const P: any = await import('/js/pdf-reader.js');
  await P[dir]();
}, dir);

// Las páginas que hay pintadas, de izquierda a derecha.
const hojas = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#pdf-container .pdf-page')].map(el => +(el as HTMLElement).dataset.page!));

test('el pliego enseña dos páginas, con la portada sola', async ({ page }) => {
  await abrirPdf(page);
  expect(await hojas(page)).toEqual([1]);

  await modo(page, 'spread');
  // La portada va sola: en una revista física es la única hoja de su pliego.
  expect(await hojas(page)).toEqual([1]);
  expect(await page.locator('#progress-page').textContent()).toBe('Pág. 1 / 8');

  await paso(page, 'next');
  expect(await hojas(page)).toEqual([2, 3]);
  // El pie dice las DOS: con una sola, al pasar de pliego el número saltaba de
  // dos en dos y parecía que se perdía una página.
  expect(await page.locator('#progress-page').textContent()).toBe('Pág. 2-3 / 8');

  await paso(page, 'next');
  expect(await hojas(page)).toEqual([4, 5]);

  // Y hacia atrás se retrocede el pliego ENTERO, no la hoja de al lado.
  await paso(page, 'prev');
  expect(await hojas(page)).toEqual([2, 3]);
  await paso(page, 'prev');
  expect(await hojas(page)).toEqual([1]);
});

test('saltar a una página impar enseña su pliego, no una hoja suelta', async ({ page }) => {
  await abrirPdf(page);
  await modo(page, 'spread');

  // Un salto del índice, de la búsqueda o de una cita del agente cae en una
  // página concreta; lo que se dibuja es el pliego que la contiene.
  await page.evaluate(async () => { const P: any = await import('/js/pdf-reader.js'); await P.goTo(7); });
  expect(await hojas(page)).toEqual([6, 7]);
  // La página actual sigue siendo la pedida: los subrayados y las citas de la 7
  // apuntan a la 7, no a la hoja izquierda del pliego.
  const actual = await page.evaluate(async () => (await import('/js/pdf-reader.js')).getCurrentPage());
  expect(actual).toBe(7);
});

test('en una pantalla estrecha se dibuja una hoja, y al ensanchar vuelve el pliego', async ({ page }) => {
  await abrirPdf(page);
  await modo(page, 'spread');
  await paso(page, 'next');
  expect(await hojas(page)).toEqual([2, 3]);

  // Media hoja en un móvil en vertical no se lee. El modo NO se apaga: se dibuja
  // una sola hoja y girar el teléfono devuelve el pliego sin volver a elegirlo.
  await page.setViewportSize({ width: 420, height: 900 });
  await expect.poll(() => hojas(page), { timeout: 5000 }).toEqual([2]);
  const sigueEnPliego = await page.evaluate(async () => (await import('/js/pdf-reader.js')).getReadingMode());
  expect(sigueEnPliego).toBe('spread');

  await page.setViewportSize({ width: 1400, height: 900 });
  await expect.poll(() => hojas(page), { timeout: 5000 }).toEqual([2, 3]);
});

test('el selector de modo ofrece «Doble» con un PDF abierto', async ({ page }) => {
  await abrirPdf(page);
  await page.click('#sidebar-toggle');
  await page.click('#reading-settings');
  await expect(page.locator('.reading-mode-btn[data-mode="spread"]')).toBeVisible();

  await page.click('.reading-mode-btn[data-mode="spread"]');
  await expect.poll(() => hojas(page), { timeout: 5000 }).toEqual([1]);
  await expect(page.locator('.reading-mode-btn[data-mode="spread"]')).toHaveClass(/active/);
});
