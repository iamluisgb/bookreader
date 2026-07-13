import { test, expect } from '@playwright/test';
import { installDriveMocks, seedDriveToken } from './drive-mock';

// Fase 3 · Recuperación de versiones: el usuario borra algo, se sincroniza, y
// luego lo recupera desde una versión anterior de Drive. Semántica: re-afirma
// los items vivos de la versión elegida (ganan el próximo sync) sin destruir lo
// más nuevo.

test.describe('Sync Fase 3 — recuperación de versiones', () => {
  test('listar libros y versiones desde el manifest/revisiones', async ({ page }) => {
    const mock = await installDriveMocks(page);
    await seedDriveToken(page);
    await page.goto('/');
    await page.evaluate(async () => {
      const H = await import('/js/highlights.js');
      const Engine = await import('/js/sync/engine.js');
      const DB = await import('/js/ai/db.js');
      await DB.put('books', { id: 'libro-v', title: 'Mi Libro', addedAt: Date.now() });
      H.setBook('libro-v');
      H.add('epubcfi(/6/2!/4/2)', 'v1', '#ffeb3b', 'c1');
      await Engine.syncNow();
      // Segundo cambio → nueva revisión del fichero del libro.
      H.add('epubcfi(/6/4!/4/2)', 'v2', '#ffeb3b', 'c1');
      await Engine.syncNow();
    });
    const res = await page.evaluate(async () => {
      const R = await import('/js/sync/recovery.js');
      const books = await R.listBooks();
      const versions = await R.listVersions('libro-v');
      return { books, nVersions: versions.length, first: versions[0] };
    });
    expect(res.books).toEqual([{ id: 'libro-v', title: 'Mi Libro', updatedAt: expect.any(Number) }]);
    expect(res.nVersions).toBeGreaterThanOrEqual(2); // al menos 2 escrituras del fichero
    expect(res.first.fileId).toBeTruthy();
    expect(res.first.modifiedTime).toBeTruthy();
  });

  test('preview de una versión cuenta sus items vivos', async ({ page }) => {
    const mock = await installDriveMocks(page);
    await seedDriveToken(page);
    await page.goto('/');
    await page.evaluate(async () => {
      const H = await import('/js/highlights.js');
      const DB = await import('/js/ai/db.js');
      const Engine = await import('/js/sync/engine.js');
      await DB.put('books', { id: 'libro-p', title: 'P', addedAt: Date.now() });
      H.setBook('libro-p');
      H.add('epubcfi(/6/2!/4/2)', 'uno', '#ffeb3b', 'c1');
      H.add('epubcfi(/6/4!/4/2)', 'dos', '#ffeb3b', 'c1');
      await Engine.syncNow();
    });
    const preview = await page.evaluate(async () => {
      const R = await import('/js/sync/recovery.js');
      const v = await R.listVersions('libro-p');
      return R.previewVersion(v[0].fileId, v[0].id);
    });
    expect(preview.highlights).toBe(2);
  });

  test('recuperar una versión revive un subrayado borrado tras esa fecha', async ({ page }) => {
    const mock = await installDriveMocks(page);
    await seedDriveToken(page);
    await page.goto('/');

    // Estado bueno: 2 subrayados, sincronizado (versión "buena" en Drive).
    const good = await page.evaluate(async () => {
      const H = await import('/js/highlights.js');
      const DB = await import('/js/ai/db.js');
      const Engine = await import('/js/sync/engine.js');
      await DB.put('books', { id: 'libro-r', title: 'R', addedAt: Date.now() });
      H.setBook('libro-r');
      H.add('epubcfi(/6/2!/4/2)', 'importante', '#ffeb3b', 'c1', 'no perder');
      H.add('epubcfi(/6/4!/4/2)', 'otro', '#ffeb3b', 'c1');
      await Engine.syncNow();
      const R = await import('/js/sync/recovery.js');
      const versions = await R.listVersions('libro-r');
      return { goodFileId: versions[0].fileId, goodRev: versions[0].id };
    });

    // Desastre: el usuario borra 'importante' y añade uno nuevo; se sincroniza.
    await page.evaluate(async () => {
      const H = await import('/js/highlights.js');
      const Engine = await import('/js/sync/engine.js');
      H.setBook('libro-r');
      H.remove('epubcfi(/6/2!/4/2)');           // borrado (tombstone)
      H.add('epubcfi(/6/9!/4/2)', 'nuevo posterior', '#a5d6a7', 'c2');
      await Engine.syncNow();
    });

    // Recuperar la versión buena.
    const res = await page.evaluate(async ({ goodFileId, goodRev }) => {
      const R = await import('/js/sync/recovery.js');
      const rec = await R.restoreVersion('libro-r', goodFileId, goodRev);
      const H = await import('/js/highlights.js');
      H.setBook('libro-r');
      return { rec, vivos: H.getAll().map((h: any) => h.text).sort() };
    }, good);

    // 'importante' vuelve, 'otro' sigue, y 'nuevo posterior' (creado después) se conserva.
    expect(res.vivos).toContain('importante');
    expect(res.vivos).toContain('nuevo posterior');
    expect(res.vivos).toContain('otro');
    expect(res.rec.recovered).toBeGreaterThanOrEqual(2);
  });

  test('sin nada en Drive, listBooks devuelve vacío', async ({ page }) => {
    await installDriveMocks(page);
    await seedDriveToken(page);
    await page.goto('/');
    const books = await page.evaluate(async () => {
      const R = await import('/js/sync/recovery.js');
      return R.listBooks();
    });
    expect(books).toEqual([]);
  });
});
