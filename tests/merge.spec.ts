import { test, expect } from '@playwright/test';

// Fase 2 · merge por item: unión por uid, LWW, tombstones. Cubre el escenario
// "mismo libro con notas distintas en dos dispositivos" (hito del SYNC_PLAN:
// editar en dos sitios no pierde datos).

test.describe('Sync Fase 2 — mergeCollections (puro)', () => {
  test('unión, LWW por item, tombstones y propiedades algebraicas', async ({ page }) => {
    await page.goto('/');
    const res = await page.evaluate(async () => {
      const { mergeCollections } = await import('/js/sync/merge.js');
      const soloLocal = { uid: 'a', text: 'solo-local', updatedAt: 100 };
      const soloRemoto = { uid: 'b', text: 'solo-remoto', updatedAt: 100 };
      const conflictoL = { uid: 'c', text: 'viejo', updatedAt: 100 };
      const conflictoR = { uid: 'c', text: 'nuevo', updatedAt: 200 };
      const borradoR = { uid: 'd', deleted: true, deletedAt: 300, updatedAt: 300 };
      const vivoL = { uid: 'd', text: 'vivo', updatedAt: 100 };

      const local = [soloLocal, conflictoL, vivoL];
      const remote = [soloRemoto, conflictoR, borradoR];
      const ab = mergeCollections(local, remote);
      const ba = mergeCollections(remote, local);
      const aa = mergeCollections(local, local);
      const sort = (l: any[]) => [...l].sort((x, y) => x.uid.localeCompare(y.uid));
      return { ab: sort(ab), ba: sort(ba), aa: sort(aa), local: sort(local) };
    });
    // Unión: 4 uids; LWW: gana 'nuevo'; tombstone: 'd' queda borrado.
    expect(res.ab.map((i: any) => i.uid)).toEqual(['a', 'b', 'c', 'd']);
    expect(res.ab.find((i: any) => i.uid === 'c').text).toBe('nuevo');
    expect(res.ab.find((i: any) => i.uid === 'd').deleted).toBe(true);
    // Conmutativo e idempotente.
    expect(res.ab).toEqual(res.ba);
    expect(res.aa).toEqual(res.local);
  });
});

