import { test, expect, Page } from '@playwright/test';
import path from 'path';

// Onboarding desde cero: sin API key, el agente arranca con la demo, que se pide SOLA al
// abrirlo (llm.js · ensureKey). Antes había que encontrar «Probar la demo» en Ajustes, y
// cada acción del agente sin clave mandaba allí con un «Introduce tu API key primero».
//
// Lo que se fija:
//   - abrir el agente sin clave pide UNA demo y lo dice (cupo incluido);
//   - con clave propia no se pide nada;
//   - si la demo no se puede dar (esta red ya tuvo la suya hoy), se manda a Ajustes CON el
//     motivo, y no se vuelve a llamar al gateway en cada pulsación.
//
// En un navegador automatizado la demo automática está apagada (cada test gastaría una
// real del gateway de producción); estos tests la encienden a propósito.

const EPUB_PATH = path.join(__dirname, 'test.epub');

async function setup(page: Page, demoToken: (route: any) => any, { key = '' } = {}) {
  let calls = 0;
  await page.addInitScript((key) => {
    localStorage.setItem('bookreader_demo_auto_webdriver', 'true');
    if (key) localStorage.setItem('bookreader_ai_key', JSON.stringify(key));
  }, key);
  await page.route('**/demo-token', (route) => { calls++; return demoToken(route); });
  await page.route('**/chat/completions', (route) => route.fulfill({
    status: 200, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
  }));
  await page.goto('/');
  const [fc] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Subir tu primer libro' }).click(),
  ]);
  await fc.setFiles(EPUB_PATH);
  await page.waitForSelector('#ai-toggle:not([disabled])', { timeout: 15000 });
  return { calls: () => calls };
}

const ok = (route: any) => route.fulfill({
  status: 200, headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: 'br-auto-123', remaining: 20, quota: 20, model: 'bookreader-fast' }),
});

const store = (page: Page, k: string) => page.evaluate((k) => JSON.parse(localStorage.getItem('bookreader_' + k) || 'null'), k);

test('sin clave, abrir el agente activa la demo sola y lo dice', async ({ page }) => {
  const gw = await setup(page, ok);
  await page.locator('#ai-toggle').click();
  await expect(page.locator('.ai-toast')).toContainText('Demo gratuita activada: 20 consultas');
  expect(await store(page, 'ai_key')).toBe('br-auto-123');
  expect(await store(page, 'ai_base_url')).toContain('bookreader-gateway');
  expect(gw.calls()).toBe(1);
  // Y no se ha mandado a nadie a Ajustes.
  await expect(page.locator('#appset-provider')).toHaveCount(0);

  // Cerrar y volver a abrir no pide otra. (Por la API del panel: el onboarding tapa el
  // botón mientras no se elige objetivo.)
  await page.evaluate(async () => {
    const Panel: any = await import('/js/ai/panel.js');
    Panel.setOpen(false);
    Panel.setOpen(true);
  });
  await page.waitForTimeout(300);
  expect(gw.calls()).toBe(1);
});

test('con API key propia no se pide demo', async ({ page }) => {
  const gw = await setup(page, ok, { key: 'sk-mia' });
  await page.locator('#ai-toggle').click();
  await expect(page.locator('#ai-onboarding')).toBeVisible();
  await page.waitForTimeout(500);
  expect(gw.calls()).toBe(0);
  expect(await store(page, 'ai_key')).toBe('sk-mia');
});

test('si esta red ya tuvo su demo hoy, Ajustes con el motivo, y sin insistir al gateway', async ({ page }) => {
  const gw = await setup(page, (route: any) => route.fulfill({
    status: 429, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: { code: 'demo_already_granted', message: 'This network already got a demo today.' } }),
  }));
  await page.locator('#ai-toggle').click();
  await page.locator('.ai-ob-tpl[data-tpl="t3-juicio"]').click();
  await page.fill('#ai-ob-goal', 'Terminar el libro.');
  await page.locator('#ai-ob-start').click();
  await expect(page.locator('#ai-onboarding')).toHaveCount(0);

  await page.fill('#ai-input', '¿De qué va?');
  await page.locator('#ai-send').click();
  await expect(page.locator('#appset-provider')).toBeVisible();          // Ajustes → Agente
  await expect(page.locator('#ai-status')).toContainText('No se pudo activar la demo gratuita');
  await expect(page.locator('#ai-status')).toContainText('already got a demo today');
  // Un intento al abrir el panel; el envío reusa el fallo recordado (hasta mañana).
  expect(gw.calls()).toBe(1);
});
