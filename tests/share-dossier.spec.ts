import { test, expect, Page } from '@playwright/test';

// P24 · Compartir una estantería (dossier). El caso que lo motivó: una investigación de
// varios papers y libros con subrayados, libretas y artefactos del agente que se le
// quiere pasar a otra persona. Lo que se fija aquí:
//   - el formato (bundle.js, puro): qué viaja y qué NO (tombstones, calendario de
//     repaso), y que lo que no es un dossier se rechaza en la puerta;
//   - el paquete (container.js): los libros van dentro del ZIP y salen con los mismos
//     bytes; uno cuyos bytes no dan su bookId se descarta;
//   - el flujo desde el menú de la estantería: el fichero que sale lleva lo elegido de
//     TODOS los libros de la estantería, y nada de los que no están en ella.
//
// Se siembra IndexedDB después de que la app arranque: sensible al timing bajo carga.
test.describe.configure({ retries: 2 });

const B = 'b'.repeat(64);   // libro de la estantería sin nada, y sin fichero aquí (fantasma)
const C = 'c'.repeat(64);   // libro FUERA de la estantería, con subrayados

// A es el paper con todo, y su id es el hash de sus bytes de verdad: es lo que el
// receptor comprobará al desempaquetar.
async function seed(page: Page) {
  return page.evaluate(async ({ B, C }) => {
    const Store: any = await import('/js/library/store.js');
    const DB: any = await import('/js/ai/db.js');
    const Storage: any = await import('/js/storage.js');
    const Custom: any = await import('/js/ai/custom-templates.js');
    const kg = await Store.addShelf('Knowledge graphs');
    const now = Date.now();
    const bytes = new Uint8Array(4096);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) % 251;
    const A = await DB.hashBuffer(bytes.buffer.slice(0));
    await Store.putBook({ id: A, title: 'Knowledge Graphs (survey)', author: 'Hogan et al.', format: 'pdf',
      fileName: '2003.02320v6.pdf', size: bytes.length, status: 'reading', addedAt: now, shelfIds: [kg.id],
      file: new Blob([bytes], { type: 'application/pdf' }) });
    await Store.putBook({ id: B, title: 'Graph Databases', author: 'Robinson', format: 'epub', size: 9999,
      status: 'unread', addedAt: now, shelfIds: [kg.id], file: null, blob: { path: 'bookreader/files/' + B, size: 9999 } });
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
    return { shelfId: kg.id, tplId: tpl.id, A };
  }, { B, C });
}

test('formato: viaja lo vivo, sin calendario ni tombstones', async ({ page }) => {
  await page.goto('/');
  const { shelfId, tplId, A } = await seed(page);
  const bundle = await page.evaluate(async (shelfId) => {
    const Share: any = await import('/js/share/export.js');
    return Share.buildShelfDossier(shelfId, { parts: ['files', 'highlights', 'notebooks', 'artifacts', 'decks'], author: 'Luis' });
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
  expect(a.file).toBe(`files/${A}.pdf`);
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
  // B es una ficha fantasma: su fichero está en Drive, no aquí, así que no puede ir.
  expect(b).toMatchObject({ file: null, highlights: [], notebooks: [], artifacts: [], decks: [], source: null });

  // Ida y vuelta por texto: lo que se exporta es lo que se puede leer.
  const back = await page.evaluate(async (text) => {
    const Bundle: any = await import('/js/share/bundle.js');
    return Bundle.parse(text);
  }, JSON.stringify(bundle));
  expect(back).toEqual(bundle);
});

test('paquete: el libro viaja dentro del ZIP con los mismos bytes; uno manipulado se descarta', async ({ page }) => {
  await page.goto('/');
  const { shelfId, A } = await seed(page);
  const out = await page.evaluate(async ({ shelfId, A }) => {
    const Share: any = await import('/js/share/export.js');
    const Container: any = await import('/js/share/container.js');
    const DB: any = await import('/js/ai/db.js');
    const pkg = await Share.packShelf(shelfId, { author: 'Luis' });
    const JSZip = (window as any).JSZip;   // lo ha cargado el empaquetado
    const ok = await Container.unpack(pkg.blob);
    const got = ok.files.get(A);

    // Mismo paquete con otros bytes bajo el nombre de A: el hash no casa → fuera.
    const zip = await JSZip.loadAsync(pkg.blob);
    zip.file(`files/${A}.pdf`, new Uint8Array([1, 2, 3]));
    const bad = await Container.unpack(await zip.generateAsync({ type: 'blob' }));

    let notZip = null;
    try { await Container.unpack(new Blob(['{"format":"bookreader-bundle"}'])); } catch (e: any) { notZip = e.message; }
    return {
      name: pkg.name,
      entries: Object.keys(zip.files).sort(),
      size: got ? got.size : 0,
      hash: got ? await DB.hashBuffer(await got.arrayBuffer()) : null,
      okRejected: ok.rejected,
      badFiles: bad.files.size,
      badRejected: bad.rejected,
      notZip,
    };
  }, { shelfId, A });
  expect(out.name).toBe('knowledge-graphs.bookreader');
  expect(out.entries).toEqual(['dossier.json', 'files/', `files/${A}.pdf`]);
  expect(out.size).toBe(4096);
  expect(out.hash).toBe(A);
  expect(out.okRejected).toEqual([]);
  expect(out.badFiles).toBe(0);
  expect(out.badRejected).toEqual([A]);
  expect(out.notZip).toContain('no es un dossier');
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
      badFile: tryParse(JSON.stringify({ ...ok, books: [{ bookId: 'a'.repeat(64), title: 'x', format: 'pdf', file: '../../sw.js' }] })),
      noAnchor: tryParse(JSON.stringify({ ...ok, books: [{ bookId: 'a'.repeat(64), title: 'x', highlights: [{ text: 'y' }] }] })),
      empty: tryParse(JSON.stringify(ok)),
    };
  });
  expect(errs.notJson).toContain('JSON inválido');
  expect(errs.backup).toContain('formato desconocido');
  expect(errs.future).toContain('posterior a la soportada');
  expect(errs.badId).toContain('bookId inválido');
  expect(errs.badSource).toContain('enlace de origen inválido');
  expect(errs.badFile).toContain('ruta de fichero inválida');
  expect(errs.noAnchor).toContain('sin ancla');
  expect(errs.empty).toBeNull();
});

