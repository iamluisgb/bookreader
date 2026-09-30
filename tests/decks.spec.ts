import { test, expect } from '@playwright/test';
import { seedProLicense } from './pro-license';

// WU3 · Pantalla «Mazos» de la biblioteca: entrada desde el rail, grupos por
// libro, reparación de huérfanos («Asignar a…»), detalle del mazo (crear a
// mano, editar en el sitio, quitar, suspender). Se siembran libros y mazos en
// IndexedDB y se recarga la biblioteca, igual que study-scope.spec.ts.
// Reintentos: la siembra toca IDB tras la carga de la app (sync, migración) →
// sensible al timing bajo carga; pasa en aislado.
test.describe.configure({ retries: 2 });

// Dos libros con un mazo cada uno y un mazo huérfano cuyo libro ya no está.
async function seed(page) {
  await page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    const Store: any = await import('/js/library/store.js');
    const card = (front: string, back: string) =>
      ({ uid: crypto.randomUUID(), type: 'basic', front, back }); // sin srs = nueva = vencida hoy
    await Store.putBook({ id: 'bA', title: 'Anatomía', format: 'pdf', shelfIds: [], addedAt: 1 });
    await Store.putBook({ id: 'bB', title: 'Fisiología', format: 'pdf', shelfIds: [], addedAt: 2 });
    await DB.addDeck({ bookId: 'bA', name: 'Mazo A', cardType: 'basic', scope: '', cards: [card('q1', 'a1'), card('q2', 'a2')] });
    await DB.addDeck({ bookId: 'bB', name: 'Mazo B', cardType: 'basic', scope: '', cards: [card('q3', 'a3')] });
    await DB.addDeck({ bookId: 'bGone', name: 'Huérfano', cardType: 'basic', scope: '', cards: [card('qh', 'ah')] });
  });
}

// Un libro con DOS mazos y tarjetas vencidas HOY en cada uno (srs a mano + nuevas),
// para la acción «Estudiar todo» de la cabecera del libro.
async function seedTwoDueDecks(page: any) {
  const today = await page.evaluate(async () => (await import('/js/ai/srs.js') as any).dayOf(Date.now()));
  await page.evaluate(async (today: any) => {
    const DB: any = await import('/js/ai/db.js');
    const Store: any = await import('/js/library/store.js');
    const future = (n: number) => ({ reps: 3, lapses: 0, ease: 2.5, interval: 10, due: today + n, lastReview: Date.now() });
    const card = (front: string, back: string, srs?: any) =>
      ({ uid: crypto.randomUUID(), type: 'basic', front, back, ...(srs ? { srs } : {}) });
    await Store.putBook({ id: 'bA', title: 'Anatomía', format: 'pdf', shelfIds: [], addedAt: 1 });
    await DB.addDeck({ bookId: 'bA', name: 'Mazo A1', cardType: 'basic', scope: '', cards: [card('a1q', 'a1a'), card('a2q', 'a2a', future(0))] });
    await DB.addDeck({ bookId: 'bA', name: 'Mazo A2', cardType: 'basic', scope: '', cards: [card('b1q', 'b1a'), card('b2q', 'b2a', future(0))] });
  }, today);
}

// Un mazo con TODO a futuro: nada vencido hoy → sin «Estudiar todo» en su libro.
async function seedFutureDecks(page: any) {
  const today = await page.evaluate(async () => (await import('/js/ai/srs.js') as any).dayOf(Date.now()));
  await page.evaluate(async (today: any) => {
    const DB: any = await import('/js/ai/db.js');
    const Store: any = await import('/js/library/store.js');
    const future = (n: number) => ({ reps: 3, lapses: 0, ease: 2.5, interval: 10, due: today + n, lastReview: Date.now() });
    await Store.putBook({ id: 'bF', title: 'Historia', format: 'pdf', shelfIds: [], addedAt: 3 });
    await DB.addDeck({ bookId: 'bF', name: 'Mazo Futuro', cardType: 'basic', scope: '', cards: [
      { uid: crypto.randomUUID(), type: 'basic', front: 'f1', back: 'g1', srs: future(4) },
      { uid: crypto.randomUUID(), type: 'basic', front: 'f2', back: 'g2', srs: future(9) },
    ] });
  }, today);
}

async function openDecks(page) {
  await page.locator('[data-act="decks"]').click();
  const overlay = page.locator('#decks');
  await expect(overlay).toBeVisible();
  return overlay;
}

