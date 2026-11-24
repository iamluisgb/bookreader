import { test, expect, Page } from '@playwright/test';
import fs from 'fs';

// Perfil público, paso 1: «Publicar…» en el menú de una estantería (solo con ?perfil-preview=1)
// arma la foto de lo que se enseña —título, autor, estado, progreso, portada en miniatura— y nada
// más. Descargar deja el JSON que convierte scripts/publicar-perfil.mjs; la vista previa lo deja en
// localStorage para la página pública con ?draft=1.

async function seed(page: Page, url = '/') {
  await page.setViewportSize({ width: 1300, height: 900 });
  await page.goto(url);
  await page.evaluate(async () => {
    const S: any = await import('/js/library/store.js');
    const ag = await S.addShelf('Técnico/Agentes');
    const c = document.createElement('canvas'); c.width = 300; c.height = 450;
    const x = c.getContext('2d')!; x.fillStyle = '#ffffff'; x.fillRect(0, 0, 300, 450); x.fillStyle = '#c0392b'; x.fillRect(0, 300, 300, 150);
    const cover = c.toDataURL('image/png');
    const now = Date.now();
    await S.putBook({ id: 'a'.repeat(64), title: 'AI Agents: The Definitive Guide', author: 'Nicole Koenigstein', format: 'epub', size: 2_000_000,
      status: 'unread', progress: 0, addedAt: now, cover, shelfIds: [ag.id] });
    await S.putBook({ id: 'b'.repeat(64), title: 'An Illustrated Guide to AI Agents', author: 'Maarten Grootendorst, Jay Alammar', format: 'pdf', size: 9_000_000,
      status: 'reading', progress: 71, addedAt: now - 1, lastOpenedAt: now, shelfIds: [ag.id] });
    await S.putBook({ id: 'c'.repeat(64), title: 'Otra cosa', format: 'epub', status: 'unread', addedAt: now - 2, shelfIds: [] });
  });
  await page.reload();
  await page.waitForSelector('.lib-rail');
}

async function openPanel(page: Page) {
  await page.locator('[data-row-label="Agentes"]').hover();
  await page.locator('.lib-rail-kebab[data-shelf-menu]').first().click({ force: true });
}

test('sin la bandera, el menú no ofrece publicar', async ({ page }) => {
  await seed(page);
  await openPanel(page);
  await expect(page.locator('.lib-menu-item[data-act="share"]')).toBeVisible();
  await expect(page.locator('.lib-menu-item[data-act="publish"]')).toHaveCount(0);
});

test('publicar: solo lo elegido, en su orden, con leyendo ahora, lomo y portada', async ({ page }) => {
  await seed(page, '/?perfil-preview=1');
  await openPanel(page);
  await page.locator('.lib-menu-item[data-act="publish"]').click();
  const card = page.locator('.pub-card');
  await expect(card.locator('.pub-row')).toHaveCount(2);              // solo los de la estantería
  await expect(card.locator('#pub-name')).toHaveValue('Agentes');     // la hoja, no la ruta
  // Leyendo ahora: por defecto el que está a medias.
  const illustrated = card.locator('.pub-row', { hasText: 'Illustrated' });
  await expect(illustrated.locator('input[data-k="now"]')).toBeChecked();
  // El Illustrated, primero y con lomo O'Reilly; nombre público en inglés; sin progreso.
  await illustrated.locator('button[data-k="up"]').click();
  await card.locator('.pub-row').first().locator('select[data-k="style"]').selectOption('oreilly');
  await card.locator('#pub-name').fill('Agents');
  await card.locator('#pub-progress').uncheck();

  const dl = page.waitForEvent('download');
  await card.locator('button[data-act="download"]').click();
  const file = await (await dl).path();
  const snap = JSON.parse(fs.readFileSync(file!, 'utf8'));
  expect(snap.format).toBe('bookreader-perfil');
  expect(snap.shelf).toBe('Agents');
  expect(snap.books.map((b: any) => b.title)).toEqual(['An Illustrated Guide to AI Agents', 'AI Agents: The Definitive Guide']);
  expect(snap.now).toBe('b'.repeat(12));
  const [ill, def] = snap.books;
  expect(ill.spine).toMatchObject({ style: 'oreilly', title: 'An Illustrated Guide to AI Agents', author: 'Grootendorst & Alammar' });
  expect(def.spine).toMatchObject({ style: 'plain', title: 'AI Agents', author: 'Koenigstein', ink: '#1d1d1f' });   // borde blanco → tinta negra
  expect(ill.progress).toBeNull();
  expect(ill.pagesEstimated).toBe(true);
  for (const b of snap.books) expect(b.coverData).toMatch(/^data:image\/(webp|jpeg);base64,/);
  // Nada que no sea de la foto: ni fichero, ni CFI, ni estanterías.
  expect(Object.keys(def).sort()).toEqual(['author', 'bookId', 'coverData', 'id', 'pages', 'pagesEstimated', 'progress', 'spine', 'status', 'title']);

  // Vista previa: deja la foto en localStorage y abre la página pública con ?draft=1.
  const popup = page.waitForEvent('popup');
  await card.locator('button[data-act="preview"]').click();
  const tab = await popup;
  await expect.poll(() => tab.url()).toContain('/@luis/?draft=1');
  const draft = await page.evaluate(() => JSON.parse(localStorage.getItem('bookreader_perfil_draft') || 'null'));
  expect(draft.books).toHaveLength(2);
});

test('la página pública pinta el borrador con ?draft=1, con lomo automático y sin progreso', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const cover = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="300" height="450" fill="#123456"/></svg>').toString('base64');
  const snap = { format: 'bookreader-perfil', version: 1, shelf: 'Borrador', now: 'x1', showProgress: false, books: [
    { id: 'x1', title: 'Libro uno', author: 'Ana Pérez', status: 'reading', progress: null, pages: 300, pagesEstimated: true,
      spine: { style: 'plain', bg: '#123456', ink: '#ffffff', muted: '#d9d9de', title: 'Libro uno', author: 'Pérez' }, coverData: cover },
    { id: 'x2', title: 'Libro dos', author: 'Luis', status: 'finished', progress: null, pages: 120, pagesEstimated: true,
      spine: { style: 'oreilly', bg: '#ffffff', ink: '#1d1d1f', muted: '#1d1d1f', title: 'Libro dos', author: 'Luis' }, coverData: cover },
  ] };
  await page.goto('http://localhost:8899/@luis/');
  await page.evaluate((s) => localStorage.setItem('bookreader_perfil_draft', JSON.stringify(s)), snap);
  await page.goto('http://localhost:8899/@luis/?draft=1');
  await expect(page.locator('.pf-bk')).toHaveCount(2);
  await expect(page.locator('#pf-shelf-title')).toHaveText('Borrador');
  await expect(page.locator('html')).toHaveClass(/is-draft/);
  await expect(page.locator('#pf-now')).toContainText('Libro uno');
  await expect(page.locator('#pf-now')).not.toContainText('%');
  await expect(page.locator('.pf-bk').first().locator('.pf-sp-end')).toHaveCount(1);   // sin logo de editorial
  expect(errors).toEqual([]);
});
