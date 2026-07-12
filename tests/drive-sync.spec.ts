import { test, expect, Page } from '@playwright/test';

// Fase 1 del sync: DriveProvider + guardar/restaurar manual sobre el layout
// por-libro. Drive y el Worker de auth van MOCKEADOS por interceptación de red:
// el test verifica el hito del SYNC_PLAN ("guardar, borrar datos locales,
// restaurar → todo vuelve") sin red real.

type DriveFile = { id: string; name: string; content: string; version: number };

async function installDriveMocks(page: Page) {
  const store = new Map<string, DriveFile>();
  let nextId = 1;
  const counters = { refresh: 0 };

  await page.route('https://bookreader-auth.luisgonzalezb93.workers.dev/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/auth/refresh') {
      counters.refresh++;
      return route.fulfill({ json: { access_token: 'tok_test', expires_in: 3600 } });
    }
    return route.fulfill({ status: 404, json: { error: 'not_found' } });
  });

  function parseMultipart(body: string) {
    const parts = body
      .split('-----bookreader_boundary')
      .map((p) => p.split('\r\n\r\n')[1])
      .filter((p): p is string => p !== undefined)
      .map((p) => p.replace(/\r\n$/, ''));
    return { metadata: JSON.parse(parts[0]), content: parts[1] };
  }

  await page.route('https://www.googleapis.com/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const asMeta = (f: DriveFile) => ({
      id: f.id, name: f.name, version: String(f.version), modifiedTime: new Date().toISOString(),
    });

    // Listado / búsqueda por nombre
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      let files = [...store.values()];
      const q = url.searchParams.get('q');
      const m = q && q.match(/name='(.+)'/);
      if (m) files = files.filter((f) => f.name === m[1].replace(/\\'/g, "'"));
      return route.fulfill({ json: { files: files.map(asMeta) } });
    }
    // Descarga de contenido
    const fileMatch = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (fileMatch && method === 'GET' && url.searchParams.get('alt') === 'media') {
      const f = [...store.values()].find((x) => x.id === fileMatch[1]);
      return f ? route.fulfill({ body: f.content }) : route.fulfill({ status: 404, body: '' });
    }
    if (fileMatch && method === 'DELETE') {
      for (const [k, f] of store) if (f.id === fileMatch[1]) store.delete(k);
      return route.fulfill({ status: 204, body: '' });
    }
    // Subida multipart: crear
    if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const { metadata, content } = parseMultipart(req.postData() || '');
      const f: DriveFile = { id: 'f' + nextId++, name: metadata.name, content, version: 1 };
      store.set(f.name, f);
      return route.fulfill({ json: asMeta(f) });
    }
    // Subida multipart: actualizar
    const upMatch = url.pathname.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
    if (upMatch && method === 'PATCH') {
      const f = [...store.values()].find((x) => x.id === upMatch[1]);
      if (!f) return route.fulfill({ status: 404, body: '' });
      const { content } = parseMultipart(req.postData() || '');
      f.content = content;
      f.version++;
      return route.fulfill({ json: asMeta(f) });
    }
    return route.fulfill({ status: 500, body: 'mock: ruta no soportada ' + method + ' ' + url.pathname });
  });

  return { store, counters };
}

async function seedConnection(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('bookreader_drive_refresh_token', JSON.stringify('rt_test'));
    localStorage.setItem('bookreader_ai_key', JSON.stringify('sk-super-secreta'));
  });
}

