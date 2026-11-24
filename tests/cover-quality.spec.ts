import { test, expect } from '@playwright/test';
import path from 'path';

// Calidad de portada (24-nov-2026). La de un PDF se dibuja con el lado largo a 1200 px (antes 800:
// una página A4 salía de ~565 px de ancho, blanda en un móvil ×3). Y una portada que es la
// miniatura del sync —mide justo THUMB_WIDTH— se vuelve a sacar del fichero al abrir el libro;
// antes la comprobación era `<` y esa miniatura no se mejoraba nunca.

async function coverInfo(page) {
  return page.evaluate(async () => {
    const S: any = await import('/js/library/store.js');
    const r = (await S.getAllRecords()).find((x: any) => !x.deleted);
    const img = new Image();
    await new Promise((res) => { img.onload = res; img.onerror = res; img.src = r.cover || ''; });
    return { id: r.id, w: img.naturalWidth, h: img.naturalHeight };
  });
}

test('PDF: portada a 1200 px de lado largo, y la miniatura del sync se cambia al abrirlo', async ({ page }) => {
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', path.join(__dirname, 'test-multipage.pdf'));
  await page.waitForSelector('#pdf-container .pdf-page canvas', { timeout: 20000 });
  await expect.poll(async () => (await coverInfo(page)).w).toBeGreaterThan(0);
  const first = await coverInfo(page);
  expect(Math.max(first.w, first.h)).toBe(1200);

  // Como si la portada hubiera llegado por el sync: una miniatura de exactamente THUMB_WIDTH.
  await page.evaluate(async (id) => {
    const S: any = await import('/js/library/store.js');
    const { THUMB_WIDTH } = await import('/js/sync/library-sync.js');
    const c = document.createElement('canvas'); c.width = THUMB_WIDTH; c.height = Math.round(THUMB_WIDTH * 1.4);
    await S.updateBook(id, { cover: c.toDataURL('image/jpeg', 0.8), coverThumb: null });
  }, first.id);
  expect((await coverInfo(page)).w).toBe(600);

  // Volver a abrirlo desde la biblioteca la regenera desde el fichero.
  await page.goto('/index.html');
  await page.locator('.lib-card').first().click();
  await page.waitForSelector('#pdf-container .pdf-page canvas', { timeout: 20000 });
  await expect.poll(async () => (await coverInfo(page)).w).toBe(first.w);
});
