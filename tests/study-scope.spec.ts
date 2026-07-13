import { test, expect } from '@playwright/test';

// P12 · Selector de repaso: dueToday por ámbito (todo | libro | estantería) y
// studyScopes (ámbitos con vencidas). Se siembran mazos y estanterías en IndexedDB.

async function seed(page) {
  await page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    const Store: any = await import('/js/library/store.js');
    const dueCard = { uid: crypto.randomUUID(), front: 'q', back: 'a' }; // sin srs = nueva = vencida hoy
    // Dos libros en la estantería "Medicina", uno en "Idiomas", uno sin estantería.
    const sh1 = await Store.addShelf('Medicina');
    const sh2 = await Store.addShelf('Idiomas');
    await Store.putBook({ id: 'bA', title: 'Anatomía', format: 'pdf', shelfIds: [sh1.id], addedAt: 1 });
    await Store.putBook({ id: 'bB', title: 'Fisiología', format: 'pdf', shelfIds: [sh1.id], addedAt: 2 });
    await Store.putBook({ id: 'bC', title: 'Inglés', format: 'pdf', shelfIds: [sh2.id], addedAt: 3 });
    await Store.putBook({ id: 'bD', title: 'Suelto', format: 'pdf', shelfIds: [], addedAt: 4 });
    await DB.addDeck({ bookId: 'bA', name: 'A', cardType: 'basic', scope: '', cards: [dueCard, { ...dueCard, uid: crypto.randomUUID() }] });
    await DB.addDeck({ bookId: 'bB', name: 'B', cardType: 'basic', scope: '', cards: [dueCard] });
    await DB.addDeck({ bookId: 'bC', name: 'C', cardType: 'basic', scope: '', cards: [dueCard] });
    await DB.addDeck({ bookId: 'bD', name: 'D', cardType: 'basic', scope: '', cards: [dueCard] });
    return { sh1: sh1.id, sh2: sh2.id };
  });
}

test.describe('P12 · ámbitos de repaso', () => {
  test('studyScopes: total global + estanterías con vencidas', async ({ page }) => {
    await page.goto('/');
    await seed(page);
    const scopes = await page.evaluate(async () => {
      const Study: any = await import('/js/ai/study.js');
      return Study.studyScopes();
    });
    // bA(2)+bB(1)+bC(1)+bD(1) = 5 vencidas en total.
    expect(scopes.total).toBe(5);
    const byName = Object.fromEntries(scopes.shelves.map((s: any) => [s.name, s.cards]));
    expect(byName['Medicina']).toBe(3);   // bA(2) + bB(1)
    expect(byName['Idiomas']).toBe(1);    // bC(1)
    expect(scopes.shelves).toHaveLength(2); // "Suelto" no está en ninguna estantería
  });

  test('dueToday por estantería y por libro filtra los mazos', async ({ page }) => {
    await page.goto('/');
    await seed(page);
    const ids = await page.evaluate(async () => {
      const Store: any = await import('/js/library/store.js');
      const shelves = await Store.getShelves();
      return Object.fromEntries(shelves.map((s: any) => [s.name, s.id]));
    });
    const res = await page.evaluate(async (ids) => {
      const Study: any = await import('/js/ai/study.js');
      const all = await Study.dueToday();
      const medicina = await Study.dueToday({ type: 'shelf', shelfId: ids['Medicina'] });
      const soloA = await Study.dueToday({ type: 'book', bookId: 'bA' });
      return { all: all.cards, medicina: medicina.cards, soloA: soloA.cards, medicinaDecks: medicina.decks.length };
    }, ids);
    expect(res.all).toBe(5);
    expect(res.medicina).toBe(3);
    expect(res.medicinaDecks).toBe(2);   // mazos de bA y bB
    expect(res.soloA).toBe(2);
  });

  test('el chip "Repasar hoy" abre el selector con Todo + estanterías', async ({ page }) => {
    await page.goto('/');
    await seed(page);
    await page.goto('/');   // re-render de la biblioteca → pinta el chip con el total
    const chip = page.locator('.lib-study-chip');
    await expect(chip).toContainText('Repasar hoy · 5');
    await chip.click();
    const menu = page.locator('.lib-study-menu');
    await expect(menu).toBeVisible();
    const opts = menu.locator('.lib-study-opt');
    await expect(opts).toHaveCount(3);            // Todo + Medicina + Oposiciones
    await expect(opts.nth(0)).toContainText('Todo');
    await expect(menu).toContainText('Medicina');
    await expect(menu).toContainText('Idiomas');
    // Elegir una estantería abre el modo Estudiar de ese ámbito.
    await menu.getByText('Medicina').click();
    await expect(page.locator('#study-overlay, .study-overlay, [data-study]').first()
      .or(page.getByText('pendientes'))).toBeVisible();
  });
});
