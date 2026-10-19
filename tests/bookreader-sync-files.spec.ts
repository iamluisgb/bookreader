import { test, expect, Page, BrowserContext } from '@playwright/test';
import { createSyncServer, installSyncServer, seedBookReaderSync, SyncServer } from './bookreader-sync-mock';

// MON4 F4 · Ficheros de libro por el sync de BookReader (con FILES_ENABLED, la opción A de
// ADR-056), contra el Worker real. Lo que se comprueba:
//   - el libro del PC llega al móvil intacto (mismo hash = mismo id), cifrado en el servidor;
//   - un libro grande va por partes y llega igual;
//   - al tope de cuota, los datos siguen y la TARJETA del libro dice por qué no se subió,
//     sin un diálogo por cada libro.

async function boot(context: BrowserContext, server: SyncServer, { pair = '' } = {}): Promise<Page> {
  await installSyncServer(context, server);
  await seedBookReaderSync(context);
  const page = await context.newPage();
  await page.goto('/' + pair);
  return page;
}

async function enableAndLink(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const A = await import('/js/sync/bookreader-auth.js');
    await A.enable();
    await A.getToken(true);   // trae `files` del servidor
    const link = A.pairingLink();
    return link.slice(link.indexOf('#'));
  });
}

async function importBook(page: Page, title: string, seed: number, bytes = 2048) {
  return page.evaluate(async ({ title, seed, bytes }) => {
    const Store = await import('/js/library/store.js');
    const DB = await import('/js/ai/db.js');
    const buf = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) buf[i] = (i * 31 + seed) % 251;
    const id = await DB.hashBuffer(buf.buffer.slice(0));
    await Store.putBook({
      id, title, author: 'Autor', format: 'epub', fileName: title + '.epub',
      file: buf.buffer, size: bytes, addedAt: Date.now(), progress: 0, status: 'unread', shelfIds: [],
    });
    return id;
  }, { title, seed, bytes });
}

const sync = (page: Page) => page.evaluate(async () => (await import('/js/sync/engine.js')).syncNow());
const flushBlobs = (page: Page) => page.evaluate(async () => (await import('/js/sync/blobs.js')).flush());

async function download(page: Page, id: string) {
  return page.evaluate(async (id) => {
    const Blobs = await import('/js/sync/blobs.js');
    const Store = await import('/js/library/store.js');
    await Blobs.requestDownload(id);
    const rec = await Store.getRaw(id);
    if (!rec || !rec.file) return null;
    const bytes = new Uint8Array(rec.file instanceof Blob ? await rec.file.arrayBuffer() : rec.file);
    const DB = await import('/js/ai/db.js');
    return { hash: await DB.hashBuffer(bytes.buffer.slice(0)), size: bytes.length };
  }, id);
}

test.describe('MON4 F4 — ficheros de libro por el sync de BookReader', () => {
  test('el libro del PC llega intacto al móvil, y en el servidor va cifrado', async ({ browser }) => {
    const server = await createSyncServer({ FILES_ENABLED: '1' });
    const pc = await browser.newContext();
    const movil = await browser.newContext();
    const a = await boot(pc, server);
    const hash = await enableAndLink(a);
    const id = await importBook(a, 'Conversación en La Catedral', 3, 50000);
    await sync(a);
    await flushBlobs(a);
    await sync(a);
    const files = server.env.DB._raw.prepare(`SELECT size FROM objects WHERE kind = 'file'`).all();
    expect(files).toHaveLength(1);
    expect(files[0].size).toBe(50000 + 28);   // un trozo cifrado: iv + tag

    const b = await boot(movil, server, { pair: hash });
    await expect.poll(() => b.evaluate(() => !!localStorage.getItem('bookreader_sync_key'))).toBe(true);
    await sync(b);
    const got = await download(b, id);
    expect(got).toEqual({ hash: id, size: 50000 });
    await pc.close();
    await movil.close();
  });

  test('un libro grande va por partes y llega igual', async ({ browser }) => {
    const server = await createSyncServer({ FILES_ENABLED: '1' });
    const pc = await browser.newContext();
    const movil = await browser.newContext();
    const a = await boot(pc, server);
    const hash = await enableAndLink(a);
    // Umbral bajo para no cifrar 100 MB en el test: 9 MB = 3 trozos de 4 MB = 3 partes.
    await a.evaluate(async () => {
      const P = await import('/js/sync/bookreader-provider.js');
      P.limits.singleMax = 1024 * 1024;
      P.limits.partSegs = 1;
    });
    const id = await importBook(a, 'La ciudad y los perros', 9, 9 * 1024 * 1024);
    await sync(a);
    await flushBlobs(a);
    await sync(a);
    expect(server.calls.filter(c => c.startsWith('PUT /v1/mp/'))).toHaveLength(3);
    expect(server.calls.some(c => /^POST \/v1\/mp\/:path\/[A-Za-z0-9_-]{22}\/complete$/.test(c))).toBe(true);

    const b = await boot(movil, server, { pair: hash });
    await expect.poll(() => b.evaluate(() => !!localStorage.getItem('bookreader_sync_key'))).toBe(true);
    await sync(b);
    expect(await download(b, id)).toEqual({ hash: id, size: 9 * 1024 * 1024 });
    await pc.close();
    await movil.close();
  });

  test('al tope de cuota: las notas siguen, el libro no sube y su tarjeta lo dice', async ({ page }) => {
    const server = await createSyncServer({ FILES_ENABLED: '1', FILE_QUOTA_BYTES: '10000' });
    await installSyncServer(page, server);
    await seedBookReaderSync(page);
    await page.goto('/');
    await enableAndLink(page);
    const dialogs: string[] = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
    await importBook(page, 'Grande', 1, 20000);
    await importBook(page, 'Otro grande', 2, 20000);
    await sync(page);
    await flushBlobs(page);
    expect(server.env.DB._raw.prepare(`SELECT COUNT(*) AS n FROM objects WHERE kind = 'file'`).get().n).toBe(0);
    // Los datos sí: la biblioteca, el manifest…
    expect(server.env.DB._raw.prepare(`SELECT COUNT(*) AS n FROM objects WHERE kind = 'data'`).get().n).toBeGreaterThan(2);

    await page.evaluate(async () => {
      const V = await import('/js/library/view.js');
      V.show();
      await V.render();
    });
    const notes = page.locator('.lib-dl-blocked');
    await expect(notes).toHaveCount(2);
    await expect(notes.first()).toHaveText('Sin subir: sync lleno');
    await expect(notes.first()).toHaveAttribute('title', /tope de espacio/);
    await expect(page.locator('.dlg-overlay')).toHaveCount(0);
    expect(dialogs).toEqual([]);
  });
});
