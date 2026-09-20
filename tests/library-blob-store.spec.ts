import { test, expect } from '@playwright/test';
import path from 'path';

// El binario de un libro se guarda como Blob, no como ArrayBuffer.
//
// No es cosmética de tipos: IndexedDB no sabe actualizar campos sueltos, así que
// CADA escritura de la ficha —y el progreso se escribe en cada pase de página—
// reescribe el registro entero. Con ArrayBuffer eso copia el fichero dos veces
// (~4 ms por MB medidos: segundo y medio por página en una revista de 400 MB);
// con Blob, IndexedDB lo referencia y la escritura es plana.

const PDF_PATH = path.join(__dirname, 'test-multipage.pdf');

async function openPdf(page) {
  await page.goto('/index.html');
  const fc = page.waitForEvent('filechooser');
  await page.click('.lib-empty .lib-upload');
  await (await fc).setFiles(PDF_PATH);
  await page.waitForSelector('#pdf-container canvas', { timeout: 15000 });
  // El guardado en IndexedDB es asíncrono tras la carga: el canvas puede estar pintado
  // antes de que la ficha exista. Bajo carga en la suite completa, apostar por esa ventana
  // falla (getAllBooks devuelve vacío). Se sondea el store real hasta que aparece.
  await expect.poll(async () => page.evaluate(async () => {
    const Store: any = await import('/js/library/store.js');
    return ((await Store.getAllBooks()) || []).some((b: any) => b.format === 'pdf');
  }), { message: 'el PDF no llegó a guardarse', timeout: 15000 }).toBe(true);
}

const tipoDelBinario = (page) => page.evaluate(async () => {
  const Store: any = await import('/js/library/store.js');
  const metas = await Store.getAllBooks();
  const meta = (metas || []).find((b: any) => b.format === 'pdf');
  if (!meta) return null;
  const raw: any = await Store.getRaw(meta.id);
  return {
    esBlob: raw.file instanceof Blob,
    esArrayBuffer: raw.file instanceof ArrayBuffer,
    bytes: raw.file.size ?? raw.file.byteLength,
    size: meta.size,
  };
});

test('un libro importado guarda su binario como Blob', async ({ page }) => {
  await openPdf(page);
  const t = await tipoDelBinario(page);
  expect(t).not.toBeNull();
  expect(t!.esBlob).toBe(true);
  expect(t!.bytes).toBe(t!.size);   // el Blob lleva el fichero entero
});

test('un libro viejo guardado como ArrayBuffer se migra a Blob al abrirlo', async ({ page }) => {
  await openPdf(page);

  // Volver atrás en el tiempo: dejar el registro como lo dejaban las versiones
  // anteriores, con el binario en un ArrayBuffer.
  const id = await page.evaluate(async () => {
    const Store: any = await import('/js/library/store.js');
    const metas = await Store.getAllBooks();
    const meta = (metas || []).find((b: any) => b.format === 'pdf');
    const raw: any = await Store.getRaw(meta.id);
    const buffer = await raw.file.arrayBuffer();
    await Store.putBook({ ...raw, file: buffer }, { stamp: false });
    return meta.id;
  });
  expect((await tipoDelBinario(page))!.esArrayBuffer).toBe(true);

  // Reabrirlo desde la biblioteca migra el binario, sin esperar a la apertura.
  await page.reload();
  await page.goto('/index.html#book=' + id);
  await page.waitForSelector('#pdf-container canvas', { timeout: 15000 });
  await expect.poll(async () => (await tipoDelBinario(page))!.esBlob, { timeout: 10000 }).toBe(true);

  const t = await tipoDelBinario(page);
  expect(t!.bytes).toBe(t!.size);   // y sin perder un byte por el camino
});
