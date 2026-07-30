import { test, expect } from '@playwright/test';

// Los cuatro slots de modelo (principal, visión, transcripción, rápido) son texto libre y
// no se podían comprobar: un id mal escrito no se nota al guardar, se nota mucho después y
// en otro sitio (`hasVision()` solo mira que la cadena no esté vacía, así que un typo deja
// la feature "activada" y fallando al usarla). El botón «Probar» convierte ese fallo
// silencioso y diferido en una respuesta inmediata.

const openAgentSettings = async (page) => {
  await page.goto('/');
  await page.locator('#sidebar-toggle').click();
  await page.locator('#open-app-settings').click();
};

test('un modelo válido responde «Funciona» con su latencia', async ({ page }) => {
  await page.route('**/chat/completions', (route) =>
    route.fulfill({ json: { choices: [{ message: { content: 'ok' } }] } }));
  await openAgentSettings(page);
  await page.locator('#appset-key').fill('test-key');
  await page.locator('#appset-model').fill('modelo-bueno');
  await page.locator('#appset-probe-model').click();
  await expect(page.locator('#appset-model-hint')).toContainText(/Funciona|Works/);
});

test('un modelo inexistente lo dice en el sitio, no al usarlo', async ({ page }) => {
  await page.route('**/chat/completions', (route) => route.fulfill({ status: 404, body: 'no such model' }));
  await openAgentSettings(page);
  await page.locator('#appset-key').fill('test-key');
  await page.locator('#appset-model').fill('modelo-que-no-existe');
  await page.locator('#appset-probe-model').click();
  const hint = page.locator('#appset-model-hint');
  await expect(hint).toContainText(/No funciona|Not working/);
  await expect(hint).toHaveClass(/is-error/);
});

test('el slot de visión se prueba con una imagen, no con texto suelto', async ({ page }) => {
  let sawImage = false;
  await page.route('**/chat/completions', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    sawImage = JSON.stringify(body.messages).includes('image_url');
    await route.fulfill({ json: { choices: [{ message: { content: 'ok' } }] } });
  });
  await openAgentSettings(page);
  await page.locator('#appset-key').fill('test-key');
  await page.locator('#appset-vmodel').fill('modelo-vision');
  await page.locator('#appset-probe-appset-vmodel').click();
  await expect(page.locator('#appset-probe-appset-vmodel-hint')).toContainText(/Funciona|Works/);
  expect(sawImage).toBe(true);   // si no manda imagen, no está probando lo que dice probar
});

test('el slot de transcripción va contra /audio/transcriptions', async ({ page }) => {
  let hitStt = false;
  await page.route('**/audio/transcriptions', async (route) => {
    hitStt = true;
    await route.fulfill({ json: { text: '' } });   // silencio → texto vacío ES un éxito
  });
  await openAgentSettings(page);
  await page.locator('#appset-key').fill('test-key');
  await page.locator('#appset-smodel').fill('whisper-x');
  await page.locator('#appset-probe-appset-smodel').click();
  await expect(page.locator('#appset-probe-appset-smodel-hint')).toContainText(/Funciona|Works/);
  expect(hitStt).toBe(true);
});

test('«Modelo rápido» vacío prueba el que se usaría de verdad y lo nombra', async ({ page }) => {
  await page.route('**/chat/completions', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({ json: { choices: [{ message: { content: body.model } }] } });
  });
  await openAgentSettings(page);
  await page.locator('#appset-key').fill('test-key');
  await page.locator('#appset-baseurl').fill('https://api.nan.builders/v1');
  await page.locator('#appset-lmodel').fill('');            // vacío = automático
  await page.locator('#appset-probe-appset-lmodel').click();
  // "vacío" deja de ser una caja negra: dice cuál ha usado (el liteModel del preset de nan).
  await expect(page.locator('#appset-probe-appset-lmodel-hint')).toContainText('qwen3.6');
});
