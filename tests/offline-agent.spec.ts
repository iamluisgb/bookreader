import { test, expect } from '@playwright/test';
import { seedProLicense } from './pro-license';
import path from 'path';

const EPUB_PATH = path.join(__dirname, 'test.epub');

// OFF1 · Preguntar al libro SIN COBERTURA (leer en un avión).
//
// Lo que se fija aquí es la observación que sostiene la feature: de las dos mitades de
// una respuesta, solo una necesita red. ENCONTRAR el pasaje es local (retrieval BM25);
// REDACTARLO es lo que se cae. Así que sin cobertura el agente no da un error de red:
// da los pasajes del libro, citados, y encola la pregunta para responderla al volver.

async function stubLLM(page) {
  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    (window as any).__llm = { calls: [] as any[] };
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions') && opts?.body) {
        const body = JSON.parse(opts.body);
        (window as any).__llm.calls.push({ stream: !!body.stream, messages: body.messages });
        if (body.stream) {
          const chunks = [
            'data: {"choices":[{"delta":{"content":"Respuesta de prueba."},"finish_reason":null}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n',
          ];
          const s = new ReadableStream({ start(c) { const e = new TextEncoder(); chunks.forEach(x => c.enqueue(e.encode(x))); c.close(); } });
          return new Response(s, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: 'LISTO' } }] }), { status: 200 });
      }
      return real(url, opts);
    };
  });
}

async function setup(page) {
  await page.goto('/index.html');
  await seedProLicense(page);
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
  await page.click('.ai-ob-tpl[data-tpl="t3-juicio"]');
  await page.fill('#ai-ob-goal', 'probar sin cobertura');
  await page.click('#ai-ob-start');
  await expect(page.locator('#ai-status')).toContainText('Listo', { timeout: 30000 });
}

const lastAnswer = (page) => page.locator('.ai-msg-assistant .ai-bubble-text').last();

async function ask(page, q: string) {
  await page.fill('#ai-input', q);
  await page.click('#ai-send');
}

test.describe('El agente sin cobertura', () => {
  test('sin red, preguntar devuelve pasajes del libro citados — no un error de red', async ({ page, context }) => {
    await setup(page);
    await page.evaluate(() => ((window as any).__llm.calls = []));
    await context.setOffline(true);

    await ask(page, 'Comala Pedro Páramo madre pueblo muerte almas');
    await expect(lastAnswer(page)).toContainText('Sin conexión', { timeout: 15000 });

    // Lo que hace útil la respuesta: son pasajes REALES del libro, con sus anclas
    // clicables (las mismas que habrían ido al modelo).
    await expect(lastAnswer(page).locator('.ai-cite').first()).toBeVisible();

    // Y no se ha intentado ninguna llamada: sin red, esperar al timeout no aporta nada.
    expect(await page.evaluate(() => (window as any).__llm.calls.length)).toBe(0);

    // La pregunta queda en cola, y se dice.
    await expect(page.locator('#ai-offline-chip')).toContainText('en cola');
  });

  test('al volver la conexión, la pregunta encolada se responde sola', async ({ page, context }) => {
    await setup(page);
    await context.setOffline(true);
    await ask(page, 'Comala Pedro Páramo madre pueblo muerte almas');
    await expect(lastAnswer(page)).toContainText('Sin conexión', { timeout: 15000 });

    await context.setOffline(false);

    // Sin tocar nada: el evento `online` vacía la cola.
    await expect(lastAnswer(page)).toContainText('Respuesta de prueba', { timeout: 20000 });
    await expect(page.locator('#ai-offline-chip')).toHaveCount(0);
  });

  test('los pasajes enseñados sin cobertura no se cuelan en la ventana del modelo', async ({ page, context }) => {
    await setup(page);
    await context.setOffline(true);
    await ask(page, 'Comala Pedro Páramo madre pueblo muerte almas');
    await expect(lastAnswer(page)).toContainText('Sin conexión', { timeout: 15000 });

    await page.evaluate(() => ((window as any).__llm.calls = []));
    await context.setOffline(false);
    await expect(lastAnswer(page)).toContainText('Respuesta de prueba', { timeout: 20000 });

    // El texto que se pintó sin cobertura NO puede aparecer como mensaje del asistente:
    // si entrara, el modelo lo leería como suyo y hablaría de "mi respuesta anterior"
    // sobre unos pasajes que no escribió.
    const calls = await page.evaluate(() => (window as any).__llm.calls);
    expect(calls.length).toBeGreaterThan(0);
    const comoAsistente = calls.flatMap((c: any) => c.messages || [])
      .filter((m: any) => m.role === 'assistant' && /Sin conexión/.test(m.content || ''));
    expect(comoAsistente).toEqual([]);
  });

  // El vuelo dura horas y la pestaña se recarga (o la PWA se cierra): la cola no puede
  // vivir solo en memoria. Se recarga SIN conexión a propósito — recargando ya con red,
  // la cola se vacía sola respondiendo, que es lo que comprueba el test de más arriba.
  test('la cola sobrevive a recargar la página sin conexión', async ({ page, context }) => {
    await setup(page);
    await context.setOffline(true);
    await ask(page, 'Comala Pedro Páramo madre pueblo muerte almas');
    await expect(lastAnswer(page)).toContainText('Sin conexión', { timeout: 15000 });

    const contar = () => page.evaluate(async () => {
      const O: any = await import('/js/ai/offline.js');
      return O.count();
    });
    expect(await contar()).toBe(1);

    await page.reload();               // sigue sin cobertura: lo sirve el service worker
    expect(await contar()).toBe(1);    // sigue ahí, esperando a que vuelva la red
  });
});

