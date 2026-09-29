import { test, expect } from '@playwright/test';
import { seedProLicense } from './pro-license';

// WU5 · Plan de tarjetas por capítulo: UI editable (tabla con números del agente, total
// vivo, coste honesto, «Quitar plan») y generación POR CAPÍTULO (un mazo por capítulo
// con el cupo del plan). Todo con el LLM stubbeado: el planificador viaja por chatStream
// (SSE) y las pasadas de tarjetas por la herramienta create_flashcards — cero llamadas
// reales.
//
// Siembra: libro en library/store + índice de pasajes en Retrieval con TRES capítulos de
// tokens idénticos (nombres de la misma longitud → mismo redondeo de estimateTokens),
// y el modal de flashcards abierto con un ctx controlado (mismo shape que el del panel).

const CHAPTERS = ['Cap A', 'Cap B', 'Cap C'];
const BOOK_ID = 'plan-book-1';
const BOOK_TITLE = 'Libro de plan';

// Plan del agente: suma EXACTA 10, todos los capítulos con contenido ≥ 1 (contrato del
// validador). El test de generación edita «Cap C» a 0 a mano para cubrir el salto.
const PLAN_JSON = JSON.stringify({
  chapters: [
    { name: 'Cap A', cards: 6, reason: 'mas denso en definiciones' },
    { name: 'Cap B', cards: 3, reason: 'narrativo' },
    { name: 'Cap C', cards: 1, reason: 'breve' },
  ],
  total: 10,
});

// Siembra el libro (db + store), el índice de pasajes y deja la página lista. El stub de
// fetch se instala DESPUÉS de seedPlanBook (el reload lo limpiaría).
async function seedPlanBook(page) {
  await page.goto('/index.html');
  await seedProLicense(page);
  await page.evaluate(() => {
    localStorage.setItem('bookreader_ai_key', JSON.stringify('test-key'));
  });
  await page.reload();
  await page.evaluate(async ({ bookId, bookTitle, chapters }) => {
    const Store: any = await import('/js/library/store.js');
    const R: any = await import('/js/ai/retrieval.js');
    await Store.putBook({ id: bookId, title: bookTitle, format: 'epub', shelfIds: [], addedAt: Date.now() });
    // Pasajes de tokens idénticos (nombres de la misma longitud) para que el fallback
    // proporcional sea predecible: 10 tarjetas entre 3 capítulos → 4/3/3.
    const passages = [];
    let n = 0;
    for (const ch of chapters) {
      for (let j = 0; j < 2; j++) {
        n++;
        passages.push({
          id: 'a' + n,
          chapter: ch,
          text: `contenido de estudio del capítulo ${ch}: definiciones y datos clave número ${j + 1} para repasar y memorizar con tarjetas.`,
        });
      }
    }
    // El modal de flashcards abre con el MISMO contrato de ctx que panel.js; ensureIndex
    // reconstruye el índice si la página lo perdió.
    (window as any).__planCtx = {
      bookId,
      bookTitle,
      goal: 'aprobar el parcial',
      tocLabels: chapters,
      currentChapter: '',
      chapterScores: null,
      ensureIndex: () => {
        if (!R.hasIndex(bookId)) R.buildIndex(bookId, passages);
      },
    };
    R.buildIndex(bookId, passages);
  }, { bookId: BOOK_ID, bookTitle: BOOK_TITLE, chapters: CHAPTERS });
}

// Abre el modal de flashcards con el ctx controlado (mismo contrato que panel.js).
async function openPlanModal(page) {
  await page.evaluate(async () => {
    const F: any = await import('/js/ai/flashcards.js');
    F.open((window as any).__planCtx);
  });
  await page.waitForSelector('#ai-flashcards');
  await page.waitForSelector('#fc-generate');
}

