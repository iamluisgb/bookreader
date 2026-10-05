import { test, expect, Page } from '@playwright/test';

// WebMCP (experimental): herramientas de SOLO LECTURA para agentes del navegador. El
// navegador real aún lo trae tras una opción experimental, así que aquí `document.modelContext`
// es un doble que guarda lo registrado y deja llamar a `execute` como lo haría el agente.
async function fakeModelContext(page: Page) {
  await page.addInitScript(() => {
    const tools: Record<string, any> = {};
    (window as any).__tools = tools;
    (document as any).modelContext = {
      registerTool(t: any) { tools[t.name] = t; return () => { delete tools[t.name]; }; },
      unregisterTool(name: string) { delete tools[name]; },
    };
  });
}

async function seed(page: Page) {
  await page.evaluate(async () => {
    const Store: any = await import('/js/library/store.js');
    const Storage: any = await import('/js/storage.js');
    const DB: any = await import('/js/ai/db.js');
    const A = 'a'.repeat(64), B = 'b'.repeat(64);
    await Store.putBook({ id: A, title: 'Designing Data-Intensive Applications', author: 'Martin Kleppmann', format: 'epub', progress: 37, status: 'reading', addedAt: Date.now(), shelfIds: [] });
    await Store.putBook({ id: B, title: 'Pedro Páramo', author: 'Juan Rulfo', format: 'epub', progress: 0, status: 'unread', addedAt: Date.now(), shelfIds: [] });
    Storage.set('highlights_' + A, [
      { uid: 'h1', id: 'h1', cfi: 'epubcfi(/6/4)', text: 'Replication means keeping a copy of the same data on multiple machines', note: 'clave para entender líderes', chapter: '5. Replication', color: '#ffeb3b', timestamp: 1 },
      { uid: 'h2', id: 'h2', cfi: 'epubcfi(/6/6)', text: 'borrado', deleted: true },
    ]);
    const cv = await DB.createConvo(A, 'hqa', 'Entender sistemas distribuidos');
    await DB.addNote(cv.id, 'hqa_q', 'P: ¿Qué es la replicación? R: copias del dato en varias máquinas', []);
    await DB.put('bookText', { bookId: A, annotatedText: '## 5. Replication\n[[a1]] Leader-based replication is the most common approach.\n[[a2]] Followers apply the log in order.\n## 6. Partitioning\n[[a3]] Partitioning spreads data across nodes.' });
  });
}

const call = (page: Page, name: string, args: any = {}) => page.evaluate(async ({ name, args }) => {
  const r = await (window as any).__tools[name].execute(args);
  const txt = r.content[0].text;
  try { return JSON.parse(txt); } catch { return txt; }
}, { name, args });

test('apagado por defecto: sin activarlo no se registra ninguna herramienta', async ({ page }) => {
  await fakeModelContext(page);
  await page.goto('/');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => Object.keys((window as any).__tools))).toEqual([]);
});

test('activado: las cinco herramientas responden con los datos del dispositivo', async ({ page }) => {
  await fakeModelContext(page);
  await page.addInitScript(() => localStorage.setItem('bookreader_webmcp_enabled', 'true'));
  await page.goto('/');
  await seed(page);
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).__tools).sort()))
    .toEqual(['export_markdown', 'get_highlights', 'get_notebook', 'list_books', 'search_book']);
  // Solo lectura, declarado.
  expect(await page.evaluate(() => (window as any).__tools.get_highlights.annotations)).toEqual({ readOnlyHint: true });

  const list = await call(page, 'list_books');
  expect(list.map((b: any) => [b.title, b.highlights])).toEqual(expect.arrayContaining([['Designing Data-Intensive Applications', 1], ['Pedro Páramo', 0]]));

  // Por parte del título, sin tildes ni mayúsculas.
  const hl = await call(page, 'get_highlights', { book: 'designing data' });
  expect(hl.book.title).toBe('Designing Data-Intensive Applications');
  expect(hl.highlights).toEqual([expect.objectContaining({ text: expect.stringContaining('Replication means'), note: 'clave para entender líderes', chapter: '5. Replication' })]);

  // Ambiguo o inexistente: error con candidatos, no una adivinanza.
  const none = await call(page, 'get_highlights', { book: 'Quijote' });
  expect(none.error).toBe('not_found');
  expect(none.candidates.length).toBe(2);

  expect(await call(page, 'get_notebook', { book: 'Designing' })).toContain('¿Qué es la replicación?');

  const s = await call(page, 'search_book', { book: 'Designing', query: 'leader replication' });
  expect(s.passages[0]).toEqual({ chapter: '5. Replication', text: 'Leader-based replication is the most common approach.' });
  const sinPreparar = await call(page, 'search_book', { book: 'Páramo', query: 'Comala' });
  expect(sinPreparar.error).toBe('not_prepared');

  const md = await call(page, 'export_markdown', { book: 'Designing' });
  expect(md).toMatch(/^---\ntitle: "Designing Data-Intensive Applications"/);
  expect(md).toContain('> Replication means keeping a copy');
  expect(md).toContain('clave para entender líderes');
  expect(md).toContain('## Libreta');
});

test('el interruptor solo existe donde hay soporte, y registra o retira al momento', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => (await import('/js/ui/app-settings.js')).open('app'));
  await expect(page.locator('#appset-webmcp')).toHaveCount(0);          // sin WebMCP, ni rastro

  await fakeModelContext(page);
  await page.reload();
  await page.evaluate(async () => (await import('/js/ui/app-settings.js')).open('app'));
  const box = page.locator('#appset-webmcp');
  await expect(box).not.toBeChecked();
  await box.check();
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).__tools).length)).toBe(5);
  await box.uncheck();
  await expect.poll(() => page.evaluate(() => Object.keys((window as any).__tools).length)).toBe(0);
});
