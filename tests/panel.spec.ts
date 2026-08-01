import { test, expect } from '@playwright/test';
import { seedProLicense } from './pro-license';
import path from 'path';

const EPUB_PATH = path.join(__dirname, 'test.epub');

// TEC2 · Tests de caracterización del panel IA — DETERMINISTAS (a diferencia de ai.spec.ts
// @live). Se conduce el panel real por la UI pero con `fetch` stubbeado: respuestas canned.
// Fijan el comportamiento del núcleo (onboarding, envío, y el gating del retrieval agéntico
// de la Fase 1b) como red de regresión.

// Instala el stub del endpoint del LLM y registra cada llamada (stream? qué herramientas).
async function stubLLM(page) {
  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    (window as any).__llm = { calls: [] as any[] };
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions') && opts?.body) {
        const body = JSON.parse(opts.body);
        (window as any).__llm.calls.push({ stream: !!body.stream, tools: (body.tools || []).map((t: any) => t.function?.name), messages: body.messages });
        if (body.stream) {
          const chunks = [
            'data: {"choices":[{"delta":{"content":"Respuesta de prueba."},"finish_reason":null}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n',
          ];
          const s = new ReadableStream({ start(c) { const e = new TextEncoder(); chunks.forEach(x => c.enqueue(e.encode(x))); c.close(); } });
          return new Response(s, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        // No-streaming (tools): sin tool_calls → cierra cualquier bucle (agéntico/atenuación).
        return new Response(JSON.stringify({ choices: [{ message: { content: 'LISTO' } }] }), { status: 200 });
      }
      return real(url, opts);
    };
  });
}

