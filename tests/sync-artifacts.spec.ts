// Sync de los artefactos del Studio (resúmenes / mapas mentales).
//
// Antes no viajaban: el store `artifacts` no estaba en SYNCED_STORES ni en el snapshot, así
// que un resumen generado en el PC no existía en el móvil. No es cosmético — regenerarlo
// cuesta llamadas al modelo, o sea que el usuario lo pagaba dos veces.
import { test, expect, BrowserContext, Page } from '@playwright/test';
import { installDriveMocks, seedDriveToken, createDriveState, DriveState } from './drive-mock';

const BOOK = 'c'.repeat(64);

async function bootDevice(context: BrowserContext, state: DriveState): Promise<Page> {
  await installDriveMocks(context, state);
  await seedDriveToken(context);
  const page = await context.newPage();
  await page.goto('/');
  return page;
}

async function registerBook(page: Page, id: string, title: string) {
  await page.evaluate(async ({ id, title }) => {
    const Lib = await import('/js/library/store.js');
    await Lib.putBook({ id, title, addedAt: Date.now() });
  }, { id, title });
}

async function putArtifact(page: Page, bookId: string, kind: string, result: any) {
  return page.evaluate(async ({ bookId, kind, result }) => {
    const DB = await import('/js/ai/db.js');
    return DB.putArtifact({ bookId, kind, result, params: { scopeName: 'Libro entero' } });
  }, { bookId, kind, result });
}

async function artifactsOf(page: Page, bookId: string) {
  return page.evaluate(async ({ bookId }) => {
    const DB = await import('/js/ai/db.js');
    const list = await DB.getArtifacts(bookId);
    return list.map((a: any) => ({ kind: a.kind, result: a.result })).sort((a: any, b: any) => a.kind.localeCompare(b.kind));
  }, { bookId });
}

async function sync(page: Page) {
  await page.evaluate(async () => {
    const Engine = await import('/js/sync/engine.js');
    await Engine.syncNow();
  });
}

test.describe('Sync de artefactos · dos dispositivos', () => {
  test('el resumen y el mapa creados en el PC aparecen en el móvil', async ({ browser }) => {
    test.setTimeout(120000);
    const state = createDriveState();
    const pc = await browser.newContext();
    const movil = await browser.newContext();
    const pcPage = await bootDevice(pc, state);
    const movilPage = await bootDevice(movil, state);

    await registerBook(pcPage, BOOK, 'Build a Large Language Model');
    await putArtifact(pcPage, BOOK, 'summary', '## TL;DR\nEl libro construye un GPT desde cero [[a4]]');
    await putArtifact(pcPage, BOOK, 'mindmap', { root: 'GPT', children: [{ label: 'Tokenizador' }] });
    await sync(pcPage);

    // El móvil no sabía nada de este libro hasta ahora.
    expect(await artifactsOf(movilPage, BOOK)).toEqual([]);
    await sync(movilPage);

    const got = await artifactsOf(movilPage, BOOK);
    expect(got).toHaveLength(2);
    expect(got[0].kind).toBe('mindmap');
    expect(got[1].kind).toBe('summary');
    expect(got[1].result).toContain('construye un GPT desde cero');

    await pc.close();
    await movil.close();
  });

  test('borrar un artefacto en un dispositivo no lo resucita el otro', async ({ browser }) => {
    test.setTimeout(120000);
    const state = createDriveState();
    const pc = await browser.newContext();
    const movil = await browser.newContext();
    const pcPage = await bootDevice(pc, state);
    const movilPage = await bootDevice(movil, state);

    await registerBook(pcPage, BOOK, 'Libro');
    const key = await putArtifact(pcPage, BOOK, 'summary', 'resumen viejo');
    await sync(pcPage);
    await sync(movilPage);
    expect(await artifactsOf(movilPage, BOOK)).toHaveLength(1);

    // Se borra en el PC…
    await pcPage.evaluate(async (k) => {
      const DB = await import('/js/ai/db.js');
      await DB.deleteArtifact(k);
    }, key);
    expect(await artifactsOf(pcPage, BOOK)).toHaveLength(0);
    await sync(pcPage);

    // …y el móvil, que aún lo tiene, debe aceptar el borrado en vez de re-subirlo.
    await sync(movilPage);
    expect(await artifactsOf(movilPage, BOOK)).toHaveLength(0);

    // Y el PC no debe recuperarlo en el ciclo siguiente (el bucle clásico de resurrección).
    await sync(pcPage);
    expect(await artifactsOf(pcPage, BOOK)).toHaveLength(0);

    await pc.close();
    await movil.close();
  });

  test('cada dispositivo genera el suyo: se conservan los dos', async ({ browser }) => {
    test.setTimeout(120000);
    const state = createDriveState();
    const pc = await browser.newContext();
    const movil = await browser.newContext();
    const pcPage = await bootDevice(pc, state);
    const movilPage = await bootDevice(movil, state);

    await registerBook(pcPage, BOOK, 'Libro');
    await registerBook(movilPage, BOOK, 'Libro');
    await putArtifact(pcPage, BOOK, 'summary', 'resumen del PC');
    await putArtifact(movilPage, BOOK, 'summary', 'resumen del móvil');

    await sync(pcPage);
    await sync(movilPage);
    await sync(pcPage);

    // La clave lleva un UUID: son artefactos distintos, no una colisión que pise a uno.
    const pcSide = await artifactsOf(pcPage, BOOK);
    const movilSide = await artifactsOf(movilPage, BOOK);
    expect(pcSide).toHaveLength(2);
    expect(movilSide).toHaveLength(2);
    expect(pcSide.map((a: any) => a.result).sort()).toEqual(['resumen del PC', 'resumen del móvil']);

    await pc.close();
    await movil.close();
  });
});

