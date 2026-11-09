import { test, expect } from '@playwright/test';

// P55 · Preguntas de comprobación — E2E determinista (sin LLM real).
// Cubre: la fecha del capítulo que queda atrás (solo el inmediatamente anterior, nunca un salto),
// la elección de candidatos (14 días, sin repetir, solo capítulos trabajados), las cifras de
// Análisis, que no cuentan como repaso ni como retención, y el paso dentro del repaso del día.

const BOOK = 'bk-probe';
const DAY = 864e5;

test('chapter-gate fecha solo el capítulo que acaba de quedar atrás, una vez', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async () => {
    const G: any = await import('/js/ai/chapter-gate.js');
    const order = ['Uno', 'Dos', 'Tres', 'Cuatro'];
    const a = G.advance({}, order, 'Dos', 1000); // lee Uno y pasa a Dos
    const b = G.advance({ ...a }, order, 'Tres', 2000); // Dos queda atrás
    const again = G.advance({ ...b }, order, 'Dos', 3000); // volver atrás no cambia nada
    const jump = G.advance({}, order, 'Cuatro', 4000); // salto por el índice desde el principio
    return { a: a.chaptersDoneAt, b: b.chaptersDoneAt, again, jump: jump.chaptersDoneAt, jumpDone: jump.chaptersDone };
  });
  expect(r.a).toEqual({ Uno: 1000 });
  expect(r.b).toEqual({ Uno: 1000, Dos: 2000 });
  expect(r.again).toBeNull();
  // Del salto solo se fecha «Tres» (el inmediatamente anterior); Uno y Dos cuentan como leídos
  // para el bloqueo de tarjetas, pero no se pregunta por ellos.
  expect(r.jumpDone).toEqual(['Uno', 'Dos', 'Tres']);
  expect(r.jump).toEqual({ Tres: 4000 });
});

test('candidatos: 14 días, un capítulo trabajado, nunca dos veces; cifras aparte del repaso', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async ({ DAY }) => {
    const P: any = await import('/js/ai/probes.js');
    const S: any = await import('/js/ai/study-stats.js');
    const now = 100 * DAY;
    const books = [
      { id: 'b1', title: 'Uno', chaptersDoneAt: { 'Cap A': now - 20 * DAY, 'Cap B': now - 15 * DAY, 'Cap C': now - 3 * DAY, 'Cap D': now - 30 * DAY } },
      { id: 'b2', title: 'Borrado', deleted: true, chaptersDoneAt: { X: 0 } },
    ];
    const engaged = P.engagementIndex(
      { highlights_b1: [{ chapter: 'Cap A' }, { chapter: 'Cap D', deleted: true }] },
      [{ bookId: 'b1', scope: 'Cap B', cards: [{ front: 'x' }] }],
    );
    const asked = [{ mode: 'probe', bookId: 'b1', probe: { chapter: ' cap a ', outcome: 'skipped' } }];
    const probes = [
      { mode: 'probe', bookId: 'b1', ts: now, verdict: 'good', probe: { chapter: 'A', outcome: 'answered', disputed: true } },
      { mode: 'probe', bookId: 'b1', ts: now, verdict: 'partial', probe: { chapter: 'B', outcome: 'answered' } },
      { mode: 'probe', bookId: 'b1', ts: now, verdict: 'wrong', probe: { chapter: 'C', outcome: 'dontknow' } },
      { mode: 'probe', bookId: 'b1', ts: now, verdict: null, probe: { chapter: 'D', outcome: 'skipped' } },
      { mode: 'probe', bookId: 'b1', ts: now, verdict: null, probe: { chapter: 'E', outcome: 'answered' } },
    ];
    const review = { mode: 'reveal', grade: 'good', cardUid: 'c1', ts: now, prevInterval: 3 };
    return {
      fresh: P.candidates(books, [], engaged, now).map((c: any) => c.chapter),
      afterAsked: P.candidates(books, asked, engaged, now).map((c: any) => c.chapter),
      stats: S.probeStats(probes),
      perDay: Object.values(S.reviewsByDay([...probes, review])),
      retention: S.trueRetention([...probes, review]).all.n,
      practice: S.practiceSplit(probes),
    };
  }, { DAY });
  // Cap C: hace 3 días. Cap D: su subrayado está borrado. Más antiguo primero.
  expect(r.fresh).toEqual(['Cap A', 'Cap B']);
  // Ya preguntado (saltado cuenta), comparando sin mayúsculas ni espacios.
  expect(r.afterAsked).toEqual(['Cap B']);
  expect(r.stats).toEqual({ n: 3, good: 1, partial: 1, wrong: 1, skipped: 1, unjudged: 1, disputed: 1, rate: 1 / 3 });
  expect(r.perDay).toEqual([1]); // las preguntas no son repasos
  expect(r.retention).toBe(1);
  expect(r.practice).toEqual({ practiced: 0, revealed: 0, judged: 0 });
});

