// "Con números": el fragmento seleccionado (fórmula o algoritmo) ejecutado a mano con
// números pequeños. Lo que aporta valor está en el bloque de sistema del turno, así que
// eso es lo que se comprueba de forma determinista; la calidad real de la salida va en
// el test @live, que sí llama al modelo.
import { test, expect, Page } from '@playwright/test';
import path from 'path';

const EPUB = path.join(__dirname, 'test.epub');
const GW = 'https://bookreader-gateway.luisgonzalezb93.workers.dev/v1';
const TOKEN = process.env.GW_TOKEN || '';

// Intercepta la llamada al modelo, guarda el system prompt recibido y responde por SSE.
async function stubLLM(page: Page) {
  await page.evaluate(() => {
    (window as any).__lastSystem = '';
    const real = window.fetch.bind(window);
    (window as any).fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions') && opts?.body) {
        const body = JSON.parse(opts.body);
        (window as any).__lastSystem = (body.messages || []).find((m: any) => m.role === 'system')?.content || '';
        const chunks = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'Con x=2 y v=0.6: (2 - 1.8)/0.8 = 0.25' }, finish_reason: null }] })}\n\n`,
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ];
        const s = new ReadableStream({ start(c) { const e = new TextEncoder(); chunks.forEach(x => c.enqueue(e.encode(x))); c.close(); } });
        return new Response(s, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return real(url, opts);
    };
  });
}

async function openWithAgent(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('bookreader_ai_key', JSON.stringify('sk-test'));
    localStorage.setItem('bookreader_ai_base_url', JSON.stringify('https://stub.invalid/v1'));
  });
  await page.goto('/');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Abrir archivo' }).click(),
  ]);
  await chooser.setFiles(EPUB);
  await expect(page.locator('#reader-title')).toHaveText('Pedro Páramo', { timeout: 15000 });
  await page.locator('#ai-toggle').click();
  await page.locator('.ai-ob-quickchat').click().catch(() => { /* ya hay conversación */ });
  await expect(page.locator('#ai-status')).toContainText(/Listo para preguntar/, { timeout: 30000 });
  await stubLLM(page);
}

test('el botón "Con números" está en la barra de selección', async ({ page }) => {
  await page.goto('/');
  const btn = page.locator('#sel-numeric');
  await expect(btn).toHaveCount(1);
  await expect(btn).toHaveAttribute('title', /números pequeños/);
});

// La barra crece cada vez que se añade una acción y es `fixed`: sin tope se sale del
// móvil (ya pasaba con 4 acciones, antes de "Con números").
test('la barra de selección cabe en un móvil', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 780 });
  await page.goto('/');
  const box = await page.evaluate(() => {
    const tt = document.getElementById('highlight-tooltip')!;
    tt.style.display = 'block';
    tt.style.visibility = 'visible';
    tt.style.left = '10px';
    return tt.getBoundingClientRect().width;
  });
  expect(box).toBeLessThanOrEqual(375);
});

test('activa el modo numérico en el system prompt del turno', async ({ page }) => {
  test.setTimeout(120000);
  await openWithAgent(page);

  await page.evaluate(async () => {
    const m: any = await import('/js/ai/panel.js');
    await m.numericExample('x\' = (x - vt) / sqrt(1 - v^2/c^2)');
  });

  const sys = await page.evaluate(() => (window as any).__lastSystem);
  expect(sys).toContain('MODO EJEMPLO NUMÉRICO');
  expect(sys).toContain('NÚMEROS CONCRETOS');
  expect(sys).toContain('COMPROBACIÓN DE SENTIDO');
  // Sin LaTeX: mdToHtml no renderiza matemáticas, así que el prompt debe prohibirlo.
  expect(sys).toContain('NADA de LaTeX');
});

test('el mensaje que se ve es corto: las instrucciones no ensucian el chat', async ({ page }) => {
  test.setTimeout(120000);
  await openWithAgent(page);

  const largo = 'La transformación de Lorentz relaciona las coordenadas de dos sistemas inerciales '.repeat(4);
  await page.evaluate(async (f) => {
    const m: any = await import('/js/ai/panel.js');
    await m.numericExample(f);
  }, largo);

  const userMsg = await page.locator('.ai-msg-user .ai-bubble-text').last().textContent();
  expect(userMsg).toContain('🔢');
  expect(userMsg!.length).toBeLessThan(220);          // el fragmento va recortado
  expect(userMsg).not.toContain('MODO EJEMPLO');       // las reglas viven en el system
});

test('el modo no se pega a los turnos siguientes', async ({ page }) => {
  test.setTimeout(120000);
  await openWithAgent(page);

  await page.evaluate(async () => {
    const m: any = await import('/js/ai/panel.js');
    await m.numericExample('E = mc^2');
  });
  expect(await page.evaluate(() => (window as any).__lastSystem)).toContain('MODO EJEMPLO NUMÉRICO');

  await page.locator('#ai-input').fill('¿De qué trata el libro?');
  await page.locator('#ai-send').click();
  await expect(page.locator('.ai-msg-assistant').last()).toBeVisible();
  await page.waitForFunction(() => !document.querySelector('.ai-typing'), null, { timeout: 30000 });

  const sys = await page.evaluate(() => (window as any).__lastSystem);
  expect(sys).not.toContain('MODO EJEMPLO NUMÉRICO');
});

test('un fragmento vacío no dispara nada', async ({ page }) => {
  test.setTimeout(120000);
  await openWithAgent(page);
  const before = await page.locator('.ai-msg-user').count();
  await page.evaluate(async () => {
    const m: any = await import('/js/ai/panel.js');
    await m.numericExample('   ');
  });
  expect(await page.locator('.ai-msg-user').count()).toBe(before);
});

test('con una fórmula real, el modelo da números, aritmética y comprobación @live', async ({ page }) => {
  test.skip(!TOKEN, 'define GW_TOKEN (token br-… del gateway) para esta prueba');
  test.setTimeout(180000);
  await page.addInitScript(([gw, tok]) => {
    localStorage.setItem('bookreader_ai_base_url', JSON.stringify(gw));
    localStorage.setItem('bookreader_ai_key', JSON.stringify(tok));
    localStorage.setItem('bookreader_ai_model', JSON.stringify('bookreader-fast'));
  }, [GW, TOKEN]);
  await page.goto('/');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Abrir archivo' }).click(),
  ]);
  await chooser.setFiles(path.join(__dirname, '..', 'evals', 'fixtures', 'p1-relativity.epub'));
  await page.waitForSelector('#reader-footer', { state: 'visible', timeout: 30000 });
  await page.locator('#ai-toggle').click();
  await page.locator('.ai-ob-quickchat').click().catch(() => { /* ya hay conversación */ });
  await page.waitForFunction(
    () => /Listo|Ready/.test(document.getElementById('ai-status')?.textContent || ''), null, { timeout: 60000 });

  await page.evaluate(async () => {
    const m: any = await import('/js/ai/panel.js');
    await m.numericExample("the Lorentz transformation: x' = (x - vt) / sqrt(1 - v^2/c^2)");
  });
  await page.waitForFunction(() => {
    const b = document.querySelectorAll('.ai-msg-assistant .ai-bubble-text');
    const last = b[b.length - 1];
    return last && last.textContent!.length > 200 && !last.querySelector('.ai-typing');
  }, null, { timeout: 120000 });

  const answer = (await page.locator('.ai-msg-assistant .ai-bubble-text').last().textContent())!;
  // Números concretos y aritmética visible, no variables sueltas.
  expect(answer).toMatch(/\d+(\.\d+)?\s*[-–+*/×·]\s*\d/);
  expect((answer.match(/\d/g) || []).length).toBeGreaterThan(20);
  // Y una comprobación de sentido al cierre (regla 5 del prompt).
  expect(answer).toMatch(/comprueb|comprobación|verific|coincid|cuadra|sentido/i);
});

// Las otras dos acciones rápidas de la barra comparten camino con "Con números" (deliver →
// retrieval, citas, historial): lo propio de cada una es su bloque de sistema, y es lo que
// distingue "explícame" de "resúmemelo" y "por qué importa" de un elogio genérico.
test('las acciones rápidas están en la barra y cada una activa su modo', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto('/');
  await expect(page.locator('#sel-explain')).toHaveCount(1);
  await expect(page.locator('#sel-why')).toHaveCount(1);

  await openWithAgent(page);
  const frag = 'La atención causal impide que una posición atienda a las siguientes.';

  await page.evaluate(async (f) => {
    const m: any = await import('/js/ai/panel.js');
    await m.quickAction('explain', f);
  }, frag);
  let sys = await page.evaluate(() => (window as any).__lastSystem);
  expect(sys).toContain('MODO EXPLICAR');
  // La regla que evita la paráfrasis (el fallo típico de "explícame"): un ejemplo concreto.
  expect(sys).toContain('ejemplo concreto');
  expect(sys).toContain('no has explicado nada');

  await page.evaluate(async (f) => {
    const m: any = await import('/js/ai/panel.js');
    await m.quickAction('why', f);
  }, frag);
  sys = await page.evaluate(() => (window as any).__lastSystem);
  expect(sys).toContain('MODO POR QUÉ IMPORTA');
  expect(sys).toContain('OBJETIVO DE LECTURA');
  // Y la regla que permite decir "esto puedes saltártelo" en vez de justificarlo todo.
  expect(sys).toContain('SECUNDARIO');
});
