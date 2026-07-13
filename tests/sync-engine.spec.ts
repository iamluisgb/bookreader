import { test, expect } from '@playwright/test';
import { installDriveMocks, seedDriveToken } from './drive-mock';

// Fase 2b · SyncEngine: ciclo pull→merge→push, 412-retry, escalares (posición),
// estado y reconexión. El motor se maneja por su API (syncNow) para hacer los
// tests deterministas; los triggers de tiempo (interval/debounce) se validan
// aparte por su efecto, no por el reloj.

test.describe('Sync Fase 2b — SyncEngine', () => {
  test('primer push sube el layout completo y deja sync_state', async ({ page }) => {
    const mock = await installDriveMocks(page);
    await seedDriveToken(page);
    await page.goto('/');
    const res = await page.evaluate(async () => {
      const H = await import('/js/highlights.js');
      const Engine = await import('/js/sync/engine.js');
      H.setBook('libro-a');
      H.add('epubcfi(/6/2!/4/2)', 'uno', '#ffeb3b', 'c1', 'nota A');
      const r = await Engine.syncNow();
      return { r, status: Engine.getStatus(), state: JSON.parse(localStorage.getItem('bookreader_sync_state') || '{}') };
    });
    expect(res.r.pushed).toBe(1);
    expect(res.status).toBe('ok');
    expect(mock.store.has('bookreader/manifest.json')).toBe(true);
    expect(mock.store.has('bookreader/books/libro-a.json')).toBe(true);
    // sync_state recuerda el etag del manifest y del libro (para el próximo ciclo).
    expect(res.state.manifestEtag).toBeTruthy();
    expect(res.state.books['bookreader/books/libro-a.json']).toBeTruthy();
  });

  test('pull: un cambio remoto se fusiona en local y re-renderiza', async ({ page }) => {
    const mock = await installDriveMocks(page);
    await seedDriveToken(page);
    // Drive ya tiene un libro con un subrayado (creado por "otro dispositivo").
    const remoteBook = {
      local: {
        'highlights_libro-r': [
          { uid: 'epubcfi(/6/9!/4/2)', cfi: 'epubcfi(/6/9!/4/2)', text: 'remoto', color: '#90caf9', chapter: 'c1', note: 'del otro equipo', timestamp: 1000, updatedAt: 1000 },
        ],
      },
      convos: [], messages: [], notes: [], ratings: [], meta: null,
    };
    mock.seedFile('bookreader/settings.json', '{}');
    mock.seedFile('bookreader/books/libro-r.json', JSON.stringify(remoteBook));
    mock.seedFile('bookreader/manifest.json', JSON.stringify({
      schemaVersion: 1, updatedAt: 1000, books: { 'libro-r': { file: 'books/libro-r.json', title: null, updatedAt: 1000 } },
    }));
    await page.goto('/');
    const res = await page.evaluate(async () => {
      let reRendered = false;
      window.addEventListener('bookreader:remote-applied', () => { reRendered = true; });
      const Engine = await import('/js/sync/engine.js');
      await Engine.syncNow();
      const H = await import('/js/highlights.js');
      H.setBook('libro-r');
      return { vivos: H.getAll().map((h: any) => ({ text: h.text, note: h.note })), reRendered };
    });
    expect(res.vivos).toEqual([{ text: 'remoto', note: 'del otro equipo' }]);
    expect(res.reRendered).toBe(true);
  });

  test('412 en el push del manifest → reintenta y acaba en ok', async ({ page }) => {
    const mock = await installDriveMocks(page);
    await seedDriveToken(page);
    await page.goto('/');
    // Primer guardado para que exista el manifest (y su etag en sync_state).
    await page.evaluate(async () => {
      const H = await import('/js/highlights.js');
      const Engine = await import('/js/sync/engine.js');
      H.setBook('libro-c');
      H.add('epubcfi(/6/2!/4/2)', 'uno', '#ffeb3b', 'c1');
      await Engine.syncNow();
    });
    // El siguiente ciclo verá el manifest "pisado por otro dispositivo" (version++
    // en el lookup) → 412 en el push, que dispara el reintento.
    mock.bumpManifestAtFind(mock.counters.manifestFinds + 2);
    const res = await page.evaluate(async () => {
      const H = await import('/js/highlights.js');
      const Engine = await import('/js/sync/engine.js');
      H.setBook('libro-c');
      H.add('epubcfi(/6/4!/4/2)', 'dos', '#ffeb3b', 'c1'); // cambio local → push necesario
      const r = await Engine.syncNow();
      return { r, status: Engine.getStatus() };
    });
    expect(res.status).toBe('ok');
    // Y el segundo subrayado acabó en Drive pese al 412.
    const book = JSON.parse(mock.store.get('bookreader/books/libro-c.json')!.content);
    expect(book.local['highlights_libro-c']).toHaveLength(2);
  });

  test('posición de lectura (escalar) sincroniza por LWW', async ({ page }) => {
    const mock = await installDriveMocks(page);
    await seedDriveToken(page);
    await page.goto('/');
    // "Dispositivo A" deja una posición reciente y la sube.
    await page.evaluate(async () => {
      const S = await import('/js/storage.js');
      const Engine = await import('/js/sync/engine.js');
      S.set('lastPosition_libroP', 'epubcfi(/6/20!/4/2)');
      S.set('lastPositionAt_libroP', Date.now());
      // Un libro necesita meta para entrar en el snapshot: sembramos vía IDB.
      const DB = await import('/js/ai/db.js');
      await DB.put('books', { id: 'libroP', title: 'Libro P', addedAt: Date.now() });
      await Engine.syncNow();
    });
    const book = JSON.parse(mock.store.get('bookreader/books/libroP.json')!.content);
    expect(book.local['lastPosition_libroP']).toBe('epubcfi(/6/20!/4/2)');
    expect(book.local['lastPositionAt_libroP']).toBeGreaterThan(0);
  });

  test('token revocado → estado reconnect, sin bucle', async ({ page }) => {
    const mock = await installDriveMocks(page);
    await seedDriveToken(page);
    await page.goto('/');
    mock.revokeToken();
    const res = await page.evaluate(async () => {
      const Engine = await import('/js/sync/engine.js');
      const H = await import('/js/highlights.js');
      H.setBook('libro-x');
      H.add('epubcfi(/6/2!/4/2)', 'uno', '#ffeb3b', 'c1');
      const r = await Engine.syncNow();
      const DriveAuth = await import('/js/sync/drive-auth.js');
      return { r, status: Engine.getStatus(), connected: DriveAuth.isConnected() };
    });
    expect(res.status).toBe('reconnect');
    // invalid_grant desconecta: no reintentará en bucle contra un token muerto.
    expect(res.connected).toBe(false);
  });

  test('sin conexión a Drive, syncNow es no-op (off)', async ({ page }) => {
    await installDriveMocks(page);
    await page.goto('/'); // sin sembrar token
    const res = await page.evaluate(async () => {
      const Engine = await import('/js/sync/engine.js');
      return { r: await Engine.syncNow(), status: Engine.getStatus() };
    });
    expect(res.r).toBe('off');
    expect(res.status).toBe('off');
  });

  test('ida y vuelta entre dos ciclos: A sube, B baja y fusiona (mismo Drive)', async ({ page }) => {
    const mock = await installDriveMocks(page);
    await seedDriveToken(page);
    await page.goto('/');
    // Dispositivo A: subraya y sincroniza.
    await page.evaluate(async () => {
      const H = await import('/js/highlights.js');
      const Engine = await import('/js/sync/engine.js');
      H.setBook('lituma');
      H.add('epubcfi(/6/2!/4/2)', 'pasaje A', '#ffeb3b', 'c1', 'nota A');
      await Engine.syncNow();
    });
    // Dispositivo B: mismo Drive (mock persistente), estado local propio; al
    // sincronizar debe traer lo de A y conservar lo suyo.
    const res = await page.evaluate(async () => {
      localStorage.removeItem('bookreader_highlights_lituma');
      localStorage.removeItem('bookreader_sync_state');
      const H = await import('/js/highlights.js');
      const Engine = await import('/js/sync/engine.js');
      H.setBook('lituma');
      H.add('epubcfi(/6/8!/4/2)', 'pasaje B', '#a5d6a7', 'c2', 'nota B');
      await Engine.syncNow();
      return H.getAll().map((h: any) => h.text).sort();
    });
    expect(res).toEqual(['pasaje A', 'pasaje B']);
  });
});
