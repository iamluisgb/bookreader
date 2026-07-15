import { test, expect } from '@playwright/test';
import path from 'path';

// MON1 F1 · E2E del gateway (@live: red real, consume cuota del token). La app
// apunta al Worker con SOLO la config existente (base URL + key + modelo alias):
// cero cambios de código en el cliente. Requiere GW_TOKEN en el entorno o .env.
const EPUB_PATH = path.join(__dirname, 'test.epub');
const GW = 'https://bookreader-gateway.luisgonzalezb93.workers.dev/v1';
const TOKEN = process.env.GW_TOKEN || '';

// F3 · Botón "Probar la demo": determinista (el endpoint se stubbea) — verifica que
// el clic autoconfigura base URL + token + modelo alias sin que el usuario vea nada.
test('el botón de demo autoconfigura el proveedor (stub del gateway)', async ({ page }) => {
  await page.route('**/demo-token', (route) =>
    route.fulfill({ json: { token: 'br-demo-stub123', remaining: 30, model: 'bookreader-fast' } }));
  await page.goto('/');
  await page.locator('#sidebar-toggle').click();
  await page.locator('#open-app-settings').click();   // abre ya en la sección Agente

  const btn = page.locator('#appset-demo-btn');
  await expect(btn).toBeVisible();          // sin key → el botón está
  await btn.click();

  // La sección se re-renderiza con la config puesta y el botón desaparece (ya hay key).
  await expect(page.locator('#appset-demo-btn')).toHaveCount(0);
  await expect(page.locator('#appset-baseurl')).toHaveValue(/bookreader-gateway/);
  await expect(page.locator('#appset-model')).toHaveValue('bookreader-fast');
  const cfg = await page.evaluate(() => ({
    key: JSON.parse(localStorage.getItem('bookreader_ai_key') || '""'),
    url: JSON.parse(localStorage.getItem('bookreader_ai_base_url') || '""'),
  }));
  expect(cfg.key).toBe('br-demo-stub123');
  expect(cfg.url).toContain('bookreader-gateway');
});

test('si el gateway rechaza (429), el botón enseña el motivo y sigue usable', async ({ page }) => {
  await page.route('**/demo-token', (route) =>
    route.fulfill({ status: 429, json: { error: { message: 'No demo tokens left today.', code: 'demo_sold_out' } } }));
  await page.goto('/');
  await page.locator('#sidebar-toggle').click();
  await page.locator('#open-app-settings').click();   // abre ya en la sección Agente
  await page.locator('#appset-demo-btn').click();
  await expect(page.locator('#appset-demo-hint')).toContainText('No demo tokens left today');
  await expect(page.locator('#appset-demo-btn')).toBeEnabled();
});

test('el agente responde a través del gateway con alias bookreader-fast @live', async ({ page }) => {
  test.skip(!TOKEN, 'define GW_TOKEN (token br-… del gateway) para esta prueba');
  test.setTimeout(120000);
  await page.addInitScript(([gw, tok]) => {
    localStorage.setItem('bookreader_ai_base_url', JSON.stringify(gw));
    localStorage.setItem('bookreader_ai_key', JSON.stringify(tok));
    localStorage.setItem('bookreader_ai_model', JSON.stringify('bookreader-fast'));
  }, [GW, TOKEN]);
  await page.goto('/');
  const [fc] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Abrir archivo' }).click(),
  ]);
  await fc.setFiles(EPUB_PATH);
  await expect(page.locator('#reader-title')).toHaveText('Pedro Páramo', { timeout: 10000 });

  await page.locator('#ai-toggle').click();
  await page.locator('.ai-ob-quickchat').click().catch(() => {});
  await expect(page.locator('#ai-status')).toContainText('Listo para preguntar', { timeout: 30000 });
  await page.locator('#ai-input').fill('¿Quién es Pedro Páramo? Responde en una frase.');
  await page.locator('#ai-send').click();
  const answer = page.locator('.ai-msg-assistant .ai-bubble-text').last();
  await expect(answer).toContainText(/Páramo|padre|Comala/i, { timeout: 60000 });
});
