import { test, expect } from '@playwright/test';

// Fase 0 del sync (SYNC_PLAN.md): backfill idempotente de uid/updatedAt y
// borrado lógico (tombstones) en subrayados, marcadores y stores de IA.

const LEGACY_HIGHLIGHTS = [
  { id: 'epubcfi(/6/4!/4/2)', cfi: 'epubcfi(/6/4!/4/2)', text: 'pasaje', color: '#ffeb3b', chapter: 'Cap 1', note: '', timestamp: 1000 },
  { id: 'pdf-3-111-abc', page: 3, rects: [], text: 'pdf', color: '#ffeb3b', chapter: 'Pág. 3', note: '', timestamp: 2000 },
];
const LEGACY_BOOKMARKS = [
  { cfi: 'epubcfi(/6/8!/4/2)', title: 'marca', chapter: '', page: null, total: null, timestamp: 3000 },
];

test.describe('Sync Fase 0 — migración de esquema', () => {
  test('backfill de uid/updatedAt en datos legacy, idempotente', async ({ page }) => {
    await page.addInitScript(([h, b]) => {
      localStorage.setItem('bookreader_highlights_migratest', JSON.stringify(h));
      localStorage.setItem('bookreader_bookmarks_migratest', JSON.stringify(b));
    }, [LEGACY_HIGHLIGHTS, LEGACY_BOOKMARKS] as const);
    await page.goto('/');
    await page.waitForFunction(() => localStorage.getItem('bookreader_sync_schema_migrated') !== null);

    const first = await page.evaluate(() => ({
      h: localStorage.getItem('bookreader_highlights_migratest')!,
      b: localStorage.getItem('bookreader_bookmarks_migratest')!,
    }));
    const [epubH, pdfH] = JSON.parse(first.h);
    // EPUB: el CFI es la identidad global; PDF: hereda su id local estable.
    expect(epubH.uid).toBe('epubcfi(/6/4!/4/2)');
    expect(epubH.updatedAt).toBe(1000);
    expect(pdfH.uid).toBe('pdf-3-111-abc');
    expect(pdfH.updatedAt).toBe(2000);
    const [bm] = JSON.parse(first.b);
    expect(bm.uid).toBe('epubcfi(/6/8!/4/2)');
    expect(bm.updatedAt).toBe(3000);

    // Segunda pasada forzada: no cambia nada (idempotente).
    const second = await page.evaluate(async () => {
      const schema = await import('/js/sync/schema.js');
      await schema.backfillAll();
      return {
        h: localStorage.getItem('bookreader_highlights_migratest')!,
        b: localStorage.getItem('bookreader_bookmarks_migratest')!,
      };
    });
    expect(second).toEqual(first);
  });

  test('borrar subrayado deja tombstone; getAll lo oculta; re-añadir resucita', async ({ page }) => {
    await page.goto('/');
    const res = await page.evaluate(async () => {
      const H = await import('/js/highlights.js');
      const cfi = 'epubcfi(/6/2!/4/2)';
      H.setBook('tombstone-book');
      H.add(cfi, 'texto', '#ffeb3b', 'cap');
      H.remove(cfi);
      const afterRemove = { live: H.getAll().length, raw: H.getAllRaw() };
      H.add(cfi, 'texto', '#a5d6a7', 'cap');
      const afterReadd = { live: H.getAll(), raw: H.getAllRaw() };
      return { afterRemove, afterReadd };
    });
    expect(res.afterRemove.live).toBe(0);
    expect(res.afterRemove.raw).toHaveLength(1);
    expect(res.afterRemove.raw[0].deleted).toBe(true);
    expect(res.afterRemove.raw[0].deletedAt).toBeGreaterThan(0);
    // Resucitado: mismo uid (CFI), sin tombstone, color nuevo, sin duplicar.
    expect(res.afterReadd.raw).toHaveLength(1);
    expect(res.afterReadd.live).toHaveLength(1);
    expect(res.afterReadd.live[0].uid).toBe('epubcfi(/6/2!/4/2)');
    expect(res.afterReadd.live[0].deleted).toBeUndefined();
    expect(res.afterReadd.live[0].color).toBe('#a5d6a7');
  });

  test('bookmarks: toggle deja tombstone y re-toggle resucita sin duplicar', async ({ page }) => {
    await page.goto('/');
    const res = await page.evaluate(async () => {
      const B = await import('/js/bookmarks.js');
      const cfi = 'epubcfi(/6/6!/4/2)';
      B.setBook('tombstone-book');
      B.toggle(cfi, 'Marca', 'cap');
      B.toggle(cfi, 'Marca', 'cap'); // borra → tombstone
      const afterRemove = { has: B.has(cfi), raw: B.getAllRaw() };
      B.toggle(cfi, 'Marca', 'cap'); // resucita
      const afterReadd = { has: B.has(cfi), raw: B.getAllRaw() };
      return { afterRemove, afterReadd };
    });
    expect(res.afterRemove.has).toBe(false);
    expect(res.afterRemove.raw).toHaveLength(1);
    expect(res.afterRemove.raw[0].deleted).toBe(true);
    expect(res.afterReadd.has).toBe(true);
    expect(res.afterReadd.raw).toHaveLength(1);
    expect(res.afterReadd.raw[0].deleted).toBeUndefined();
    expect(res.afterReadd.raw[0].uid).toBe('epubcfi(/6/6!/4/2)');
  });

  test('IndexedDB: backfill da uid estable a messages legacy; los nuevos ya lo traen', async ({ page }) => {
    await page.goto('/');
    const res = await page.evaluate(async () => {
      const DB = await import('/js/ai/db.js');
      // Registro legacy (sin uid), como los anteriores a la Fase 0.
      await DB.put('messages', { convoId: 'cv_legacy', role: 'user', content: 'hola', ts: 111 });
      await DB.backfillSyncFields();
      const find = async () => (await DB.getAll('messages')).find((m: any) => m.convoId === 'cv_legacy');
      const m1 = await find();
      await DB.backfillSyncFields(); // segunda pasada: uid estable
      const m2 = await find();
      const newMsg = await DB.addMessage('cv_new', 'user', 'nuevo').then(async () =>
        (await DB.getAll('messages')).find((m: any) => m.convoId === 'cv_new'));
      return { m1, m2, newMsg };
    });
    expect(res.m1.uid).toBeTruthy();
    expect(res.m1.updatedAt).toBe(111);
    expect(res.m2.uid).toBe(res.m1.uid);
    expect(res.newMsg.uid).toBeTruthy();
    expect(res.newMsg.updatedAt).toBeGreaterThan(0);
  });

  test('IndexedDB: deleteNote deja tombstone y getNotes lo oculta', async ({ page }) => {
    await page.goto('/');
    const res = await page.evaluate(async () => {
      const DB = await import('/js/ai/db.js');
      await DB.addNote('cv_notes', 'ideas', 'contenido');
      const [note] = await DB.getNotes('cv_notes');
      await DB.deleteNote(note.id);
      const visible = await DB.getNotes('cv_notes');
      const raw = (await DB.getAll('notes')).filter((n: any) => n.convoId === 'cv_notes');
      return { uid: note.uid, visible, raw };
    });
    expect(res.uid).toBeTruthy();
    expect(res.visible).toHaveLength(0);
    expect(res.raw).toHaveLength(1);
    expect(res.raw[0].deleted).toBe(true);
    expect(res.raw[0].uid).toBe(res.uid);
  });

  test('purga: los tombstones caducados desaparecen, los recientes no', async ({ page }) => {
    await page.goto('/');
    const res = await page.evaluate(async () => {
      const H = await import('/js/highlights.js');
      const schema = await import('/js/sync/schema.js');
      H.setBook('purge-book');
      H.add('epubcfi(/6/2!/4/2)', 'viejo', '#ffeb3b', 'cap');
      H.add('epubcfi(/6/4!/4/2)', 'reciente', '#ffeb3b', 'cap');
      H.remove('epubcfi(/6/2!/4/2)');
      H.remove('epubcfi(/6/4!/4/2)');
      // Simula que el primer tombstone caducó hace tiempo.
      const raw = H.getAllRaw();
      raw[0].deletedAt = Date.now() - schema.TOMBSTONE_TTL_MS - 1000;
      localStorage.setItem('bookreader_highlights_purge-book', JSON.stringify(raw));
      await schema.purgeExpiredTombstones();
      return H.getAllRaw();
    });
    expect(res).toHaveLength(1);
    expect(res[0].cfi).toBe('epubcfi(/6/4!/4/2)');
    expect(res[0].deleted).toBe(true);
  });
});
