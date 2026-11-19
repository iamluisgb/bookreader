import { test, expect, Page } from '@playwright/test';

// P58 F2 · Cabecera de estantería. Con UNA estantería (o grupo) elegida, en lugar de las
// tarjetas globales de «Continuar» y «Repaso de hoy»: su estado, para qué es y qué hacer.

async function seed(page: Page) {
  await page.setViewportSize({ width: 1300, height: 900 });
  await page.goto('/');
  const ids = await page.evaluate(async () => {
    const S: any = await import('/js/library/store.js');
    const DB: any = await import('/js/ai/db.js');
    const Srs: any = await import('/js/ai/srs.js');
    const ag = await S.addShelf('Técnico/Agentes');
    const otra = await S.addShelf('Novela');
    const now = Date.now(), today = Srs.dayOf(now);
    const st = ['finished', 'reading', 'unread'];
    for (let i = 0; i < 3; i++) {
      await S.putBook({ id: 'b' + i, title: ['Uno', 'Dos', 'Tres'][i], format: 'epub', status: st[i], progress: [100, 40, 0][i],
        addedAt: now - i, lastOpenedAt: now - i * 1000, shelfIds: [ag.id] });
    }
    await S.putBook({ id: 'n1', title: 'Una novela', format: 'epub', status: 'unread', addedAt: now, shelfIds: [otra.id] });
    await S.putBook({ id: 'suelto', title: 'Suelto', format: 'epub', status: 'unread', addedAt: now - 9, shelfIds: [] });
    const cards = Array.from({ length: 6 }, (_, k) => ({ front: 'q' + k, back: 'a' + k,
      srs: k < 4 ? { due: today - 1, interval: 3, stability: 3, lastReview: now - 4 * 86400000, reps: 2 }
        : { due: today + 5, interval: 10, stability: 12, lastReview: now - 2 * 86400000, reps: 3 } }));
    await DB.addDeck({ bookId: 'b1', name: 'Dos', cards });
    // Tarjetas vencidas de OTRA estantería: no deben contar en la de Agentes.
    await DB.addDeck({ bookId: 'n1', name: 'Novela', cards: cards.slice(0, 3) });
    return { ag: ag.id, otra: otra.id };
  });
  await page.reload();
  await page.waitForSelector('.lib-rail');
  return ids;
}

test('una estantería: estado, repaso solo de lo suyo, seguir leyendo y sin las tarjetas globales', async ({ page }) => {
  await seed(page);
  await page.locator('[data-row-label="Agentes"]').click();
  const hero = page.locator('.lib-shelf-hero');
  await expect(hero).toBeVisible();
  await expect(page.locator('.lib-top')).toHaveCount(0);
  await expect(page.locator('.lib-head .lib-head-shelf')).toBeVisible();
  const stats = hero.locator('.lib-shelf-stats');
  await expect(stats).toContainText('1 de 3 terminados');
  await expect(stats).toContainText('1 en curso');
  await expect(stats).toContainText('4 tarjetas para hoy');      // las 3 de la novela, fuera
  await expect(stats).toContainText('estimado, 6 tarjetas');
  await expect(hero.locator('[data-act="shelf-continue"]')).toContainText('Dos');
  const review = hero.locator('[data-act="shelf-review"]');
  await expect(review).toContainText('4');
  await review.click();
  await expect(page.locator('#ai-study')).toBeVisible();
});

test('para qué es: se escribe, se guarda y viaja en el sync', async ({ page }) => {
  const { ag } = await seed(page);
  await page.locator('[data-row-label="Agentes"]').click();
  await page.locator('[data-act="shelf-goal"]').click();
  await page.locator('.dlg-card .dlg-input').fill('  Diseñar   agentes con memoria ');
  await page.locator('.dlg-card .dlg-ok').click();
  await expect(page.locator('.lib-shelf-goal')).toHaveText('Diseñar agentes con memoria');
  const entry = await page.evaluate(async (id) => {
    const L: any = await import('/js/sync/library-sync.js');
    return (await L.buildLibrary()).shelves[id];
  }, ag);
  expect(entry.goal).toBe('Diseñar agentes con memoria');
});

