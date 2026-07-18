import { test, expect, BrowserContext, Page } from '@playwright/test';
import { installDriveMocks, seedDriveToken, createDriveState, DriveState } from './drive-mock';

// End-to-end de sincronización entre DOS dispositivos reales: cada uno con su
// propio localStorage + IndexedDB (contextos aislados), ambos contra el MISMO
// Drive en memoria. Es el escenario que los tests de un solo contexto no cubren
// —comparten IndexedDB entre "dispositivos"— y donde vive el bug reportado:
// "subrayo en el móvil y el PC no lo ve".
//
// El id de libro es el SHA-256 del fichero: dos descargas no byte-idénticas del
// mismo título (mirrors distintos) dan hashes distintos. Para que los subrayados
// se crucen, la reconciliación por título (sync/aliases.js) debe converger, y
// para eso el manifest tiene que llevar el TÍTULO real de cada libro.

const A = 'a'.repeat(64); // hash del "PC"
const B = 'b'.repeat(64); // hash del "móvil" (otra descarga del mismo libro)

async function bootDevice(context: BrowserContext, state: DriveState): Promise<Page> {
  await installDriveMocks(context, state);
  await seedDriveToken(context);
  const page = await context.newPage();
  await page.goto('/');
  return page;
}

// Simula abrir un libro de la biblioteca: lo registra con su título e id (hash) y
// apunta los módulos al id canónico (como hace app.js con canonicalOf + migrate).
async function openBook(page: Page, id: string, title: string) {
  await page.evaluate(async ({ id, title }) => {
    const Lib = await import('/js/library/store.js');
    const Aliases = await import('/js/sync/aliases.js');
    const H = await import('/js/highlights.js');
    const Bm = await import('/js/bookmarks.js');
    await Lib.putBook({ id, title, addedAt: Date.now() });
    const canon = Aliases.canonicalOf(id);
    H.migrateBook([id], canon); H.setBook(canon);
    Bm.migrateBook([id], canon); Bm.setBook(canon);
  }, { id, title });
}

async function addHighlight(page: Page, cfi: string, text: string) {
  await page.evaluate(async ({ cfi, text }) => {
    const H = await import('/js/highlights.js');
    H.add(cfi, text, '#ffeb3b', 'c1', '');
  }, { cfi, text });
}

async function sync(page: Page) {
  await page.evaluate(async () => {
    const Engine = await import('/js/sync/engine.js');
    await Engine.syncNow();
  });
}

// Subrayados vivos del libro tal como los vería el usuario tras abrirlo.
async function highlightsOf(page: Page, id: string): Promise<string[]> {
  return page.evaluate(async ({ id }) => {
    const Aliases = await import('/js/sync/aliases.js');
    const H = await import('/js/highlights.js');
    H.setBook(Aliases.canonicalOf(id));
    return H.getAll().map((h: any) => h.text).sort();
  }, { id });
}

test.describe('Sync end-to-end · dos dispositivos, mismo Drive', () => {
  test('mismo hash: el subrayado del móvil llega al PC', async ({ browser }) => {
    const drive = createDriveState();
    const pc = await browser.newContext();
    const movil = await browser.newContext();
    try {
      const pcPage = await bootDevice(pc, drive);
      const mvPage = await bootDevice(movil, drive);

      await openBook(mvPage, A, 'Lituma en los Andes');
      await addHighlight(mvPage, 'epubcfi(/6/2!/4/2)', 'pasaje del móvil');
      await sync(mvPage);

      await openBook(pcPage, A, 'Lituma en los Andes');
      await sync(pcPage);

      expect(await highlightsOf(pcPage, A)).toEqual(['pasaje del móvil']);
    } finally {
      await pc.close(); await movil.close();
    }
  });

  test('hash distinto (mismo libro, otro mirror): converge y el PC ve el subrayado del móvil', async ({ browser }) => {
    const drive = createDriveState();
    const pc = await browser.newContext();
    const movil = await browser.newContext();
    try {
      const pcPage = await bootDevice(pc, drive);
      const mvPage = await bootDevice(movil, drive);

      // El PC ya tiene su copia (hash A) con un subrayado y la ha subido.
      await openBook(pcPage, A, 'Lituma en los Andes');
      await addHighlight(pcPage, 'epubcfi(/6/2!/4/2)', 'pasaje del PC');
      await sync(pcPage);

      // El móvil tiene OTRA descarga (hash B, título con sufijo de mirror) y
      // subraya otro pasaje.
      await openBook(mvPage, B, 'Lituma en los Andes (z-lib.org)');
      await addHighlight(mvPage, 'epubcfi(/6/8!/4/2)', 'pasaje del móvil');
      await sync(mvPage);   // pull de A + reconcilia B→A + push del canónico

      // El PC sincroniza de nuevo y, al abrir SU libro (A), debe ver ambos.
      await sync(pcPage);
      expect(await highlightsOf(pcPage, A)).toEqual(['pasaje del PC', 'pasaje del móvil'].sort());

      // Y el móvil, al abrir SU libro (B → canónico A), también ve ambos.
      expect(await highlightsOf(mvPage, B)).toEqual(['pasaje del PC', 'pasaje del móvil'].sort());
    } finally {
      await pc.close(); await movil.close();
    }
  });
});
