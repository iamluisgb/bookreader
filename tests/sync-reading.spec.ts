import { test, expect, BrowserContext, Page } from '@playwright/test';
import { installDriveMocks, seedDriveToken, createDriveState, DriveState } from './drive-mock';

// P25 F3 — los días de lectura entre dispositivos. Lo que se prueba no es "viaja el dato"
// sino la propiedad que hace que viajar sea seguro: cada equipo escribe SOLO su fila
// (`${día}|${deviceId}`), así que fusionar es UNIR y leer el mismo martes en dos sitios
// SUMA. Con una fila por día, el LWW se habría comido una de las dos lecturas.

async function bootDevice(context: BrowserContext, state: DriveState): Promise<Page> {
  await installDriveMocks(context, state);
  await seedDriveToken(context);
  const page = await context.newPage();
  await page.goto('/');
  return page;
}

// Siembra lectura a ritmo humano: `steps` vueltas de página, una unidad cada 96 s.
async function read(page: Page, bookId: string, steps: number, dayOffset = 0) {
  await page.evaluate(async ({ bookId, steps, dayOffset }) => {
    const RL: any = await import('/js/reading-log.js');
    const start = Date.now() - dayOffset * 86400000;
    await RL.startBook(bookId, { unitWords: 205, maxStep: 4 });
    let t = start;
    for (let k = 0; k < steps; k++) { RL.position(100 + k, t); t += 96000; }
    await RL.endBook(t);
  }, { bookId, steps, dayOffset });
}

async function sync(page: Page) {
  await page.evaluate(async () => {
    const Engine: any = await import('/js/sync/engine.js');
    await Engine.syncNow();
  });
}

async function minutes(page: Page, days = 7): Promise<number> {
  return page.evaluate(async (days) => {
    const RL: any = await import('/js/reading-log.js');
    const s = await RL.summary(days);
    return Math.round(s.ms / 60000);
  }, days);
}

test.describe('Sync de lo leído · dos dispositivos', () => {
  test('leer el mismo día en dos equipos SUMA, no se pisa', async ({ browser }) => {
    const drive = createDriveState();
    const pc = await browser.newContext();
    const movil = await browser.newContext();
    try {
      const pcPage = await bootDevice(pc, drive);
      const mvPage = await bootDevice(movil, drive);

      await read(pcPage, 'libro-1', 20);      // 20 pasos × 96 s = 32 min
      await sync(pcPage);
      await read(mvPage, 'libro-1', 10);      // 10 pasos = 16 min, el MISMO día
      await sync(mvPage);                     // pull del PC + push de lo suyo

      expect(await minutes(mvPage)).toBe(48); // 32 + 16: se suman, no compiten
      await sync(pcPage);
      expect(await minutes(pcPage)).toBe(48);
    } finally {
      await pc.close(); await movil.close();
    }
  });

  test('lo de otro dispositivo no pisa lo propio ni vuelve deformado', async ({ browser }) => {
    const drive = createDriveState();
    const pc = await browser.newContext();
    const movil = await browser.newContext();
    try {
      const pcPage = await bootDevice(pc, drive);
      const mvPage = await bootDevice(movil, drive);

      await read(pcPage, 'libro-1', 20);
      await sync(pcPage);
      await sync(mvPage);                     // el móvil solo recibe
      expect(await minutes(mvPage)).toBe(32);

      // El PC lee MÁS y vuelve a sincronizar: su propia fila la manda él, y la copia
      // que le devuelve el remoto (más vieja) no puede hacerla retroceder.
      await read(pcPage, 'libro-1', 10);
      await sync(pcPage);
      expect(await minutes(pcPage)).toBe(48);
      await sync(mvPage);
      expect(await minutes(mvPage)).toBe(48);

      // Sincronizar de nuevo sin leer nada no cambia ni una cifra (converge).
      await sync(pcPage); await sync(mvPage); await sync(pcPage);
      expect(await minutes(pcPage)).toBe(48);
      expect(await minutes(mvPage)).toBe(48);
    } finally {
      await pc.close(); await movil.close();
    }
  });

  test('el desglose por libro y por día sobrevive al viaje', async ({ browser }) => {
    const drive = createDriveState();
    const pc = await browser.newContext();
    const movil = await browser.newContext();
    try {
      const pcPage = await bootDevice(pc, drive);
      const mvPage = await bootDevice(movil, drive);

      await read(pcPage, 'libro-1', 20);          // hoy
      await read(pcPage, 'libro-2', 10, 2);       // anteayer
      await sync(pcPage);
      await sync(mvPage);

      const s = await mvPage.evaluate(async () => {
        const RL: any = await import('/js/reading-log.js');
        const x = await RL.summary(7);
        return {
          libros: Object.entries(x.books).map(([id, v]: any) => [id, Math.round(v.ms / 60000), v.units]),
          dias: Object.keys(x.byDay).length,
        };
      });
      expect(s.libros.sort()).toEqual([['libro-1', 32, 20], ['libro-2', 16, 10]]);
      expect(s.dias).toBe(2);
    } finally {
      await pc.close(); await movil.close();
    }
  });

  // El `device_id` es la MITAD de la clave con la que cada equipo escribe sus días. Viajaba
  // en settings.json —donde va todo `bookreader_*`— y el segundo dispositivo lo adoptaba al
  // rellenar lo que le faltaba: los dos pasaban a escribir la misma fila y uno dejaba de
  // contar, en silencio. Esta es la prueba de que no vuelve a viajar.
  test('cada dispositivo conserva su propia identidad tras sincronizar', async ({ browser }) => {
    const drive = createDriveState();
    const pc = await browser.newContext();
    const movil = await browser.newContext();
    try {
      const pcPage = await bootDevice(pc, drive);
      const mvPage = await bootDevice(movil, drive);
      const idOf = (p: Page) => p.evaluate(async () => {
        const RL: any = await import('/js/reading-log.js');
        return RL.deviceId();
      });

      await read(pcPage, 'libro-1', 20);
      await sync(pcPage);
      const pcId = await idOf(pcPage);
      await sync(mvPage);
      expect(await idOf(mvPage)).not.toBe(pcId);

      // Y cada uno escribe su propia fila: dos filas distintas para el mismo día.
      await read(mvPage, 'libro-1', 10);
      await sync(mvPage);
      const keys = await mvPage.evaluate(async () => {
        const RL: any = await import('/js/reading-log.js');
        return (await RL.getRecords()).map((r: any) => r.key).sort();
      });
      expect(keys.length).toBe(2);
      expect(new Set(keys.map((k: string) => k.split('|')[1])).size).toBe(2);
    } finally {
      await pc.close(); await movil.close();
    }
  });

  test('lo que viaja es compacto: la lista de unidades se queda en casa', async ({ browser }) => {
    const drive = createDriveState();
    const pc = await browser.newContext();
    try {
      const pcPage = await bootDevice(pc, drive);
      await read(pcPage, 'libro-1', 20);
      const exported = await pcPage.evaluate(async () => {
        const RL: any = await import('/js/reading-log.js');
        return await RL.exportDays();
      });
      expect(exported).toHaveLength(1);
      // 20 unidades contadas viajan como el número 20, no como veinte enteros.
      expect(exported[0].books['libro-1'].units).toBe(20);
    } finally {
      await pc.close();
    }
  });
});
