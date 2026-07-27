// Barra de progreso deslizable (estilo Play Books) e índice con número de página.
// Se usan los fixtures de evals porque test.epub es un stub de 3 localizaciones:
// con él, "página 1" en todas las entradas pasaría por bueno sin demostrar nada.
import { test, expect, Page } from '@playwright/test';
import path from 'path';

const EPUB = path.join(__dirname, '..', 'evals', 'fixtures', 'p1-relativity.epub');
const PDF = path.join(__dirname, '..', 'evals', 'fixtures', 'p3-constitucion.pdf');

async function openBook(page: Page, file: string) {
  await page.goto('/');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Abrir archivo' }).click(),
  ]);
  await chooser.setFiles(file);
  await page.waitForSelector('#reader-footer', { state: 'visible', timeout: 30000 });
}

// Las localizaciones de epub.js se generan de forma progresiva: hay que esperar a que
// el total deje de crecer, no a que exista. (Leer a medias da páginas de un libro que
// todavía "mide" la mitad.)
async function waitForLocations(page: Page) {
  await page.evaluate(async () => {
    const m = await import('/js/epub-reader.js');
    let last = -1, stable = 0;
    for (let i = 0; i < 200; i++) {
      let n = 0;
      try { n = m.getBook()?.locations?.length?.() || 0; } catch { /* aún no */ }
      stable = (n === last && n > 1) ? stable + 1 : 0;
      if (stable >= 6) return;
      last = n;
      await new Promise((r) => setTimeout(r, 500));
    }
  });
}

function tocEntries(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('#toc-list a')].map((a) => ({
      label: a.querySelector('.toc-label')?.textContent || '',
      page: a.querySelector('.toc-page')?.textContent || null,
    })));
}

// Arrastra desde `from` hasta `to` (fracciones de la barra) y devuelve lo que decía
// la burbuja justo antes de soltar.
async function scrub(page: Page, from: number, to: number) {
  const box = (await page.locator('#progress-container').boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * from, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to, y, { steps: 10 });
  const bubble = await page.evaluate(() => {
    const b = document.getElementById('progress-bubble')!;
    return { visible: b.classList.contains('visible'), text: b.innerText, left: b.style.left };
  });
  await page.mouse.up();
  return bubble;
}

test.describe('Barra de progreso deslizable', () => {
  test('EPUB: la burbuja previsualiza y el salto ocurre al soltar', async ({ page }) => {
    test.setTimeout(180000);
    await openBook(page, EPUB);
    await waitForLocations(page);

    const before = await page.locator('#progress-page').textContent();

    // Durante el arrastre la burbuja va diciendo dónde caeríamos...
    const box = (await page.locator('#progress-container').boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.1, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, y, { steps: 10 });

    const bubble = await page.evaluate(() => {
      const b = document.getElementById('progress-bubble')!;
      return { visible: b.classList.contains('visible'), text: b.innerText, left: b.style.left };
    });
    expect(bubble.visible).toBe(true);
    expect(bubble.text).toMatch(/Pág\.|P\./);
    expect(bubble.left).toBe('70%');

    // ...pero el lector NO se ha movido todavía: arrastrar no debe repaginar en cada píxel.
    expect(await page.locator('#progress-page').textContent()).toBe(before);

    await page.mouse.up();
    await page.waitForTimeout(2000);
    const after = await page.locator('#progress-page').textContent();
    expect(after).not.toBe(before);

    // La página a la que saltó es la que anunciaba la burbuja.
    const announced = bubble.text.match(/(\d+)/)![1];
    expect(after).toContain(announced);
  });

  test('PDF: mismo gesto, página exacta', async ({ page }) => {
    test.setTimeout(180000);
    await openBook(page, PDF);
    const before = await page.locator('#progress-page').textContent();
    const bubble = await scrub(page, 0.05, 0.6);
    expect(bubble.visible).toBe(true);
    await page.waitForTimeout(2000);
    const after = await page.locator('#progress-page').textContent();
    expect(after).not.toBe(before);
    expect(after).toContain(bubble.text.match(/(\d+)/)![1]);
  });

  test('un toque sin arrastre sigue saltando, como antes', async ({ page }) => {
    test.setTimeout(180000);
    await openBook(page, PDF);
    const before = await page.locator('#progress-page').textContent();
    const box = (await page.locator('#progress-container').boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
    await page.waitForTimeout(2000);
    expect(await page.locator('#progress-page').textContent()).not.toBe(before);
  });

  test('la burbuja desaparece al soltar', async ({ page }) => {
    test.setTimeout(180000);
    await openBook(page, PDF);
    await scrub(page, 0.2, 0.5);
    await expect(page.locator('#progress-bubble')).not.toHaveClass(/visible/);
  });
});

test.describe('Índice con número de página', () => {
  test('EPUB: cada sección muestra su página, y las anclas del mismo fichero no comparten número', async ({ page }) => {
    test.setTimeout(180000);
    await openBook(page, EPUB);
    await waitForLocations(page);
    await page.waitForFunction(() => !!document.querySelector('#toc-list .toc-page'), null, { timeout: 30000 });

    const entries = await tocEntries(page);
    expect(entries.length).toBeGreaterThan(5);
    const withPage = entries.filter((e) => e.page !== null);
    expect(withPage.length).toBeGreaterThan(entries.length / 2);

    // Este EPUB (Gutenberg) mete varios capítulos por fichero y los separa por ancla:
    // sin resolverlas, todos caerían en la misma página. Los números deben crecer.
    const nums = withPage.map((e) => Number(e.page));
    expect(nums.every((n, i) => i === 0 || n >= nums[i - 1])).toBe(true);
    expect(new Set(nums).size).toBeGreaterThan(3);
  });

  test('PDF: el índice muestra la página de cada entrada', async ({ page }) => {
    test.setTimeout(180000);
    await openBook(page, PDF);
    await page.waitForFunction(() => !!document.querySelector('#toc-list .toc-page'), null, { timeout: 30000 });
    const entries = await tocEntries(page);
    const nums = entries.filter((e) => e.page !== null).map((e) => Number(e.page));
    expect(nums.length).toBeGreaterThan(3);
    expect(nums.every((n, i) => i === 0 || n >= nums[i - 1])).toBe(true);
  });

  test('al pulsar una entrada del índice se salta a su página', async ({ page }) => {
    test.setTimeout(180000);
    await openBook(page, PDF);
    await page.waitForFunction(() => !!document.querySelector('#toc-list .toc-page'), null, { timeout: 30000 });
    // El índice vive en el sidebar: sin abrirlo, la entrada existe pero no es pulsable.
    await page.getByRole('button', { name: 'Abrir sidebar' }).click().catch(() => { /* ya abierto */ });
    const target = page.locator('#toc-list a').nth(4);
    const announced = await target.locator('.toc-page').textContent();
    await target.click();
    await page.waitForTimeout(2000);
    expect(await page.locator('#progress-page').textContent()).toContain(announced!);
  });
});
