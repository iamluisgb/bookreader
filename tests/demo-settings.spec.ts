import { test, expect, Page } from '@playwright/test';

// Ajustes → Agente con la DEMO activa. El bug que fija este spec: la vista simple
// enseñaba el token del gateway en el campo "API key" y "Guardar" lo escribía junto a
// la base URL del proveedor del desplegable (nan por defecto). Resultado: el token
// `br-demo-…` viajaba a api.nan.builders y la primera pregunta moría con "API key
// inválida (401)" — el usuario concluía, con razón, que la key de la demo nacía rota.

const GATEWAY = 'https://bookreader-gateway.luisgonzalezb93.workers.dev/v1';
const NAN = 'https://api.nan.builders/v1';
const TOKEN = 'br-demo-000000000000';

// Siembra el estado de localStorage ANTES de que cargue la app (los módulos leen los
// ajustes al importarse).
async function seed(page: Page, ajustes: Record<string, unknown>) {
  await page.addInitScript((a) => {
    for (const [k, v] of Object.entries(a)) localStorage.setItem('bookreader_' + k, JSON.stringify(v));
  }, ajustes);
}

const leer = (page: Page, k: string) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem('bookreader_' + key) || 'null'), k);

async function abrirAgente(page: Page) {
  await page.goto('/');
  await page.locator('.lib-rail-settings').click();
}

test('con la demo activa, el token no se enseña como API key', async ({ page }) => {
  await seed(page, { ai_base_url: GATEWAY, ai_key: TOKEN, ai_model: 'bookreader-fast' });
  await abrirAgente(page);
  await expect(page.locator('#appset-key')).toHaveValue('');
  await expect(page.locator('.appset-demo-on')).toBeVisible();
});

test('Guardar sin escribir key conserva la demo (no la manda a otro proveedor)', async ({ page }) => {
  await seed(page, { ai_base_url: GATEWAY, ai_key: TOKEN, ai_model: 'bookreader-fast' });
  await abrirAgente(page);
  await page.locator('#appset-save').click();

  await expect(page.locator('#appset-simple-hint')).toBeVisible();
  expect(await leer(page, 'ai_base_url')).toBe(GATEWAY);
  expect(await leer(page, 'ai_key')).toBe(TOKEN);
  expect(await leer(page, 'ai_model')).toBe('bookreader-fast');
});

test('pegar una key propia sí cambia de proveedor', async ({ page }) => {
  await seed(page, { ai_base_url: GATEWAY, ai_key: TOKEN, ai_model: 'bookreader-fast' });
  await abrirAgente(page);
  await page.selectOption('#appset-provider', 'nan');
  await page.fill('#appset-key', 'sk-mia');
  await page.locator('#appset-save').click();

  expect(await leer(page, 'ai_base_url')).toBe(NAN);
  expect(await leer(page, 'ai_key')).toBe('sk-mia');
  expect(await leer(page, 'ai_model')).toBe('deepseek-v4-flash');
});

// Mismo bug que el token, en el micrófono: el alias de voz del gateway solo existe en el
// gateway. Cambiar de proveedor sin limpiarlo dejaba el dictado mandando audio a un modelo
// que el proveedor nuevo no conoce, con el agravante de que el fallo llega 30 segundos
// después de hablar. Vacío = dictado del navegador, que funciona siempre.
test('cambiar de proveedor no se lleva puesto el alias de dictado de la demo', async ({ page }) => {
  await seed(page, {
    ai_base_url: GATEWAY, ai_key: TOKEN, ai_model: 'bookreader-fast',
    ai_stt_model: 'bookreader-voice',
  });
  await abrirAgente(page);
  await page.selectOption('#appset-provider', 'nan');
  await page.fill('#appset-key', 'sk-mia');
  await page.locator('#appset-save').click();

  expect(await leer(page, 'ai_stt_model')).toBe('');
});

test('la vista avanzada tampoco borra el token de la demo al guardar', async ({ page }) => {
  await seed(page, { ai_base_url: GATEWAY, ai_key: TOKEN, ai_model: 'bookreader-fast', ai_advanced: true });
  await abrirAgente(page);
  await expect(page.locator('#appset-key')).toHaveValue('');
  await page.locator('#appset-save').click();

  expect(await leer(page, 'ai_key')).toBe(TOKEN);
  expect(await leer(page, 'ai_base_url')).toBe(GATEWAY);
});

// Quien ya se quedó con el estado roto no puede arreglarlo desde la UI (no ve el token
// que hay que borrar): la app lo repara al arrancar.
test('un token del gateway con otra base URL se repara al cargar', async ({ page }) => {
  await seed(page, { ai_base_url: NAN, ai_key: TOKEN, ai_model: 'deepseek-v4-flash', ai_vision_model: 'mimo-v2.5' });
  await abrirAgente(page);

  expect(await leer(page, 'ai_base_url')).toBe(GATEWAY);
  expect(await leer(page, 'ai_model')).toBe('bookreader-fast');
  // La visión NO se limpia: el gateway tiene su propio alias multimodal, y dejarlo vacío
  // apagaba "Explícame esta figura" en la demo.
  expect(await leer(page, 'ai_vision_model')).toBe('bookreader-vision');
  await expect(page.locator('.appset-demo-on')).toBeVisible();
});

// La fila de la API key lleva ojo + copiar en las dos vistas: en password a secas la
// key era invisible e incopiable, y quien la recibe pegada (un token de demo, por
// ejemplo) no puede verificarla ni llevarla a otro dispositivo.
test('el ojo revela y oculta la API key, y hay botón de copiar', async ({ page }) => {
  await seed(page, { ai_base_url: NAN, ai_key: 'sk-mi-key-secreta-123', ai_model: 'm1' });
  await abrirAgente(page);
  const key = page.locator('#appset-key');
  await expect(key).toHaveValue('sk-mi-key-secreta-123');
  await expect(key).toHaveAttribute('type', 'password');

  await page.locator('.appset-key-eye').click();
  await expect(key).toHaveAttribute('type', 'text');
  await page.locator('.appset-key-eye').click();
  await expect(key).toHaveAttribute('type', 'password');

  // Copiar existe y funciona (el portapapeles se rellena con lo del campo).
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#appset-key + .appset-key-eye ~ .appset-copy, .appset-key-row .appset-copy').first().click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe('sk-mi-key-secreta-123');
});
