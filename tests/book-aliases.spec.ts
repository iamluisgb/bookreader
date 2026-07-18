import { test, expect } from '@playwright/test';

// Reconciliación de identidad entre dispositivos (sync/aliases.js): el mismo
// título bajo dos ids canónicos (hash de ficheros no byte-idénticos, p. ej. dos
// descargas de mirrors distintos) se aliasa al menor lexicográfico y los datos
// se fusionan. Es la causa de "subrayo en el móvil y el PC no lo ve": cada
// dispositivo sincronizaba "su" libro sin cruzarse (SYNC_PLAN, caso límite
// "mismo libro con distinto bookId").

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

test('computeAliases agrupa por título normalizado y elige el id menor', async ({ page }) => {
  await page.goto('/index.html');
  const res = await page.evaluate(async ({ A, B, C }) => {
    const AL: any = await import('/js/sync/aliases.js');
    return AL.computeAliases({
      [A]: 'Lituma en los andes',
      [B]: 'Lituma en los Andes (z-lib.org)',   // mismo libro, otro mirror
      [C]: 'Otro libro distinto',
      'epubjs:0.3:xyz': 'Lituma en los Andes',  // id legacy: lo trata purgeOrphans, no el alias
    });
  }, { A, B, C });
  expect(res).toEqual({ [B]: A });   // B → A (menor); C y el legacy quedan fuera
});

test('reconcile fusiona subrayados/marcadores del alias y canonicalOf redirige', async ({ page }) => {
  await page.goto('/index.html');
  const res = await page.evaluate(async ({ A, B }) => {
    const AL: any = await import('/js/sync/aliases.js');
    const S: any = await import('/js/storage.js');
    const now = Date.now();
    // El "PC" tiene datos bajo su hash (A) y el pull trajo los del "móvil" bajo el suyo (B).
    S.set('highlights_' + A, [{ uid: 'pc-1', cfi: 'x', updatedAt: now }]);
    S.set('highlights_' + B, [{ uid: 'movil-1', cfi: 'y', updatedAt: now }]);
    S.set('bookmarks_' + B, [{ uid: 'movil-m1', cfi: 'z', updatedAt: now }]);
    const moved = AL.reconcile({ [A]: 'Lituma en los Andes', [B]: 'Lituma en los Andes' });
    const again = AL.reconcile({ [A]: 'Lituma en los Andes', [B]: 'Lituma en los Andes' });
    return {
      moved,
      again,                                                    // idempotente: segunda pasada no mueve nada
      canonical: AL.canonicalOf(B),
      uids: S.get('highlights_' + A, []).map((i: any) => i.uid).sort(),
      marks: S.get('bookmarks_' + A, []).map((i: any) => i.uid),
      aliasGone: S.get('highlights_' + B, null) === null && S.get('bookmarks_' + B, null) === null,
    };
  }, { A, B });
  expect(res.moved).toBe(2);
  expect(res.again).toBe(0);
  expect(res.canonical).toBe(A);
  expect(res.uids).toEqual(['movil-1', 'pc-1']);   // unión por uid, sin duplicar
  expect(res.marks).toEqual(['movil-m1']);
  expect(res.aliasGone).toBe(true);
});

test('títulos distintos no se aliasan y normTitle ignora tildes/mirror', async ({ page }) => {
  await page.goto('/index.html');
  const res = await page.evaluate(async ({ A, B, C }) => {
    const AL: any = await import('/js/sync/aliases.js');
    return {
      distinct: AL.computeAliases({ [A]: 'Lituma en los Andes', [C]: 'Crónica del Perú' }),
      norm: AL.normTitle("  Crónica del Perú (z-library.sk, 1lib.sk) "),
    };
  }, { A, B, C });
  expect(res.distinct).toEqual({});
  expect(res.norm).toBe('cronica del peru');
});