// Stub único del LLM. El planificador (system "planificador de estudio", stream SSE)
// responde con `plannerPayload`; las pasadas de tarjetas (herramienta create_flashcards)
// responden con EXACTAMENTE las tarjetas que pide el prompt. Todo queda registrado en
// window.__plan (contador de llamadas, prompts completos) para asertar el reparto.
async function stubPlanLLM(page, plannerPayload: string) {
  await page.evaluate((payload) => {
    const real = window.fetch.bind(window);
    (window as any).__plan = { planner: 0, gen: 0, seq: 0, prompts: [] as string[] };
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions') && opts?.body) {
        const body = JSON.parse(opts.body);
        const sys = (body.messages || []).find((m: any) => m.role === 'system')?.content || '';
        // Planificador: SSE con el payload configurado.
        if (body.stream && /planificador de estudio/.test(sys)) {
          (window as any).__plan.planner++;
          const sse = [
            `data: ${JSON.stringify({ choices: [{ delta: { content: payload }, finish_reason: null }] })}\n\n`,
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n',
          ];
          const s = new ReadableStream({ start(c) { const e = new TextEncoder(); sse.forEach(x => c.enqueue(e.encode(x))); c.close(); } });
          return new Response(s, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        // Pasadas de tarjetas: tool-call con el cupo EXACTO que pide el prompt.
        if ((body.tools || []).some((t: any) => t.function?.name === 'create_flashcards')) {
          (window as any).__plan.gen++;
          (window as any).__plan.prompts.push(body.messages.map((m: any) => m.content).join('\n'));
          const ask = parseInt((sys.match(/Genera EXACTAMENTE (\d+) tarjetas/) || [])[1] || '0', 10);
          const seq = ++(window as any).__plan.seq;
          const cards = Array.from({ length: ask }, (_, i) => ({
            front: `pregunta generada ${seq} punto ${i + 1}`,
            back: 'respuesta breve',
            chapter: '',
            src: '',
          }));
          const message = { content: '', tool_calls: [{ id: 'tc' + seq, function: { name: 'create_flashcards', arguments: JSON.stringify({ cards }) } }] };
          return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
        }
      }
      return real(url, opts);
    };
  }, plannerPayload);
}

// Flujo completo: libro entero, total 10, sugerir y esperar la tabla del plan.
async function suggestPlan(page, payload = PLAN_JSON) {
  await stubPlanLLM(page, payload);
  await openPlanModal(page);
  await page.selectOption('#fc-count', '10');
  await page.click('#fc-plan-btn');
  await expect(page.locator('.fc-plan-row')).toHaveCount(3);
}

// ---- Parte 1 · UI del plan editable -------------------------------------------

test('el botón Sugerir cantidades solo aparece con el alcance de libro entero', async ({ page }) => {
  await seedPlanBook(page);
  await stubPlanLLM(page, PLAN_JSON);
  await openPlanModal(page);
  const btn = page.locator('#fc-plan-btn');
  await expect(btn).toBeVisible();
  // Elegir un capítulo esconde el botón (un capítulo suelto no tiene nada que planificar).
  await page.locator('#fc-scope .fc-combo-btn').click();
  await page.locator('#fc-scope .fc-combo-list li').nth(1).click();
  await expect(btn).toBeHidden();
});

test('sugerir muestra la tabla con los números y motivos del agente y el total vivo', async ({ page }) => {
  await seedPlanBook(page);
  await suggestPlan(page);
  // Los números del agente, sin tocar (6/3/1 → total 10, el total pedido).
  await expect(page.locator('.fc-plan-num').nth(0)).toHaveValue('6');
  await expect(page.locator('.fc-plan-num').nth(1)).toHaveValue('3');
  await expect(page.locator('.fc-plan-num').nth(2)).toHaveValue('1');
  await expect(page.locator('.fc-plan-total')).toHaveText('10 en total');
  // El motivo del agente va como texto secundario en cada fila.
  await expect(page.locator('.fc-plan-reason').nth(0)).toContainText('definiciones');
  // Plan del agente real: SIN aviso de fallback.
  await expect(page.locator('.fc-plan-src')).toHaveCount(0);
  // Coste honesto: 3 capítulos con tarjetas × 1 tipo de texto = 3 llamadas estimadas.
  await expect(page.locator('.fc-plan-cost')).toContainText('3 llamadas');
});

