import { test, expect } from '@playwright/test';

// MON2 · Licencias de BookReader Pro (js/license.js + ui/paywall.js). Se ejercita el
// módulo real en el navegador: modo simulado (sin organizationId), camino de API real
// con fetch stubbeado, ventana offline de 30 días, degradación por revocación y el
// paywall como gate. La licencia viaja en el backup (mitigación de purga de storage).

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
});

test('mock mode: BKRD key activates Pro and persists', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const L = await import('/js/license.js');
    await L.activate('BKRD-TEST-1234');
    const s = L.getState();
    return {
      pro: L.isPro(),
      mock: L.isMock(),
      key: s.key,
      hasActivation: typeof s.activationId === 'string' && s.activationId.length > 0,
      raw: localStorage.getItem('bookreader_license') !== null,
    };
  });
  expect(r.mock).toBe(true);
  expect(r.pro).toBe(true);
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
      proAfterFailures: L.isPro(),
    };
  });
  expect(r.garbage).toBe('invalid');
  expect(r.revoked).toBe('invalid');
  expect(r.limit).toBe('limit');
  expect(r.empty).toBe('invalid');
  expect(r.proAfterFailures).toBe(false);
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
    return { captured, activationId: s.activationId, pro: L.isPro(), label: L.deviceLabel() };
  });
  expect(r.captured.url).toBe('https://api.polar.sh/v1/customer-portal/license-keys/activate');
  expect(r.captured.body.key).toBe('BKRD-REAL-0001');   // trim aplicado
  expect(r.captured.body.organization_id).toBe('org-123');
  expect(r.captured.body.label).toBe(r.label);          // label legible "<navegador> · <SO>"
  expect(r.label).toMatch(/ · /);
  expect(r.activationId).toBe('act-789');
  expect(r.pro).toBe(true);
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
      fresh: L.isPro(now),
      day29: L.isPro(now + 29 * day),
      day31: L.isPro(now + 31 * day),
      keyKept: L.getState().key,   // caducar la ventana NO borra la key
    };
  });
  expect(r.window).toBe(true);
  expect(r.fresh).toBe(true);
  expect(r.day29).toBe(true);
  expect(r.day31).toBe(false);
  expect(r.keyKept).toBe('BKRD-TEST-30D');
});

test('validateOnStartup: network failure keeps Pro, 4xx degrades to Free without losing data', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const L = await import('/js/license.js');
    L.CONFIG.organizationId = 'org-123';
    window.fetch = async () => new Response(JSON.stringify({ id: 'act-1' }), { status: 200 });
    await L.activate('BKRD-REAL-0003');

    // Sin red: el estado no cambia (la ventana offline decide).
    window.fetch = async () => { throw new TypeError('offline'); };
    await L.validateOnStartup();
    const afterOffline = L.isPro();

    // El servidor dice que ya no vale (reembolso/revocación): degradar, conservar estado.
    let evt: any = null;
    window.addEventListener('license:changed', (e: any) => { evt = e.detail; });
    window.fetch = async () => new Response(JSON.stringify({ detail: 'not found' }), { status: 404 });
    await L.validateOnStartup();
    const s = L.getState();
    return { afterOffline, afterRevoke: L.isPro(), revoked: s.revoked, keyKept: s.key, evt };
  });
  expect(r.afterOffline).toBe(true);
  expect(r.afterRevoke).toBe(false);
  expect(r.revoked).toBe(true);
  expect(r.keyKept).toBe('BKRD-REAL-0003');
  expect(r.evt).toEqual({ pro: false });
});

test('paywall gate: free shows the modal (Escape → false), Pro passes without modal', async ({ page }) => {
  // Free: ensurePro pinta el paywall y Escape lo resuelve a false.
  const freeRun = page.evaluate(async () => {
    const P = await import('/js/ui/paywall.js');
    return P.ensurePro('mindmap');
  });
  await page.waitForSelector('.pw-overlay');
  const hot = await page.textContent('.pw-feat-hot');
  await page.keyboard.press('Escape');
  expect(await freeRun).toBe(false);
  expect(hot).toContain('Mapas mentales');
  expect(await page.$('.pw-overlay')).toBeNull();

  // Pro (mock): pasa sin tocar el DOM.
  const proRun = await page.evaluate(async () => {
    const L = await import('/js/license.js');
    const P = await import('/js/ui/paywall.js');
    await L.activate('BKRD-TEST-GATE');
    const ok = await P.ensurePro('mindmap');
    return { ok, overlay: !!document.querySelector('.pw-overlay') };
  });
  expect(proRun.ok).toBe(true);
  expect(proRun.overlay).toBe(false);
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
    const purged = L.isPro();

    await B.importBackup(JSON.parse(JSON.stringify(backup)));
    const restored = L.getState();
    return {
      inBackup: !!backup.localStorage.license,
      purged,
      pro: L.isPro(),
      sameActivation: restored.activationId === original.activationId,
    };
  });
  expect(r.inBackup).toBe(true);
  expect(r.purged).toBe(false);
  expect(r.pro).toBe(true);
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
  expect(await page.textContent('.appset-lic-state')).toContain('Pro activo');

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

