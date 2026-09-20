import { test, expect, Page } from '@playwright/test';
import { createHash } from 'crypto';

// Exportar el ARCHIVO de un libro desde la biblioteca.
//
// El caso que lo justifica: importas un EPUB, borras el original del disco y
// meses después quieres pasárselo a alguien. El binario está en IndexedDB y la
// copia de Drive vive en el appDataFolder, que no se ve ni se comparte — sin
// esta salida, el fichero entra en BookReader y no vuelve a salir.
//
// Lo que se fija aquí: que salgan los BYTES EXACTOS (el id es su SHA-256, así
// que el que lo reciba obtiene el mismo bookId y sus anotaciones enganchan), y
// que la entrada no se ofrezca cuando el archivo no está en este dispositivo.

// Siembra un libro con contenido real: el id es el hash de esos bytes.
async function seedBook(page: Page, { local = true } = {}) {
  return page.evaluate(async ({ local }) => {
    const Store: any = await import('/js/library/store.js');
    const DB: any = await import('/js/ai/db.js');
    const bytes = new Uint8Array(2048);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) % 251;
    const id = await DB.hashBuffer(bytes.buffer.slice(0));
    await Store.putBook({
      id, title: 'Lituma en los Andes', author: 'Vargas Llosa', format: 'epub',
      fileName: 'lituma.epub', size: bytes.length, addedAt: Date.now(), progress: 0,
      status: 'unread', shelfIds: [],
      file: local ? new Blob([bytes], { type: 'application/epub+zip' }) : null,
      // Ficha fantasma: sin fichero aquí, pero con copia en Drive.
      blob: local ? null : { path: 'bookreader/files/' + id, size: bytes.length },
    });
    return id;
  }, { local });
}

const openMenu = async (page: Page) => {
  await expect(page.locator('.lib-card')).toHaveCount(1);
  await page.locator('.lib-kebab').click();
  await expect(page.locator('.lib-menu')).toBeVisible();
};

test('exportar devuelve el archivo intacto: mismos bytes, mismo hash', async ({ page }) => {
  await page.goto('/');
  const id = await seedBook(page);
  await page.reload();
  await openMenu(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('.lib-menu-item[data-act="export"]').click(),
  ]);

  // El nombre con el que se importó, no uno inventado.
  expect(download.suggestedFilename()).toBe('lituma.epub');

  // Y los bytes: su SHA-256 tiene que ser el id del libro. Es lo que hace que
  // las anotaciones de quien lo reciba caigan sobre el mismo bookId.
  const path = await download.path();
  const fs = await import('fs/promises');
  const got = await fs.readFile(path!);
  expect(got.length).toBe(2048);
  expect(createHash('sha256').update(got).digest('hex')).toBe(id);
});

// El verbo del menú no es cosmético: promete lo que va a pasar al pulsar. Donde
// hay hoja de compartir (el móvil) dice "Compartir"; donde no (este Chromium de
// escritorio), el fichero acaba en Descargas y dice "Exportar".
test('sin Web Share de ficheros el menú dice Exportar, no Compartir', async ({ page }) => {
  await page.goto('/');
  await seedBook(page);
  await page.reload();
  await openMenu(page);

  const item = page.locator('.lib-menu-item[data-act="export"]');
  await expect(item).toContainText('Exportar archivo');
  await expect(item).not.toContainText('Compartir');
  await expect(item).toContainText('2 KB');   // el tamaño, antes de soltar 400 MB por error
});

test('donde SÍ se pueden compartir ficheros, el menú lo dice y usa la hoja del sistema', async ({ page }) => {
  // Se finge un navegador móvil: canShare acepta ficheros y share registra la
  // llamada en vez de abrir nada.
  await page.addInitScript(() => {
    (navigator as any).canShare = () => true;
    (window as any).__shared = null;
    (navigator as any).share = async (data: any) => {
      (window as any).__shared = (data.files || []).map((f: File) => ({ name: f.name, size: f.size, type: f.type }));
    };
  });
  await page.goto('/');
  await seedBook(page);
  await page.reload();
  await openMenu(page);

  await expect(page.locator('.lib-menu-item[data-act="export"]')).toContainText('Compartir archivo');
  await page.locator('.lib-menu-item[data-act="export"]').click();

  // Y lo que llega a la hoja es el fichero entero, con su nombre y su tipo.
  await expect.poll(() => page.evaluate(() => (window as any).__shared)).toEqual([
    { name: 'lituma.epub', size: 2048, type: 'application/epub+zip' },
  ]);
});

test('una ficha fantasma no ofrece exportar: no hay nada que sacar de aquí', async ({ page }) => {
  await page.goto('/');
  await seedBook(page, { local: false });
  await page.reload();
  await openMenu(page);

  await expect(page.locator('.lib-menu-item[data-act="export"]')).toHaveCount(0);
  // Lo que sí se ofrece es traérselo primero.
  await expect(page.locator('.lib-menu-item[data-act="download"]')).toBeVisible();
});
