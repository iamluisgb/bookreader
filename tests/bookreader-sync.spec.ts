import { test, expect, Page } from '@playwright/test';
import { createSyncServer, installSyncServer, seedBookReaderSync, SyncServer } from './bookreader-sync-mock';

// MON4 F3 · El motor de sync (el MISMO de Drive) sobre el sync de BookReader, contra el
// Worker real en el proceso del test. Lo que se comprueba:
//   - dos dispositivos emparejados convergen (subrayados, ajustes, biblioteca);
//   - en el servidor no hay nada en claro: ni rutas, ni títulos, ni contenido;
//   - el historial de versiones de un libro sale de las copias del Worker y se restaura;
//   - con la suscripción caducada el sync queda en solo lectura: baja, no sube, y lo dice;
//   - Ajustes → Datos: elegir BookReader, activarlo y ver el enlace y la clave.

async function addHighlight(page: Page, book: string, cfi: string, text: string) {
  await page.evaluate(async ({ book, cfi, text }) => {
    const H = await import('/js/highlights.js');
    H.setBook(book);
    H.add(cfi, text, '#ffeb3b', 'c1', '');
  }, { book, cfi, text });
}

async function syncNow(page: Page) {
  return page.evaluate(async () => (await import('/js/sync/engine.js')).syncNow());
}

async function highlights(page: Page, book: string) {
  return page.evaluate((book) => JSON.parse(localStorage.getItem('bookreader_highlights_' + book) || '[]')
    .filter((h: any) => !h.deleted).map((h: any) => h.text).sort(), book);
}

// Dos dispositivos: el PC activa el sync (crea la clave) y el móvil se empareja con su enlace.
async function twoDevices(browser: any, server: SyncServer) {
  const pc = await browser.newContext();
  const movil = await browser.newContext();
  for (const c of [pc, movil]) {
    await installSyncServer(c, server);
    await seedBookReaderSync(c);
  }
  const a = await pc.newPage();
  await a.goto('/');
  const link: string = await a.evaluate(async () => {
    const A = await import('/js/sync/bookreader-auth.js');
    await A.enable();
    return A.pairingLink();
  });
  const b = await movil.newPage();
  await b.goto('/' + link.slice(link.indexOf('#')));
  // El arranque consume el #pair= y empareja solo.
  await expect.poll(() => b.evaluate(() => !!localStorage.getItem('bookreader_sync_key'))).toBe(true);
  return { pc, movil, a, b };
}

