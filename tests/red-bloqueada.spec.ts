import { test, expect } from '@playwright/test';
import { installDriveMocks, seedDriveToken } from './drive-mock';

// Bug del PC de la oficina (red de empresa, 2026-11-25): la app cargaba, la licencia se
// verificaba, y la biblioteca no recibía nada nuevo sin decir por qué. Dos piezas:
//  1. La app sabe qué commit CORRE (js/build-stamp.js, lo escribe el build) y lo compara con
//     /build.json al arrancar: si corre código de caché, avisa «Hay una versión nueva».
//  2. Si el sync no LLEGA a su servidor (proxy que bloquea workers.dev), el badge y Ajustes →
//     Datos lo dicen con el host, en vez de «Sync con errores».

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

async function sellos(page, corre: string, servido: string) {
  await page.route('**/js/build-stamp.js', (r) => r.fulfill({
    contentType: 'application/javascript', body: `export const BUILD = '${corre}';\n`,
  }));
  await page.route('**/build.json', (r) => r.fulfill({
    contentType: 'application/json', body: JSON.stringify({ commit: servido }),
  }));
}

test.describe('versión del código', () => {
  test.use({ serviceWorkers: 'block' });

  test('arrancar con código viejo avisa sin esperar a cambiar de pestaña', async ({ page }) => {
    await sellos(page, A, B);
    await page.goto('/index.html');
    const aviso = page.locator('.ai-toast, [role="status"]', { hasText: 'Hay una versión nueva' });
    await expect(aviso).toBeVisible({ timeout: 10000 });
    await expect(aviso.getByRole('button', { name: 'Actualizar' })).toBeVisible();
  });

  test('con el código al día no hay aviso', async ({ page }) => {
    await sellos(page, A, A);
    await page.goto('/index.html');
    await page.waitForTimeout(5500);
    await expect(page.locator('.ai-toast, [role="status"]', { hasText: 'Hay una versión nueva' })).toHaveCount(0);
  });

  test('el segundo «Actualizar» para el mismo commit quita el service worker y la caché de código', async ({ page }) => {
    await sellos(page, A, B);
    await page.goto('/index.html');
    await page.evaluate(async (b) => {
      await caches.open('bookreader-v1');
      await caches.open('bookreader-static');
      sessionStorage.setItem('bookreader_update_try', b);
    }, B);
    const aviso = page.locator('.ai-toast, [role="status"]', { hasText: 'Hay una versión nueva' });
    await expect(aviso).toBeVisible({ timeout: 10000 });
    await Promise.all([page.waitForEvent('load'), aviso.getByRole('button', { name: 'Actualizar' }).click()]);
    const keys = await page.evaluate(() => caches.keys());
    expect(keys).not.toContain('bookreader-v1');
    expect(keys).toContain('bookreader-static');
  });
});

test('un sync que no llega a su servidor lo dice, con el host', async ({ page }) => {
  await installDriveMocks(page);
  await seedDriveToken(page);
  await page.goto('/');
  // Proxy que corta Google y el Worker: fetch falla como «Failed to fetch».
  await page.route(/googleapis\.com|workers\.dev/, (r) => r.abort('blockedbyclient'));
  const res = await page.evaluate(async () => {
    const Engine = await import('/js/sync/engine.js');
    const { unreachableHost } = await import('/js/sync/net.js');
    for (let i = 0; i < Engine.ERROR_BADGE_AFTER; i++) await Engine.syncNow();
    const d = Engine.getDiag();
    return { error: d.lastError, host: unreachableHost(d.lastError), consecutive: d.consecutive };
  });
  expect(res.host, res.error).toMatch(/googleapis\.com|workers\.dev/);
  await expect(page.locator('#sync-badge')).toHaveText('Sync bloqueado por la red');
  await page.locator('#sync-badge').click();
  await expect(page.locator('#appset-sync-diag')).toContainText('No se llega al servidor del sync');
  await expect(page.locator('#appset-sync-diag')).toContainText(res.host!);
});

test('unreachableHost solo reconoce fallos de red anotados', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async () => {
    const { unreachableHost } = await import('/js/sync/net.js');
    return [
      unreachableHost('Failed to fetch [bookreader-sync.x.workers.dev]'),
      unreachableHost('Tiempo de espera de red agotado [www.googleapis.com]'),
      unreachableHost('Drive 500 [www.googleapis.com]'),
      unreachableHost('reconnect'),
    ];
  });
  expect(r).toEqual(['bookreader-sync.x.workers.dev', 'www.googleapis.com', null, null]);
});
