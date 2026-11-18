import { test, expect, Page } from '@playwright/test';

// El rail de estanterías se pliega a una franja de iconos (navigation rail). Sin preferencia
// guardada, plegado en ventanas medianas (tablet en vertical) y entero en escritorio; el botón
// guarda la elección. Plegado: solo raíces, con inicial también en los grupos, y la raíz de
// una subestantería elegida marcada.

async function seed(page: Page) {
  await page.goto('/');
  const ids = await page.evaluate(async () => {
    const S: any = await import('/js/library/store.js');
    const names = ['Ahora', 'Técnico/LLM', 'Técnico/Sistemas', 'Ensayo'];
    const sh: any = {};
    for (const n of names) sh[n] = await S.addShelf(n);
    for (let i = 0; i < 8; i++) {
      await S.putBook({ id: 'b' + i, title: 'Libro ' + i, format: 'epub', status: 'unread', addedAt: Date.now() - i, shelfIds: [sh[names[i % names.length]].id] });
    }
    return { llm: sh['Técnico/LLM'].id };
  });
  await page.reload();
  await page.waitForSelector('.lib-rail', { state: 'attached' });
  return ids;
}

const railWidth = (page: Page) => page.locator('.lib-rail').evaluate((el) => el.getBoundingClientRect().width);

test('tablet en vertical: plegado por defecto, solo raíces, y el botón lo despliega y lo recuerda', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await seed(page);
  const layout = page.locator('.lib-layout');
  await expect(layout).toHaveClass(/rail-compact/);
  await expect.poll(() => railWidth(page)).toBeLessThan(80);
  // Raíces visibles con su inicial (el grupo «Técnico» incluido); hijas fuera; sin nombres.
  const tecnico = page.locator('.lib-rail-row', { has: page.locator('[data-row-label="Técnico"]') });
  await expect(tecnico).toBeVisible();
  await expect(tecnico.locator('.lib-rail-thumb--mark')).toHaveText('T');
  await expect(page.locator('.lib-rail-row.is-child').first()).toBeHidden();
  await expect(page.locator('.lib-rail-name').first()).toBeHidden();
  await expect(page.locator('.lib-rail-settings')).toBeVisible();

  const fold = page.locator('.lib-rail-fold');
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await fold.click();
  await expect(layout).not.toHaveClass(/rail-compact/);
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => railWidth(page)).toBeGreaterThan(200);
  await page.reload();
  await expect(page.locator('.lib-layout')).not.toHaveClass(/rail-compact/);
});

test('escritorio: entero por defecto; plegado, una subestantería elegida marca su raíz', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 820 });
  await seed(page);
  await expect(page.locator('.lib-layout')).not.toHaveClass(/rail-compact/);
  await page.locator('[data-row-label="LLM"]').click();
  await page.locator('.lib-rail-fold').click();
  await expect(page.locator('.lib-layout')).toHaveClass(/rail-compact/);
  await expect(page.locator('.lib-rail-row.has-active-child', { has: page.locator('[data-row-label="Técnico"]') })).toBeVisible();
  // Con ratón, el nombre sale en la etiqueta flotante.
  await page.locator('.lib-rail-item[data-row-label="Ahora"]').hover();
  await expect(page.locator('.lib-rail-tip.is-on')).toContainText('Ahora');
  await page.reload();
  await expect(page.locator('.lib-layout')).toHaveClass(/rail-compact/);
});

test('móvil: ni rail ni botón, la tira de siempre', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page);
  await expect(page.locator('.lib-rail')).toBeHidden();
  await expect(page.locator('.lib-strip')).toBeVisible();
});
