import { test, expect, Page } from '@playwright/test';

// P24 · Las otras puertas de entrada de un dossier, y la de salida:
//   - soltarlo sobre la biblioteca (escritorio);
//   - «Compartir → BookReader» desde otra app (Android): POST al share target, que el
//     service worker deja en la caché INBOX y la app recoge al arrancar con ?inbox=1;
//   - quitar lo importado desde el menú de la estantería a la que llegó.
test.describe.configure({ retries: 2 });

// Un dossier mínimo, empaquetado con el código de verdad: un libro sin fichero y con un
// subrayado, de «Luis», estantería «KG».
async function makeDossier(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const Bundle: any = await import('/js/share/bundle.js');
    const Container: any = await import('/js/share/container.js');
    const bundle = Bundle.build({
      shelf: { name: 'KG' }, author: 'Luis', parts: ['highlights'],
      books: [{ book: { id: 'd'.repeat(64), title: 'Paper sin fichero', format: 'pdf' }, hasFile: false,
        highlights: [{ text: 'idea', page: 1, rects: [], color: '#81c784' }], convos: [], artifacts: [], decks: [] }],
    });
    const blob = await Container.pack(bundle, new Map());
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = ''; for (const x of buf) bin += String.fromCharCode(x);
    return btoa(bin);
  });
}

const dialog = (page: Page) => page.locator('.dlg-card');

test('soltar un .bookreader sobre la biblioteca abre su revisión', async ({ page }) => {
  await page.goto('/');
  const b64 = await makeDossier(page);
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'kg.bookreader'));
    const lib = document.getElementById('library')!;
    lib.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    if (!lib.classList.contains('is-file-over')) throw new Error('sin zona de soltar');
    lib.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, b64);
  await expect(dialog(page).locator('.dlg-title')).toHaveText('Abrir «KG»');
  await expect(page.locator('#library')).not.toHaveClass(/is-file-over/);
});

test('compartido desde otra app: el service worker lo guarda y la app lo recoge al abrirse', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 15000 })
    .catch(async () => { await page.reload(); await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 15000 }); });
  const b64 = await makeDossier(page);

  // Lo que hace Android: POST multipart al share target del manifest.
  const status = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const fd = new FormData();
    fd.append('file', new File([bytes], 'kg.bookreader', { type: 'application/octet-stream' }));
    const res = await fetch('./share-target', { method: 'POST', body: fd, redirect: 'manual' });
    return res.type;
  }, b64);
  expect(status).toBe('opaqueredirect');

  await page.goto('/?inbox=1');
  await expect(dialog(page).locator('.dlg-title')).toHaveText('Abrir «KG»');
  // La marca se quita al recogerlo: recargar no lo vuelve a importar.
  expect(new URL(page.url()).searchParams.has('inbox')).toBe(false);
  expect(await page.evaluate(async () => (await (await caches.open('bookreader-inbox')).keys()).length)).toBe(0);
});

test('quitar lo de Luis desde el menú de la estantería', async ({ page }) => {
  await page.goto('/');
  const b64 = await makeDossier(page);
  await page.evaluate(async (b64) => {
    const Import: any = await import('/js/share/import.js');
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    await Import.apply(await Import.plan(new Blob([bytes])));
  }, b64);
  await page.reload();

  const row = page.locator('.lib-rail-row', { has: page.locator('.lib-rail-name', { hasText: /^KG · Luis$/ }) });
  await row.hover();
  await row.locator('.lib-rail-kebab').click();
  await page.locator('.lib-menu-item[data-act="unshare"]').click();
  await expect(dialog(page)).toContainText('Se quitan los subrayados, libretas, artefactos y mazos de Luis en este libro');
  await dialog(page).getByRole('button', { name: 'Quitar' }).click();

  await expect.poll(() => page.evaluate(async () => (await (await import('/js/share/store.js') as any).getAll()).length)).toBe(0);
  // La opción ya no aparece: no queda nada que quitar.
  await row.hover();
  await row.locator('.lib-rail-kebab').click();
  await expect(page.locator('.lib-menu')).toBeVisible();
  await expect(page.locator('.lib-menu-item[data-act="unshare"]')).toHaveCount(0);
});

// Lo que llega por WhatsApp no conserva el nombre: un dossier aparece como «.zip» o sin
// extensión, y el móvil decía «Formato no soportado». Ahora manda el contenido.
for (const name of ['tecnico-llm.zip', 'tecnico-llm.bookreader.zip', 'DOC-20261002-WA0003']) {
  test(`un dossier llamado «${name}» se reconoce por su contenido`, async ({ page }) => {
    await page.goto('/');
    const b64 = await makeDossier(page);
    const fs = await import('fs/promises');
    const file = test.info().outputPath(name);
    await fs.writeFile(file, Buffer.from(b64, 'base64'));
    await page.locator('#file-input').setInputFiles(file);
    await expect(dialog(page).locator('.dlg-title')).toHaveText('Abrir «KG»');
  });
}

test('kindOf: EPUB y PDF reales por su firma, aunque el nombre diga otra cosa', async ({ page }) => {
  await page.goto('/');
  const path = await import('path');
  const fs = await import('fs/promises');
  const epub = (await fs.readFile(path.join(__dirname, 'test.epub'))).toString('base64');
  const pdf = (await fs.readFile(path.join(__dirname, 'test.pdf'))).toString('base64');
  const kinds = await page.evaluate(async ({ epub, pdf }) => {
    const { kindOf }: any = await import('/js/file-kind.js');
    const f = (b64: string, name: string) => new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], name);
    return {
      epubZip: await kindOf(f(epub, 'libro.zip')),
      pdfNoExt: await kindOf(f(pdf, 'DOC-123')),
      junk: await kindOf(new File(['hola'], 'notas.txt')),
    };
  }, { epub, pdf });
  expect(kinds).toEqual({ epubZip: 'epub', pdfNoExt: 'pdf', junk: null });
});
