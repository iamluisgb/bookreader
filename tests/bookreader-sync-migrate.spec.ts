import { test, expect, Page, BrowserContext } from '@playwright/test';
import { installDriveMocks, seedDriveToken, createDriveState } from './drive-mock';
import { createSyncServer, installSyncServer, seedBookReaderSync, enableSyncPreview, SYNC_URL } from './bookreader-sync-mock';
import { seedProLicense } from './pro-license';

// MON4 F5 · «Pasar mi sync de Drive a BookReader» en un paso, y al revés para quien cancela.
// Lo que no puede pasar: que algo se quede atrás. Ni lo que otro dispositivo subió a Drive y
// este aún no había bajado, ni los ficheros de libro que solo están en Drive.

async function importBook(page: Page, title: string, seed: number, bytes = 4096) {
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
const addHighlight = (page: Page, book: string, text: string) => page.evaluate(async ({ book, text }) => {
  const H = await import('/js/highlights.js');
  H.setBook(book);
  H.add('epubcfi(/6/' + (text.length * 2) + '!/4/2)', text, '#ffeb3b', 'c1', '');
}, { book, text });
const highlights = (page: Page, book: string) => page.evaluate((book) =>
  JSON.parse(localStorage.getItem('bookreader_highlights_' + book) || '[]').filter((h: any) => !h.deleted).map((h: any) => h.text).sort(), book);

test.describe('MON4 F5 — pasar el sync de un proveedor a otro', () => {
  test('de Drive a BookReader: datos, lo que solo estaba en Drive y los ficheros de libro', async ({ browser }) => {
    const drive = createDriveState();
    const server = await createSyncServer({ FILES_ENABLED: '1' });

    // Otro dispositivo (la tablet) subió a Drive un libro y un subrayado que el PC aún no tiene.
    const tablet = await browser.newContext();
    await installDriveMocks(tablet, drive);
    await seedDriveToken(tablet);
    const t = await tablet.newPage();
    await t.goto('/');
    await seedProLicense(t);
    const soloEnDrive = await importBook(t, 'La casa verde', 5);
    await addHighlight(t, 'libro-m', 'de la tablet');
    await sync(t);
    await flushBlobs(t);
    await sync(t);

    // El PC sincroniza con Drive y tiene lo suyo; luego activa el sync de BookReader y migra.
    const pc = await browser.newContext();
    await installDriveMocks(pc, drive);
    await seedDriveToken(pc);
    await installSyncServer(pc, server);
    await pc.addInitScript(() => {
      localStorage.setItem('bookreader_license', JSON.stringify({ key: 'BKRD-TEST-MIG', activationId: 'm', validatedAt: Date.now(), revoked: false }));
    });
    const a = await pc.newPage();
    await a.goto('/');
    const delPc = await importBook(a, 'Pantaleón', 6);
    await addHighlight(a, 'libro-m', 'del PC');
    // Sin sincronizar todavía con Drive: lo de la tablet lo trae la propia migración.
    const r = await a.evaluate(async () => {
      const A = await import('/js/sync/bookreader-auth.js');
      await A.enable();
      await A.getToken(true);
      const S = await import('/js/sync/switch.js');
      const r = await S.migrate('drive', 'bookreader');
      return { ...r, active: (await import('/js/sync/provider.js')).activeId() };
    });
    expect(r.active).toBe('bookreader');
    expect(r.copied).toBe(1);   // el de la tablet; el del PC lo sube la cola normal
    expect(r.skipped).toBe(0);
    expect(await highlights(a, 'libro-m')).toEqual(['de la tablet', 'del PC']);
    await flushBlobs(a);
    await sync(a);

    // Un móvil nuevo, emparejado al sync de BookReader y SIN Drive, lo tiene todo.
    const link = await a.evaluate(async () => {
      const l = (await import('/js/sync/bookreader-auth.js')).pairingLink();
      return l.slice(l.indexOf('#'));
    });
    const movil = await browser.newContext();
    await installSyncServer(movil, server);
    await seedBookReaderSync(movil);
    const m = await movil.newPage();
    await m.goto('/' + link);
    // El móvil tenía OTRA licencia: el enlace pide usar la suya (si no, caería en otro espacio).
    await expect(m.locator('.dlg-overlay')).toContainText('otra licencia');
    await m.locator('.dlg-overlay .dlg-ok').click();
    await expect.poll(() => m.evaluate(() => !!localStorage.getItem('bookreader_sync_key'))).toBe(true);
    await sync(m);
    expect(await highlights(m, 'libro-m')).toEqual(['de la tablet', 'del PC']);
    const files = await m.evaluate(async (ids) => {
      const Blobs = await import('/js/sync/blobs.js');
      const Store = await import('/js/library/store.js');
      const out: Record<string, boolean> = {};
      for (const id of ids) {
        await Blobs.requestDownload(id);
        out[id] = Store.hasFile(await Store.getRaw(id));
      }
      return out;
    }, [soloEnDrive, delPc]);
    expect(files).toEqual({ [soloEnDrive]: true, [delPc]: true });
    for (const c of [tablet, pc, movil]) await c.close();
  });

  test('de BookReader a Drive (quien cancela): con la suscripción caducada, en solo lectura', async ({ browser }) => {
    const drive = createDriveState();
    const server = await createSyncServer({ FILES_ENABLED: '1' });
    const pc = await browser.newContext();
    await installSyncServer(pc, server);
    await seedBookReaderSync(pc);
    const a = await pc.newPage();
    await a.goto('/');
    await a.evaluate(async () => {
      const A = await import('/js/sync/bookreader-auth.js');
      await A.enable();
      await A.getToken(true);
    });
    await importBook(a, 'El hablador', 8);
    await addHighlight(a, 'libro-c', 'antes de cancelar');
    await sync(a);
    await flushBlobs(a);
    await sync(a);

    // Cancela: solo lectura. Conecta Drive (el token de Google, sembrado) y migra.
    server.env.DB._raw.prepare('UPDATE users SET lapsed_at = ?').run(Date.now());
    server.env.DB._raw.prepare('UPDATE tokens SET read_only = 1').run();
    await installDriveMocks(pc, drive);
    await a.evaluate(() => localStorage.setItem('bookreader_drive_refresh_token', JSON.stringify('rt_test')));
    const r = await a.evaluate(async () => {
      const S = await import('/js/sync/switch.js');
      const r = await S.migrate('bookreader', 'drive');
      return { ...r, active: (await import('/js/sync/provider.js')).activeId() };
    });
    expect(r.active).toBe('drive');
    expect(r.copied).toBe(1);
    expect([...drive.store.keys()].some(k => k.startsWith('bookreader/files/'))).toBe(true);
    expect([...drive.store.keys()]).toContain('bookreader/books/libro-c.json');
    expect(drive.store.get('bookreader/books/libro-c.json')!.content).toContain('antes de cancelar');
    await pc.close();
  });

  test('Ajustes: activar BookReader con Drive conectado pide confirmación, migra y desconecta Drive', async ({ browser }) => {
    const drive = createDriveState();
    const server = await createSyncServer();
    const pc = await browser.newContext();
    await installDriveMocks(pc, drive);
    await seedDriveToken(pc);
    await installSyncServer(pc, server);
    await pc.addInitScript(() => {
      localStorage.setItem('bookreader_license', JSON.stringify({ key: 'BKRD-TEST-UIM', activationId: 'm', validatedAt: Date.now(), revoked: false }));
    });
    await enableSyncPreview(pc);
    const a = await pc.newPage();
    await a.goto('/');
    await addHighlight(a, 'libro-u', 'por la UI');
    await sync(a);
    await a.evaluate(async () => (await import('/js/ui/app-settings.js')).open('data'));
    await expect(a.locator('#appset-sync-choice .segmented-btn.active')).toHaveAttribute('data-p', 'drive');
    await a.locator('#appset-sync-choice [data-p="bookreader"]').click();
    await a.locator('#appset-br-enable').click();
    await expect(a.locator('.dlg-overlay')).toContainText('Pasar mi sync a BookReader');
    await a.locator('.dlg-overlay .dlg-ok').click();
    await expect(a.locator('#appset-data-msg')).toContainText('Hecho: tu sync está ahora en BookReader', { timeout: 20000 });
    expect(await a.evaluate(() => localStorage.getItem('bookreader_drive_refresh_token'))).toBeNull();
    await expect(a.locator('#appset-sync-choice .segmented-btn.active')).toHaveAttribute('data-p', 'bookreader');
    await expect(a.locator('#appset-br-on')).toBeVisible();
    expect(server.env.DB._raw.prepare('SELECT COUNT(*) AS n FROM objects').get().n).toBeGreaterThan(3);
    await pc.close();
  });

  test('un libro que falla por la red: se reintenta; si sigue fallando, Drive no se desconecta y se pasa después', async ({ browser }) => {
    const drive = createDriveState();
    const server = await createSyncServer({ FILES_ENABLED: '1' });

    // La tablet deja en Drive un libro que el PC no tiene en local.
    const tablet = await browser.newContext();
    await installDriveMocks(tablet, drive);
    await seedDriveToken(tablet);
    const t = await tablet.newPage();
    await t.goto('/');
    await seedProLicense(t);
    const soloEnDrive = await importBook(t, 'Conversación en La Catedral', 9);
    await sync(t);
    await flushBlobs(t);

    const pc = await browser.newContext();
    await installDriveMocks(pc, drive);
    await seedDriveToken(pc);
    await installSyncServer(pc, server);
    await pc.addInitScript(() => {
      localStorage.setItem('bookreader_license', JSON.stringify({ key: 'BKRD-TEST-RED', activationId: 'm', validatedAt: Date.now(), revoked: false }));
    });
    await enableSyncPreview(pc);
    // La red del móvil: toda subida de fichero de libro al sync se corta.
    let cortar = true;
    let cortadas = 0;
    await pc.route(SYNC_URL + '/v1/o/**', async (route) => {
      const r = route.request();
      if (cortar && r.method() === 'PUT' && r.headers()['x-kind'] === 'file') { cortadas++; return route.abort('failed'); }
      return route.fallback();
    });
    const a = await pc.newPage();
    await a.goto('/');
    await a.evaluate(async () => { (await import('/js/sync/switch.js')).COPY_WAITS_MS.splice(0, 9, 10, 10); });
    await sync(a);
    await a.evaluate(async () => (await import('/js/ui/app-settings.js')).open('data'));
    await a.locator('#appset-sync-choice [data-p="bookreader"]').click();
    await a.locator('#appset-br-enable').click();
    await a.locator('.dlg-overlay .dlg-ok').click();
    await expect(a.locator('#appset-data-msg')).toContainText('no se pudieron pasar por un fallo de red', { timeout: 20000 });
    expect(cortadas).toBe(3);   // el intento y dos reintentos
    expect(await a.evaluate(() => !!localStorage.getItem('bookreader_drive_refresh_token'))).toBe(true);
    const retry = a.locator('#appset-br-from-drive');
    await expect(retry).toBeVisible();

    // Vuelve la red: el botón lo pasa y, sin nada pendiente, desconecta Drive.
    cortar = false;
    await retry.click();
    await expect(a.locator('#appset-data-msg')).toContainText('Archivos de libros pasados: 1', { timeout: 20000 });
    await expect(a.locator('#appset-data-msg')).toContainText('se desconecta de Drive');
    expect(await a.evaluate(() => localStorage.getItem('bookreader_drive_refresh_token'))).toBeNull();
    await expect(retry).toBeHidden();
    expect(server.env.DB._raw.prepare("SELECT COUNT(*) AS n FROM objects WHERE kind = 'file'").get().n).toBe(1);
    expect(soloEnDrive).toBeTruthy();
    for (const c of [tablet, pc]) await c.close();
  });
});