test.describe('unidades del merge de artefactos', () => {
  test('mergeArtifacts es idempotente y respeta el updatedAt mayor', async ({ page }) => {
    await page.goto('/');
    const out = await page.evaluate(async () => {
      const DB: any = await import('/js/ai/db.js');
      const base = {
        key: 'b:summary:1', id: '1', uid: 'u1', bookId: 'b', kind: 'summary',
        params: {}, segVersion: 1, createdAt: 1000, updatedAt: 1000,
      };
      await DB.mergeArtifacts([{ ...base, result: 'viejo' }]);
      await DB.mergeArtifacts([{ ...base, result: 'viejo' }]);           // idempotente
      const dup = (await DB.getAll('artifacts')).filter((a: any) => a.key === 'b:summary:1').length;
      await DB.mergeArtifacts([{ ...base, result: 'nuevo', updatedAt: 2000 }]);
      const after = await DB.get('artifacts', 'b:summary:1');
      await DB.mergeArtifacts([{ ...base, result: 'antiguo otra vez', updatedAt: 500 }]);
      const stillNew = await DB.get('artifacts', 'b:summary:1');
      return { dup, after: after.result, stillNew: stillNew.result };
    });
    expect(out.dup).toBe(1);
    expect(out.after).toBe('nuevo');
    expect(out.stillNew).toBe('nuevo');    // un remoto más viejo no pisa
  });

  test('el tombstone gana el empate de updatedAt (determinista en los dos lados)', async ({ page }) => {
    await page.goto('/');
    const deleted = await page.evaluate(async () => {
      const DB: any = await import('/js/ai/db.js');
      const base = {
        key: 'b:summary:2', id: '2', uid: 'u2', bookId: 'b', kind: 'summary',
        params: {}, segVersion: 1, createdAt: 1, updatedAt: 5000,
      };
      await DB.mergeArtifacts([{ ...base, result: 'vivo' }]);
      await DB.mergeArtifacts([{ ...base, result: null, deleted: true, deletedAt: 5000 }]);
      return (await DB.get('artifacts', 'b:summary:2')).deleted;
    });
    expect(deleted).toBe(true);
  });

  test('un artefacto borrado no lo devuelve getArtifacts', async ({ page }) => {
    await page.goto('/');
    const n = await page.evaluate(async () => {
      const DB: any = await import('/js/ai/db.js');
      const key = await DB.putArtifact({ bookId: 'zz', kind: 'summary', result: 'x' });
      await DB.deleteArtifact(key);
      return (await DB.getArtifacts('zz')).length;
    });
    expect(n).toBe(0);
  });

  test('generar un artefacto avisa al SyncEngine (dispara el push)', async ({ page }) => {
    await page.goto('/');
    const fired = await page.evaluate(async () => {
      const DB: any = await import('/js/ai/db.js');
      let n = 0;
      window.addEventListener('bookreader:data-changed', () => { n++; });
      await DB.putArtifact({ bookId: 'yy', kind: 'mindmap', result: {} });
      await new Promise((r) => setTimeout(r, 50));
      return n;
    });
    expect(fired).toBeGreaterThan(0);
  });
});

// Límite conocido: si el MISMO libro tiene hashes distintos en cada dispositivo (dos
// descargas no byte-idénticas), los subrayados se reconcilian por título (sync/aliases.js)
// pero los artefactos NO: su clave lleva el bookId crudo. Con el fichero sincronizado
// (Fase B) los hashes coinciden y el caso no se da, pero conviene tenerlo escrito.
test('hash distinto: los artefactos NO se reconcilian por alias (límite documentado)', async ({ browser }) => {
  test.setTimeout(120000);
  const state = createDriveState();
  const pc = await browser.newContext();
  const movil = await browser.newContext();
  const pcPage = await bootDevice(pc, state);
  const movilPage = await bootDevice(movil, state);

  const HASH_PC = 'd'.repeat(64);
  const HASH_MOVIL = 'e'.repeat(64);
  await registerBook(pcPage, HASH_PC, 'Mismo Libro');
  await registerBook(movilPage, HASH_MOVIL, 'Mismo Libro');
  await putArtifact(pcPage, HASH_PC, 'summary', 'resumen del PC');

  await sync(pcPage);
  await sync(movilPage);

  // El artefacto viaja (existe en el móvil bajo el id del PC)…
  expect(await artifactsOf(movilPage, HASH_PC)).toHaveLength(1);
  // …pero el móvil abre SU hash, y ahí no aparece.
  expect(await artifactsOf(movilPage, HASH_MOVIL)).toHaveLength(0);

  await pc.close();
  await movil.close();
});