test.describe('unidades de ai/offline.js', () => {
  const load = (page) => page.goto('/index.html').then(() => page);

  test('la respuesta por pasajes lleva anclas y respeta el tope', async ({ page }) => {
    await load(page);
    const out = await page.evaluate(async () => {
      const O: any = await import('/js/ai/offline.js');
      const picked = Array.from({ length: 9 }, (_, i) => ({ id: 'a' + (i + 1), text: 'pasaje ' + i, chapter: 'Cap 1' }));
      return O.passageAnswer(picked);
    });
    expect(out).toContain('[[a1]]');
    expect((out.match(/\[\[a\d+\]\]/g) || []).length).toBe(6);   // MAX_PASSAGES
    expect(out).not.toContain('[[a7]]');
  });

  test('sin pasajes no se inventa una respuesta', async ({ page }) => {
    await load(page);
    expect(await page.evaluate(async () => {
      const O: any = await import('/js/ai/offline.js');
      return O.passageAnswer([]);
    })).toBe(null);
  });

  test('un 4xx del proveedor NO se trata como falta de red', async ({ page }) => {
    await load(page);
    const r = await page.evaluate(async () => {
      const O: any = await import('/js/ai/offline.js');
      const http = Object.assign(new Error('HTTP 401 no autorizado'), { code: 401 });
      const red = new TypeError('Failed to fetch');
      const abort = Object.assign(new Error('abort'), { name: 'AbortError' });
      return { http: O.isNetworkError(http), red: O.isNetworkError(red), abort: O.isNetworkError(abort) };
    });
    // Con red y un error real del proveedor, el mensaje del proveedor es más útil que
    // un puñado de pasajes: solo se degrada cuando de verdad no hay red.
    expect(r).toEqual({ http: false, red: true, abort: false });
  });
});

// «Preparar para sin conexión»: lo caro que no se puede improvisar a 10.000 metros es el
// resumen del libro entero (map-reduce sobre todo el texto). El índice ya sobrevive solo
// —se cachea al abrir el libro—, así que lo que esta acción añade es el artefacto.
test('preparar para el vuelo deja el resumen del libro cacheado en el dispositivo', async ({ page }) => {
  await setup(page);
  // El resumen es un map-reduce que EXIGE viñetas: el stub genérico ("Respuesta de
  // prueba") las rompe y el trabajo acaba en "el modelo no devolvió puntos". Aquí se
  // responde con forma de resumen para ejercitar el camino entero.
  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions') && opts?.body) {
        const puntos = '- Comala es un pueblo de muertos [[a1]]\n- El padre ausente organiza el relato [[a2]]\n';
        if (JSON.parse(opts.body).stream) {
          const chunks = [
            `data: ${JSON.stringify({ choices: [{ delta: { content: puntos }, finish_reason: null }] })}\n\n`,
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n',
          ];
          const st = new ReadableStream({ start(c) { const e = new TextEncoder(); chunks.forEach(x => c.enqueue(e.encode(x))); c.close(); } });
          return new Response(st, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: puntos } }] }), { status: 200 });
      }
      return real(url, opts);
    };
  });

  expect(await page.evaluate(async () => {
    const J: any = await import('/js/ai/jobs.js');
    const B: any = await import('/js/ai/db.js');
    const id = (await B.getAll('convos'))[0]?.bookId;
    return !!J.cached(id, 'summary');
  })).toBe(false);                       // de partida no hay nada guardado

  await page.click('#ai-convo-btn');
  await page.locator('.ai-convo-menu').getByText('Preparar para sin conexión').click();
  await page.locator('.dlg-ok').click();  // "Preparar": avisa de que tarda y consume llamadas

  await expect(page.locator('#ai-status')).toContainText('Listo para volar', { timeout: 60000 });

  expect(await page.evaluate(async () => {
    const J: any = await import('/js/ai/jobs.js');
    const B: any = await import('/js/ai/db.js');
    const id = (await B.getAll('convos'))[0]?.bookId;
    return !!J.cached(id, 'summary');
  })).toBe(true);                        // queda legible sin conexión desde el Studio
});
