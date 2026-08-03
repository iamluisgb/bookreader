import { test, expect } from '@playwright/test';
import { createDriveState, installDriveMocks, seedDriveToken } from './drive-mock';

// BUG ABIERTO (no arreglado): dos dispositivos sincronizando a la vez pueden dejar a
// uno SIN VOLVER A RECIBIR ajustes NUNCA. No es un test que "a veces falla": el estado
// queda encallado de forma permanente.
//
// SÍNTOMA. En el equipo afectado, `study_streak` (y cualquier ajuste global) se congela.
// La racha de estudio deja de avanzar aunque repases en el otro dispositivo, que es
// justo lo que sync-decks › "la racha de estudio avanza…" comprueba — y por eso ese
// test cae ~1 de cada 3 suites completas.
//
// QUÉ SE OBSERVA, medido:
//   - `bookreader/settings.json` remoto tiene el valor CORRECTO. No se pierde el dato.
//   - En el equipo afectado, `st.settingsAt === manifest.settingsUpdatedAt`, así que la
//     condición de pull de engine.js (1c) es falsa y no vuelve a leer settings.json.
//   - No converge: 6 de 10 reproducciones siguen mal tras 8 ciclos de sync.
//   - Correlación: el caso sano deja settings.json en v2; el encallado, en v3 (hay una
//     escritura de más de por medio).
//
// QUÉ SE DESCARTÓ:
//   - `syncNow()` no vuelve antes de tiempo: encadena el ciclo en vuelo (engine.js:356).
//   - `mergeStreak` es correcto para estos valores (layout.js).
//   - NO es el `ifMatch: undefined` del manifest cuando el ciclo no vio uno previo
//     (engine.js:290). Se probó a cerrarlo con `'0'` y la tasa de fallo SUBIÓ (2/10 →
//     4/10), así que esa no es la causa. El cambio se revirtió.
//
// CÓMO REPRODUCIR: hace falta CARGA — con la máquina ociosa casi siempre pasa.
//   npx playwright test tests/sync-settings-race.spec.ts --repeat-each=10 --workers=4
//
// Excluido de `npm test` (@race) para no meter un rojo intermitente en la suite: el
// fallo que hay que mirar es el de sync-decks, que sí es determinista en su intención.
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
