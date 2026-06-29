import { test, expect } from '@playwright/test';

// Test del agente de IA contra la API real de nan. Se salta automáticamente si no
// hay NAN_API_KEY (definida en .env, cargada por playwright.config.ts).
const KEY = process.env.NAN_API_KEY;

test.describe('BookReader - Agente IA', () => {
  test.skip(!KEY, 'NAN_API_KEY no definido (crea .env a partir de .env.example)');

  // @live: prueba contra la API real de nan (no determinista). Fuera del `npm test`
  // determinista; se ejecuta con `npm run test:ai`.
  test('responde sobre el libro con citas navegables @live', async ({ page }) => {
    test.setTimeout(180000); // API real, no determinista; varios reintentos posibles

    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text());
    });

    await page.goto('/index.html');

    // BYOK: inyectar la key como lo haría el usuario en el panel (localStorage).
    await page.evaluate((k) => localStorage.setItem('bookreader_ai_key', JSON.stringify(k)), KEY);
    await page.reload();

    // Abrir el EPUB de prueba.
    const [fc] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: 'Abrir archivo' }).click(),
    ]);
    await fc.setFiles('tests/test.epub');

    // Abrir el panel: con un libro nuevo aparece el onboarding.
    await page.waitForSelector('#ai-toggle:not([disabled])', { timeout: 15000 });
    await page.click('#ai-toggle');

    // Onboarding: bloque -> plantilla -> objetivo.
    await page.waitForSelector('.ai-onboarding', { timeout: 5000 });
    await page.click('.ai-ob-block[data-block="tecnico"]');
    await page.click('.ai-ob-tpl[data-tpl="adler"]');
    await page.fill('#ai-ob-goal', 'Comprender la obra a fondo.');
    await page.click('#ai-ob-start');

    // Sesión lista y libro segmentado.
    await expect(page.locator('#ai-tabs')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#ai-status')).toContainText('Listo', { timeout: 30000 });

    // Helper: enviar una pregunta y esperar la respuesta del agente.
    const ask = async (q: string) => {
      await page.fill('#ai-input', q);
      await page.click('#ai-send');
      const bubble = page.locator('.ai-msg-assistant .ai-bubble-text').last();
      await expect(bubble).toHaveText(/.{30,}/, { timeout: 90000 });
      await expect(bubble).not.toContainText('pensando');
    };

    // El modelo no siempre cita inline a la primera (no determinista); reintentamos
    // con peticiones cada vez más explícitas antes de afirmar que las citas funcionan.
    const prompts = [
      '¿Qué le promete Juan Preciado a su madre antes de ir a Comala? Termina tu respuesta con el marcador del pasaje en formato [[aN]] (obligatorio).',
      'Indícame el marcador exacto del pasaje donde se lo promete, en formato [[aN]].',
      'Responde SOLO con el marcador del pasaje, p. ej. [[a12]], sin más texto.',
    ];
    for (const p of prompts) {
      await ask(p);
      if (await page.locator('.ai-cite').count() > 0) break;
    }

    // Hay al menos una cita clicable.
    const cite = page.locator('.ai-cite').first();
    await expect(cite).toBeVisible({ timeout: 5000 });

    // Clic en la cita navega el lector a otro pasaje.
    const readBody = () =>
      page.evaluate(
        () => document.querySelector('#epub-container iframe')?.contentDocument?.body.textContent?.slice(0, 80) || ''
      );
    const before = await readBody();
    await cite.click();
    await page.waitForTimeout(1500);
    const after = await readBody();
    expect(after).not.toEqual(before);

    expect(errors).toEqual([]);
  });
});
