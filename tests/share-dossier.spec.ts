import { test, expect, Page } from '@playwright/test';

// P24 · Compartir una estantería (dossier). El caso que lo motivó: una investigación de
// varios papers y libros con subrayados, libretas y artefactos del agente que se le
// quiere pasar a otra persona. Lo que se fija aquí:
//   - el formato (bundle.js, puro): qué viaja y qué NO (tombstones, calendario de
//     repaso, el libro), y que lo que no es un dossier se rechaza en la puerta;
//   - el flujo desde el menú de la estantería: el fichero que sale lleva lo elegido de
//     TODOS los libros de la estantería, y nada de los que no están en ella.
//
// Se siembra IndexedDB después de que la app arranque: sensible al timing bajo carga.
test.describe.configure({ retries: 2 });

const A = 'a'.repeat(64);   // paper con todo
const B = 'b'.repeat(64);   // libro de la estantería sin nada
const C = 'c'.repeat(64);   // libro FUERA de la estantería, con subrayados

async function seed(page: Page) {
  return page.evaluate(async ({ A, B, C }) => {
    const Store: any = await import('/js/library/store.js');
    const DB: any = await import('/js/ai/db.js');
    const Storage: any = await import('/js/storage.js');
    const Custom: any = await import('/js/ai/custom-templates.js');
    const kg = await Store.addShelf('Knowledge graphs');
    const now = Date.now();
    await Store.putBook({ id: A, title: 'Knowledge Graphs (survey)', author: 'Hogan et al.', format: 'pdf',
      fileName: '2003.02320v6.pdf', status: 'reading', addedAt: now, shelfIds: [kg.id] });
    await Store.putBook({ id: B, title: 'Graph Databases', author: 'Robinson', format: 'epub',
      status: 'unread', addedAt: now, shelfIds: [kg.id] });
    await Store.putBook({ id: C, title: 'Rayuela', author: 'Cortázar', format: 'epub',
      status: 'reading', addedAt: now, shelfIds: [] });

    Storage.set('highlights_' + A, [
      { uid: 'u1', id: 'p1', page: 3, rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.02 }], text: 'A knowledge graph is…',
        color: '#ffeb3b', chapter: 'Pág. 3', note: 'definición clave', timestamp: now, updatedAt: now },
      { uid: 'u2', id: 'p2', page: 4, rects: [], text: 'borrado', color: '#ffeb3b', deleted: true, deletedAt: now },
    ]);
    Storage.set('highlights_' + C, [{ uid: 'x', id: 'x', cfi: 'epubcfi(/6/2)', text: 'de otra estantería', timestamp: now }]);

    const tpl = Custom.save({ name: 'Mi método KG', block: 'tecnico', fields: [{ label: 'Ontologías', type: 'text', fill: 'agent' }] });
    const cv = await DB.createConvo(A, tpl.id, 'Entender ontologías vs grafos');
    await DB.addNote(cv.id, tpl.fields[0].key, 'OWL es la capa de esquema', ['p1']);
    await DB.addNote(cv.id, tpl.fields[0].key, 'nota borrada', [], { deleted: true });
    await DB.addMessage(cv.id, 'user', '¿Qué es RDF?');
    await DB.putArtifact({ bookId: A, kind: 'summary', result: { tldr: 'Los KG unifican datos', points: [] } });
    await DB.addDeck({ bookId: A, name: 'KG básico', cards: [
      { front: '¿Qué es un triple?', back: 'sujeto-predicado-objeto', srs: { reps: 3, due: 99999 } },
    ] });
    return { shelfId: kg.id, tplId: tpl.id };
  }, { A, B, C });
}

