import { test, expect } from '@playwright/test';

// Licencia de BookReader Plus (js/license.js, ADR-061). Se ejercita el módulo real en el
// navegador: modo simulado (sin organizationId), camino de API real con fetch stubbeado,
// ventana offline de 30 días y degradación por revocación. Desde ADR-061 no hay Pro ni
// ventana de pago. La licencia viaja en el backup (mitigación de purga de storage).

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
});

test('mock mode: BKRD key activates Plus and persists', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const L = await import('/js/license.js');
    await L.activate('BKRD-TEST-1234');
    const s = L.getState();
    return {
      plus: L.isPlus(),
      mock: L.isMock(),
      key: s.key,
      hasActivation: typeof s.activationId === 'string' && s.activationId.length > 0,
      raw: localStorage.getItem('bookreader_license') !== null,
    };
  });
  expect(r.mock).toBe(true);
  expect(r.plus).toBe(true);
  expect(r.key).toBe('BKRD-TEST-1234');
  expect(r.hasActivation).toBe(true);
  expect(r.raw).toBe(true);   // persistida → entra en el backup de localStorage
});

test('mock mode: invalid, revoked and limit keys behave like the real API', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const L = await import('/js/license.js');
    const codeOf = async (key: string) => {
      try { await L.activate(key); return 'ok'; } catch (e: any) { return e.code; }
    };
    return {
      garbage: await codeOf('no-es-una-key'),
      revoked: await codeOf('BKRD-XXXX-REVOKED'),
      limit: await codeOf('BKRD-XXXX-LIMIT'),
      empty: await codeOf('   '),
      plusAfterFailures: L.isPlus(),
    };
  });
  expect(r.garbage).toBe('invalid');
  expect(r.revoked).toBe('invalid');
  expect(r.limit).toBe('limit');
  expect(r.empty).toBe('invalid');
  expect(r.plusAfterFailures).toBe(false);
});

test('real API path: activate posts key+org+label and stores the activation id', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const L = await import('/js/license.js');
    L.CONFIG.organizationId = 'org-123';   // sale del modo simulado
    let captured: any = null;
    window.fetch = async (url: any, init: any) => {
      captured = { url: String(url), body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ id: 'act-789' }), { status: 200 });
    };
    await L.activate('  BKRD-REAL-0001  ');
    const s = L.getState();
    return { captured, activationId: s.activationId, plus: L.isPlus(), label: L.deviceLabel() };
  });
  expect(r.captured.url).toBe('https://api.polar.sh/v1/customer-portal/license-keys/activate');
  expect(r.captured.body.key).toBe('BKRD-REAL-0001');   // trim aplicado
  expect(r.captured.body.organization_id).toBe('org-123');
  expect(r.captured.body.label).toBe(r.label);          // label legible "<navegador> · <SO>"
  expect(r.label).toMatch(/ · /);
  expect(r.activationId).toBe('act-789');
  expect(r.plus).toBe(true);
});

test('real API path: activation limit is classified as "limit"', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const L = await import('/js/license.js');
    L.CONFIG.organizationId = 'org-123';
    window.fetch = async () =>
      new Response(JSON.stringify({ detail: 'License key activation limit already reached' }), { status: 403 });
    try { await L.activate('BKRD-REAL-0002'); return 'ok'; } catch (e: any) { return e.code; }
  });
  expect(r).toBe('limit');
});

test('offline window: last good validation is worth 30 days, not more', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const L = await import('/js/license.js');
    await L.activate('BKRD-TEST-30D');
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    return {
      window: L.OFFLINE_WINDOW_MS === 30 * day,
      fresh: L.isPlus(now),
      day29: L.isPlus(now + 29 * day),
      day31: L.isPlus(now + 31 * day),
      keyKept: L.getState().key,   // caducar la ventana NO borra la key
    };
  });
  expect(r.window).toBe(true);
  expect(r.fresh).toBe(true);
  expect(r.day29).toBe(true);
  expect(r.day31).toBe(false);
  expect(r.keyKept).toBe('BKRD-TEST-30D');
});