test.describe('MON4 F3 — sync de BookReader de punta a punta', () => {
  test('dos dispositivos convergen, y el servidor no ve nada en claro', async ({ browser }) => {
    const server = await createSyncServer();
    const { pc, movil, a, b } = await twoDevices(browser, server);

    await addHighlight(a, 'libro-x', 'epubcfi(/6/2!/4/2)', 'subrayado del PC');
    expect((await syncNow(a)).pushed).toBeGreaterThan(0);
    await addHighlight(b, 'libro-x', 'epubcfi(/6/4!/4/2)', 'subrayado del móvil');
    await syncNow(b);
    await syncNow(a);
    expect(await highlights(a, 'libro-x')).toEqual(['subrayado del PC', 'subrayado del móvil']);
    expect(await highlights(b, 'libro-x')).toEqual(['subrayado del PC', 'subrayado del móvil']);

    // Nada en claro en el servidor: ni rutas, ni nombres, ni contenido.
    const rows = server.env.DB._raw.prepare('SELECT path, name FROM objects').all();
    expect(rows.length).toBeGreaterThan(3);
    for (const r of rows) {
      expect(r.path).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(r.name).not.toMatch(/bookreader|libro-x|manifest/);
    }
    for (const bytes of server.env.SYNC._m.values()) {
      const s = Buffer.from(bytes).toString('latin1');
      expect(s).not.toContain('subrayado');
      expect(s).not.toContain('libro-x');
    }
    // Un listado y lecturas, nunca listar R2.
    expect(server.env.SYNC._ops.list).toBe(0);
    await pc.close();
    await movil.close();
  });

  test('el 412 de verdad: dos ciclos solapados convergen sin perder nada', async ({ browser }) => {
    const server = await createSyncServer();
    const { pc, movil, a, b } = await twoDevices(browser, server);
    await syncNow(a);
    await syncNow(b);
    // Los dos escriben el mismo libro y sincronizan A LA VEZ: uno de los dos se lleva el 412
    // en el Worker (CAS en D1), reintenta, fusiona y sube.
    await addHighlight(a, 'libro-y', 'epubcfi(/6/2!/4/2)', 'A');
    await addHighlight(b, 'libro-y', 'epubcfi(/6/6!/4/2)', 'B');
    await Promise.all([syncNow(a), syncNow(b)]);
    await syncNow(a);
    await syncNow(b);
    expect(await highlights(a, 'libro-y')).toEqual(['A', 'B']);
    expect(await highlights(b, 'libro-y')).toEqual(['A', 'B']);
    await pc.close();
    await movil.close();
  });

  test('historial de versiones: las copias del Worker se listan y se restauran', async ({ page }) => {
    const server = await createSyncServer();
    await installSyncServer(page, server);
    await seedBookReaderSync(page);
    await page.goto('/');
    await page.evaluate(async () => (await import('/js/sync/bookreader-auth.js')).enable());
    await addHighlight(page, 'libro-h', 'epubcfi(/6/2!/4/2)', 'primero');
    await syncNow(page);
    await addHighlight(page, 'libro-h', 'epubcfi(/6/4!/4/2)', 'segundo');
    await syncNow(page);
    // Se borra el primero y se sincroniza: la versión anterior aún lo tiene.
    await page.evaluate(async () => {
      const H = await import('/js/highlights.js');
      H.setBook('libro-h');
      H.remove('epubcfi(/6/2!/4/2)');
    });
    await syncNow(page);
    expect(await highlights(page, 'libro-h')).toEqual(['segundo']);

    const r = await page.evaluate(async () => {
      const R = await import('/js/sync/recovery.js');
      const books = await R.listBooks();
      const versions = await R.listVersions('libro-h');
      const oldest = versions[versions.length - 1];
      const preview = await R.previewVersion(oldest.fileId, oldest.id);
      const restored = await R.restoreVersion('libro-h', oldest.fileId, oldest.id);
      return { books: books.map((b: any) => b.id), n: versions.length, preview, restored };
    });
    expect(r.books).toContain('libro-h');
    expect(r.n).toBeGreaterThanOrEqual(2);
    expect(r.preview.highlights).toBe(1);
    expect(r.restored.recovered).toBe(1);
    expect(await highlights(page, 'libro-h')).toEqual(['primero', 'segundo']);
  });

  test('suscripción caducada: solo lectura — baja lo de otros, no sube, y el estado lo dice', async ({ browser }) => {
    const server = await createSyncServer();
    const { pc, movil, a, b } = await twoDevices(browser, server);
    await addHighlight(a, 'libro-z', 'epubcfi(/6/2!/4/2)', 'antes de caducar');
    await syncNow(a);

    // Caduca: el servidor solo emite tokens de lectura (se fuerza pidiendo uno nuevo).
    server.env.DB._raw.prepare('UPDATE users SET lapsed_at = ?').run(Date.now());
    server.env.DB._raw.prepare('UPDATE tokens SET read_only = 1').run();

    await addHighlight(b, 'libro-z', 'epubcfi(/6/8!/4/2)', 'después');
    const r = await syncNow(b);
    expect(r).toBe('error');
    const st = await b.evaluate(async () => ({
      status: (await import('/js/sync/engine.js')).getStatus(),
      readOnly: (await import('/js/sync/bookreader-auth.js')).readOnlyInfo(),
    }));
    expect(st.status).toBe('reconnect');
    expect(st.readOnly).not.toBeNull();
    // Lo del PC sí bajó al móvil antes de fallar la subida.
    expect(await highlights(b, 'libro-z')).toContain('antes de caducar');
    // Y lo del móvil no llegó al servidor.
    await syncNow(a);
    expect(await highlights(a, 'libro-z')).toEqual(['antes de caducar']);
    await pc.close();
    await movil.close();
  });

  test('Ajustes → Datos: elegir BookReader, activarlo, enlace y clave de recuperación', async ({ page, context }) => {
    // Como en producción por defecto (ADR-056 opción B): sin ficheros de libro.
    const server = await createSyncServer({ FILES_ENABLED: '0' });
    await installSyncServer(page, server);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.addInitScript(() => {
      localStorage.setItem('bookreader_license', JSON.stringify({ key: 'BKRD-TEST-UI', activationId: 'm', validatedAt: Date.now(), revoked: false }));
    });
    await page.goto('/');
    await page.evaluate(async () => (await import('/js/ui/app-settings.js')).open('data'));
    const seg = page.locator('#appset-sync-choice');
    await expect(seg.locator('.segmented-btn.active')).toHaveAttribute('data-p', 'none');
    await expect(page.locator('#appset-sync-pane-none')).toBeVisible();
    await expect(page.locator('#appset-sync-pane-drive')).toBeHidden();

    await seg.locator('[data-p="bookreader"]').click();
    await expect(page.locator('#appset-sync-pane-bookreader')).toBeVisible();
    await page.locator('#appset-br-enable').click();
    await expect(page.locator('#appset-data-msg')).toContainText('Sync de BookReader activado');
    await expect(page.locator('#appset-br-on')).toBeVisible();
    await expect(page.locator('#appset-br-status')).toContainText('Ocupas');
    await expect(page.locator('#appset-br-status')).toContainText('los archivos de los libros no');

    await page.locator('#appset-br-pairlink').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/#pair=/);
    await page.locator('#appset-br-recovery').click();
    await expect(page.locator('#appset-br-recovery-code')).toHaveText(/^([0-9A-Z]{4}-){13}[0-9A-Z]{2}$/);

    // Reabrir la sección marca BookReader como el sync en uso.
    await page.evaluate(async () => {
      const S = await import('/js/ui/app-settings.js');
      S.close();
      S.open('data');
    });
    await expect(seg.locator('.segmented-btn.active')).toHaveAttribute('data-p', 'bookreader');
    expect(server.env.DB._raw.prepare('SELECT COUNT(*) AS n FROM objects').get().n).toBeGreaterThan(1);
  });

  test('Ajustes → Datos: un segundo dispositivo recupera con la clave tecleada', async ({ browser }) => {
    const server = await createSyncServer();
    const pc = await browser.newContext();
    const otro = await browser.newContext();
    for (const c of [pc, otro]) { await installSyncServer(c, server); await seedBookReaderSync(c); }
    const a = await pc.newPage();
    await a.goto('/');
    const code = await a.evaluate(async () => {
      const A = await import('/js/sync/bookreader-auth.js');
      await A.enable();
      const H = await import('/js/highlights.js');
      H.setBook('libro-r');
      H.add('epubcfi(/6/2!/4/2)', 'recuperado', '#ffeb3b', 'c1', '');
      await (await import('/js/sync/engine.js')).syncNow();
      return A.recoveryCode();
    });
    // El otro dispositivo no tiene la clave: al activar, pide emparejar o la clave.
    const b = await otro.newPage();
    await b.goto('/');
    await b.evaluate(() => localStorage.removeItem('bookreader_sync_provider'));
    await b.evaluate(async () => (await import('/js/ui/app-settings.js')).open('data'));
    await b.locator('#appset-sync-choice [data-p="bookreader"]').click();
    await b.locator('#appset-br-enable').click();
    await expect(b.locator('#appset-br-pair')).toBeVisible();
    await b.locator('#appset-br-code').fill(code.toLowerCase());
    await b.locator('#appset-br-usecode').click();
    await expect(b.locator('#appset-br-on')).toBeVisible();
    await expect.poll(() => highlights(b, 'libro-r')).toEqual(['recuperado']);
    await pc.close();
    await otro.close();
  });
});