test.describe('Pantalla Mazos (gestor de mazos)', () => {
  test('el botón del rail abre el gestor y lista el mazo bajo su libro', async ({ page }) => {
    await page.goto('/');
    await seedProLicense(page);
    await seed(page);
    await page.goto('/');   // re-render de la biblioteca con los datos sembrados
    await expect(page.locator('[data-act="decks"]')).toBeVisible();
    await openDecks(page);
    const anatomia = page.locator('#decks .dk-book', { hasText: 'Anatomía' });
    await expect(anatomia.locator('.dk-row-name')).toHaveText(['Mazo A']);
    // Resumen: 3 mazos, 4 tarjetas, 4 vencidas (todas nuevas = vencidas hoy).
    const hero = page.locator('#decks .dk-hero');
    await expect(hero.locator('.dk-tile', { hasText: 'Mazos' }).locator('.dk-tile-v')).toHaveText('3');
    await expect(hero.locator('.dk-tile', { hasText: 'Tarjetas' }).locator('.dk-tile-v')).toHaveText('4');
    await expect(hero.locator('.dk-tile', { hasText: 'Vencidas hoy' }).locator('.dk-tile-v')).toHaveText('4');
  });

  test('los huérfanos van a «Mazos sin libro» y «Asignar a…» los reasigna', async ({ page }) => {
    await page.goto('/');
    await seedProLicense(page);
    await seed(page);
    await page.goto('/');
    await openDecks(page);
    const orphans = page.locator('#decks .dk-orphans');
    await expect(orphans).toBeVisible();
    await expect(orphans.locator('.dk-book-h')).toHaveText('Mazos sin libro');
    await expect(orphans.locator('.dk-row-name', { hasText: 'Huérfano' })).toBeVisible();

    // Asignar a…: el picker aclara cuántos mazos se mueven (todos los del libro ausente).
    await orphans.locator('[data-act="dk-assign"]').click();
    const dlg = page.locator('.dlg-card');
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('.dlg-msg')).toContainText('1 mazo');
    await dlg.locator('select.dlg-input').selectOption({ label: 'Fisiología' });
    await dlg.locator('.dlg-ok').click();

    // En IndexedDB el mazo apunta al libro elegido (remapDecks mueve por bookId).
    const bookId = await page.evaluate(async () => {
      const DB: any = await import('/js/ai/db.js');
      const decks = await DB.getAllDecks();
      return decks.find((d: any) => d.name === 'Huérfano').bookId;
    });
    expect(bookId).toBe('bB');
    // La pantalla se repinta sola: la fila salió de huérfanos y cayó en su libro.
    await expect(page.locator('#decks .dk-orphans')).toHaveCount(0);
    const fisio = page.locator('#decks .dk-book', { hasText: 'Fisiología' });
    await expect(fisio.locator('.dk-row-name', { hasText: 'Huérfano' })).toBeVisible();
  });

  test('crear tarjeta a mano: P→R se guarda; cloze sin hueco y duplicado dan error', async ({ page }) => {
    await page.goto('/');
    await seedProLicense(page);
    await seed(page);
    await page.goto('/');
    await openDecks(page);
    await page.locator('#decks .dk-row', { hasText: 'Mazo A' }).locator('[data-act="dk-open"]').click();
    await expect(page.locator('#decks .dk-head-name')).toHaveText('Mazo A');
    await expect(page.locator('#decks .fc-item')).toHaveCount(2);

    // P→R nueva: se agrega y queda en IndexedDB.
    await page.locator('#decks .dk-add-front').fill('¿Nueva pregunta?');
    await page.locator('#decks .dk-add-back').fill('Sí');
    await page.locator('#decks .dk-add-btn').click();
    await expect(page.locator('#decks .fc-item')).toHaveCount(3);
    const fronts = await page.evaluate(async () => {
      const DB: any = await import('/js/ai/db.js');
      const decks = await DB.getAllDecks();
      const deck = decks.find((d: any) => d.name === 'Mazo A');
      return deck.cards.filter((c: any) => !c.deleted).map((c: any) => [c.front, c.back]);
    });
    expect(fronts).toContainEqual(['¿Nueva pregunta?', 'Sí']);

    // Cloze sin hueco: muestra el motivo y no agrega nada.
    await page.locator('#decks .dk-add-type').selectOption('cloze');
    await page.locator('#decks .dk-add-front').fill('cloze sin hueco');
    await page.locator('#decks .dk-add-btn').click();
    await expect(page.locator('#decks .dk-error')).toContainText('hueco');
    await expect(page.locator('#decks .fc-item')).toHaveCount(3);

    // Frente duplicado: muestra el motivo y no agrega nada.
    await page.locator('#decks .dk-add-type').selectOption('basic');
    await page.locator('#decks .dk-add-front').fill('q1');
    await page.locator('#decks .dk-add-btn').click();
    await expect(page.locator('#decks .dk-error')).toContainText('Ya existe');
    await expect(page.locator('#decks .fc-item')).toHaveCount(3);
  });

  test('editar el frente en el sitio y quitar una tarjeta persisten', async ({ page }) => {
    await page.goto('/');
    await seedProLicense(page);
    await seed(page);
    await page.goto('/');
    await openDecks(page);
    await page.locator('#decks .dk-row', { hasText: 'Mazo A' }).locator('[data-act="dk-open"]').click();
    await expect(page.locator('#decks .fc-item')).toHaveCount(2);

    // Editar el frente: al salir del campo (focusout) se persiste.
    const front = page.locator('#decks .fc-item').first().locator('.fc-front');
    await front.fill('q1 editada');
    await front.blur();
    // Quitar la segunda tarjeta.
    await page.locator('#decks .fc-item').nth(1).locator('[data-act="dk-del-card"]').click();
    await expect(page.locator('#decks .fc-item')).toHaveCount(1);
    const fronts = await page.evaluate(async () => {
      const DB: any = await import('/js/ai/db.js');
      const decks = await DB.getAllDecks();
      const deck = decks.find((d: any) => d.name === 'Mazo A');
      return deck.cards.filter((c: any) => !c.deleted).map((c: any) => c.front);
    });
    expect(fronts).toEqual(['q1 editada']);
  });

  test('«Estudiar todo · N» en la cabecera del libro repasa lo vencido de todos sus mazos', async ({ page }) => {
    await page.goto('/');
    await seedProLicense(page);
    await seedTwoDueDecks(page);
    await page.goto('/');
    await openDecks(page);

    const anatomia = page.locator('#decks .dk-book', { hasText: 'Anatomía' });
    const all = anatomia.locator('[data-act="dk-study-book"]');

    // Acción con la SUMA de vencidas de los dos mazos del libro (2 + 2).
    await expect(all).toBeVisible();
    await expect(all).toContainText('Estudiar todo · 4');

    // Abre la sesión del libro (scope book) con el título del libro.
    await all.click();
    const study = page.locator('#ai-study');
    await expect(study).toBeVisible();
    await expect(study.locator('.study-title')).toHaveText('Anatomía');
    await expect(study.locator('.study-left')).toHaveText('4 pendientes');

    // La cola mezcla los DOS mazos: recorriéndola entera aparecen ambos.
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      seen.push(((await study.locator('.study-deckname').first().textContent()) || '').trim());
      await study.locator('.study-card3d').click();
      await study.locator('.study-grade[data-rate="good"]').click();
    }
    await expect(study.locator('.study-end h2')).toHaveText('¡Repaso completado!');
    expect(seen).toEqual(expect.arrayContaining(['Mazo A1', 'Mazo A2']));

    // Cerrar repinta el gestor (onClose).
    await study.locator('.ai-ob-close').click();
    await expect(study).toHaveCount(0);
    await expect(page.locator('#decks')).toBeVisible();
  });

  test('sin tarjetas vencidas hoy, la cabecera del libro NO ofrece «Estudiar todo»', async ({ page }) => {
    await page.goto('/');
    await seedProLicense(page);
    await seedFutureDecks(page);
    await page.goto('/');
    await openDecks(page);

    // El mazo se lista (con su fila), pero sin acción de libro.
    await expect(page.locator('#decks .dk-row-name', { hasText: 'Mazo Futuro' })).toBeVisible();
    await expect(page.locator('#decks [data-act="dk-study-book"]')).toHaveCount(0);
    // Y el héroe lo confirma: 0 vencidas hoy.
    const hero = page.locator('#decks .dk-hero');
    await expect(hero.locator('.dk-tile', { hasText: 'Vencidas hoy' }).locator('.dk-tile-v')).toHaveText('0');
  });

  test('suspender una tarjeta la marca y deja de contar como vencida', async ({ page }) => {
    await page.goto('/');
    await seedProLicense(page);
    await seed(page);
    await page.goto('/');
    await openDecks(page);
    // Mazo B: 1 tarjeta nueva = vencida hoy → badge.
    const rowB = page.locator('#decks .dk-row', { hasText: 'Mazo B' });
    await expect(rowB.locator('.dk-badge')).toHaveText('1 vencida');
    await rowB.locator('[data-act="dk-open"]').click();
    await page.locator('#decks .fc-item').first().locator('[data-act="dk-susp"]').click();

    // En IndexedDB quedó suspendida.
    const suspended = await page.evaluate(async () => {
      const DB: any = await import('/js/ai/db.js');
      const decks = await DB.getAllDecks();
      const deck = decks.find((d: any) => d.name === 'Mazo B');
      return deck.cards.filter((c: any) => !c.deleted).map((c: any) => !!c.suspended);
    });
    expect(suspended).toEqual([true]);

    // De vuelta a la lista: sin badge y el héroe de vencidas baja de 4 a 3.
    await page.locator('#decks [data-act="dk-back"]').click();
    await expect(rowB.locator('.dk-badge')).toHaveCount(0);
    const hero = page.locator('#decks .dk-hero');
    await expect(hero.locator('.dk-tile', { hasText: 'Vencidas hoy' }).locator('.dk-tile-v')).toHaveText('3');
  });
});