test('validateOnStartup: network failure keeps Plus, 4xx drops it without losing data', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const L = await import('/js/license.js');
    L.CONFIG.organizationId = 'org-123';
    window.fetch = async () => new Response(JSON.stringify({ id: 'act-1' }), { status: 200 });
    await L.activate('BKRD-REAL-0003');

    // Sin red: el estado no cambia (la ventana offline decide).
    window.fetch = async () => { throw new TypeError('offline'); };
    await L.validateOnStartup();
    const afterOffline = L.isPlus();

    // El servidor dice que ya no vale (reembolso/revocación): degradar, conservar estado.
    let evt: any = null;
    window.addEventListener('license:changed', (e: any) => { evt = e.detail; });
    window.fetch = async () => new Response(JSON.stringify({ detail: 'not found' }), { status: 404 });
    await L.validateOnStartup();
    const s = L.getState();
    return { afterOffline, afterRevoke: L.isPlus(), revoked: s.revoked, keyKept: s.key, evt };
  });
  expect(r.afterOffline).toBe(true);
  expect(r.afterRevoke).toBe(false);
  expect(r.revoked).toBe(true);
  expect(r.keyKept).toBe('BKRD-REAL-0003');
  expect(r.evt).toEqual({ plus: false });
});

test('backup round-trip restores the license without a new activation', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const L = await import('/js/license.js');
    const B = await import('/js/backup.js');
    await L.activate('BKRD-TEST-BCKP');
    const original = L.getState();
    const backup = await B.buildBackup();

    // Purga simulada del navegador: se pierde todo el storage local.
    localStorage.clear();
    const purged = L.isPlus();

    await B.importBackup(JSON.parse(JSON.stringify(backup)));
    const restored = L.getState();
    return {
      inBackup: !!backup.localStorage.license,
      purged,
      plus: L.isPlus(),
      sameActivation: restored.activationId === original.activationId,
    };
  });
  expect(r.inBackup).toBe(true);
  expect(r.purged).toBe(false);
  expect(r.plus).toBe(true);
  expect(r.sameActivation).toBe(true);   // restaurar NO quema un hueco de dispositivo
});

test('settings has a Licencia section that activates a mock key end-to-end', async ({ page }) => {
  await page.evaluate(async () => {
    const AppSettings = await import('/js/ui/app-settings.js');
    AppSettings.open('license');
  });
  await page.fill('#appset-lic-key', 'BKRD-UI-TEST-0001');
  await page.click('#appset-lic-activate');
  await page.waitForSelector('.appset-lic-state.is-pro');
  expect(await page.textContent('.appset-lic-state')).toContain('Plus activo');

  // La key no se muestra en claro por defecto: input de tipo password (su VALUE está en el
  // DOM pero no es texto visible) con ojo para revelar y Copiar — igual que la API key:
  // hay que poder rescatarla para llevarla a otro navegador.
  const lic = page.locator('#appset-lic-key');
  await expect(lic).toHaveAttribute('type', 'password');
  await expect(lic).toHaveValue('BKRD-UI-TEST-0001');
  await expect(page.locator('.appset-key-eye')).toBeVisible();

  // El ojo la revela, y Copiar la lleva al portapapeles entera.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.click('.appset-key-eye');
  await expect(lic).toHaveAttribute('type', 'text');
  await page.click('[data-copy="appset-lic-key"]');
  await expect(page.locator('[data-copy="appset-lic-key"]')).toHaveText(/Copiado/);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('BKRD-UI-TEST-0001');

  // Y en EN no cuela español en la fila.
  await page.evaluate(() => localStorage.setItem('bookreader_lang', 'en'));
  await page.reload();
  await page.evaluate(async () => {
    const AppSettings = await import('/js/ui/app-settings.js');
    AppSettings.open('license');
  });
  await page.waitForSelector('.appset-lic-state.is-pro');
  expect(await page.textContent('#app-settings')).toContain('Copy');
});

test('Drive: book files sync without a license', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const L = await import('/js/license.js');
    const P = await import('/js/sync/provider.js');
    return { plus: L.isPlus(), files: P.canTransferFiles() };
  });
  expect(r.plus).toBe(false);
  expect(r.files).toBe(true);
});

// ADR-061: todo lo que era Pro es gratis. Ni ventana de pago ni prueba que caduque (el
// resto de la suite ya estudia, hace mapas y perfiles sin licencia).
test('no Pro: no paywall module, and opening the app starts no trial', async ({ page }) => {
  await page.reload();   // beforeEach borró el almacenamiento: esta es la primera apertura
  const r = await page.evaluate(async () => {
    const L: any = await import('/js/license.js');
    let paywall = true;
    try { await import('/js/ui/paywall.js'); } catch { paywall = false; }
    return { isPro: typeof L.isPro, startTrial: typeof L.startTrial, paywall, trialKey: localStorage.getItem('bookreader_pro_trial') };
  });
  expect(r).toEqual({ isPro: 'undefined', startTrial: 'undefined', paywall: false, trialKey: null });
});