test.describe('Sync Fase 1 — Drive manual', () => {
  test('hito: guardar en Drive, borrar datos locales, restaurar → todo vuelve', async ({ page }) => {
    const { store, counters } = await installDriveMocks(page);
    await seedConnection(page);
    await page.goto('/');

    // 1) Crear datos: 2 subrayados (uno borrado → tombstone), 1 marcador.
    const saved = await page.evaluate(async () => {
      const H = await import('/js/highlights.js');
      const B = await import('/js/bookmarks.js');
      const DS = await import('/js/sync/drive-sync.js');
      H.setBook('drive-test');
      B.setBook('drive-test');
      H.add('epubcfi(/6/2!/4/2)', 'uno', '#ffeb3b', 'c1');
      H.add('epubcfi(/6/4!/4/2)', 'dos', '#ffeb3b', 'c1');
      H.remove('epubcfi(/6/4!/4/2)');
      B.add('epubcfi(/6/6!/4/2)', 'marca', 'c1');
      return DS.saveToDrive();
    });
    expect(saved.books).toBeGreaterThanOrEqual(1);
    expect(counters.refresh).toBeGreaterThanOrEqual(1); // el token salió del Worker

    // 2) El layout remoto es el del plan: manifest + settings + fichero por libro.
    expect(store.has('bookreader/manifest.json')).toBe(true);
    expect(store.has('bookreader/settings.json')).toBe(true);
    expect(store.has('bookreader/books/drive-test.json')).toBe(true);
    const manifest = JSON.parse(store.get('bookreader/manifest.json')!.content);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.books['drive-test'].file).toBe('books/drive-test.json');
    expect(manifest.books['drive-test'].updatedAt).toBeGreaterThan(0);

    // 3) Los secretos NO viajan a Drive.
    const settingsJson = store.get('bookreader/settings.json')!.content;
    expect(settingsJson).not.toContain('sk-super-secreta');
    expect(settingsJson).not.toContain('rt_test');

    // 4) Borrar datos locales y restaurar: todo vuelve, tombstone incluido.
    const restored = await page.evaluate(async () => {
      localStorage.removeItem('bookreader_highlights_drive-test');
      localStorage.removeItem('bookreader_bookmarks_drive-test');
      const DS = await import('/js/sync/drive-sync.js');
      const r = await DS.restoreFromDrive();
      const H = await import('/js/highlights.js');
      const B = await import('/js/bookmarks.js');
      H.setBook('drive-test');
      B.setBook('drive-test');
      return {
        r,
        vivos: H.getAll().map((h: any) => h.text),
        crudos: H.getAllRaw().length,
        marcadores: B.getAll().length,
      };
    });
    expect(restored.r.keys).toBeGreaterThanOrEqual(2);
    expect(restored.vivos).toEqual(['uno']);
    expect(restored.crudos).toBe(2); // el tombstone viajó
    expect(restored.marcadores).toBe(1);
  });

  test('restaurar sin nada guardado devuelve null (no rompe)', async ({ page }) => {
    await installDriveMocks(page);
    await seedConnection(page);
    await page.goto('/');
    const r = await page.evaluate(async () => {
      const DS = await import('/js/sync/drive-sync.js');
      return DS.restoreFromDrive();
    });
    expect(r).toBeNull();
  });

  test('write con ifMatch caducado falla con 412 (concurrencia optimista)', async ({ page }) => {
    await installDriveMocks(page);
    await seedConnection(page);
    await page.goto('/');
    const res = await page.evaluate(async () => {
      const P = await import('/js/sync/drive-provider.js');
      const w1 = await P.write('bookreader/x.json', '{"a":1}');
      const w2 = await P.write('bookreader/x.json', '{"a":2}');
      let code = null;
      try {
        await P.write('bookreader/x.json', '{"a":3}', { ifMatch: w1.etag });
      } catch (e: any) {
        code = e.code;
      }
      const ok = await P.write('bookreader/x.json', '{"a":3}', { ifMatch: w2.etag });
      return { code, v1: w1.etag, v2: w2.etag, v3: ok.etag };
    });
    expect(res.code).toBe(412);
    expect(res.v1).toBe('1');
    expect(res.v2).toBe('2');
    expect(res.v3).toBe('3');
  });

  test('sin refresh_token, el provider pide reconectar', async ({ page }) => {
    await installDriveMocks(page);
    await page.goto('/');
    const msg = await page.evaluate(async () => {
      const DS = await import('/js/sync/drive-sync.js');
      try {
        await DS.restoreFromDrive();
        return 'no-error';
      } catch (e: any) {
        return e.message;
      }
    });
    expect(msg).toBe('reconnect');
  });
});
