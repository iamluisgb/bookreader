import { test, expect } from '@playwright/test';

// Menú de un libro: marcar o desmarcar estanterías no cierra el menú. Un libro está en varias
// (las estanterías son etiquetas), así que se ponen o quitan varias seguidas.
test('varias estanterías seguidas sin que se cierre el menú', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const ids = await page.evaluate(async () => {
    const S: any = await import('/js/library/store.js');
    const a = await S.addShelf('Uno'); const b = await S.addShelf('Dos'); const c = await S.addShelf('Tres');
    await S.putBook({ id: 'x'.repeat(64), title: 'Libro', format: 'epub', status: 'unread', addedAt: Date.now(), shelfIds: [c.id] });
    return { a: a.id, b: b.id, c: c.id };
  });
  await page.reload();
  await page.locator('.lib-card .lib-kebab').first().click({ force: true });
  const menu = page.locator('.lib-menu');
  await menu.locator(`[data-shelf="${ids.a}"]`).click();
  await menu.locator(`[data-shelf="${ids.b}"]`).click();
  await menu.locator(`[data-shelf="${ids.c}"]`).click();
  await expect(menu).toBeVisible();
  await expect(menu.locator(`[data-shelf="${ids.a}"]`)).toHaveAttribute('aria-pressed', 'true');
  await expect(menu.locator(`[data-shelf="${ids.c}"]`)).toHaveAttribute('aria-pressed', 'false');
  await expect(menu.locator(`[data-shelf="${ids.c}"] .lib-menu-check .icon`)).toHaveCount(0);
  const saved = await page.evaluate(async () => (await (await import('/js/library/store.js')).getBook('x'.repeat(64))).shelfIds);
  expect(saved.sort()).toEqual([ids.a, ids.b].sort());
  // Tocar fuera lo cierra; cualquier otra acción también.
  await page.mouse.click(10, 800);
  await expect(menu).toHaveCount(0);
});
