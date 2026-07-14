import { test, expect } from '@playwright/test';
import { installDriveMocks, seedDriveToken } from './drive-mock';

// Purga de mantenimiento: quita del manifest de Drive (+ fichero + claves locales) las entradas
// de "libro" bajo ids NO canónicos (epubjs:… legacy, nombre de fichero) — restos de esquemas de
// identidad viejos. NUNCA toca los ids hash (canónicos: posible data de otro dispositivo).
test('purgeOrphans quita los ids no canónicos y conserva los hash (Drive + local)', async ({ page }) => {
  const mock = await installDriveMocks(page);
  await seedDriveToken(page);

  const HASH = 'a'.repeat(64);
  const EPUBJS = 'epubjs:0.3:urn:uuid:1234';
  const FNAME = 'Lituma en los Andes';
  const bp = (id: string) => `bookreader/books/${id}.json`;

  mock.seedFile('bookreader/manifest.json', JSON.stringify({
    schemaVersion: 1,
    books: {
      [HASH]: { file: `books/${HASH}.json`, title: 'Libro real', updatedAt: 2 },
      [EPUBJS]: { file: `books/${EPUBJS}.json`, title: null, updatedAt: 1 },
      [FNAME]: { file: `books/${FNAME}.json`, title: null, updatedAt: 1 },
    },
  }));
  mock.seedFile(bp(HASH), JSON.stringify({ local: {} }));
  mock.seedFile(bp(EPUBJS), JSON.stringify({ local: {} }));
  mock.seedFile(bp(FNAME), JSON.stringify({ local: {} }));

  await page.goto('/');

  // Claves locales: una canónica (se conserva) y dos huérfanas (se quitan).
  await page.evaluate(async ({ HASH, EPUBJS, FNAME }) => {
    const S: any = await import('/js/storage.js');
    S.set('highlights_' + HASH, [{ uid: '1' }]);
    S.set('highlights_' + EPUBJS, [{ uid: '2' }]);
    S.set('bookmarks_' + FNAME, [{ uid: '3' }]);
  }, { HASH, EPUBJS, FNAME });

  const res = await page.evaluate(async () => {
    const R: any = await import('/js/sync/recovery.js');
    return R.purgeOrphans();
  });
  expect(res.ids).toContain(EPUBJS);
  expect(res.ids).toContain(FNAME);
  expect(res.ids).not.toContain(HASH);

  // Local: canónica intacta; huérfanas fuera.
  const local = await page.evaluate(async ({ HASH, EPUBJS, FNAME }) => {
    const S: any = await import('/js/storage.js');
    return {
      hash: S.get('highlights_' + HASH, null),
      epubjs: S.get('highlights_' + EPUBJS, null),
      fname: S.get('bookmarks_' + FNAME, null),
    };
  }, { HASH, EPUBJS, FNAME });
  expect(local.hash).not.toBeNull();
  expect(local.epubjs).toBeNull();
  expect(local.fname).toBeNull();

  // Drive: manifest solo con el hash; ficheros huérfanos borrados, el canónico intacto.
  const manifest = JSON.parse(mock.store.get('bookreader/manifest.json')!.content);
  expect(Object.keys(manifest.books)).toEqual([HASH]);
  expect(mock.store.has(bp(HASH))).toBe(true);
  expect(mock.store.has(bp(EPUBJS))).toBe(false);
  expect(mock.store.has(bp(FNAME))).toBe(false);
});