test('desde el menú de la estantería: elegir partes y descargar el .bookreader', async ({ page }) => {
  await page.goto('/');
  const { A } = await seed(page);
  await page.reload();

  const row = page.locator('.lib-rail-row', { has: page.locator('.lib-rail-name', { hasText: /^Knowledge graphs$/ }) });
  await row.hover();
  await row.locator('.lib-rail-kebab').click();
  await page.locator('.lib-menu-item[data-act="share"]').click();

  // Diálogo: por defecto todo menos el chat. Los libros dicen cuánto pesan y cuántos
  // no pueden ir. Se marca el chat también.
  const files = page.locator('.dlg-check', { has: page.locator('input[value="files"]') });
  await expect(files.locator('input')).toBeChecked();
  await expect(files).toContainText('4 KB');
  await expect(files).toContainText('1 sin fichero en este dispositivo');
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
  const b64 = (await fs.readFile((await download.path())!)).toString('base64');
  const { bundle, nFiles } = await page.evaluate(async (b64) => {
    const Container: any = await import('/js/share/container.js');
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const r = await Container.unpack(new Blob([bytes]));
    return { bundle: r.bundle, nFiles: r.files.size };
  }, b64);
  expect(nFiles).toBe(1);
  expect(bundle.author).toBe('Luis');
  expect(bundle.parts).toEqual(['files', 'highlights', 'notebooks', 'chat', 'artifacts', 'decks']);
  const a = bundle.books.find((b: any) => b.bookId === A);
  expect(a.notebooks[0].messages.map((m: any) => m.content)).toEqual(['¿Qué es RDF?']);
  expect(a.artifacts).toHaveLength(1);

  // El nombre se recuerda para la próxima vez.
  expect(await page.evaluate(() => localStorage.getItem('bookreader_share_author'))).toBe('"Luis"');
});

