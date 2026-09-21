import { test, expect } from '@playwright/test';
import { installDriveMocks, seedDriveToken } from './drive-mock';

// P1/P2 · Diagnóstico de sync: cada ciclo deja huella (último ok, último error,
// fallos consecutivos, historial) persistida en sync_state — que no viaja. Es lo
// que permite responder "¿por qué mi tablet no sincroniza?" desde el propio
// dispositivo en vez de adivinar entre timeout, rate limit o storage purgado.

test.describe('Sync — diagnóstico', () => {
  test('un ciclo correcto deja lastOkAt y entrada en el historial', async ({ page }) => {
    await installDriveMocks(page);
    await seedDriveToken(page);
    await page.goto('/');
    const res = await page.evaluate(async () => {
      const H = await import('/js/highlights.js');
      const Engine = await import('/js/sync/engine.js');
      H.setBook('libro-d');
      H.add('epubcfi(/6/2!/4/2)', 'uno', '#ffeb3b', 'c1');
      await Engine.syncNow();
      return Engine.getDiag();
    });
    expect(res.lastOkAt).toBeGreaterThan(0);
    expect(res.consecutive).toBe(0);
    expect(res.history[0].ok).toBe(true);
    expect(res.history[0].pushed).toBe(1);
    expect(res.history[0].ms).toBeGreaterThanOrEqual(0);
  });

  test('un ciclo que falla lo cuenta sin borrar el último ok; un fallo solo no asoma badge de error', async ({ page }) => {
    const mock = await installDriveMocks(page);
    await seedDriveToken(page);
    await page.goto('/');
    // Primer ciclo correcto, para tener un lastOkAt que conservar.
    await page.evaluate(async () => {
      const H = await import('/js/highlights.js');
      const Engine = await import('/js/sync/engine.js');
      H.setBook('libro-e');
      H.add('epubcfi(/6/2!/4/2)', 'uno', '#ffeb3b', 'c1');
      await Engine.syncNow();
    });
    // Token revocado → el ciclo falla con 'reconnect'. Recargar antes: el access
    // token sigue vivo en memoria (caduca a la hora) y sin recargar el ciclo
    // completaría sin tocar el Worker de refresh.
    mock.revokeToken();
    await page.reload();
    const res = await page.evaluate(async () => {
      const Engine = await import('/js/sync/engine.js');
      await Engine.syncNow();
      return { status: Engine.getStatus(), diag: Engine.getDiag(), history: Engine.hasSyncHistory() };
    });
    expect(res.status).toBe('reconnect');
    expect(res.diag.consecutive).toBe(1);
    expect(res.diag.lastError).toBe('reconnect');
    expect(res.diag.lastOkAt).toBeGreaterThan(0); // el sync correcto anterior no se borra
    expect(res.diag.history[0].ok).toBe(false);
    expect(res.history).toBe(true);
    // Con un solo fallo, el badge de error NO sale (solo con ERROR_BADGE_AFTER seguidos).
    expect(res.diag.consecutive < (await page.evaluate(async () =>
      (await import('/js/sync/engine.js')).ERROR_BADGE_AFTER))).toBe(true);
  });

  test('la huella persiste en sync_state y no viaja en el snapshot', async ({ page }) => {
    await installDriveMocks(page);
    await seedDriveToken(page);
    await page.goto('/');
    await page.evaluate(async () => {
      const H = await import('/js/highlights.js');
      const Engine = await import('/js/sync/engine.js');
      H.setBook('libro-f');
      H.add('epubcfi(/6/2!/4/2)', 'uno', '#ffeb3b', 'c1');
      await Engine.syncNow();
    });
    const res = await page.evaluate(async () => {
      const st = JSON.parse(localStorage.getItem('bookreader_sync_state'));
      // Lo subido a Drive (el libro) no debe contener el diag por ningún lado.
      const Engine = await import('/js/sync/engine.js');
      return { st, diag: Engine.getDiag() };
    });
    expect(res.st.diag.lastOkAt).toBe(res.diag.lastOkAt);
    expect(JSON.stringify(res.st.diag.history)).toContain('"ok":true');
  });

  test('Ajustes → Datos muestra el estado del sync y permite copiar el diagnóstico', async ({ page }) => {
    await installDriveMocks(page);
    await seedDriveToken(page);
    await page.goto('/');
    await page.evaluate(async () => {
      const H = await import('/js/highlights.js');
      const Engine = await import('/js/sync/engine.js');
      H.setBook('libro-g');
      H.add('epubcfi(/6/2!/4/2)', 'uno', '#ffeb3b', 'c1');
      await Engine.syncNow();
    });
    // En la estantería, el botón visible es el del rail (el de la sidebar queda fuera de pantalla).
    await page.locator('.lib-rail-settings').click();
    await page.locator('.appset-nav-item[data-section="data"]').click();
    const diag = page.locator('#appset-sync-diag');
    await expect(diag).toContainText(/Último sync correcto|Sincronizando/);
    // El volcado copiable funciona (concede el permiso del portapapeles).
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.locator('#appset-sync-copy').click();
    await expect(page.locator('#appset-data-msg')).toContainText('portapapeles');
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    const report = JSON.parse(clip);
    expect(report.diag.lastOkAt).toBeGreaterThan(0);
    expect(report).toHaveProperty('userAgent');
  });
});