test('añadir libro aquí: el libro nuevo entra en la estantería; cancelar desarma', async ({ page }) => {
  const { ag } = await seed(page);
  await page.locator('[data-row-label="Agentes"]').click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('[data-act="shelf-add"]').click();
  await chooser;
  // El alta real abre el libro; aquí basta con el anuncio que hace app.js de un libro nuevo.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('bookreader:book-imported', { detail: { bookId: 'suelto' } })));
  await expect.poll(() => page.evaluate(async () => {
    const S: any = await import('/js/library/store.js');
    return (await S.getBook('suelto')).shelfIds;
  })).toContain(ag);
  // Desarmado tras el primero: otro alta posterior no se cuela en la estantería.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('bookreader:book-imported', { detail: { bookId: 'n1' } })));
  await page.waitForTimeout(300);
  const n1 = await page.evaluate(async () => {
    const S: any = await import('/js/library/store.js');
    return (await S.getBook('n1')).shelfIds;
  });
  expect(n1).not.toContain(ag);
});

test('un grupo tiene cabecera sin «para qué» ni «añadir»; varias o «Sin estantería», la portada de siempre', async ({ page }) => {
  await seed(page);
  await page.locator('[data-row-label="Técnico"]').click();
  const hero = page.locator('.lib-shelf-hero');
  await expect(hero).toBeVisible();
  await expect(hero.locator('[data-act="shelf-goal"]')).toHaveCount(0);
  await expect(hero.locator('[data-act="shelf-add"]')).toHaveCount(0);
  // Cruce de dos: sin cabecera.
  await page.locator('[data-row-label="Novela"]').click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await expect(page.locator('.lib-shelf-hero')).toHaveCount(0);
  await page.locator('.lib-rail-item[data-shelf="none"]').click();
  await expect(page.locator('.lib-shelf-hero')).toHaveCount(0);
  await expect(page.locator('.lib-top')).toHaveCount(1);
});

test('siguiente paso: título sin subtítulo y progreso; sin nada a medias, «Empieza por» el primero sin abrir', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await page.goto('/');
  await page.evaluate(async () => {
    const S: any = await import('/js/library/store.js');
    const now = Date.now();
    const a = await S.addShelf('Agentes');
    const n = await S.addShelf('Nueva');
    await S.putBook({ id: 'g', title: 'Graph Engineering — The Loop Memory Pattern', format: 'pdf', status: 'reading', progress: 40, addedAt: now, lastOpenedAt: now, shelfIds: [a.id] });
    await S.putBook({ id: 'old', title: 'El primero: con subtítulo', format: 'epub', status: 'unread', addedAt: now - 100, shelfIds: [n.id] });
    await S.putBook({ id: 'new', title: 'El segundo', format: 'epub', status: 'unread', addedAt: now - 10, shelfIds: [n.id] });
  });
  await page.reload();
  await page.waitForSelector('.lib-rail');
  await page.locator('[data-row-label="Agentes"]').click();
  const next = page.locator('.lib-shelf-next');
  await expect(next.locator('.lib-shelf-next-kicker')).toHaveText('Seguir leyendo');
  await expect(next.locator('.lib-shelf-next-title')).toHaveText('Graph Engineering');
  await expect(next.locator('.lib-shelf-next-progress')).toContainText('40 %');
  await expect(next).toHaveAttribute('aria-label', /Graph Engineering — The Loop Memory Pattern.*40% leído/);
  await page.locator('[data-row-label="Nueva"]').click();
  await expect(next.locator('.lib-shelf-next-kicker')).toHaveText('Empieza por');
  await expect(next.locator('.lib-shelf-next-title')).toHaveText('El primero');
  await expect(next.locator('.lib-shelf-next-progress')).toHaveCount(0);
});