// Abre el epub y deja el panel listo. Con `template=null` toma la vía de CHAT LIBRE
// (botón "solo chatear"); si no, pasa el onboarding con esa plantilla. El coach mark de
// flashcards se marca visto para que no aparezca sobre las aserciones (test propio aparte).
async function setup(page, { template = 't3-juicio', goal = 'probar el panel' } = {}) {
  await page.goto('/index.html');
  await seedProLicense(page);   // features Pro gateadas (MON2): el test ejercita la feature
  await page.evaluate((k) => {
    localStorage.setItem('bookreader_ai_key', JSON.stringify(k));
    localStorage.setItem('bookreader_flashcards_hint_seen', 'true');
  }, 'test-key');
  await page.reload();
  await stubLLM(page);

  const fc = page.waitForEvent('filechooser');
  await page.click('.lib-empty .lib-upload');
  await (await fc).setFiles(EPUB_PATH);

  await page.waitForSelector('#ai-toggle:not([disabled])', { timeout: 15000 });
  await page.click('#ai-toggle');
  await page.waitForSelector('.ai-onboarding', { timeout: 5000 });
  if (template === null) {
    await page.click('.ai-ob-quickchat');
  } else {
    await page.click(`.ai-ob-tpl[data-tpl="${template}"]`);
    await page.fill('#ai-ob-goal', goal);
    await page.click('#ai-ob-start');
  }
  await expect(page.locator('#ai-tabs')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#ai-status')).toContainText('Listo', { timeout: 30000 });
}

const answerBubble = (page) => page.locator('.ai-msg-assistant .ai-bubble-text').last();

async function ask(page, q: string) {
  await page.evaluate(() => ((window as any).__llm.calls = []));   // limpiar (onboarding ya llamó)
  await page.fill('#ai-input', q);
  await page.click('#ai-send');
  await expect(answerBubble(page)).toContainText('Respuesta de prueba', { timeout: 15000 });
}

test('onboarding deja la sesión lista y una pregunta obtiene respuesta', async ({ page }) => {
  await setup(page);
  await ask(page, 'Comala Pedro Páramo madre pueblo muerte almas');
  await expect(answerBubble(page)).toBeVisible();
});

test('pregunta con buen match NO dispara retrieval agéntico', async ({ page }) => {
  await setup(page);
  await ask(page, 'Comala Pedro Páramo madre padre pueblo muerte almas caballo');
  const calls = await page.evaluate(() => (window as any).__llm.calls);
  const agentic = calls.filter((c: any) => (c.tools || []).includes('search_book'));
  expect(agentic.length).toBe(0);                            // sin recolección agéntica
  expect(calls.some((c: any) => c.stream)).toBe(true);       // sí hubo respuesta en streaming
});

test('pregunta vaga (sin match léxico) dispara retrieval agéntico', async ({ page }) => {
  await setup(page);
  await ask(page, 'zxcvbnm qwertyui asdfghj');               // términos inexistentes en el libro
  const calls = await page.evaluate(() => (window as any).__llm.calls);
  const agentic = calls.filter((c: any) => (c.tools || []).includes('search_book'));
  expect(agentic.length).toBeGreaterThan(0);                 // sí hubo recolección agéntica
});

// UX #2 · El estado en reposo es de cara al usuario, sin jerga del pipeline.
test('el estado listo no filtra jerga interna ("pasajes"/"cacheado")', async ({ page }) => {
  await setup(page);
  const txt = await page.locator('#ai-status').textContent();
  expect(txt).toContain('Listo');
  expect(txt).not.toMatch(/pasaj|cachead/i);                 // jerga interna → fuera de la UI
});

// UX #4 · Chat libre: se puede preguntar SIN elegir objetivo, y tras la 1ª respuesta se
// ofrece subir a un objetivo conservando el chat (upgrade en sitio, no una convo nueva).
test('chat libre permite preguntar sin objetivo y luego ofrece activarlo sin perder el chat', async ({ page }) => {
  await setup(page, { template: null });
  // Sin plantilla, la libreta no muestra campos de objetivo.
  await ask(page, '¿de qué trata el libro?');
  await expect(answerBubble(page)).toContainText('Respuesta de prueba');

  // Aparece el aviso para activar un objetivo.
  const nudge = page.locator('.ai-objnudge');
  await expect(nudge).toBeVisible();
  await nudge.locator('.ai-objnudge-go').click();

  // Se reabre el picker en modo "upgrade": elegimos objetivo…
  await page.waitForSelector('.ai-onboarding', { timeout: 5000 });
  await page.click('.ai-ob-tpl[data-tpl="hqa"]');
  await page.fill('#ai-ob-goal', 'memorizar el libro');
  await page.click('#ai-ob-start');

  // …y el chat previo SE CONSERVA (la respuesta sigue en pantalla) y ahora hay plantilla
  // (el selector de conversación muestra el objetivo escrito).
  await expect(answerBubble(page)).toContainText('Respuesta de prueba');
  await expect(page.locator('#ai-convo-label')).toContainText('memorizar el libro');
});

// UX #4 · El aviso de objetivo NO aparece cuando ya se eligió uno en el onboarding.
test('con objetivo elegido no se muestra el aviso de chat libre', async ({ page }) => {
  await setup(page, { template: 'hqa', goal: 'dominar el material' });
  await ask(page, 'una pregunta cualquiera');
  await expect(page.locator('.ai-objnudge')).toHaveCount(0);
});

// UX #1 · Coach mark: la primera vez que un libro queda listo, señala el botón de
// flashcards; se muestra una sola vez (persiste "visto").
test('el coach mark de flashcards aparece una vez y no reaparece', async ({ page }) => {
  await page.goto('/index.html');
  await page.evaluate((k) => localStorage.setItem('bookreader_ai_key', JSON.stringify(k)), 'test-key');
  await page.reload();
  await stubLLM(page);
  const fc = page.waitForEvent('filechooser');
  await page.click('.lib-empty .lib-upload');
  await (await fc).setFiles(EPUB_PATH);
  await page.waitForSelector('#ai-toggle:not([disabled])', { timeout: 15000 });
  await page.click('#ai-toggle');
  await page.waitForSelector('.ai-onboarding', { timeout: 5000 });
  await page.click('.ai-ob-quickchat');
  await expect(page.locator('#ai-status')).toContainText('Listo', { timeout: 30000 });

  // Aparece señalando el botón de flashcards y marca "visto" (una vez, aunque lo ignoren).
  await expect(page.locator('.ai-coachmark')).toBeVisible({ timeout: 5000 });
  expect(await page.evaluate(() => localStorage.getItem('bookreader_flashcards_hint_seen'))).toBe('true');
  await page.locator('.ai-coachmark-x').click();
  await expect(page.locator('.ai-coachmark')).toHaveCount(0);

  // Cerrar y reabrir el panel (mismo perfil, flag ya puesto) → no reaparece.
  await page.click('#ai-close');
  await page.click('#ai-toggle');
  await page.waitForTimeout(400);
  await expect(page.locator('.ai-coachmark')).toHaveCount(0);
});

// Regresión: "subrayo → Preguntar al agente → '¿qué significa esto?'" decía a veces que no
// veía el contexto. Causa: el retrieval buscaba solo con la pregunta cruda (deíctica: cero
// aciertos útiles), el pasaje del fragmento no entraba en el EXTRACTO, y el system prompt
// exige responder SOLO desde el extracto. El fix usa el fragmento (texto literal del libro)
// para localizar su pasaje anclado y meterlo primero en el contexto.
test('el fragmento adjunto entra ANCLADO en el extracto aunque la pregunta sea deíctica', async ({ page }) => {
  await setup(page);
  await ask(page, 'Comala Pedro Páramo pueblo');   // fuerza ensureIndex (el índice es perezoso)

  // Fragmento literal de un pasaje "profundo" (fuera del capítulo actual del lector y sin
  // las palabras de la pregunta): antes del fix, nada lo recuperaba.
  const frag = await page.evaluate(async () => {
    const R: any = await import('/js/ai/retrieval.js');
    const all = R.allPassages();
    const p = all.slice(Math.floor(all.length / 2)).find((x: any) => x.text.length > 150);
    return { id: p.id, text: p.text.slice(0, 200) };
  });

  await page.evaluate(async (t) => {
    const P: any = await import('/js/ai/panel.js');
    P.quoteSelection(t);
  }, frag.text);
  await expect(page.locator('#ai-ref')).toBeVisible();   // chip de referencia adjunta

  await page.evaluate(() => { (window as any).__llm.calls = []; });
  await page.fill('#ai-input', '¿qué significa esto?');
  await page.click('#ai-send');
  await expect(page.locator('.ai-msg-assistant .ai-bubble-text').last()).toContainText('Respuesta de prueba', { timeout: 15000 });

  const r = await page.evaluate((fid) => {
    const calls = (window as any).__llm.calls;
    const stream = calls.filter((c: any) => c.stream);
    const last = stream[stream.length - 1];
    const extract = (last?.messages || []).find((m: any) =>
      m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('EXTRACTO'))?.content || '';
    return {
      anchored: extract.includes(`[[${fid}]]`),                       // el pasaje del fragmento, anclado
      agentic: calls.some((c: any) => (c.tools || []).includes('search_book')),   // no hace falta ronda agéntica
      expansion: calls.some((c: any) => c.stream && (c.messages || []).some((m: any) =>
        m.role === 'system' && /BÚSQUEDA por palabras clave/i.test(m.content))),  // ni expansión HyDE
    };
  }, frag.id);
  expect(r.anchored).toBe(true);
  expect(r.agentic).toBe(false);
  expect(r.expansion).toBe(false);
});

// Los artefactos (resumen, mapa, flashcards) tenían icono propio en el toolbar ADEMÁS de su
// tarjeta en el Studio. La duplicación ya estaba rota —"Explícamelo tú" nació sin icono— así
// que se retiraron: la barra es de la CONVERSACIÓN y los artefactos viven en el Studio.
test('el toolbar ya no duplica los lanzadores de artefactos', async ({ page }) => {
  await page.goto('/');
  for (const id of ['#ai-convo-cards', '#ai-convo-summary', '#ai-convo-mindmap']) {
    await expect(page.locator(id)).toHaveCount(0);
  }
  // Lo que sí es de la conversación se queda.
  for (const id of ['#ai-convo-btn', '#ai-edit-cfg', '#ai-close']) {
    await expect(page.locator(id)).toHaveCount(1);
  }
  // "Nueva" y "Exportar" bajaron al menú del selector: a 380px de panel los seis controles
  // no cabían y el flex aplastaba a cero la etiqueta de la conversación.
  for (const id of ['#ai-convo-new', '#ai-convo-export']) {
    await expect(page.locator(id)).toHaveCount(0);
  }
});

// El coachmark de flashcards apuntaba al icono retirado (sin él no se enseñaba nada, que es
// la única pista que tiene un usuario nuevo de que existen). Ahora señala la pestaña Studio.
// Y se coloca CUANDO el panel ha terminado de entrar: midiendo a mitad de la animación, la
// flecha salía disparada fuera de la tarjeta.
test('el coachmark señala la pestaña Studio, y la flecha cae dentro', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('bookreader_ai_key', JSON.stringify('sk-test')));
  await page.goto('/');
  const fc = page.waitForEvent('filechooser');
  await page.click('.lib-empty .lib-upload');
  await (await fc).setFiles(path.join(__dirname, 'test.epub'));
  await page.waitForSelector('#epub-container iframe', { timeout: 15000 });
  await page.locator('#ai-toggle').click();
  await page.locator('.ai-ob-quickchat').click().catch(() => { /* ya hay conversación */ });
  await expect(page.locator('.ai-coachmark')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(600);   // deja terminar la entrada del panel

  const g = await page.evaluate(() => {
    const m = document.querySelector('.ai-coachmark')!.getBoundingClientRect();
    const tab = document.querySelector('.ai-tab[data-view="studio"]')!.getBoundingClientRect();
    const arrow = parseFloat(getComputedStyle(document.querySelector('.ai-coachmark')!).getPropertyValue('--arrow-x'));
    return { m: { left: m.left, right: m.right, top: m.top, width: m.width }, tabCx: tab.left + tab.width / 2, tabBottom: tab.bottom, arrow };
  });
  expect(g.m.top).toBeGreaterThanOrEqual(g.tabBottom);        // debajo de la pestaña
  expect(g.arrow).toBeGreaterThan(0);
  expect(g.arrow).toBeLessThan(g.m.width);                    // la flecha, DENTRO de la tarjeta
  expect(g.m.left + g.arrow).toBeCloseTo(g.tabCx, 0);         // y apuntando a su centro
  await expect(page.locator('.ai-coachmark')).toContainText('Studio');
});