// ---- En el repaso del día ---------------------------------------------------------------

async function seed(page) {
  await page.evaluate(
    async ({ BOOK, DAY }) => {
      const DB: any = await import('/js/ai/db.js');
      const Lib: any = await import('/js/library/store.js');
      await Lib.putBook({
        id: BOOK,
        title: 'Libro sondas',
        addedAt: Date.now(),
        lastOpenedAt: Date.now(),
        chaptersDoneAt: { 'Capítulo 1': Date.now() - 15 * DAY },
      });
      await DB.put('anchors', {
        bookId: BOOK,
        entries: [
          ['a1', { chapter: 'Capítulo 1' }],
          ['a2', { chapter: 'Capítulo 1' }],
          ['a3', { chapter: 'Capítulo 2' }],
        ],
      });
      await DB.put('bookText', {
        bookId: BOOK,
        annotatedText: '[[a1]] Raft elige un líder.\n[[a2]] El líder replica el log.\n[[a3]] Otro capítulo.',
      });
      await DB.addDeck({
        bookId: BOOK,
        name: 'Libro sondas',
        cardType: 'basic',
        scope: 'Capítulo 1',
        cards: [1, 2, 3].map((i) => ({ type: 'basic', front: `Pregunta ${i}`, back: `Respuesta ${i}`, chapter: 'Capítulo 1' })),
      });
      localStorage.setItem('bookreader_ai_key', JSON.stringify('test-key'));
    },
    { BOOK, DAY },
  );
}

// Modelo falso: la generación devuelve la pregunta; la corrección, «bien». Guarda lo que recibió.
async function stubModel(page) {
  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    (window as any).__llm = [];
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (!u.includes('/chat/completions')) return real(url, opts);
      const body = JSON.parse(opts.body);
      const system = body.messages[0].content;
      (window as any).__llm.push({ system, user: body.messages[1].content });
      const content = system.startsWith('Escribes UNA pregunta')
        ? JSON.stringify({
            pregunta: '¿Por qué hace falta un líder?',
            respuesta_esperada: 'Para ordenar las escrituras.',
            ideas_clave: ['orden'],
            src: ['a2'],
          })
        : JSON.stringify({ veredicto: 'bien', comentario: 'Correcto.' });
      const chunk = JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] });
      return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };
  });
}

const attempts = (page) =>
  page.evaluate(async () => ((await import('/js/ai/db.js')) as any).getAll('attempts'));