// Prueba inversa de Pro (ADR-060): 60 días desde la primera apertura, una vez por navegador.
test('trial: the first open grants 60 days of Pro, once per browser, and the demo does not touch it', async ({ page }) => {
  await page.reload();   // beforeEach borró el almacenamiento: esta es la primera apertura
  await page.route('**/demo-token', (route) => route.fulfill({
    status: 200, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'br-demo-trial', remaining: 30, quota: 30, model: 'bookreader-fast' }),
  }));
  const r = await page.evaluate(async () => {
    const L = await import('/js/license.js');
    const LLM = await import('/js/ai/llm.js');
    const first = L.getTrial();
    const day = 24 * 60 * 60 * 1000;
    await LLM.requestDemoToken();
    const again = L.startTrial(Date.now() + 5 * day);
    return {
      pro: L.isPro(), trial: L.isTrial(), license: L.hasLicense(), plus: L.isPlus(),
      days: Math.round((first.until - first.start) / day), left: L.trialDaysLeft(),
      again, sameStart: L.getTrial().start === first.start,
      proAtDay59: L.isPro(first.start + 59 * day), proAtDay60: L.isPro(first.start + 60 * day),
    };
  });
  expect(r.pro).toBe(true);
  expect(r.trial).toBe(true);
  expect(r.license).toBe(false);          // la prueba no es una licencia
  expect(r.plus).toBe(false);             // ni da Plus
  expect(r.days).toBe(60);
  expect(r.left).toBe(60);
  expect(r.again).toBe(false);
  expect(r.sameStart).toBe(true);
  expect(r.proAtDay59).toBe(true);
  expect(r.proAtDay60).toBe(false);
});

test('trial: it warns once, on opening, near the end', async ({ page }) => {
  // A 5 días del final avisa al abrir, y solo la primera vez.
  await page.evaluate(() => {
    const day = 24 * 60 * 60 * 1000;
    localStorage.setItem('bookreader_pro_trial', JSON.stringify({ start: Date.now() - 55 * day, until: Date.now() + 5 * day }));
  });
  await page.reload();
  const warn = page.locator('.ai-toast', { hasText: 'acaba en 5 días' });
  await expect(warn).toBeVisible();
  await page.reload();
  await page.waitForTimeout(500);
  await expect(warn).toHaveCount(0);
});

test('plans: a Plus key opens Plus and Pro, a Pro key only Pro; the real API reads the benefit', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const L = await import('/js/license.js');
    await L.activate('BKRD-PLUS-0001');
    const plus = { pro: L.isPro(), plus: L.isPlus() };
    await L.activate('BKRD-PRO-0001');
    const pro = { pro: L.isPro(), plus: L.isPlus() };
    L.CONFIG.organizationId = 'org-123';
    L.CONFIG.plusBenefitIds = ['ben-plus'];
    window.fetch = async () => new Response(JSON.stringify({ id: 'act-1', license_key: { benefit_id: 'ben-plus' } }), { status: 200 });
    await L.activate('POLAR-KEY-1');
    const real = L.isPlus();
    window.fetch = async () => new Response(JSON.stringify({ id: 'lk-1', benefit_id: 'ben-pro' }), { status: 200 });
    await L.validateOnStartup();
    return { plus, pro, real, afterValidate: { pro: L.isPro(), plus: L.isPlus() } };
  });
  expect(r.plus).toEqual({ pro: true, plus: true });
  expect(r.pro).toEqual({ pro: true, plus: false });
  expect(r.real).toBe(true);
  expect(r.afterValidate).toEqual({ pro: true, plus: false });
});

test('Drive: book files sync without Pro', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const L = await import('/js/license.js');
    const P = await import('/js/sync/provider.js');
    return { pro: L.isPro(), files: P.canTransferFiles(), active: P.activeId() };
  });
  expect(r.pro).toBe(false);
  expect(r.files).toBe(true);
});

test('trial: an expired trial falls back to Free and Settings says so', async ({ page }) => {
  await page.evaluate(() => {
    const day = 24 * 60 * 60 * 1000;
    localStorage.setItem('bookreader_pro_trial', JSON.stringify({ start: Date.now() - 101 * day, until: Date.now() - day }));
  });
  const pro = await page.evaluate(async () => (await import('/js/license.js')).isPro());
  expect(pro).toBe(false);
});