test.describe('Sync Fase 2 — restaurar fusiona (escenario dos dispositivos)', () => {
  test('notas distintas del mismo libro en A y B: restaurar une sin perder nada', async ({ page }) => {
    // Mock de Drive compartido entre "dispositivos" (mismo store del test).
    const store = new Map<string, { id: string; name: string; content: string; version: number }>();
    let nextId = 1;
    await page.route('https://bookreader-auth.luisgonzalezb93.workers.dev/**', (route) =>
      route.fulfill({ json: { access_token: 'tok', expires_in: 3600 } }));
    await page.route('https://www.googleapis.com/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const asMeta = (f: any) => ({ id: f.id, name: f.name, version: String(f.version), modifiedTime: new Date().toISOString() });
      if (url.pathname === '/drive/v3/files' && req.method() === 'GET') {
        let files = [...store.values()];
        const m = url.searchParams.get('q')?.match(/name='(.+)'/);
        if (m) files = files.filter((f) => f.name === m[1].replace(/\\'/g, "'"));
        return route.fulfill({ json: { files: files.map(asMeta) } });
      }
      const dl = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
      if (dl && req.method() === 'GET') {
        const f = [...store.values()].find((x) => x.id === dl[1]);
        return f ? route.fulfill({ body: f.content }) : route.fulfill({ status: 404, body: '' });
      }
      const parts = (req.postData() || '').split('-----bookreader_boundary')
        .map((p) => p.split('\r\n\r\n')[1]).filter((p): p is string => p !== undefined)
        .map((p) => p.replace(/\r\n$/, ''));
      if (url.pathname === '/upload/drive/v3/files' && req.method() === 'POST') {
        const f = { id: 'f' + nextId++, name: JSON.parse(parts[0]).name, content: parts[1], version: 1 };
        store.set(f.name, f);
        return route.fulfill({ json: asMeta(f) });
      }
      const up = url.pathname.match(/^\/upload\/drive\/v3\/files\/([^/]+)$/);
      if (up && req.method() === 'PATCH') {
        const f = [...store.values()].find((x) => x.id === up[1])!;
        f.content = parts[1];
        f.version++;
        return route.fulfill({ json: asMeta(f) });
      }
      return route.fulfill({ status: 500, body: 'mock' });
    });
    await page.addInitScript(() => {
      localStorage.setItem('bookreader_drive_refresh_token', JSON.stringify('rt'));
    });
    await page.goto('/');

    // Dispositivo A: dos subrayados de "lituma", uno con nota; guarda en Drive.
    await page.evaluate(async () => {
      const H = await import('/js/highlights.js');
      const DS = await import('/js/sync/drive-sync.js');
      H.setBook('lituma');
      H.add('epubcfi(/6/2!/4/2)', 'pasaje uno', '#ffeb3b', 'c1', 'nota de A');
      H.add('epubcfi(/6/4!/4/2)', 'pasaje dos', '#ffeb3b', 'c1');
      await DS.saveToDrive();
    });

    // Dispositivo B: estado local DISTINTO para el mismo libro (se simula
    // vaciando y recreando): un subrayado propio + una edición más reciente
    // del pasaje dos. Restaurar debe unir, no pisar.
    const res = await page.evaluate(async () => {
      localStorage.removeItem('bookreader_highlights_lituma');
      const H = await import('/js/highlights.js');
      const DS = await import('/js/sync/drive-sync.js');
      H.setBook('lituma');
      H.add('epubcfi(/6/8!/4/2)', 'pasaje tres (solo B)', '#a5d6a7', 'c2', 'nota de B');
      H.add('epubcfi(/6/4!/4/2)', 'pasaje dos', '#ef9a9a', 'c1', 'nota editada en B');
      const r = await DS.restoreFromDrive();
      const vivos = H.getAll().sort((a: any, b: any) => a.cfi.localeCompare(b.cfi));
      return { r, vivos };
    });

    // Unión: los 2 de A + el propio de B = 3, sin duplicar el pasaje compartido.
    expect(res.vivos).toHaveLength(3);
    const dos = res.vivos.find((h: any) => h.cfi === 'epubcfi(/6/4!/4/2)');
    // LWW por item: la edición de B es posterior al guardado de A → gana B.
    expect(dos.note).toBe('nota editada en B');
    expect(dos.color).toBe('#ef9a9a');
    expect(res.vivos.find((h: any) => h.cfi === 'epubcfi(/6/2!/4/2)').note).toBe('nota de A');
    expect(res.vivos.find((h: any) => h.cfi === 'epubcfi(/6/8!/4/2)').note).toBe('nota de B');
  });

  test('IDB: los ids autoincrementales no colisionan — casa por uid, remapea ids', async ({ page }) => {
    await page.goto('/');
    const res = await page.evaluate(async () => {
      const DB = await import('/js/ai/db.js');
      await DB.addNote('cv_merge', 'ideas', 'nota local');
      const [localNote] = await DB.getNotes('cv_merge');
      // "Remoto": otro dispositivo, MISMO id numérico pero uid distinto (+ una
      // edición más reciente de una nota que sí compartimos).
      const written = await DB.mergeRecords('notes', [
        { id: localNote.id, uid: 'uid-remoto-1', convoId: 'cv_merge', fieldKey: 'ideas', content: 'nota remota', updatedAt: Date.now() + 1000 },
        { id: 999, uid: localNote.uid, convoId: 'cv_merge', fieldKey: 'ideas', content: 'local editada en remoto', updatedAt: Date.now() + 2000 },
      ]);
      const notes = await DB.getNotes('cv_merge');
      return { written, notes, localId: localNote.id };
    });
    expect(res.written).toBe(2);
    expect(res.notes).toHaveLength(2); // unión, sin pisar la local
    const editada = res.notes.find((n: any) => n.content === 'local editada en remoto');
    const remota = res.notes.find((n: any) => n.content === 'nota remota');
    expect(editada.id).toBe(res.localId);   // LWW conservando el id local
    expect(remota.id).not.toBe(res.localId); // insertada con id nuevo
  });
});
