import { test, expect } from '@playwright/test';

// Organización de la biblioteca en la UI: cruzar estanterías (filtro múltiple),
// estanterías inteligentes y jerarquía por nombre en el rail. Complementa
// tests/shelves.spec.ts, que cubre la lógica pura sin pantalla.
//
// Reintentos por el mismo motivo que study-scope: se siembra IndexedDB después
// de que la app arranque (y ella también toca IDB), así que es sensible al
// timing bajo carga.
test.describe.configure({ retries: 2 });

const DAY = 24 * 60 * 60 * 1000;

async function seed(page) {
  return page.evaluate(async ({ DAY }) => {
    const Store: any = await import('/js/library/store.js');
    const tec = await Store.addShelf('Técnico');
    const ml = await Store.addShelf('Técnico/ML');
    const pend = await Store.addShelf('Pendientes');
    const now = Date.now();
    // Cruce: "Compiladores" está en Técnico Y en Pendientes; "Redes" solo en Técnico.
    await Store.putBook({ id: 'b1', title: 'Compiladores', author: 'Aho', format: 'epub', status: 'unread', addedAt: now, shelfIds: [tec.id, pend.id] });
    await Store.putBook({ id: 'b2', title: 'Redes', author: 'Tanenbaum', format: 'epub', status: 'reading', addedAt: now, shelfIds: [tec.id] });
    await Store.putBook({ id: 'b3', title: 'Deep Learning', author: 'Goodfellow', format: 'pdf', status: 'unread', addedAt: now - 200 * DAY, shelfIds: [ml.id] });
    await Store.putBook({ id: 'b4', title: 'Rayuela', author: 'Cortázar', format: 'epub', status: 'finished', addedAt: now, shelfIds: [] });
    return { tec: tec.id, ml: ml.id, pend: pend.id };
  }, { DAY });
}

// Los clics del rail disparan un re-render ASÍNCRONO: el handler es async y
// Playwright devuelve el control antes de que termine. Leer el DOM de una vez
// devolvería la rejilla anterior, así que todas las comprobaciones de la rejilla
// van con expect.poll (reintenta hasta que cuadra o expira).
const expectGrid = (page, titles: string[]) =>
  expect.poll(async () => (await page.locator('.lib-grid .lib-title').allTextContents()).sort())
    .toEqual([...titles].sort());

test('cruzar dos estanterías con ⌘+clic: primero la unión visible, luego la intersección', async ({ page }) => {
  await page.goto('/');
  await seed(page);
  await page.reload();

  await page.locator('.lib-rail-item', { hasText: 'Pendientes' }).click();
  await expectGrid(page, ['Compiladores']);

  // ⌘+clic añade en vez de reemplazar: dos estanterías seleccionadas a la vez.
  await page.locator('.lib-rail-item .lib-rail-name', { hasText: 'Técnico' }).first().click({ modifiers: ['Meta'] });
  await expect(page.locator('.lib-chip', { hasText: 'Pendientes' })).toBeVisible();

  // Modo Y (por defecto): solo el libro que está en LAS DOS.
  await expect(page.locator('.lib-chip-mode')).toHaveText('en todas');
  await expectGrid(page, ['Compiladores']);

  // Modo O: los de cualquiera de las dos. "Técnico" arrastra a su hija "ML".
  await page.locator('.lib-chip-mode').click();
  await expect(page.locator('.lib-chip-mode')).toHaveText('en alguna');
  await expectGrid(page, ['Compiladores', 'Deep Learning', 'Redes']);

  // La ✕ de un chip quita esa estantería del cruce (la vía táctil, sin teclado).
  await page.locator('.lib-chip', { hasText: 'Pendientes' }).locator('.lib-chip-x').click();
  await expect(page.locator('.lib-chip-mode')).toHaveCount(0);
  await expectGrid(page, ['Compiladores', 'Deep Learning', 'Redes']);

  // Y "Quitar filtro" vuelve a la biblioteca entera.
  await page.locator('.lib-chip-clear').click();
  await expectGrid(page, ['Compiladores', 'Deep Learning', 'Rayuela', 'Redes']);
});

test('el rail anida por el nombre: "Técnico/ML" se pinta dentro de "Técnico" y arrastra sus libros', async ({ page }) => {
  await page.goto('/');
  await seed(page);
  await page.reload();

  const rows = page.locator('.lib-rail-shelf');
  // Tras el reload la biblioteca se pinta de forma asíncrona: hay que esperar a
  // que el rail esté completo antes de leerlo de una vez: "Técnico", su hija
  // "ML" y "Pendientes". "Sin estantería" ya no cuenta aquí: es una vista del
  // sistema y se pinta arriba, junto a "Libros", no entre las estanterías.
  await expect(rows).toHaveCount(3);
  const labels = await rows.locator('.lib-rail-name').allTextContents();
  expect(labels).toContain('Técnico');
  // La hija se pinta con su tramo final, no con la ruta completa (la ruta solo
  // sale en móvil, donde el rail es una tira plana sin indentación).
  expect(labels).toContain('ML');
  expect(labels).not.toContain('Técnico/ML');

  // La indentación la lleva la FILA (contenedor), no el botón: así el botón de
  // opciones puede vivir fuera del botón de la estantería.
  const filaHija = page.locator('.lib-rail-row', { has: page.locator('.lib-rail-name', { hasText: /^ML$/ }) });
  await expect(filaHija).toHaveCSS('padding-left', '14px');   // 1 nivel × 14
  await expect(filaHija).toHaveClass(/is-child/);

  // La rama madre se pliega y su hija desaparece del rail (sin tocar el filtro).
  const twisty = page.locator('.lib-rail-row', { has: page.locator('.lib-rail-name', { hasText: /^Técnico$/ }) })
    .locator('.lib-rail-twisty');
  await expect(twisty).toHaveAttribute('aria-expanded', 'true');
  await twisty.click();
  await expect(filaHija).toBeHidden();
  await twisty.click();
  await expect(filaHija).toBeVisible();

  // El contador del padre incluye lo que cuelga de él: 2 propios + 1 de "ML".
  const padre = page.locator('.lib-rail-item', { has: page.locator('.lib-rail-name', { hasText: /^Técnico$/ }) });
  await expect(padre.locator('.lib-rail-count')).toHaveText('3');
  await padre.click();
  await expectGrid(page, ['Compiladores', 'Deep Learning', 'Redes']);
});

