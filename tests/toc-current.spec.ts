import { test, expect } from '@playwright/test';
import path from 'path';

const EPUB_PATH = path.join(__dirname, 'test.epub');
// PDF con outline (el `test.pdf` de la suite no tiene índice).
const PDF_PATH = path.join(__dirname, '..', 'evals', 'fixtures', 'p3-constitucion.pdf');

// El índice tiene que decir dónde se está leyendo: al abrir la pestaña Contenido, la
// sección actual va marcada (`a.current`), y solo una.
test.describe('Índice — sección actual', () => {
  async function loadEpub(page) {
    await page.goto('/');
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: 'Subir tu primer libro' }).click(),
    ]);
    await fileChooser.setFiles(EPUB_PATH);
    // Esperar a que el libro esté MONTADO (iframe + índice pintado) en vez de apostar
    // 3 s. La apuesta se pierde en cuanto la máquina tiene algo más entre manos, y el
    // fallo aparece luego en la aserción, que es donde peor se lee.
    await page.waitForSelector('#epub-container iframe', { timeout: 30000 });
    await page.waitForFunction(() => !!document.querySelector('#toc-list a'), null, { timeout: 30000 });
  }

  test('al abrir el sidebar hay exactamente una entrada marcada', async ({ page }) => {
    await loadEpub(page);
    await page.getByRole('button', { name: 'Abrir sidebar' }).click();

    const current = page.locator('#toc-list a.current');
    await expect(current).toHaveCount(1, { timeout: 5000 });
    await expect(current).toHaveAttribute('aria-current', 'location');
  });

  test('saltar a otra sección mueve la marca', async ({ page }) => {
    await loadEpub(page);
    await page.getByRole('button', { name: 'Abrir sidebar' }).click();

    const links = page.locator('#toc-list a');
    await expect(links.first()).toBeVisible({ timeout: 5000 });
    const target = links.nth(await links.count() - 1);
    // La ETIQUETA de la sección, sin el número de página: `fillTocPages` (app.js) le
    // cuelga un `<span class="toc-page">` a cada entrada en cuanto epub.js termina de
    // generar las localizaciones. Leer el textContent entero comparaba "Pedro Páramo" de
    // ANTES contra "Pedro Páramo13" de DESPUÉS, y que pasara o no dependía de si el libro
    // había cargado más rápido que el test. El número no es lo que se está probando aquí.
    const soloEtiqueta = (a: any) => a.evaluate((el: HTMLElement) => {
      const c = el.cloneNode(true) as HTMLElement;
      c.querySelector('.toc-page')?.remove();
      return c.textContent?.trim();
    });
    const label = await soloEtiqueta(target);

    await target.click();
    // Volver a Contenido re-marca (por si la lectura avanzó con el sidebar abierto).
    await page.locator('.tab-btn[data-tab="contents"]').click();

    // Sin espera fija: `markCurrentToc` se re-ejecuta en cada `relocated` (app.js), así
    // que la marca acaba llegando sola. La aserción reintenta hasta que llega; leer el
    // texto UNA vez tras 1,5 s era apostar a que la navegación ya había terminado.
    const current = page.locator('#toc-list a.current');
    await expect(current).toHaveCount(1);
    await expect.poll(() => soloEtiqueta(current)).toBe(label);
  });

  // Regresión: abrir un EPUB dejaba el lector de EPUB "cargado" para siempre, así que al
  // abrir DESPUÉS un PDF, markCurrentToc seguía yendo por la rama EPUB: el índice del PDF
  // se quedaba sin marcar y el pie, sin capítulo. Cada load suelta ahora al otro lector.
  test('un PDF abierto después de un EPUB también marca su sección', async ({ page }) => {
    await page.goto('/index.html');
    await page.setInputFiles('#file-input', EPUB_PATH);
    await page.waitForSelector('#epub-container iframe', { timeout: 30000 });
    await page.waitForFunction(() => !!document.querySelector('#toc-list a'), null, { timeout: 30000 });

    await page.setInputFiles('#file-input', PDF_PATH);
    await page.waitForSelector('#pdf-container canvas', { timeout: 30000 });
    await page.waitForFunction(
      () => !!document.querySelector('#toc-list a[data-toc-page]'), null, { timeout: 30000 });

    await page.getByRole('button', { name: 'Abrir sidebar' }).click();

    const current = page.locator('#toc-list a.current');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveAttribute('aria-current', 'location');
    await expect(page.locator('#progress-chapter')).not.toBeEmpty();
  });
});
