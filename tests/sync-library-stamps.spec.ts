import { test, expect, BrowserContext, Page } from '@playwright/test';
import { installDriveMocks, seedDriveToken, createDriveState, DriveState } from './drive-mock';

// Estanterías y estado de un libro con su propio sello (`shelvesAt`, `statusAt`; ver
// library/store.js · stampGroups y sync/library-sync.js · STAMPED). El caso que lo pide: se
// organiza la biblioteca en un sitio (o un agente por MCP) y, sin haber bajado el cambio, otro
// dispositivo pasa una página del mismo libro. Con LWW por registro, el pase de página ganaba y
// la organización se perdía sin avisar.
const A = 'a'.repeat(64);

async function boot(context: BrowserContext, state: DriveState): Promise<Page> {
  await installDriveMocks(context, state);
  await seedDriveToken(context);
  const page = await context.newPage();
  await page.goto('/');
  return page;
}
const sync = (p: Page) => p.evaluate(async () => (await import('/js/sync/engine.js')).syncNow());
const rec = (p: Page, id: string) => p.evaluate(async ({ id }) => {
  const S: any = await import('/js/library/store.js');
  const b = await S.getBook(id);
  return b && { shelfIds: b.shelfIds, status: b.status, progress: b.progress, finished: !!b.finishedAt };
}, { id });
// Pasar página como lo hace la app (app.js: el estado se deriva del progreso).
const turnPage = (p: Page, id: string, pct: number) => p.evaluate(async ({ id, pct }) => {
  const S: any = await import('/js/library/store.js');
  await S.updateBook(id, (cur: any) => ({ progress: pct, status: S.statusFor(pct, cur.status) }));
}, { id, pct });

test('mover a una estantería y marcar terminado en el PC sobrevive a un pase de página en el móvil', async ({ browser }) => {
  const drive = createDriveState();
  const [pc, mv] = [await browser.newContext(), await browser.newContext()];
  try {
    const pcP = await boot(pc, drive), mvP = await boot(mv, drive);
    await pcP.evaluate(async ({ id }) => {
      const S: any = await import('/js/library/store.js');
      await S.putBook({ id, title: 'DDIA', author: 'Kleppmann', format: 'epub', addedAt: Date.now(), status: 'reading', progress: 30, shelfIds: [] });
    }, { id: A });
    await sync(pcP); await sync(mvP);

    // PC: a la estantería «Bases de datos» y terminado a mano (como view.js).
    await pcP.evaluate(async ({ id }) => {
      const S: any = await import('/js/library/store.js');
      const sh = await S.addShelf('Técnico/Bases de datos');
      await S.toggleBookShelf(id, sh.id ?? sh, true);
      await S.updateBook(id, { status: 'finished' });
    }, { id: A });
    await sync(pcP);
    // Móvil: lee DESPUÉS, sin haber bajado nada.
    await mvP.waitForTimeout(20);
    await turnPage(mvP, A, 35);
    await sync(mvP); await sync(pcP); await sync(mvP);

    for (const p of [pcP, mvP]) {
      const r = await rec(p, A);
      expect(r!.shelfIds).toHaveLength(1);
      expect(r).toMatchObject({ status: 'finished', progress: 35, finished: true });
    }
  } finally { await pc.close(); await mv.close(); }
});

test('el estado que se deriva al leer no sella: no le gana a uno puesto a mano en otro sitio', async ({ page }) => {
  await page.goto('/');
  const out = await page.evaluate(async ({ id }) => {
    const S: any = await import('/js/library/store.js');
    await S.putBook({ id, title: 'X', format: 'epub', addedAt: 1, status: 'unread', progress: 0, shelfIds: [] });
    await S.updateBook(id, (cur: any) => ({ progress: 10, status: S.statusFor(10, cur.status) }));
    const auto = await S.getBook(id);
    await S.updateBook(id, { status: 'finished' });
    const manual = await S.getBook(id);
    return { autoStamped: !!auto.statusAt, autoStatus: auto.status, manualStamped: !!manual.statusAt };
  }, { id: A });
  expect(out).toEqual({ autoStamped: false, autoStatus: 'reading', manualStamped: true });
});