test('estantería inteligente: los libros entran por la regla y valen como filtro', async ({ page }) => {
  await page.goto('/');
  await seed(page);
  await page.evaluate(async () => {
    const Store: any = await import('/js/library/store.js');
    await Store.addShelf('Sin empezar', { rule: { status: 'unread' } });
  });
  await page.reload();

  const smart = page.locator('.lib-rail-item', { hasText: 'Sin empezar' });
  await expect(smart.locator('.lib-rail-count')).toHaveText('2');
  await smart.click();
  await expectGrid(page, ['Compiladores', 'Deep Learning']);

  // Cambiar el estado de un libro cambia la pertenencia sin tocar la estantería:
  // es la diferencia con una manual.
  await page.evaluate(async () => {
    const Store: any = await import('/js/library/store.js');
    await Store.updateBook('b3', { status: 'finished' });
  });
  await page.reload();
  const tras = page.locator('.lib-rail-item', { hasText: 'Sin empezar' });
  await expect(tras.locator('.lib-rail-count')).toHaveText('1');
  await tras.click();
  await expectGrid(page, ['Compiladores']);
});

test('borrar una estantería la quita también de las reglas que la citaban', async ({ page }) => {
  await page.goto('/');
  const ids = await seed(page);
  const out = await page.evaluate(async (ids) => {
    const Store: any = await import('/js/library/store.js');
    const smart = await Store.addShelf('Derivada', { rule: { shelfIds: [ids.pend, ids.tec] } });
    await Store.deleteShelf(ids.pend);
    const after = (await Store.getShelves()).find((s: any) => s.id === smart.id);
    return after.rule.shelfIds;
  }, ids);
  // Si no se limpiara, la regla seguiría filtrando por un id que ya no existe:
  // sin miembros posibles y sin forma de verlo desde la UI.
  expect(out).toEqual([ids.tec]);
});

test('regla y orden sobreviven al ida y vuelta del sync', async ({ page }) => {
  await page.goto('/');
  const out = await page.evaluate(async () => {
    const Store: any = await import('/js/library/store.js');
    const Lib: any = await import('/js/sync/library-sync.js');
    const a = await Store.addShelf('Primera');
    const b = await Store.addShelf('Segunda', { rule: { status: 'unread', addedWithinDays: 30 } });
    await Store.moveShelf(b.id, -1);          // "Segunda" pasa a ir antes que "Primera"
    const snapshot = await Lib.buildLibrary();
    const antes = (await Store.getShelves()).map((s: any) => s.name);
    // Aplicar el propio snapshot no debe cambiar nada (merge idempotente).
    const cambios = await Lib.applyLibrary(snapshot);
    const despues = await Store.getShelves();
    return {
      antes, cambios,
      orden: despues.map((s: any) => s.name),
      regla: despues.find((s: any) => s.name === 'Segunda').rule,
      entry: snapshot.shelves[b.id],
    };
  });

  expect(out.antes).toEqual(['Segunda', 'Primera']);
  expect(out.orden).toEqual(['Segunda', 'Primera']);
  expect(out.regla).toEqual({ status: 'unread', addedWithinDays: 30 });
  expect(out.entry.rule).toEqual({ status: 'unread', addedWithinDays: 30 });
  expect(out.entry.order).toBe(0);
  // Sin cambios reales no hay escrituras: si las hubiera, cada sync provocaría
  // un push y los dispositivos se pisarían el orden entre ellos.
  expect(out.cambios).toBe(0);
});

test('arrastrar un libro al rail lo AÑADE a esa estantería (y una inteligente no acepta)', async ({ page }) => {
  await page.goto('/');
  await seed(page);
  await page.evaluate(async () => {
    const Store: any = await import('/js/library/store.js');
    await Store.addShelf('Sin empezar', { rule: { status: 'unread' } });
  });
  await page.reload();

  const ficha = page.locator('.lib-card', { has: page.locator('.lib-title', { hasText: 'Rayuela' }) });
  await expect(ficha).toHaveAttribute('draggable', 'true');

  // Una estantería MANUAL acepta el libro; una inteligente no ofrece dónde
  // soltarlo, porque su pertenencia la decide la regla, no el gesto.
  const manual = page.locator('.lib-rail-row', { has: page.locator('.lib-rail-name', { hasText: /^Pendientes$/ }) });
  await expect(manual).toHaveAttribute('data-drop-shelf', /.+/);
  const smart = page.locator('.lib-rail-row', { has: page.locator('.lib-rail-name', { hasText: /^Sin empezar$/ }) });
  await expect(smart).not.toHaveAttribute('data-drop-shelf', /.+/);

  await ficha.dragTo(manual);
  // Se AÑADE, no se mueve: "Rayuela" no estaba en ninguna y ahora está en una.
  await expect.poll(async () => page.evaluate(async () => {
    const Store: any = await import('/js/library/store.js');
    const b = await Store.getBook('b4');
    return (b.shelfIds || []).length;
  })).toBe(1);
  await page.locator('.lib-rail-item', { hasText: 'Pendientes' }).click();
  await expectGrid(page, ['Compiladores', 'Rayuela']);
});
