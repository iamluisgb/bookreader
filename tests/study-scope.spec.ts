import { test, expect } from '@playwright/test';
import { seedProLicense } from './pro-license';

// P12 · Selector de repaso: dueToday por ámbito (todo | libro | estantería) y
// studyScopes (ámbitos con vencidas). Se siembran mazos y estanterías en IndexedDB.
// Reintentos: el flujo siembra IDB tras la carga de la app (que también toca IDB:
// migración de esquema, sync) → sensible al timing bajo carga; pasa en aislado.
test.describe.configure({ retries: 2 });

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
  test('studyScopes: árbol estantería→libros + sueltos', async ({ page }) => {
    await page.goto('/');
    await seed(page);
    const scopes = await page.evaluate(async () => {
      const Study: any = await import('/js/ai/study.js');
      return Study.studyScopes();
    });
    // bA(2)+bB(1)+bC(1)+bD(1) = 5 vencidas en total.
    expect(scopes.total).toBe(5);
    // Estantería = categoría padre con la SUMA de sus libros y estos anidados dentro.
    const byShelf = Object.fromEntries(scopes.shelves.map((s: any) => [s.name, s]));
    expect(byShelf['Medicina'].cards).toBe(3);   // bA(2) + bB(1)
    expect(byShelf['Medicina'].books.map((b: any) => `${b.title}:${b.cards}`)).toEqual(['Anatomía:2', 'Fisiología:1']);
    expect(byShelf['Idiomas'].cards).toBe(1);
    expect(byShelf['Idiomas'].books.map((b: any) => b.title)).toEqual(['Inglés']);
    expect(scopes.shelves).toHaveLength(2);
    // "Suelto" no está en ninguna estantería → aparece como libro suelto.
    expect(scopes.looseBooks.map((b: any) => `${b.title}:${b.cards}`)).toEqual(['Suelto:1']);
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

  test('el chip "Repasar hoy" abre el árbol estantería→libros', async ({ page }) => {
    await page.goto('/');
    await seedProLicense(page);   // features Pro gateadas (MON2): el test ejercita la feature
    await seed(page);
    await page.goto('/');   // re-render de la biblioteca → pinta el chip con el total
    const chip = page.locator('.lib-study-chip');
    // paintStudyChip es async (lee IndexedDB tras el render); espera holgada anti-flake.
    await expect(chip).toContainText('Repasar hoy · 5', { timeout: 15000 });
    // ST2 · «Repasar hoy» repasa TODO directo; el árbol de ámbitos está en «Elegir».
    await page.locator('.lib-study-pick').click();
    const menu = page.locator('.lib-study-menu');
    await expect(menu).toBeVisible();
    // Todo(1) + 2 estanterías (padre) + 3 libros anidados + 1 suelto = 7 opciones.
    await expect(menu.locator('.lib-study-opt')).toHaveCount(7);
    await expect(menu.locator('.lib-study-opt').nth(0)).toContainText('Todo');
    await expect(menu.locator('.lib-study-opt--shelf')).toHaveCount(2);   // Medicina, Idiomas
    await expect(menu.locator('.lib-study-opt--book')).toHaveCount(4);    // Anatomía, Fisiología, Inglés, Suelto
    await expect(menu.locator('.lib-study-sec')).toHaveText('Sin estantería');
    // La estantería padre "Medicina" precede a sus libros anidados.
    await expect(menu.locator('.lib-study-opt--shelf').first()).toContainText('Medicina');
    // Elegir un LIBRO anidado abre el modo Estudiar de ese ámbito (2 pendientes en Anatomía).
    await menu.getByText('Anatomía').click();
    await expect(page.getByText('pendientes')).toBeVisible({ timeout: 10000 });
  });

  // El mazo guardado bajo el id VIEJO del libro (la biblioteca migra identidades y
  // `reconcile` no remapea mazos) debe contar como EL libro: una sola fila, suma de
  // ambos mazos, sin duplicados ni huérfanos; y la sesión del libro incluye sus tarjetas.
  test('mazo con bookId aliased: cuenta como el libro canónico y entra en su sesión', async ({ page }) => {
    await page.goto('/');
    await seedProLicense(page);
    const ids = await page.evaluate(async () => {
      const DB: any = await import('/js/ai/db.js');
      const Store: any = await import('/js/library/store.js');
      const Aliases: any = await import('/js/sync/aliases.js');
      // reconcile agrupa ids canónicos (64 hex) por título y aliasa el MAYOR al MENOR:
      // el libro vive en el menor (canónico), el mazo quedó en el mayor (alias).
      const canonical = 'a'.repeat(64);
      const oldId = 'b'.repeat(64);
      const dueCard = { uid: crypto.randomUUID(), front: 'q', back: 'a' }; // sin srs = vencida hoy
      await Store.putBook({ id: canonical, title: 'Cervantes', format: 'pdf', shelfIds: [], addedAt: 1 });
      await DB.addDeck({ bookId: canonical, name: 'direct', cardType: 'basic', scope: '', cards: [dueCard] });
      await DB.addDeck({ bookId: oldId, name: 'aliased', cardType: 'basic', scope: '', cards: [dueCard, { ...dueCard, uid: crypto.randomUUID() }] });
      Aliases.reconcile({ [canonical]: 'Cervantes', [oldId]: 'Cervantes' });
      return { canonical, oldId };
    });
    const scopes = await page.evaluate(async () => {
      const Study: any = await import('/js/ai/study.js');
      return Study.studyScopes();
    });
    // Suma de los DOS mazos (1 + 2) bajo UNA sola fila del libro: ni duplicado ni huérfano.
    expect(scopes.total).toBe(3);
    expect(scopes.orphanDecks).toEqual([]);
    expect(scopes.looseBooks.map((b: any) => `${b.title}:${b.cards}`)).toEqual(['Cervantes:3']);
    // La sesión del libro incluye también el mazo guardado bajo el alias.
    await page.evaluate(async (ids) => {
      const Study: any = await import('/js/ai/study.js');
      await Study.openToday({ scope: { type: 'book', bookId: ids.canonical } });
    }, ids);
    await expect(page.locator('#ai-study')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.study-left')).toContainText('3 pendientes');
  });

  // Un mazo cuyo libro ya no está en la biblioteca no era alcanzable desde «Elegir»:
  // ahora tiene su propia sección y su fila abre una sesión con exactamente sus tarjetas.
  test('mazo huérfano: su propia sección en el picker y sesión con solo sus tarjetas', async ({ page }) => {
    await page.goto('/');
    await seedProLicense(page);
    await page.evaluate(async () => {
      const DB: any = await import('/js/ai/db.js');
      const dueCard = { uid: crypto.randomUUID(), front: 'q', back: 'a' };
      await DB.addDeck({ bookId: 'bOrphan', name: 'Legacy', cardType: 'basic', scope: '', cards: [dueCard, { ...dueCard, uid: crypto.randomUUID() }] });
    });
    const scopes = await page.evaluate(async () => {
      const Study: any = await import('/js/ai/study.js');
      return Study.studyScopes();
    });
    expect(scopes.orphanDecks).toEqual([{ bookId: 'bOrphan', name: 'Legacy', cards: 2 }]);
    // El total sigue siendo TODO lo vencido (igual que lo que estudia «Repasar hoy»).
    expect(scopes.total).toBe(2);
    await page.goto('/');   // re-render de la biblioteca → pinta el chip con el total
    await page.locator('.lib-study-pick').click();
    const menu = page.locator('.lib-study-menu');
    await expect(menu).toBeVisible();
    await expect(menu.locator('.lib-study-sec')).toHaveText('Mazos sin libro');
    await expect(menu.locator('.lib-study-opt')).toHaveCount(2);   // Todo + el huérfano
    await menu.getByText('Legacy').click();
    await expect(page.locator('#ai-study')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.study-left')).toContainText('2 pendientes');
  });

  test('el menú del picker no se sale del viewport angosto', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 800 });
    await page.goto('/');
    await seedProLicense(page);
    await seed(page);
    await page.goto('/');
    await page.locator('.lib-study-pick').click();
    const menu = page.locator('.lib-study-menu');
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    const vp = page.viewportSize();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vp!.width);
    expect(box.y + box.height).toBeLessThanOrEqual(vp!.height);
  });

  // El «▸» decorativo prometía expandir/colapsar y no hacía nada: no debe estar en el
  // contenido de las filas de estantería (la guía de anidación queda en el CSS de hijos).
  test('las filas de estantería no llevan el marcador decorativo ▸', async ({ page }) => {
    await page.goto('/');
    await seedProLicense(page);
    await seed(page);
    await page.goto('/');
    await page.locator('.lib-study-pick').click();
    const menu = page.locator('.lib-study-menu');
    await expect(menu).toBeVisible();
    const shelf = menu.locator('.lib-study-opt--shelf').first();
    await expect(shelf).toContainText('Medicina');
    const label = await shelf.locator('.lib-study-opt-lbl').textContent();
    expect(label?.startsWith('▸')).toBeFalsy();
    expect(await menu.textContent()).not.toContain('▸');
  });
});