// F2 · Dos lectores de verdad (dos contextos de navegador, dos IndexedDB). Luis comparte
// su estantería; Ana ya tenía el paper A con un subrayado suyo en la MISMA página.
test('importar: los libros entran en la biblioteca, lo ajeno va aparte y lo tuyo queda intacto', async ({ browser }, testInfo) => {
  const luis = await (await browser.newContext()).newPage();
  await luis.goto('/');
  const { shelfId, A } = await seed(luis);
  // D: un EPUB que Ana no tiene → entra nuevo en su biblioteca.
  const { D, b64 } = await luis.evaluate(async (shelfId) => {
    const Store: any = await import('/js/library/store.js');
    const DB: any = await import('/js/ai/db.js');
    const Share: any = await import('/js/share/export.js');
    const bytes = new Uint8Array(3000).map((_, i) => (i * 13 + 5) % 253);
    const D = await DB.hashBuffer(bytes.buffer.slice(0));
    await Store.putBook({ id: D, title: 'Linked Data', author: 'Heath', format: 'epub', size: bytes.length,
      addedAt: Date.now(), status: 'unread', shelfIds: [shelfId], file: new Blob([bytes]) });
    const pkg = await Share.packShelf(shelfId, { author: 'Luis' });
    const buf = new Uint8Array(await pkg.blob.arrayBuffer());
    let bin = ''; for (const x of buf) bin += String.fromCharCode(x);
    return { D, b64: btoa(bin) };
  }, shelfId);
  const fs = await import('fs/promises');
  const file = testInfo.outputPath('knowledge-graphs.bookreader');
  await fs.writeFile(file, Buffer.from(b64, 'base64'));

  const ana = await (await browser.newContext()).newPage();
  await ana.goto('/');
  // Ana tiene A (mismos bytes que Luis → mismo id) y un subrayado propio en la pág. 3.
  await ana.evaluate(async (A) => {
    const Store: any = await import('/js/library/store.js');
    const Storage: any = await import('/js/storage.js');
    const bytes = new Uint8Array(4096);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) % 251;
    await Store.putBook({ id: A, title: 'KG survey (mi copia)', format: 'pdf', size: 4096, addedAt: Date.now(),
      status: 'reading', shelfIds: [], file: new Blob([bytes]) });
    Storage.set('highlights_' + A, [{ uid: 'mio', id: 'mio', page: 3, rects: [], text: 'mi subrayado', color: '#a5d6a7', timestamp: 1 }]);
  }, A);
  await ana.reload();

  const importOnce = async (linkedData: string) => {
    await ana.locator('#file-input').setInputFiles(file);
    const dlg = ana.locator('.dlg-card');
    await expect(dlg.locator('.dlg-title')).toHaveText('Abrir «Knowledge graphs»');
    await expect(dlg).toContainText('De Luis (según el fichero). 1 subrayado · 1 nota de libreta · 1 artefacto · 1 tarjeta');
    await expect(dlg).toContainText('Knowledge Graphs (survey) — ya lo tienes');
    await expect(dlg).toContainText(`Linked Data — ${linkedData}`);
    await expect(dlg).toContainText('Graph Databases — sin fichero: solo notas');
    await dlg.getByRole('button', { name: 'Importar' }).click();
    await expect(ana.locator('.dlg-card')).toContainText('Listo: 3 libros en la estantería «Knowledge graphs · Luis».');
    await ana.locator('.dlg-card').getByRole('button', { name: 'Entendido' }).click();
  };
  await importOnce('nuevo');

  const state = async () => ana.evaluate(async ({ A, D }) => {
    const Store: any = await import('/js/library/store.js');
    const Storage: any = await import('/js/storage.js');
    const Shared: any = await import('/js/share/store.js');
    const shelves = await Store.getShelves();
    const kg = shelves.find((s: any) => s.name === 'Knowledge graphs · Luis');
    const a = await Store.getRaw(A);
    const d = await Store.getRaw(D);
    const all = await Shared.getAll();
    const sa = (await Shared.forBook(A))[0];
    return {
      shelves: shelves.length,
      aTitle: a.title, aInShelf: a.shelfIds.includes(kg.id),
      dHasFile: Store.hasFile(d), dInShelf: d.shelfIds.includes(kg.id),
      mine: Storage.get('highlights_' + A, []).map((h: any) => h.text),
      shared: all.length,
      sharedA: { from: sa.from, highlights: sa.highlights.map((h: any) => h.text), notes: sa.notebooks[0].notes.length,
        artifacts: sa.artifacts.length, templates: sa.templates.length },
    };
  }, { A, D });

  const first = await state();
  expect(first.aTitle).toBe('KG survey (mi copia)');          // su ficha no se toca
  expect(first.aInShelf).toBe(true);
  expect(first.dHasFile).toBe(true);
  expect(first.dInShelf).toBe(true);
  expect(first.mine).toEqual(['mi subrayado']);               // lo suyo, intacto
  expect(first.shared).toBe(3);                               // A, B y D en el carril ajeno
  expect(first.sharedA).toEqual({ from: 'Luis', highlights: ['A knowledge graph is…'], notes: 1, artifacts: 1, templates: 1 });

  // Reimportar el mismo dossier SUSTITUYE: ni libros, ni estanterías ni notas duplicadas.
  // (Y ahora Linked Data ya está en su biblioteca.)
  await importOnce('ya lo tienes');
  const second = await state();
  expect(second.shared).toBe(3);
  expect(second.shelves).toBe(first.shelves);
  expect(second.sharedA.highlights).toHaveLength(1);
});