test('con basura del agente aparece el aviso de reparto automático y la suma cierra', async ({ page }) => {
  await seedPlanBook(page);
  // El planificador devuelve prosa sin JSON utilizable → fallback proporcional.
  await suggestPlan(page, 'no hay plan utilizable en esta respuesta {roto');
  await expect(page.locator('.fc-plan-src')).toHaveText('reparto automático (el agente no dio un plan usable)');
  const nums = await page.locator('.fc-plan-num').evaluateAll(
    (els: any[]) => els.map((e: any) => parseInt(e.value, 10) || 0));
  expect(nums.reduce((s: number, x: number) => s + x, 0)).toBe(10);
  // Reparto proporcional de 10 entre 3 capítulos de tokens iguales: 4/3/3.
  expect(nums).toEqual([4, 3, 3]);
});

test('editar un número actualiza el total y Quitar plan vuelve al flujo normal', async ({ page }) => {
  await seedPlanBook(page);
  await suggestPlan(page);
  // Con plan activo el selector de cantidad queda fuera de la ecuación (y se dice).
  await expect(page.locator('.fc-plan-note')).toBeVisible();
  await page.locator('.fc-plan-num').nth(2).fill('4');
  await expect(page.locator('.fc-plan-total')).toHaveText('13 en total');
  await page.click('#fc-plan-clear');
  await expect(page.locator('.fc-plan-row')).toHaveCount(0);
  await expect(page.locator('.fc-plan-note')).toBeHidden();
  // El botón vuelve y el selector de cantidad vuelve a mandar: el hint de reparto
  // (dos tipos de texto) sale del select otra vez, no del plan muerto.
  await expect(page.locator('#fc-plan-btn')).toBeVisible();
  await page.check('input[name="fc-type"][value="cloze"]');
  await expect(page.locator('#fc-split')).toContainText('10 en total');
});

test('cambiar el alcance limpia el plan: la tabla desaparece', async ({ page }) => {
  await seedPlanBook(page);
  await suggestPlan(page);
  await expect(page.locator('.fc-plan-row')).toHaveCount(3);
  await page.locator('#fc-scope .fc-combo-btn').click();
  await page.locator('#fc-scope .fc-combo-list li').nth(1).click();
  await expect(page.locator('.fc-plan-row')).toHaveCount(0);
  await expect(page.locator('.fc-plan-note')).toBeHidden();
});

// ---- Parte 2 · Generación por capítulo ----------------------------------------

test('generar con plan crea un mazo POR CAPÍTULO y salta el capítulo a 0', async ({ page }) => {
  await seedPlanBook(page);
  await suggestPlan(page);
  // «Cap C» a 0: sin mazo y sin llamada con sus pasajes.
  await page.locator('.fc-plan-num').nth(2).fill('0');
  await page.click('#fc-generate');
  await expect(page.locator('#fc-error')).toContainText('Plan aplicado: 9 de 9 tarjetas', { timeout: 30000 });
  // Desglose por capítulo en el resumen del trabajo.
  await expect(page.locator('#fc-error')).toContainText('Cap A 6/6 · Cap B 3/3');
  const decks = await page.evaluate(async () => (await import('/js/ai/db.js') as any).getAllDecks());
  expect(decks).toHaveLength(2);   // un mazo por capítulo con tarjetas; el libro entero NO
  const uno = decks.find((d: any) => d.scope === 'Cap A');
  const dos = decks.find((d: any) => d.scope === 'Cap B');
  expect(uno).toBeDefined();
  expect(dos).toBeDefined();
  expect(uno.cards).toHaveLength(6);
  expect(dos.cards).toHaveLength(3);
  expect(uno.name).toBe('Libro de plan — Cap A');
  // Ningún prompt de generación llevó material de «Cap C» (ni su encabezado ## ni su texto).
  const { prompts } = await page.evaluate(() => (window as any).__plan);
  expect(prompts).toHaveLength(2);   // un trozo por capítulo activo, una llamada por trozo
  for (const p of prompts) {
    expect(p).not.toContain('## Cap C');
    expect(p).not.toContain('capítulo Cap C');
  }
});
