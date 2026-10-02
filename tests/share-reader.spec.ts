import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';

// P24 F2 · Lo ajeno en el lector. Un dossier importado deja subrayados de otra persona
// en su propia base (share/store.js); al abrir ESE libro (mismo hash) se pintan con trazo
// punteado y salen en la barra lateral bajo «De <nombre>», sin tocar los tuyos.
//
// El test que justifica el carril aparte (BACKLOG · P24): en EPUB uid = cfi, así que un
// subrayado ajeno en el MISMO pasaje que uno tuyo, metido en tu lista, lo habría pisado.
// Aquí los dos conviven.

const EPUB_PATH = path.join(__dirname, 'test.epub');
const PDF_PATH = path.join(__dirname, 'test-multipage.pdf');
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

async function seedShared(page: Page, bookId: string, highlights: any[]) {
  await page.evaluate(async ({ bookId, highlights }) => {
    const Shared: any = await import('/js/share/store.js');
    await Shared.replaceDossier('luis|knowledge graphs', [{
      bookId, title: 'x', from: 'Luis', shelfName: 'Knowledge graphs', importedAt: Date.now(),
      highlights, notebooks: [], artifacts: [], decks: [], templates: [],
    }]);
  }, { bookId, highlights });
}

async function openEpub(page: Page) {
  await page.setInputFiles('#file-input', EPUB_PATH);
  await page.waitForSelector('#epub-container iframe', { timeout: 30000 });
  await page.waitForFunction(() => !!document.querySelector('#toc-list a'), null, { timeout: 30000 });
}

// Mismo gesto que highlight-edit.spec.ts: avanzar hasta una página con prosa y seleccionar
// un párrafo, repitiendo hasta que la app reacciona.
async function highlightInEpub(page: Page) {
  await expect.poll(async () => page.evaluate(async () => {
    const doc = (document.querySelector('#epub-container iframe') as HTMLIFrameElement)?.contentDocument;
    if ((doc?.body?.textContent || '').trim().length > 60) return true;
    await (await import('/js/epub-reader.js') as any).next();
    return false;
  }), { timeout: 30000 }).toBe(true);
  const gesto = () => page.evaluate(() => {
    const doc = (document.querySelector('#epub-container iframe') as HTMLIFrameElement)?.contentDocument;
    const p = doc?.body && [...doc.body.querySelectorAll('*')]
      .find(el => el.children.length === 0 && (el.textContent || '').trim().length > 20);
    if (!p) return;
    const range = doc.createRange();
    range.selectNodeContents(p);
    const sel = doc.defaultView!.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    doc.dispatchEvent(new Event('selectionchange', { bubbles: true }));
    doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await gesto();
  await expect.poll(async () => {
    if (await page.locator('#highlight-tooltip').isVisible()) return true;
    await gesto();
    return false;
  }, { timeout: 20000 }).toBe(true);
  await page.locator('.highlight-color[data-color="#64b5f6"]').click();
  await expect(page.locator('#epub-container svg g.hl')).toHaveCount(1);
}

test('EPUB: el subrayado ajeno en el MISMO pasaje que uno tuyo convive con él', async ({ page }) => {
  await page.goto('/index.html');
  await openEpub(page);
  await highlightInEpub(page);
  const mine = await page.evaluate(async () => (await import('/js/highlights.js') as any).getAll());
  expect(mine).toHaveLength(1);

  // Luis subrayó exactamente ese pasaje, en otro color y con nota.
  await seedShared(page, sha(EPUB_PATH), [{ text: mine[0].text, cfi: mine[0].cfi, color: '#e57373', note: 'clave', chapter: '' }]);
  // Reabrir el libro desde la biblioteca (la ficha la guardó la primera apertura): es el
  // camino de verdad, el que dispara la carga de lo ajeno.
  await page.goto('/index.html');
  await page.locator('.lib-card').first().click();
  await page.waitForFunction(() => !!document.querySelector('#toc-list a'), null, { timeout: 30000 });
  // Volver al pasaje: el lector restaura la posición, pero se fuerza por si acaso.
  await page.evaluate(async (cfi) => (await import('/js/epub-reader.js') as any).goTo(cfi), mine[0].cfi);

  await expect(page.locator('#epub-container svg g.hl-shared')).toHaveCount(1);
  await expect(page.locator('#epub-container svg g.hl')).toHaveCount(1);       // el tuyo, sigue
  const after = await page.evaluate(async () => (await import('/js/highlights.js') as any).getAll());
  expect(after).toEqual(mine);                                                 // tu lista, intacta

  // En la barra lateral: lo tuyo arriba, lo de Luis debajo con su nota.
  const list = page.locator('#highlights-list');
  await expect(list.locator('.highlight-item:not(.highlight-item--shared)')).toHaveCount(1);
  await expect(list.locator('.highlight-shared-head')).toHaveText('De Luis');
  await expect(list.locator('.highlight-item--shared')).toHaveCount(1);
  await expect(list.locator('.highlight-item--shared')).toContainText('clave');
  await expect(list.locator('.highlight-item--shared .highlight-delete')).toHaveCount(0);   // no es tuyo
});

test('PDF: lo ajeno se pinta como trazo en su página y sale en la lista aunque no tengas subrayados', async ({ page }) => {
  await page.goto('/index.html');
  await seedShared(page, sha(PDF_PATH), [
    { text: 'una frase del paper', page: 1, rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.02 }], color: '#81c784', note: '', chapter: 'Pág. 1' },
  ]);
  await page.setInputFiles('#file-input', PDF_PATH);
  await page.waitForSelector('#pdf-container canvas', { timeout: 30000 });

  await expect(page.locator('#pdf-container .pdf-page[data-page="1"] .pdf-hl-shared .pdf-hl-under')).toHaveCount(1);
  await expect(page.locator('#pdf-container .pdf-hl-group')).toHaveCount(0);   // ninguno tuyo
  const list = page.locator('#highlights-list');
  await expect(list.locator('.empty-state')).toHaveCount(1);   // la barra está cerrada: se mira el DOM
  await expect(list.locator('.highlight-item--shared')).toContainText('una frase del paper');
});

test('un libro sin nada compartido no pinta nada ajeno', async ({ page }) => {
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', PDF_PATH);
  await page.waitForSelector('#pdf-container canvas', { timeout: 30000 });
  await expect(page.locator('#highlights-list .highlight-shared-head')).toHaveCount(0);
  await expect(page.locator('#pdf-container .pdf-hl-shared')).toHaveCount(0);
});
