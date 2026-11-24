import { test, expect } from '@playwright/test';

// Una rama («Técnico») suele no tener libros propios: están en sus hijas. Compartirla o publicarla
// tiene que llevar los de toda la rama. Antes «Compartir estantería» decía «no tiene libros».
async function seed(page) {
  await page.setViewportSize({ width: 1300, height: 900 });
  await page.goto('/?perfil-preview=1');
  const ids = await page.evaluate(async () => {
    const S: any = await import('/js/library/store.js');
    const tec = await S.addShelf('Técnico');
    const ag = await S.addShelf('Técnico/Agentes');
    const rag = await S.addShelf('Técnico/RAG');
    const now = Date.now();
    await S.putBook({ id: 'a'.repeat(64), title: 'Agentes', format: 'epub', status: 'unread', addedAt: now, shelfIds: [ag.id] });
    await S.putBook({ id: 'b'.repeat(64), title: 'Grafos', format: 'epub', status: 'unread', addedAt: now - 1, shelfIds: [rag.id] });
    // En dos hijas a la vez: tiene que salir una sola vez.
    await S.putBook({ id: 'd'.repeat(64), title: 'Memoria', format: 'epub', status: 'unread', addedAt: now - 3, shelfIds: [ag.id, rag.id] });
    await S.putBook({ id: 'c'.repeat(64), title: 'Fuera', format: 'epub', status: 'unread', addedAt: now - 2, shelfIds: [] });
    return { tec: tec.id, ag: ag.id };
  });
  await page.reload();
  await page.waitForSelector('.lib-rail');
  return ids;
}

test('booksInBranch: la rama con sus hijas, sin repetir; una hoja, solo lo suyo', async ({ page }) => {
  const ids = await seed(page);
  const r = await page.evaluate(async (ids) => {
    const S: any = await import('/js/library/store.js');
    const Sh: any = await import('/js/library/shelves.js');
    const [books, shelves] = [await S.getAllRecords(), await S.getShelves()];
    const of = (id) => Sh.booksInBranch(books, shelves, shelves.find(s => s.id === id)).map(b => b.title).sort();
    return { tec: of(ids.tec), ag: of(ids.ag) };
  }, ids);
  expect(r.tec).toEqual(['Agentes', 'Grafos', 'Memoria']);
  expect(r.ag).toEqual(['Agentes', 'Memoria']);
});

test('compartir y publicar una rama llevan los libros de sus hijas', async ({ page }) => {
  const ids = await seed(page);
  const open = async () => {
    await page.locator('[data-row-label="Técnico"]').hover();
    await page.locator(`.lib-rail-kebab[data-shelf-menu="${ids.tec}"]`).click({ force: true });
  };
  await open();
  await page.locator('.lib-menu-item[data-act="share"]').click();
  await expect(page.locator('.dlg-card .dlg-msg')).toContainText('Se comparten 3 libros');
  await page.locator('.dlg-card .dlg-cancel').click();

  await open();
  await page.locator('.lib-menu-item[data-act="publish"]').click();
  await expect(page.locator('.pp-shelf .pub-row')).toHaveCount(3);
});
