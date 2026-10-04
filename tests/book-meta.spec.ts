import { test, expect, Page } from '@playwright/test';
import path from 'path';

// Título y autor editables (library/book-meta.js). Los libros traen a menudo títulos con
// subtítulos larguísimos; lo que el usuario escribe se ve en toda la app, se puede deshacer
// y no lo pisa reabrir el fichero.
const EPUB_PATH = path.join(__dirname, 'test.epub');

async function importAndBack(page: Page) {
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', EPUB_PATH);
  await page.waitForSelector('#epub-container iframe', { timeout: 30000 });
  await page.evaluate(() => document.body.classList.remove('immersive'));
  const fileTitle = (await page.locator('#reader-title').textContent())!.trim();
  await page.locator('#library-btn').click();
  await expect(page.locator('.lib-h1')).toBeVisible();
  return fileTitle;
}

test('quitar subtítulo: utilidad', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async () => {
    const M: any = await import('/js/library/book-meta.js');
    return [
      M.withoutSubtitle('Designing Data-Intensive Applications: The Big Ideas Behind Reliable Systems'),
      M.withoutSubtitle('Sapiens — De animales a dioses'),
      M.withoutSubtitle('Pedro Páramo'),
      M.withoutSubtitle('C: a reference'),
      M.naturalAuthor('Kleppmann, Martin'),
      M.naturalAuthor('Juan Rulfo'),
      M.naturalAuthor('Gamma, Erich; Helm, Richard'),
    ];
  });
  expect(r).toEqual(['Designing Data-Intensive Applications', 'Sapiens', '', '', 'Martin Kleppmann', '', '']);
});

test('editar desde la biblioteca: se ve en la tarjeta y en el lector, y reabrir el fichero no lo pisa', async ({ page }) => {
  const fileTitle = await importAndBack(page);
  await page.locator('.lib-kebab').first().click();
  await page.locator('.lib-menu [data-act="meta"]').click();
  const dlg = page.locator('.dlg-card');
  await dlg.locator('[data-field="title"]').fill('Mi título');
  await dlg.locator('[data-field="author"]').fill('Alguien');
  await dlg.locator('.dlg-ok').click();
  await expect(page.locator('.lib-main')).toContainText('Mi título');

  // La búsqueda encuentra el libro por el título del fichero también.
  await page.locator('.lib-search').fill(fileTitle.slice(0, 6));
  await expect(page.locator('.lib-main')).toContainText('Mi título');
  await page.locator('.lib-search').fill('');

  // Reimportar el mismo fichero: el título del usuario sobrevive.
  await page.setInputFiles('#file-input', EPUB_PATH);
  await page.waitForSelector('#epub-container iframe', { timeout: 30000 });
  await expect(page.locator('#reader-title')).toHaveText('Mi título');
  await page.locator('#sidebar-toggle').click();
  await expect(page.locator('#sidebar-book-title')).toHaveText('Mi título');
  await expect(page.locator('#sidebar-book-meta')).toContainText('Alguien');
  const rec = await page.evaluate(async () => {
    const S: any = await import('/js/library/store.js');
    const [b] = await S.getAllBooks();
    return { title: b.title, origTitle: b.origTitle, author: b.author };
  });
  expect(rec).toEqual({ title: 'Mi título', origTitle: fileTitle, author: 'Alguien' });
});

test('editar desde el lector y restaurar el original', async ({ page }) => {
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', EPUB_PATH);
  await page.waitForSelector('#epub-container iframe', { timeout: 30000 });
  const fileTitle = (await page.locator('#reader-title').textContent())!.trim();
  await page.evaluate(() => document.body.classList.remove('immersive'));
  await page.locator('#sidebar-toggle').click();
  await page.locator('#sidebar-book-edit').click();
  const dlg = page.locator('.dlg-card');
  await dlg.locator('[data-field="title"]').fill('Corto');
  await dlg.locator('.dlg-ok').click();
  await expect(page.locator('#reader-title')).toHaveText('Corto');      // al momento
  await expect(page.locator('#sidebar-book-title')).toHaveText('Corto');

  await page.locator('#sidebar-book-edit').click();
  await expect(dlg.locator('.dlg-field-hint')).toContainText(fileTitle);
  await dlg.locator('.dlg-sugg', { hasText: 'Restaurar el original' }).click();
  await expect(dlg.locator('[data-field="title"]')).toHaveValue(fileTitle);
  await dlg.locator('.dlg-ok').click();
  await expect(page.locator('#reader-title')).toHaveText(fileTitle);
});
