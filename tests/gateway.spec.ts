import { test, expect } from '@playwright/test';
import path from 'path';

// MON1 F1 · E2E del gateway (@live: red real, consume cuota del token). La app
// apunta al Worker con SOLO la config existente (base URL + key + modelo alias):
// cero cambios de código en el cliente. Requiere GW_TOKEN en el entorno o .env.
const EPUB_PATH = path.join(__dirname, 'test.epub');
const GW = 'https://bookreader-gateway.luisgonzalezb93.workers.dev/v1';
const TOKEN = process.env.GW_TOKEN || '';

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