test('formato: viaja lo vivo, sin calendario ni tombstones; el libro no', async ({ page }) => {
  await page.goto('/');
  const { shelfId, tplId } = await seed(page);
  const bundle = await page.evaluate(async (shelfId) => {
    const Share: any = await import('/js/share/export.js');
    return Share.buildShelfDossier(shelfId, { parts: ['highlights', 'notebooks', 'artifacts', 'decks'], author: 'Luis' });
  }, shelfId);

  expect(bundle.format).toBe('bookreader-bundle');
  expect(bundle.kind).toBe('dossier');
  expect(bundle.shelf.name).toBe('Knowledge graphs');
  expect(bundle.author).toBe('Luis');
  // Los dos de la estantería; Rayuela no.
  expect(bundle.books.map((b: any) => b.bookId).sort()).toEqual([A, B]);

  const a = bundle.books.find((b: any) => b.bookId === A);
  // arXiv reconocido por el nombre del fichero: es lo que permite al receptor bajarse
  // el MISMO PDF y que el hash coincida.
  expect(a.source).toBe('https://arxiv.org/abs/2003.02320v6');
  expect(a.highlights).toHaveLength(1);
  expect(a.highlights[0]).toMatchObject({ text: 'A knowledge graph is…', page: 3, note: 'definición clave' });
  expect(a.highlights[0].uid).toBeUndefined();
  expect(a.notebooks).toHaveLength(1);
  expect(a.notebooks[0].notes.map((n: any) => n.content)).toEqual(['OWL es la capa de esquema']);
  expect(a.notebooks[0].messages).toBeUndefined();          // chat no marcado
  expect(a.artifacts).toHaveLength(1);
  expect(a.artifacts[0]).toMatchObject({ kind: 'summary', result: { tldr: 'Los KG unifican datos' } });
  expect(a.decks[0].cards).toEqual([{ front: '¿Qué es un triple?', back: 'sujeto-predicado-objeto' }]);
  // La plantilla propia viaja incrustada: sin ella el receptor no puede pintar la libreta.
  expect(bundle.templates.map((t: any) => t.id)).toEqual([tplId]);

  const b = bundle.books.find((x: any) => x.bookId === B);
  expect(b).toMatchObject({ highlights: [], notebooks: [], artifacts: [], decks: [], source: null });

  // Ida y vuelta por texto: lo que se exporta es lo que se puede leer.
  const back = await page.evaluate(async (text) => {
    const Bundle: any = await import('/js/share/bundle.js');
    return Bundle.parse(text);
  }, JSON.stringify(bundle));
  expect(back).toEqual(bundle);
});

test('formato: lo que no es un dossier se rechaza con el motivo', async ({ page }) => {
  await page.goto('/');
  const errs = await page.evaluate(async () => {
    const Bundle: any = await import('/js/share/bundle.js');
    const tryParse = (text: string) => { try { Bundle.parse(text); return null; } catch (e: any) { return e.message; } };
    const ok = { format: 'bookreader-bundle', version: 1, kind: 'dossier', books: [] };
    return {
      notJson: tryParse('{nope'),
      backup: tryParse(JSON.stringify({ format: 'bookreader-backup', version: 1 })),
      future: tryParse(JSON.stringify({ ...ok, version: 99 })),
      badId: tryParse(JSON.stringify({ ...ok, books: [{ bookId: '../etc', title: 'x' }] })),
      badSource: tryParse(JSON.stringify({ ...ok, books: [{ bookId: 'a'.repeat(64), title: 'x', source: 'javascript:alert(1)' }] })),
      noAnchor: tryParse(JSON.stringify({ ...ok, books: [{ bookId: 'a'.repeat(64), title: 'x', highlights: [{ text: 'y' }] }] })),
      empty: tryParse(JSON.stringify(ok)),
    };
  });
  expect(errs.notJson).toContain('JSON inválido');
  expect(errs.backup).toContain('formato desconocido');
  expect(errs.future).toContain('posterior a la soportada');
  expect(errs.badId).toContain('bookId inválido');
  expect(errs.badSource).toContain('enlace de origen inválido');
  expect(errs.noAnchor).toContain('sin ancla');
  expect(errs.empty).toBeNull();
});

test('desde el menú de la estantería: elegir partes y descargar el .bookreader', async ({ page }) => {
  await page.goto('/');
  await seed(page);
  await page.reload();

  const row = page.locator('.lib-rail-row', { has: page.locator('.lib-rail-name', { hasText: /^Knowledge graphs$/ }) });
  await row.hover();
  await row.locator('.lib-rail-kebab').click();
  await page.locator('.lib-menu-item[data-act="share"]').click();

  // Diálogo: por defecto todo menos el chat. Se marca el chat también.
  await expect(page.locator('.dlg-check input[value="chat"]')).not.toBeChecked();
  await expect(page.locator('.dlg-check input[value="artifacts"]')).toBeChecked();
  await page.locator('.dlg-check input[value="chat"]').check();
  await page.locator('.dlg-input[data-field="author"]').fill('Luis');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Compartir', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('knowledge-graphs.bookreader');
  const fs = await import('fs/promises');
  const bundle = JSON.parse(await fs.readFile((await download.path())!, 'utf8'));
  expect(bundle.author).toBe('Luis');
  expect(bundle.parts).toEqual(['highlights', 'notebooks', 'chat', 'artifacts', 'decks']);
  const a = bundle.books.find((b: any) => b.bookId === A);
  expect(a.notebooks[0].messages.map((m: any) => m.content)).toEqual(['¿Qué es RDF?']);
  expect(a.artifacts).toHaveLength(1);

  // El nombre se recuerda para la próxima vez.
  expect(await page.evaluate(() => localStorage.getItem('bookreader_share_author'))).toBe('"Luis"');
});
