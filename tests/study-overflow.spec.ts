import { test, expect } from '@playwright/test';
import { seedProLicense } from './pro-license';

// ST2 · Regresión de producción (reporte del 2026-09-28): con un mazo cuyo nombre es el
// título completo del fichero (pegote de 130+ caracteres):
//   1) el deckname (nowrap) medía 1167px y se derramaba fuera de la tarjeta de 620px,
//      porque el track implícito del grid 3D adoptaba el min-content del texto;
//   2) la tarjeta nunca giraba visualmente: rotate(calc(var(--drag) / 30)) con --drag en
//      px produce una LONGITUD donde rotate() exige un ángulo → transform inválido
//      (computed = none). El fix usa --drag sin unidad + calc(x * 1px / x * 1deg).
// Se corre también bajo WebKit vía playwright.webkit.config.ts (motor del reporte).
test('mazo con nombre larguísimo: sin desborde y con giro real', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 856 });
  await page.goto('/index.html');
  await seedProLicense(page);
  await page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    const Lib: any = await import('/js/library/store.js');
    await Lib.putBook({ id: 'bk-long', title: 'Build a Large Language Model (From Scratch)', addedAt: Date.now(), lastOpenedAt: Date.now() });
    const LONG = 'BUILD A LARGE LANGUAGE MODEL (FROM SCRATCH) (SEBASTIAN RASCHKA) (Z-LIBRARY.SK, 1LIB.SK, Z-LIB.SK) — 2 WORKING WITH TEXT DATA · ';
    await DB.addDeck({
      bookId: 'bk-long', name: LONG, cardType: 'basic', scope: 'Capítulo 2',
      cards: [{ type: 'basic', front: 'What determines the input-target pairs in the sliding window approach for training?', back: 'The window size and the stride.', chapter: '2 WORKING WITH TEXT DATA' }],
    });
  });
  await page.reload();
  await page.locator('.lib-study-chip').first().click();
  await expect(page.locator('.study-card3d')).toBeVisible();
  await page.waitForTimeout(400);

  // 1) La tarjeta cabe en el stage y el deckname no se derrama fuera de ella.
  const m = await page.evaluate(() => {
    const card = document.querySelector('.study-card3d')!.getBoundingClientRect();
    const name = (document.querySelector('.study-deckname') as HTMLElement).getBoundingClientRect();
    return { cardW: card.width, cardRight: card.right, viewport: innerWidth, nameW: name.width };
  });
  expect(m.cardW).toBeLessThanOrEqual(620 + 1);
  expect(m.cardRight).toBeLessThanOrEqual(m.viewport + 1);
  expect(m.nameW).toBeLessThanOrEqual(m.cardW + 1);

  // 2) Al tocar la tarjeta, el transform computado pasa de "none" a una matriz (giro real).
  const before = await page.evaluate(() => getComputedStyle(document.querySelector('.study-card3d')!).transform);
  await page.locator('.study-card3d').click();
  await expect.poll(async () =>
    page.evaluate(() => getComputedStyle(document.querySelector('.study-card3d')!).transform),
  ).not.toBe(before);
});