// Guard de navegación del panel. EV1 (la batería de evals) estuvo ROTA en silencio porque
// los artefactos se movieron a la pestaña Studio y su arnés siguió asumiendo que, tras
// generar, se podía escribir en el chat sin más. `#ai-input` vive en `#ai-view-chat`, que
// es `display:none` mientras Studio está activa: el fill esperaba 30s a un elemento que
// existe pero no se ve, y la batería moría ahí. Como los @eval no corren en `npm test`,
// nadie se enteró. Este test determinista fija el invariante que faltaba.
test('el chat NO es escribible desde la pestaña Studio, y vuelve a serlo al volver a Chat', async ({ page }) => {
  await setup(page);
  await expect(page.locator('#ai-input')).toBeVisible();

  await page.locator('.ai-tab[data-view="studio"]').click();
  await expect(page.locator('#ai-view-studio')).toHaveClass(/active/);
  // Existe en el DOM pero NO es visible: es exactamente lo que confundía al arnés.
  await expect(page.locator('#ai-input')).toHaveCount(1);
  await expect(page.locator('#ai-input')).not.toBeVisible();

  await page.locator('.ai-tab[data-view="chat"]').click();
  await expect(page.locator('#ai-input')).toBeVisible();
  await page.fill('#ai-input', 'ya se puede escribir');
  await expect(page.locator('#ai-input')).toHaveValue('ya se puede escribir');
});

