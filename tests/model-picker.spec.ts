import { test, expect, Page } from '@playwright/test';

// Selector de modelo (ai/catalog.js + openModelPicker). Lo que se fija aquí es lo que
// motivó el cambio: "Descubrir" pedía GET /models al proveedor y eso NO puede funcionar
// en nan (responde sin cabeceras CORS), mientras que en OpenRouter devolvía 337 ids
// pelados, ilegibles. Ahora el catálogo de models.dev da nombre y capacidades, y el slot
// de visión solo ofrece modelos que ven — el error que antes no se notaba hasta pulsar
// "Explicar lo que veo".
//
// models.dev se STUBBEA: son 3,4 MB reales y su contenido cambia solo. Lo que se prueba
// es nuestro contrato con esa forma de datos, no su catálogo.

const CATALOG = {
  openrouter: {
    name: 'OpenRouter',
    models: {
      'acme/ve-y-usa-herramientas': {
        id: 'acme/ve-y-usa-herramientas', name: 'Acme Multimodal', tool_call: true, attachment: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 200000 }, cost: { input: 0.3, output: 2.5 }, release_date: '2026-06-01',
      },
      'acme/solo-texto': {
        id: 'acme/solo-texto', name: 'Acme Texto', tool_call: true, attachment: false,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 128000 }, cost: { input: 0.1, output: 0.4 }, release_date: '2026-05-01',
      },
      'acme/viejo-y-ciego': {
        id: 'acme/viejo-y-ciego', name: 'Acme Antiguo', tool_call: false, attachment: false,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 8000 }, release_date: '2024-01-01',
      },
    },
  },
};

// El catálogo se cachea en memoria por sesión: cada test estrena página, así que no
// hace falta resetear nada entre unos y otros.
async function stubCatalog(page: Page) {
  let hits = 0;
  await page.route('https://models.dev/api.json', (route) => {
    hits++;
    return route.fulfill({ json: CATALOG });
  });
  return () => hits;
}

async function abrirAvanzada(page: Page, provider: string) {
  await page.goto('/');
  await page.locator('.lib-rail-settings').click();
  await page.locator('#appset-agent-advanced').click();
  await page.selectOption('#appset-provider', provider);
}

test('el selector muestra nombre, id y capacidades del catálogo', async ({ page }) => {
  await stubCatalog(page);
  await abrirAvanzada(page, 'openrouter');
  await page.locator('#appset-model-discover').click();

  await expect(page.locator('.mp-source')).toContainText('models.dev');
  await expect(page.locator('.mp-item')).toHaveCount(3);
  const primero = page.locator('.mp-item').first();
  await expect(primero.locator('.mp-name')).toHaveText('Acme Multimodal');       // el más reciente arriba
  await expect(primero.locator('.mp-id')).toHaveText('acme/ve-y-usa-herramientas');
  await expect(primero.locator('.mp-tags')).toContainText('herramientas');
  await expect(primero.locator('.mp-tags')).toContainText('0.30 $/M');
});

test('el buscador filtra por nombre y por id, y elegir rellena el slot', async ({ page }) => {
  await stubCatalog(page);
  await abrirAvanzada(page, 'openrouter');
  await page.locator('#appset-model-discover').click();

  await page.fill('#mp-search', 'antiguo');            // por nombre
  await expect(page.locator('.mp-item')).toHaveCount(1);
  await page.fill('#mp-search', 'solo-texto');         // por id
  await expect(page.locator('.mp-item')).toHaveCount(1);

  await page.locator('.mp-item').first().click();
  await expect(page.locator('.mp-overlay')).toHaveCount(0);
  await expect(page.locator('#appset-model')).toHaveValue('acme/solo-texto');
});

// La razón de ser del filtro: un modelo ciego en el slot de visión no falla al guardar,
// falla semanas después al pulsar "Explicar lo que veo".
test('el slot de visión solo ofrece modelos que aceptan imágenes', async ({ page }) => {
  await stubCatalog(page);
  await abrirAvanzada(page, 'openrouter');
  await page.locator('#appset-pick-appset-vmodel').click();

  await expect(page.locator('.mp-item')).toHaveCount(1);
  await expect(page.locator('.mp-item .mp-id')).toHaveText('acme/ve-y-usa-herramientas');
});

// nan: ni está en models.dev ni deja enumerar sus modelos (CORS). El selector cae en los
// curados y lo DICE, en vez de enseñar un error. Y no dispara peticiones condenadas.
test('sin catálogo ni /models, el selector cae en los modelos verificados', async ({ page }) => {
  const catalogHits = await stubCatalog(page);
  let modelsHits = 0;
  await page.route('**/v1/models', (route) => { modelsHits++; return route.abort(); });

  await abrirAvanzada(page, 'nan');
  await page.locator('#appset-model-discover').click();

  await expect(page.locator('.mp-source')).toContainText(/verificados|verified/);
  await expect(page.locator('.mp-item')).toHaveCount(4);
  expect(catalogHits()).toBe(0);   // nan no declara catalogId
  expect(modelsHits).toBe(0);      // `discover: false` evita la petición que iba a fallar
});
