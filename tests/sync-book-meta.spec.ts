import { test, expect, BrowserContext, Page } from '@playwright/test';
import { installDriveMocks, seedDriveToken, createDriveState, DriveState } from './drive-mock';

// Título y autor editados (library/book-meta.js) entre DOS dispositivos con el mismo Drive
// (contextos aislados: cada uno su IndexedDB). Lo que se fija:
//   - el cambio llega al otro, con el original;
//   - el otro lo conserva aunque haya leído (tocado el progreso) sin haberlo recibido aún;
//   - renombrar no rompe el reconocimiento del mismo libro con distinto hash (aliases.js),
//     que va por título: los subrayados se siguen cruzando.
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

async function boot(context: BrowserContext, state: DriveState): Promise<Page> {
  await installDriveMocks(context, state);
  await seedDriveToken(context);
  const page = await context.newPage();
  await page.goto('/');
  return page;
}
const sync = (p: Page) => p.evaluate(async () => (await import('/js/sync/engine.js')).syncNow());
const put = (p: Page, id: string, title: string, author = '') => p.evaluate(async ({ id, title, author }) => {
  const S: any = await import('/js/library/store.js');
  await S.putBook({ id, title, author, origTitle: title, origAuthor: author, format: 'epub', addedAt: Date.now(), status: 'unread', progress: 0, shelfIds: [] });
}, { id, title, author });
const rename = (p: Page, id: string, title: string, author: string) => p.evaluate(async ({ id, title, author }) => {
  const S: any = await import('/js/library/store.js');
  await S.updateBook(id, { title, author, metaAt: Date.now() });   // como book-meta.js
}, { id, title, author });
const rec = (p: Page, id: string) => p.evaluate(async ({ id }) => {
  const S: any = await import('/js/library/store.js');
  const b = await S.getBook(id);
  return b && { title: b.title, author: b.author, origTitle: b.origTitle, progress: b.progress };
}, { id });

const LONG = 'Designing Data-Intensive Applications: The Big Ideas Behind Reliable Systems';

test('renombrar en el PC llega al móvil, con el original', async ({ browser }) => {
  const drive = createDriveState();
  const [pc, mv] = [await browser.newContext(), await browser.newContext()];
  try {
    const pcP = await boot(pc, drive), mvP = await boot(mv, drive);
    await put(pcP, A, LONG, 'Kleppmann, Martin');
    await sync(pcP); await sync(mvP);
    expect((await rec(mvP, A))!.title).toBe(LONG);

    await rename(pcP, A, 'DDIA', 'Martin Kleppmann');
    await sync(pcP); await sync(mvP);
    expect(await rec(mvP, A)).toMatchObject({ title: 'DDIA', author: 'Martin Kleppmann', origTitle: LONG });
  } finally { await pc.close(); await mv.close(); }
});

test('el móvil lee (progreso) sin haber recibido el cambio: el nombre nuevo no se pierde', async ({ browser }) => {
  const drive = createDriveState();
  const [pc, mv] = [await browser.newContext(), await browser.newContext()];
  try {
    const pcP = await boot(pc, drive), mvP = await boot(mv, drive);
    await put(pcP, A, LONG);
    await sync(pcP); await sync(mvP);

    await rename(pcP, A, 'DDIA', '');
    await sync(pcP);
    // El móvil avanza DESPUÉS del renombrado, pero sin haberlo bajado todavía.
    await mvP.waitForTimeout(20);
    await mvP.evaluate(async ({ id }) => {
      const S: any = await import('/js/library/store.js');
      await S.updateBook(id, { progress: 40, status: 'reading' });
    }, { id: A });
    await sync(mvP); await sync(pcP);

    for (const p of [pcP, mvP]) expect(await rec(p, A)).toMatchObject({ title: 'DDIA', progress: 40 });
  } finally { await pc.close(); await mv.close(); }
});

test('renombrar no rompe el reconocimiento del mismo libro con distinto hash', async ({ browser }) => {
  const drive = createDriveState();
  const [pc, mv] = [await browser.newContext(), await browser.newContext()];
  try {
    const pcP = await boot(pc, drive), mvP = await boot(mv, drive);
    await put(pcP, A, 'Lituma en los Andes');
    await rename(pcP, A, 'Lituma', '');           // renombrado ANTES de que el otro lo vea
    await put(mvP, B, 'Lituma en los Andes');     // otra descarga del mismo libro
    await sync(pcP); await sync(mvP); await sync(pcP);
    const canon = await Promise.all([pcP, mvP].map(p => p.evaluate(async ({ a, b }) => {
      const Al: any = await import('/js/sync/aliases.js');
      return [Al.canonicalOf(a), Al.canonicalOf(b)];
    }, { a: A, b: B })));
    for (const [ca, cb] of canon) expect(ca).toBe(cb);
  } finally { await pc.close(); await mv.close(); }
});

test('vaciar el autor a propósito no lo rellena el otro dispositivo', async ({ browser }) => {
  const drive = createDriveState();
  const [pc, mv] = [await browser.newContext(), await browser.newContext()];
  try {
    const pcP = await boot(pc, drive), mvP = await boot(mv, drive);
    await put(pcP, A, LONG, 'O\'Reilly Media');
    await sync(pcP); await sync(mvP);
    await rename(pcP, A, LONG, '');
    await sync(pcP); await sync(mvP); await sync(pcP);
    for (const p of [pcP, mvP]) expect((await rec(p, A))!.author).toBe('');
  } finally { await pc.close(); await mv.close(); }
});

test('mergeMaps con sello propio: conmutativo e idempotente', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const { mergeMaps } = await import('/js/sync/merge.js');
    const opts = { monotone: ['title', 'author'], stamped: [{ at: 'metaAt', fields: ['title', 'author'] }] };
    const l = { x: { title: 'Viejo', author: 'A', updatedAt: 300, progress: 40 } };
    const rr = { x: { title: 'Nuevo', author: '', metaAt: 200, updatedAt: 200, progress: 10 } };
    const ab = mergeMaps(l, rr, opts), ba = mergeMaps(rr, l, opts);
    return { ab, ba, again: mergeMaps(ab, ab, opts) };
  });
  expect(r.ab).toEqual(r.ba);
  expect(r.again).toEqual(r.ab);
  expect(r.ab.x).toMatchObject({ title: 'Nuevo', author: '', progress: 40, metaAt: 200 });
});
