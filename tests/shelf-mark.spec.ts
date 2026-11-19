import { test, expect, Page } from '@playwright/test';

// P58 F1 · Icono y color por estantería. Se elige en el ⋯ de la estantería, se pinta en el
// rail (también plegado) y viaja en el sync; «Inicial» + «Automático» vuelven a la marca de
// siempre, y un valor sucio que llegue por el sync no rompe el rail.

async function seed(page: Page) {
  await page.goto('/');
  const ids = await page.evaluate(async () => {
    const S: any = await import('/js/library/store.js');
    const salud = await S.addShelf('Salud y hábitos');
    const sist = await S.addShelf('Técnico/Sistemas');
    await S.putBook({ id: 'b1', title: 'Libro 1', format: 'epub', status: 'unread', addedAt: Date.now(), shelfIds: [salud.id] });
    return { salud: salud.id, sist: sist.id };
  });
  await page.reload();
  await page.waitForSelector('.lib-rail', { state: 'attached' });
  return ids;
}

const row = (page: Page, label: string) => page.locator('.lib-rail-row', { has: page.locator(`[data-row-label="${label}"]`) });

test('elegir icono y color desde el menú: se pinta, se guarda y viaja en el sync', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 820 });
  const { salud } = await seed(page);
  const r = row(page, 'Salud y hábitos');
  await expect(r.locator('.lib-rail-thumb--mark')).toHaveText('S');

  await r.hover();
  await r.locator('.lib-rail-kebab').click();
  await page.locator('.lib-menu [data-act="mark"]').click();
  const dlg = page.locator('.dlg-card');
  await expect(dlg).toBeVisible();
  await dlg.locator('input[data-choice="icon"][value="heart"]').check();
  await dlg.locator('input[data-choice="hue"][value="0"]').check();
  // La vista previa se tiñe con el tono elegido.
  await expect.poll(() => dlg.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--pick-h'))).toBe('0');
  await dlg.locator('.dlg-ok').click();

  const mark = r.locator('.lib-rail-thumb--mark');
  await expect(mark).toHaveClass(/has-icon/);
  await expect(mark.locator('svg.icon')).toHaveCount(1);
  await expect(mark).toHaveAttribute('style', /--mark-h:0/);

  const entry = await page.evaluate(async (id) => {
    const L: any = await import('/js/sync/library-sync.js');
    return (await L.buildLibrary()).shelves[id];
  }, salud);
  expect(entry).toMatchObject({ icon: 'heart', hue: 0 });

  // Plegado, la franja enseña el icono, no la letra.
  await page.locator('.lib-rail-fold').click();
  await expect(r.locator('.lib-rail-thumb--mark svg.icon')).toBeVisible();

  // Vuelta a la marca de siempre: «Inicial» + «Automático», y `null` en el sync.
  await page.locator('.lib-rail-fold').click();
  await r.hover();
  await r.locator('.lib-rail-kebab').click();
  await page.locator('.lib-menu [data-act="mark"]').click();
  await dlg.locator('input[data-choice="icon"][value=""]').check();
  await dlg.locator('input[data-choice="hue"][value=""]').check();
  await dlg.locator('.dlg-ok').click();
  await expect(r.locator('.lib-rail-thumb--mark')).toHaveText('S');
  const back = await page.evaluate(async (id) => {
    const L: any = await import('/js/sync/library-sync.js');
    return (await L.buildLibrary()).shelves[id];
  }, salud);
  expect(back).toMatchObject({ icon: null, hue: null });
});

test('un icono desconocido o un tono fuera de la lista vuelven a la inicial', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 820 });
  const { sist } = await seed(page);
  await page.evaluate(async (id) => {
    const S: any = await import('/js/library/store.js');
    const all = await S.getAllShelfRecords();
    const sh = all.find((x: any) => x.id === id);
    await S.putShelf({ ...sh, icon: '<img src=x onerror=alert(1)>', hue: 120 });
  }, sist);
  await page.reload();
  await page.locator('[data-collapse="Técnico"]').waitFor({ state: 'attached' });
  const mark = row(page, 'Sistemas').locator('.lib-rail-thumb--mark');
  await expect(mark).toHaveText('S');
  await expect(mark).not.toHaveClass(/has-icon/);
  const style = await mark.getAttribute('style');
  expect(style).not.toContain('--mark-h:120');
});
