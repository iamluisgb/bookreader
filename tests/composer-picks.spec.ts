import { test, expect, Page } from '@playwright/test';
import path from 'path';

// Perfil y modelo se eligen en el propio composer (ai/composer-picks.js), sin salir de la
// conversación a Ajustes; y un botón redondo lleva al inicio de la última respuesta, que
// tras una respuesta larga queda por encima de la vista. Inspirado en la web de Hermes.

const EPUB_PATH = path.join(__dirname, 'test.epub');
const LONG = Array.from({ length: 30 }, (_, i) => `Párrafo ${i + 1} de una respuesta larga sobre Comala.`).join('\n\n');

async function setup(page: Page, { demo = false } = {}) {
  const models: string[] = [];
  await page.addInitScript((demo) => {
    if (demo) {
      localStorage.setItem('bookreader_ai_base_url', JSON.stringify('https://bookreader-gateway.luisgonzalezb93.workers.dev/v1'));
      localStorage.setItem('bookreader_ai_key', JSON.stringify('br-demo-stub'));
      localStorage.setItem('bookreader_ai_model', JSON.stringify('bookreader-fast'));
    } else {
      localStorage.setItem('bookreader_ai_base_url', JSON.stringify('https://openrouter.ai/api/v1'));
      localStorage.setItem('bookreader_ai_key', JSON.stringify('sk-test'));
      localStorage.setItem('bookreader_ai_model', JSON.stringify('google/gemini-2.5-flash'));
    }
    localStorage.setItem('bookreader_profiles', JSON.stringify([
      { id: 'p1', name: 'Investigador', soul: 'Eres riguroso.' },
      { id: 'p2', name: 'Estudiante', soul: 'Explica fácil.' },
    ]));
  }, demo);
  await page.route('**/chat/completions', (route) => {
    try { models.push(JSON.parse(route.request().postData() || '{}').model); } catch { /* */ }
    const body = 'data: ' + JSON.stringify({ choices: [{ delta: { content: LONG }, finish_reason: null }] }) + '\n\ndata: [DONE]\n\n';
    return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body });
  });
  await page.goto('/');
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Subir tu primer libro' }).click()]);
  await fc.setFiles(EPUB_PATH);
  await page.waitForSelector('#ai-toggle:not([disabled])');
  await page.locator('#ai-toggle').click();
  await page.locator('.ai-ob-tpl[data-tpl="t3-juicio"]').click();
  await page.fill('#ai-ob-goal', 'Entender Comala');
  await page.locator('#ai-ob-start').click();
  await expect(page.locator('#ai-status')).toContainText('Listo', { timeout: 30000 });
  return { models };
}

const ask = async (page: Page, q: string) => {
  const n = await page.locator('.ai-msg-assistant').count();
  await page.fill('#ai-input', q);
  await page.locator('#ai-send').click();
  await expect(page.locator('.ai-msg-assistant')).toHaveCount(n + 1, { timeout: 20000 });
  await expect(page.locator('.ai-msg-assistant').last()).toContainText('Párrafo 30', { timeout: 20000 });
};

test('el modelo se cambia en el composer y la siguiente pregunta ya lo usa', async ({ page }) => {
  const { models } = await setup(page);
  const pick = page.locator('[data-pick="model"]');
  await expect(pick).toContainText('gemini-2.5-flash');
  await pick.click();
  await page.locator('.ai-pick-menu [data-model="anthropic/claude-haiku-4.5"]').click();
  await expect(pick).toContainText('claude-haiku-4.5');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('bookreader_ai_model')!))).toBe('anthropic/claude-haiku-4.5');

  await ask(page, '¿Qué es Comala?');
  expect(models).toContain('anthropic/claude-haiku-4.5');
  // Y sigue en la conversación: nadie ha ido a Ajustes.
  await expect(page.locator('#appset-provider')).toHaveCount(0);
});

test('el perfil se elige en el composer; «Sin perfil» lo quita', async ({ page }) => {
  await setup(page);
  const pick = page.locator('[data-pick="profile"]');
  await expect(pick.locator('.ai-pick-label')).toBeHidden();      // sin perfil: solo el icono
  await pick.click();
  await page.locator('.ai-pick-menu [data-profile="p2"]').click();
  await expect(pick.locator('.ai-pick-label')).toHaveText('Estudiante');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('bookreader_active_profile')!))).toBe('p2');

  await pick.click();
  await page.locator('.ai-pick-menu [data-profile=""]').click();
  await expect(pick.locator('.ai-pick-label')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('bookreader_active_profile'))).toBeNull();

  // Gestionar perfiles sí lleva a Ajustes: crear y editar es configurar.
  await pick.click();
  await page.locator('.ai-pick-menu [data-go="profiles"]').click();
  await expect(page.locator('.appset-overlay, #app-settings').first()).toBeVisible();
});

test('en la demo, el menú del modelo ofrece la salida a tu propia API key', async ({ page }) => {
  await setup(page, { demo: true });
  const pick = page.locator('[data-pick="model"]');
  await expect(pick).toContainText('Demo');
  await pick.click();
  await expect(page.locator('.ai-pick-menu')).toContainText('Estás usando la demo gratuita.');
  await page.locator('.ai-pick-menu [data-go="agent"]').click();
  await expect(page.locator('#appset-provider')).toBeVisible();
});

test('tras una respuesta larga, el botón redondo lleva a su inicio y desaparece', async ({ page }) => {
  await setup(page);
  await ask(page, '¿Qué es Comala?');
  const jump = page.locator('#ai-jump');
  await expect(jump).toBeVisible();
  await expect(jump).not.toHaveClass(/is-down/);                 // el inicio está ARRIBA
  await jump.click();
  const last = page.locator('.ai-msg-assistant').last();
  await expect.poll(async () => page.evaluate(() => {
    const m = document.getElementById('ai-messages')!;
    const a = [...m.querySelectorAll('.ai-msg-assistant')].pop() as HTMLElement;
    return Math.abs(a.offsetTop - m.scrollTop) < 40;
  })).toBe(true);
  await expect(last).toContainText('Párrafo 1 ');
  await expect(jump).toBeHidden();
});