// La pregunta del usuario se pintaba DESPUÉS de la reescritura de consulta (una llamada al
// LLM) y del retrieval. Como send() ya ha vaciado el textarea, entre pulsar Enviar y ver tu
// propio mensaje pasaban segundos con el chat idéntico a antes de pulsar: la lectura natural
// es que el mensaje no ha salido o se ha borrado. Medido antes del arreglo: 1577 ms con solo
// 1,2 s de latencia. Aquí el stub tarda 2,5 s por llamada, así que si la burbuja depende de
// la red el test no puede pasar.
test('mi pregunta aparece al instante, sin esperar a la red', async ({ page }) => {
  test.setTimeout(120000);
  await setup(page);

  // Re-stub LENTO (el de setup responde al momento): 2,5 s por llamada al proveedor.
  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions') && opts?.body) {
        await new Promise((r) => setTimeout(r, 2500));
        const body = JSON.parse(opts.body);
        if (body.stream) {
          const chunks = ['data: {"choices":[{"delta":{"content":"Respuesta de prueba."},"finish_reason":null}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n'];
          const s = new ReadableStream({ start(c) { const e = new TextEncoder(); chunks.forEach(x => c.enqueue(e.encode(x))); c.close(); } });
          return new Response(s, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: 'LISTO' } }] }), { status: 200 });
      }
      return real(url, opts);
    };
  });

  const pregunta = '¿Por qué es importante esto y qué significa para el conjunto del libro?';
  await page.fill('#ai-input', pregunta);
  const t0 = Date.now();
  await page.click('#ai-send');
  await page.locator('.ai-msg-user').last().waitFor({ state: 'visible', timeout: 30000 });
  const ms = Date.now() - t0;

  expect(ms, `la burbuja del usuario tardó ${ms} ms (el stub tarda 2500 ms por llamada)`).toBeLessThan(1500);
  await expect(page.locator('.ai-msg-user').last()).toContainText('Por qué es importante');
  // Y el turno sigue funcionando de punta a punta.
  await expect(answerBubble(page)).toContainText('Respuesta de prueba', { timeout: 30000 });
});
