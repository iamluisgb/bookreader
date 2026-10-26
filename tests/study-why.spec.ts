import { test, expect } from '@playwright/test';
import { seedProLicense } from './pro-license';

// P46 F1 · «¿Por qué?»: con la tarjeta girada se pregunta al agente (stub) sin salir del repaso.
// Antes de girar no existe; escribir la duda no califica; la respuesta sale en el dorso con el
// pasaje en el contexto; «Mejorar la explicación» abre el editor con la propuesta; la nota no se
// toca y el intento queda apuntado con `asked`.

const BOOK_ID = 'bk-why';

async function stubLLM(page) {
  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    (window as any).__why = { bodies: [] as any[] };
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions') && opts?.body) {
        const body = JSON.parse(opts.body);
        (window as any).__why.bodies.push(body);
        const sys = (body.messages || []).find((m: any) => m.role === 'system')?.content || '';
        const out = sys.includes('resuelve dudas')
          ? 'Porque con **retardo acotado** un timeout sí detecta el fallo.'
          : sys.includes('Mejora la tarjeta')
            ? JSON.stringify({ front: '¿Qué necesita 3PC?', back: 'Retardo acotado: sin él, un timeout no distingue caída de lentitud.' })
            : '{}';
        const chunks = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: out }, finish_reason: null }] })}\n\n`,
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ];
        const s = new ReadableStream({ start(c) { const e = new TextEncoder(); chunks.forEach((x) => c.enqueue(e.encode(x))); c.close(); } });
        return new Response(s, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return real(url, opts);
    };
  });
}

async function seed(page) {
  await page.evaluate(async (BOOK_ID) => {
    const DB: any = await import('/js/ai/db.js');
    await DB.put('bookText', {
      bookId: BOOK_ID, segVersion: 5, blockCount: 1, tokenEstimate: 20,
      annotatedText: '## 9\n[[a1]] Three-phase commit assumes a network with bounded delay.',
    });
    await DB.addDeck({
      bookId: BOOK_ID, name: 'DDIA', cardType: 'basic', scope: '',
      cards: [{ uid: 'c-why', type: 'basic', front: '¿Qué necesita 3PC?', back: 'Retardo acotado.', chapter: '9', src: 'a1' }],
    });
  }, BOOK_ID);
}

test('«¿Por qué?» responde en el dorso, no califica al escribir y apunta el intento', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await page.evaluate(() => localStorage.setItem('bookreader_ai_key', JSON.stringify('test-key')));
  await page.reload();
  await stubLLM(page);
  await seed(page);
  await page.evaluate(async () => (await import('/js/ai/study.js') as any).openToday());
  const overlay = page.locator('#ai-study');

  // Antes de girar no hay a quién preguntar: la respuesta no puede adelantarse.
  await expect(overlay.locator('.study-flip')).toBeVisible();
  await expect(overlay.locator('.study-why-btn')).toHaveCount(0);
  await page.keyboard.press('?');
  await expect(overlay.locator('.study-why-input')).toHaveCount(0);

  await overlay.locator('.study-flip').click();
  await expect(overlay.locator('.study-why-btn')).toBeVisible();
  // El salto al libro vive ahora en la misma fila, no en el pie de las notas.
  await expect(overlay.locator('.study-why .study-src')).toBeVisible();
  await expect(overlay.locator('.study-foot .study-src')).toHaveCount(0);

  // «?» abre la caja; escribir un «2» es texto, no la nota «Bien».
  await page.keyboard.press('?');
  const input = overlay.locator('.study-why-input');
  await expect(input).toBeFocused();
  await input.pressSequentially('¿y con 2 nodos?');
  await expect(overlay.locator('.study-why-input')).toHaveValue('¿y con 2 nodos?');
  await expect(overlay.locator('.study-grade')).toHaveCount(2);
  await input.press('Enter');

  const answer = overlay.locator('.study-why-a');
  await expect(answer).toContainText('retardo acotado');
  await expect(answer.locator('strong')).toHaveCount(1);
  // Leer la respuesta no voltea la tarjeta.
  await answer.click();
  await expect(overlay.locator('.study-card3d')).toHaveClass(/is-flipped/);

  const ask = await page.evaluate(() => (window as any).__why.bodies.find((b: any) =>
    b.messages[0].content.includes('resuelve dudas')).messages[1].content);
  expect(ask).toContain('Three-phase commit assumes');   // el pasaje
  expect(ask).toContain('¿y con 2 nodos?');              // la duda
  expect(ask).toContain('Retardo acotado.');             // la respuesta, ya vista

  // La nota no se sugiere por haber preguntado.
  await expect(overlay.locator('.study-grade.is-suggested')).toHaveCount(0);

  // «Mejorar la explicación» abre el editor con la propuesta, sin guardar.
  await overlay.locator('.study-why-improve').click();
  await expect(overlay.locator('.study-edit-b')).toContainText('un timeout no distingue');
  const improve = await page.evaluate(() => (window as any).__why.bodies.find((b: any) =>
    b.messages[0].content.includes('Mejora la tarjeta')).messages[1].content);
  expect(improve).toContain('¿y con 2 nodos?');
  await overlay.locator('.study-edit-cancel').click();

  await overlay.locator('.study-flip').click();
  await overlay.locator('.study-grade[data-rate="good"]').click();
  await expect.poll(async () => page.evaluate(async (BOOK_ID) =>
    ((await (await import('/js/ai/db.js') as any).getAttempts(BOOK_ID)) || []).map((a: any) => a.asked), BOOK_ID)).toEqual([true]);
});

test('sin agente no hay «¿Por qué?», pero el salto al libro sigue', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await seed(page);
  await page.evaluate(async () => (await import('/js/ai/study.js') as any).openToday());
  const overlay = page.locator('#ai-study');
  await overlay.locator('.study-flip').click();
  await expect(overlay.locator('.study-src')).toBeVisible();
  await expect(overlay.locator('.study-why-btn')).toHaveCount(0);
  await page.keyboard.press('?');
  await expect(overlay.locator('.study-why-input')).toHaveCount(0);
});
