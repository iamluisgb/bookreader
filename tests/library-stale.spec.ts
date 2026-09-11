import { test, expect, BrowserContext, Page } from '@playwright/test';
import { installDriveMocks, seedDriveToken, createDriveState, DriveState, DriveMock } from './drive-mock';
import { seedProLicense } from './pro-license';

// REGRESIÓN: "descargué libros en el móvil y en la tablet no aparecían".
//
// LA CAUSA es la misma enfermedad que ya se curó para `settings.json`
// (sync-settings-race.spec.ts), pero en la BIBLIOTECA, donde no se había
// tratado: la decisión de bajarse `library.json` colgaba de un sello de tiempo
// del manifest (`libraryUpdatedAt`) comparado por IGUALDAD, y ese sello puede
// retroceder. Cuando retrocede al valor que el otro dispositivo ya tiene
// apuntado, ese dispositivo no vuelve a leer `library.json` NUNCA: los libros
// están en Drive todo el tiempo, pero nadie los pide.
//
// Y no hace falta una carrera de relojes para provocarlo, basta un 412 en el
// manifest —dos dispositivos sincronizando cerca, que es lo normal—: el
// reintento vuelve a leer el manifest remoto y, como la biblioteca ya está
// subida, hereda el `libraryUpdatedAt` VIEJO y lo reescribe encima del suyo.
//
// EL ARREGLO (engine.js · 1a): la decisión cuelga de la VERSIÓN del propio
// `library.json`/`covers.json` —la asigna Drive en cada escritura y no puede
// retroceder—, igual que ya hacían los ajustes.

async function bootDevice(context: BrowserContext, state: DriveState): Promise<{ page: Page; drive: DriveMock }> {
  const drive = await installDriveMocks(context, state);
  await seedDriveToken(context);
  const page = await context.newPage();
  await page.goto('/');
  await seedProLicense(page);
  return { page, drive };
}

async function importBook(page: Page, title: string, seed: number, bytes = 1024) {
  return page.evaluate(async ({ title, seed, bytes }) => {
    const Store = await import('/js/library/store.js');
    const DB = await import('/js/ai/db.js');
    const buf = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) buf[i] = (i * 31 + seed) % 251;
    const id = await DB.hashBuffer(buf.buffer.slice(0));
    await Store.putBook({
      id, title, author: 'Autor', format: 'epub', fileName: title + '.epub',
      file: buf.buffer, size: bytes, addedAt: Date.now(), progress: 0,
      status: 'unread', shelfIds: [],
    });
    return id;
  }, { title, seed, bytes });
}

const sync = (page: Page) => page.evaluate(async () => {
  const Engine = await import('/js/sync/engine.js');
  await Engine.syncNow();
});

const titlesOf = (page: Page) => page.evaluate(async () => {
  const Store = await import('/js/library/store.js');
  return (await Store.getAllBooks()).map((b: any) => b.title).sort();
});

test('un 412 en el manifest no puede dejar al otro dispositivo sin ver los libros nuevos', async ({ browser }) => {
  const state = createDriveState();
  const tablet = await browser.newContext();
  const movil = await browser.newContext();
  try {
    const { page: tabletPage } = await bootDevice(tablet, state);
    const { page: movilPage, drive } = await bootDevice(movil, state);

    // Punto de partida: los dos dispositivos han sincronizado una vez, así que
    // ambos tienen apuntado el mismo `libraryUpdatedAt`.
    await sync(tabletPage);
    await sync(movilPage);

    // El móvil añade dos libros y sincroniza, pero su escritura del manifest
    // pilla a otro dispositivo escribiendo (412) y reintenta el ciclo.
    await importBook(movilPage, 'Lituma en los Andes', 7);
    await importBook(movilPage, 'La ciudad y los perros', 11);
    drive.bumpManifestAtFind(state.counters.manifestFinds + 2);  // el 2.º find del ciclo es el del write
    await sync(movilPage);

    // La biblioteca remota SÍ tiene los libros: lo que falla es que nadie la pide.
    const remota = JSON.parse(state.store.get('bookreader/library.json')?.content || '{}');
    expect(Object.keys(remota.books || {}), 'los libros están en Drive').toHaveLength(2);

    // La tablet sincroniza varias veces: lo que se afirma es que no basta con
    // volver a sincronizar, el estado quedaba encallado para siempre.
    for (let i = 0; i < 3; i++) await sync(tabletPage);

    expect(await titlesOf(tabletPage)).toEqual(['La ciudad y los perros', 'Lituma en los Andes']);
  } finally {
    await tablet.close();
    await movil.close();
  }
});