test('el repaso del día trae la pregunta tras dos tarjetas, sin ayuda, y no la repite', async ({ page }) => {
  await page.goto('/index.html');
  await seed(page);
  await page.reload();
  await stubModel(page);
  await page.locator('.lib-study-chip').click();
  const overlay = page.locator('#ai-study');

  for (let i = 0; i < 2; i++) {
    await overlay.locator('.study-flip').click();
    await page.keyboard.press('3');
  }
  const probe = overlay.locator('.study-probe');
  await expect(probe).toBeVisible();
  await expect(probe.locator('.study-probe-q')).toHaveText('¿Por qué hace falta un líder?');
  // Sin ayuda: ni respuesta, ni pasaje, ni agente, ni menú de la tarjeta hasta responder.
  await expect(overlay.locator('.study-passage-wrap')).toHaveCount(0);
  await expect(overlay.locator('.study-why-btn:not(.study-probe-dispute)')).toHaveCount(0);
  await expect(overlay.locator('.study-tools .study-more')).toHaveCount(0);
  // La generación vio el capítulo, y solo ese.
  const gen = await page.evaluate(() => (window as any).__llm[0].user);
  expect(gen).toContain('[[a1]] Raft elige un líder.');
  expect(gen).not.toContain('Otro capítulo');

  await expect(overlay.locator('[data-probe="submit"]')).toBeDisabled();
  await probe.locator('.study-probe-input').fill('Para que las escrituras tengan un orden.');
  await overlay.locator('[data-probe="submit"]').click();
  await expect(overlay.locator('.study-feedback.is-good')).toBeVisible();
  await expect(overlay.locator('.study-probe-expected')).toContainText('Para ordenar las escrituras.');
  await overlay.locator('.study-passage-wrap summary').click();
  await expect(overlay.locator('.study-passage')).toHaveText('El líder replica el log.');
  await overlay.locator('[data-probe="dispute"]').click();
  await expect(overlay.locator('[data-probe="dispute"]')).toHaveAttribute('aria-pressed', 'true');
  await overlay.locator('[data-probe="continue"]').click();

  // Vuelve la tarjeta que quedaba (la cola va barajada: cualquiera de las tres).
  await expect(overlay.locator('.study-q')).toHaveText(/^Pregunta [123]$/);
  await expect.poll(async () => (await attempts(page)).filter((a) => a.mode === 'probe').length).toBe(1);
  const p = (await attempts(page)).find((a) => a.mode === 'probe');
  expect(p).toMatchObject({
    bookId: BOOK,
    mode: 'probe',
    verdict: 'good',
    grade: null,
    answer: 'Para que las escrituras tengan un orden.',
    probe: { chapter: 'Capítulo 1', question: '¿Por qué hace falta un líder?', outcome: 'answered', disputed: true, delayDays: 15, src: ['a2'] },
  });
  // El mazo no se tocó por la pregunta: solo las dos notas de tarjeta.
  expect((await attempts(page)).filter((a) => a.mode !== 'probe').length).toBe(2);

  // Siguiente sesión: el capítulo ya está preguntado y no se genera otra.
  await overlay.locator('.study-flip').click();
  await page.keyboard.press('1');
  await overlay.locator('.ai-ob-close').click();
  await page.reload();
  await stubModel(page);
  await page.locator('.lib-study-chip').click();
  for (let i = 0; i < 3; i++) {
    if (!(await overlay.locator('.study-flip').isVisible())) break;
    await overlay.locator('.study-flip').click();
    await page.keyboard.press('3');
  }
  await expect(overlay.locator('.study-probe')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__llm.length)).toBe(0);
});

test('«no lo sé» cuenta como fallo', async ({ page }) => {
  await page.goto('/index.html');
  await seed(page);
  await page.reload();
  await stubModel(page);
  await page.locator('.lib-study-chip').click();
  const overlay = page.locator('#ai-study');
  for (let i = 0; i < 2; i++) {
    await overlay.locator('.study-flip').click();
    await page.keyboard.press('3');
  }
  await overlay.locator('[data-probe="dontknow"]').click();
  await expect(overlay.locator('.study-feedback.is-wrong')).toBeVisible();
  await overlay.locator('[data-probe="continue"]').click();
  await expect.poll(async () => (await attempts(page)).filter((a) => a.mode === 'probe').length).toBe(1);
  const p = (await attempts(page)).find((a) => a.mode === 'probe');
  expect(p).toMatchObject({ verdict: 'wrong', answer: null, probe: { outcome: 'dontknow' } });
});

test('cerrar con la pregunta a la vista y sin responder no la gasta', async ({ page }) => {
  await page.goto('/index.html');
  await seed(page);
  await page.reload();
  await stubModel(page);
  await page.locator('.lib-study-chip').click();
  const overlay = page.locator('#ai-study');
  for (let i = 0; i < 2; i++) {
    await overlay.locator('.study-flip').click();
    await page.keyboard.press('3');
  }
  await expect(overlay.locator('.study-probe')).toBeVisible();
  await overlay.locator('.ai-ob-close').click();
  await expect(overlay).toHaveCount(0);
  expect((await attempts(page)).filter((a) => a.mode === 'probe').length).toBe(0);
});
