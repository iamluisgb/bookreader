import { test, expect, Page } from '@playwright/test';
import path from 'path';

// MON1 F5 · El medidor de la prueba gratuita. Se enseña en PORCENTAJE porque lo que
// cuesta un turno varía (una pregunta puede ser una llamada o cuatro si entra el
// camino agéntico): un contador de llamadas bajando a saltos se lee como un timo.
//
// Las dos reglas que fija este spec:
//   1. No aparece hasta consumida la mitad — delante de quien acaba de empezar, un
//      medidor solo comunica escasez.
//   2. El total lo manda el servidor (X-Quota-Total), así que el porcentaje sobrevive
//      a un navegador limpio y a que mañana cambie DEMO_QUOTA.

const EPUB_PATH = path.join(__dirname, 'test.epub');
const GATEWAY = 'https://bookreader-gateway.luisgonzalezb93.workers.dev/v1';

// Deja la demo configurada y stubbea el gateway con el cupo que pida cada test.
async function conCupo(page: Page, remaining: number, total = 100) {
  await page.addInitScript((gw) => {
    localStorage.setItem('bookreader_ai_base_url', JSON.stringify(gw));
    localStorage.setItem('bookreader_ai_key', JSON.stringify('br-demo-stub'));
    localStorage.setItem('bookreader_ai_model', JSON.stringify('bookreader-fast'));
  }, GATEWAY);
  await page.route('**/chat/completions', (route) => route.fulfill({
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Quota-Remaining': String(remaining),
      'X-Quota-Total': String(total),
      // Igual que producción: el gateway es otro origen, así que sin exponerlas el
      // navegador las recibe pero NO deja que el JS las lea. Fue justo lo que faltaba.
      'Access-Control-Expose-Headers': 'X-Quota-Remaining, X-Quota-Total',
    },
    body: JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
  }));
}

// Una llamada cualquiera basta: el cupo se lee en el fetch común, no en una ruta concreta.
const provocarLlamada = (page: Page) => page.evaluate(async () => {
  const LLM = await import('/js/ai/llm.js');
  await LLM.chatTools({ messages: [{ role: 'user', content: 'x' }], tools: [] }).catch(() => {});
});

async function abrirPanel(page: Page) {
  await page.goto('/');
  const [fc] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Subir tu primer libro' }).click(),
  ]);
  await fc.setFiles(EPUB_PATH);
  await page.locator('#ai-toggle').click();
}

test('con la demo recién empezada no se enseña nada', async ({ page }) => {
  await conCupo(page, 80);
  await abrirPanel(page);
  await provocarLlamada(page);
  await expect(page.locator('#ai-quota')).toBeHidden();
});

test('pasada la mitad aparece el porcentaje que queda', async ({ page }) => {
  await conCupo(page, 42);
  await abrirPanel(page);
  await provocarLlamada(page);

  const quota = page.locator('#ai-quota');
  await expect(quota).toBeVisible();
  await expect(quota).toContainText('42%');
  await expect(quota.locator('.ai-quota-bar > span')).toHaveAttribute('style', /width:\s*42%/);
  await expect(quota).not.toHaveClass(/ai-quota--low/);
});

test('el porcentaje sale del total del SERVIDOR, no de lo que recuerde el cliente', async ({ page }) => {
  // MISMO "remaining" que el test anterior (42) sobre otro total: si el cliente se
  // inventara el denominador —o recordara uno viejo— aquí seguiría diciendo 42%.
  await conCupo(page, 42, 200);
  await abrirPanel(page);
  await provocarLlamada(page);
  await expect(page.locator('#ai-quota')).toContainText('21%');
});

test('quedando poco, sube el tono y ofrece poner la propia key', async ({ page }) => {
  await conCupo(page, 12);
  await abrirPanel(page);
  await provocarLlamada(page);

  const quota = page.locator('#ai-quota');
  await expect(quota).toHaveClass(/ai-quota--low/);
  await expect(quota).toContainText('12%');
  // El onboarding tapa el panel hasta que se elige objetivo; el enlace vive debajo.
  await page.locator('.ai-ob-tpl[data-tpl="t3-juicio"]').click();
  await page.fill('#ai-ob-goal', 'Terminar el libro.');
  await page.locator('#ai-ob-start').click();
  await expect(page.locator('#ai-onboarding')).toHaveCount(0);
  await quota.locator('.ai-quota-link').click();
  await expect(page.locator('#appset-provider')).toBeVisible();   // abre Ajustes → Agente
});

test('agotada, lo dice sin medias tintas', async ({ page }) => {
  await conCupo(page, 0);
  await abrirPanel(page);
  await provocarLlamada(page);
  await expect(page.locator('#ai-quota')).toContainText('Se acabó la prueba gratuita');
});

test('con API key propia no hay medidor: el cupo no es asunto suyo', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('bookreader_ai_base_url', JSON.stringify('https://api.nan.builders/v1'));
    localStorage.setItem('bookreader_ai_key', JSON.stringify('sk-mia'));
  });
  // Un proveedor propio no manda estas cabeceras; que las mandara no debería importar.
  await page.route('**/chat/completions', (route) => route.fulfill({
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-Quota-Remaining': '1', 'X-Quota-Total': '100' },
    body: JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
  }));
  await abrirPanel(page);
  await provocarLlamada(page);
  await expect(page.locator('#ai-quota')).toBeHidden();
});
