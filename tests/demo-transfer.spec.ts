import { test, expect, Page } from '@playwright/test';

// F3.1 · Traspaso de la demo a otro dispositivo (`#demo=br-…`).
//
// El caso que lo justifica: pedir una demo nueva desde el móvil devuelve
// `demo_already_granted`, porque el gateway cuenta 1 demo por RED y día y el móvil está
// en la misma wifi que el portátil. Sin traspaso, la demo se queda encerrada donde se
// emitió. Lo que se fija aquí es lo que hace que el traspaso sea seguro de usar: que el
// token salga de la URL, que un enlace malo no deje la app configurada a medias, y que
// lo que se comparte lleve la configuración ENTERA (el token suelto no sirve).

const GATEWAY = 'https://bookreader-gateway.luisgonzalezb93.workers.dev/v1';
const QUOTA = 'https://bookreader-gateway.luisgonzalezb93.workers.dev/quota';
const TOKEN = 'br-demo-000000000000';

async function seed(page: Page, ajustes: Record<string, unknown>) {
  await page.addInitScript((a) => {
    for (const [k, v] of Object.entries(a)) localStorage.setItem('bookreader_' + k, JSON.stringify(v));
  }, ajustes);
}

const leer = (page: Page, k: string) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem('bookreader_' + key) || 'null'), k);

// El gateway responde `/quota` sin gastar cupo: es lo que valida el enlace recibido.
async function stubQuota(page: Page, body: Record<string, unknown> | null, status = 200) {
  await page.route(QUOTA, (route) => route.fulfill({
    status,
    json: body ?? { error: { message: 'Unknown or revoked token.', code: 'invalid_token' } },
  }));
}

test('un enlace de traspaso configura la demo en este dispositivo', async ({ page }) => {
  await stubQuota(page, { remaining: 27, quota: 30, tier: 'demo', product: 'bookreader', model: 'bookreader-fast' });
  await page.goto('/#demo=' + TOKEN);

  await expect(page.locator('.ai-toast')).toContainText('27');
  expect(await leer(page, 'ai_base_url')).toBe(GATEWAY);
  expect(await leer(page, 'ai_key')).toBe(TOKEN);
  expect(await leer(page, 'ai_model')).toBe('bookreader-fast');
  // El cupo llega con el propio enlace: el medidor existe antes de la primera pregunta.
  expect(await leer(page, 'ai_demo_quota')).toEqual({ remaining: 27, total: 30 });
});

// El token es la credencial: dejarlo en la barra de direcciones lo mete en el historial
// y en cualquier enlace que el usuario copie después sin fijarse.
test('el token desaparece de la URL nada más abrirla', async ({ page }) => {
  await stubQuota(page, { remaining: 30, quota: 30, model: 'bookreader-fast' });
  await page.goto('/#demo=' + TOKEN);

  await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
  expect(page.url()).not.toContain(TOKEN);
});

test('el resto del hash sobrevive: el enlace puede venir pegado a uno de libro', async ({ page }) => {
  await stubQuota(page, { remaining: 30, quota: 30, model: 'bookreader-fast' });
  await page.goto('/#book=abc&demo=' + TOKEN);

  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#book=abc');
});

// Sin validar antes de guardar, un enlace mal copiado dejaría la app pidiendo al gateway
// con una key que solo sabe devolver 401 — y eso se lee como "la demo nace rota".
test('un token revocado no se guarda: se avisa y la config queda intacta', async ({ page }) => {
  await stubQuota(page, null, 401);
  await page.goto('/#demo=br-demo-noexiste');

  await expect(page.locator('.ai-toast')).toContainText(/revoked|válido|good/i);
  expect(await leer(page, 'ai_key')).toBe(null);
  expect(await leer(page, 'ai_base_url')).toBe(null);
});

test('un token con forma inválida ni siquiera llega al gateway', async ({ page }) => {
  let llamadas = 0;
  await page.route(QUOTA, (route) => { llamadas++; route.fulfill({ json: {} }); });
  await page.goto('/#demo=sk-de-otro-proveedor');

  await expect(page.locator('.ai-toast')).toBeVisible();
  expect(llamadas).toBe(0);
  expect(await leer(page, 'ai_key')).toBe(null);
});

// Si el enlace llega ya gastado, se dice de entrada: descubrirlo al preguntar es peor.
test('una demo agotada se guarda, pero avisando de que no queda cupo', async ({ page }) => {
  await stubQuota(page, { remaining: 0, quota: 30, model: 'bookreader-fast' });
  await page.goto('/#demo=' + TOKEN);

  await expect(page.locator('.ai-toast')).toContainText(/agotada|used up/i);
  expect(await leer(page, 'ai_key')).toBe(TOKEN);
});

// ---- el lado que EMITE el enlace ---------------------------------------------

async function abrirTraspaso(page: Page) {
  await page.goto('/');
  await page.locator('.lib-rail-settings').click();
  await page.locator('#appset-xfer-btn').click();
}

test('con la demo activa se ofrece el enlace, con el token vivo dentro', async ({ page }) => {
  await stubQuota(page, { remaining: 12, quota: 30, model: 'bookreader-fast' });
  await seed(page, { ai_base_url: GATEWAY, ai_key: TOKEN, ai_model: 'bookreader-fast' });
  await abrirTraspaso(page);

  await expect(page.locator('#appset-xfer-url')).toHaveValue(new RegExp('#demo=' + TOKEN + '$'));
  // El cupo se pregunta al gateway al abrir: el número que se comparte es el de verdad.
  await expect(page.locator('#appset-xfer-hint')).toContainText('12');
});

// El token suelto no sirve (solo vale contra esta base URL): ese fue siempre el motivo
// de no enseñarlo, así que donde se enseña va acompañado de los otros dos campos.
test('el modo manual da los tres campos, no solo el token', async ({ page }) => {
  await stubQuota(page, { remaining: 12, quota: 30, model: 'bookreader-fast' });
  await seed(page, { ai_base_url: GATEWAY, ai_key: TOKEN, ai_model: 'bookreader-fast' });
  await abrirTraspaso(page);
  await page.locator('.appset-xfer-manual > summary').click();

  await expect(page.locator('#appset-xfer-base')).toHaveValue(GATEWAY);
  await expect(page.locator('#appset-xfer-token')).toHaveValue(TOKEN);
  await expect(page.locator('#appset-xfer-model')).toHaveValue('bookreader-fast');
});

// Las dos vistas del Agente lo ofrecen: la avanzada no enseña el bloque de la demo (ya
// hay key), así que sin esto el traspaso solo existiría para quien nunca la abre.
test('la vista avanzada también ofrece el traspaso', async ({ page }) => {
  await stubQuota(page, { remaining: 12, quota: 30, model: 'bookreader-fast' });
  await seed(page, { ai_base_url: GATEWAY, ai_key: TOKEN, ai_model: 'bookreader-fast', ai_advanced: true });
  await abrirTraspaso(page);

  await expect(page.locator('#appset-xfer-url')).toHaveValue(new RegExp('#demo=' + TOKEN + '$'));
});

// Una key propia JAMÁS va en una URL: el traspaso es solo para el token de la demo.
test('con una API key propia no se ofrece traspaso', async ({ page }) => {
  await seed(page, { ai_base_url: 'https://api.nan.builders/v1', ai_key: 'sk-mia', ai_model: 'deepseek-v4-flash' });
  await page.goto('/');
  await page.locator('.lib-rail-settings').click();

  await expect(page.locator('#appset-xfer-btn')).toHaveCount(0);
});
