import { test, expect } from '@playwright/test';

// Identidad de libro unificada: subrayados/marcadores migran del id antiguo (nombre de
// fichero / book.key() de epub.js) al hash canónico, fusionando por uid sin duplicar.

test('migrateBook fusiona del id antiguo al hash y borra la clave vieja', async ({ page }) => {
  await page.goto('/index.html');
  const res = await page.evaluate(async () => {
    const H: any = await import('/js/highlights.js');
    const S: any = await import('/js/storage.js');
    const now = Date.now();
    S.set('highlights_Mi Libro', [
      { uid: 'a', cfi: 'x', updatedAt: now },
      { uid: 'b', cfi: 'y', updatedAt: now },
    ]);
    S.set('highlights_HASH', [{ uid: 'b', cfi: 'y-viejo', updatedAt: now - 1000 }]); // dup más antiguo
    const moved = H.migrateBook(['Mi Libro'], 'HASH');
    const target = S.get('highlights_HASH', []);
    return {
      moved,
      oldGone: S.get('highlights_Mi Libro', null) === null,
      uids: target.map((i: any) => i.uid).sort(),
      // el dup 'b' se resuelve por LWW: gana el más nuevo (cfi 'y', no 'y-viejo').
      bCfi: (target.find((i: any) => i.uid === 'b') || {}).cfi,
    };
  });
  expect(res.moved).toBe(2);
  expect(res.oldGone).toBe(true);
  expect(res.uids).toEqual(['a', 'b']);   // fusión por uid, sin duplicar
  expect(res.bCfi).toBe('y');
});

test('migrateBook es idempotente y no toca cuando no hay datos viejos', async ({ page }) => {
  await page.goto('/index.html');
  const res = await page.evaluate(async () => {
    const B: any = await import('/js/bookmarks.js');
    const S: any = await import('/js/storage.js');
    S.set('bookmarks_H2', [{ uid: 'z', cfi: 'w', updatedAt: Date.now() }]);
    const first = B.migrateBook(['inexistente'], 'H2');   // id viejo sin datos
    const second = B.migrateBook(['H2'], 'H2');            // mismo id → no-op
    return { first, second, keep: S.get('bookmarks_H2', []).length };
  });
  expect(res.first).toBe(0);
  expect(res.second).toBe(0);
  expect(res.keep).toBe(1);
});
