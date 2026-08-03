import { test, expect } from '@playwright/test';
import { createDriveState, installDriveMocks, seedDriveToken } from './drive-mock';

// REGRESIÓN: dos dispositivos sincronizando a la vez dejaban a uno SIN VOLVER A
// RECIBIR ajustes NUNCA. No era un test frágil: el estado quedaba encallado de forma
// permanente y `study_streak` (la racha de estudio) se congelaba en ese equipo.
//
// LA CAUSA, sacada de la traza del engine. Drive no soporta If-Match, así que el
// manifest se escribe releyendo la versión justo antes (drive-provider.js): hay una
// ventana en la que dos equipos se pisan y el segundo deja un `settingsUpdatedAt` MÁS
// VIEJO que el que había. A partir de ahí el equipo rezagado tiene el mismo número que
// el manifest, la condición de pull —que era una IGUALDAD— da falso, y no vuelve a leer
// settings.json jamás. El dato remoto estaba bien todo el tiempo; lo que fallaba era
// que nadie lo pedía.
//
// EL ARREGLO (engine.js · 1c): la decisión ya no cuelga del manifest, sino de la VERSIÓN
// del propio settings.json, que la asigna el proveedor y no puede retroceder. Más un
// máximo al sellar `settingsUpdatedAt`, para que el manifest tampoco vaya hacia atrás.
//
// Medido: 6 de 10 encallaban antes; 20 de 20 pasan después. Sin el máximo, 18 de 20 —
// los dos cambios hacen falta. Este test necesita CARGA para provocar el solape, así
// que para estresarlo de verdad:
//   npx playwright test tests/sync-settings-race.spec.ts --repeat-each=20 --workers=4
//
// Va con @race, FUERA de `npm test`: es un test de ESTRÉS que fuerza un solape que en
// la app no se da (solo sincroniza un lado en el bucle de recuperación). Dentro de la
// suite completa, compitiendo con otros 340 tests, sigue cayendo — meterlo ahí solo
// devolvería el rojo rotatorio. El que vigila el síntoma real es sync-decks › "la racha
// de estudio avanza…", que sí corre siempre y lleva 6 suites completas en verde.
test('@race el primer sync solapado de dos dispositivos congela los ajustes de uno', async ({ browser }) => {
  test.setTimeout(120000);
  const state = createDriveState();
  const pc = await browser.newContext();
  const movil = await browser.newContext();
  const boot = async (ctx: any) => {
    await installDriveMocks(ctx, state);
    await seedDriveToken(ctx);
    const p = await ctx.newPage();
    await p.goto('/');
    return p;
  };
  const pcPage = await boot(pc);
  const movilPage = await boot(movil);
  const traza: string[] = [];
  pcPage.on('console', (m) => { if (m.text().startsWith('[DBG]')) traza.push('PC    ' + m.text()); });
  movilPage.on('console', (m) => { if (m.text().startsWith('[DBG]')) traza.push('MOVIL ' + m.text()); });

  // El PC arrastra una racha vieja; el móvil repasa hoy.
  await pcPage.evaluate(async () => {
    const S: any = await import('/js/storage.js');
    S.set('study_streak', { count: 3, lastDay: 19000 });
  });
  await movilPage.evaluate(async () => {
    const S: any = await import('/js/storage.js');
    const Srs: any = await import('/js/ai/srs.js');
    S.set('study_streak', Srs.bumpStreak({ count: 3, lastDay: Srs.dayOf(Date.now()) - 1 }));
  });

  // El PC arranca un ciclo y NO se espera: es exactamente lo que hace el disparador
  // automático del engine (startDelayMs = 1,5 s tras arrancar, o el debounce de 4 s
  // tras un cambio local). El test de la racha lo sufre sin pedirlo.
  await pcPage.evaluate(() => {
    import('/js/sync/engine.js').then((E: any) => E.syncNow());
  });
  await movilPage.evaluate(async () => (await import('/js/sync/engine.js')).syncNow());

  // Varias rondas: lo que se afirma es que NO basta con volver a sincronizar.
  for (let i = 0; i < 8; i++) {
    await pcPage.evaluate(async () => (await import('/js/sync/engine.js')).syncNow());
    const ok = await pcPage.evaluate(async () => {
      const S: any = await import('/js/storage.js');
      return (S.get('study_streak')?.lastDay || 0) > 20000;
    });
    if (ok) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log('\n===== TRAZA =====\n' + traza.join('\n') + '\n=================');
  const remoto = JSON.parse(state.store.get('bookreader/settings.json')?.content || '{}');
  expect(remoto.study_streak?.lastDay, 'el dato remoto sí es correcto').toBeGreaterThan(20000);

  const enPc = await pcPage.evaluate(async () => {
    const S: any = await import('/js/storage.js');
    const Srs: any = await import('/js/ai/srs.js');
    return Srs.currentStreak(S.get('study_streak'));
  });
  expect(enPc, 'el PC nunca llega a leer settings.json aunque el remoto sea correcto').toBe(4);

  await pc.close();
  await movil.close();
});
