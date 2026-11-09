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

// ---- PDF y prueba ---------------------------------------------------------------------------

test('PDF: stampLeft fecha el anterior una vez; muestras repartidas; capítulos detrás de la posición', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async () => {
    const G: any = await import('/js/ai/chapter-gate.js');
    const P: any = await import('/js/ai/probes.js');
    const order = ['Cover', 'Chapter 1', 'Chapter 2', 'Chapter 3'];
    const a = G.stampLeft({}, order, 'Chapter 2', 10);
    const again = G.stampLeft({ chaptersDoneAt: { 'chapter 1': 5 } }, order, 'Chapter 2', 20);
    const first = G.stampLeft({}, order, 'Cover', 30);
    const lines = Array.from({ length: 100 }, (_, i) => `[[a${i}]] ${'x'.repeat(90)}`);
    const sample = P.sampleLines(lines, 2000, 4).trim().split('\n');
    const short = P.sampleLines(lines.slice(0, 3), 2000);
    const entries = [
      ['a1', { page: 1, chapter: 'Chapter 1' }], ['a2', { page: 9, chapter: 'Chapter 1' }],
      ['a3', { page: 10, chapter: 'Chapter 2' }], ['a4', { page: 19, chapter: 'Chapter 2' }],
      ['a5', { page: 20, chapter: 'Chapter 3' }], ['a6', { page: 40, chapter: 'Chapter 3' }],
    ];
    return {
      a, again, first,
      sampleIds: sample.map((l: string) => Number(/a(\d+)/.exec(l)![1])),
      sampleLen: sample.join('\n').length,
      short: short.split('\n').filter(Boolean).length,
      behind: P.behindPdf(entries, 72), // página 28,8 de 40: capítulos 1 y 2 detrás, el 3 a medias
    };
  });
  expect(r.a).toEqual({ chaptersDoneAt: { 'Chapter 1': 10 } });
  expect(r.again).toBeNull(); // ya fechado (sin mayúsculas)
  expect(r.first).toBeNull(); // el primero no deja nada atrás
  // Muestras de las cuatro partes, en orden, dentro del tope.
  expect(r.sampleLen).toBeLessThanOrEqual(2000);
  expect(r.sampleIds.some((i: number) => i < 25)).toBe(true);
  expect(r.sampleIds.some((i: number) => i >= 75)).toBe(true);
  expect([...r.sampleIds].sort((x: number, y: number) => x - y)).toEqual(r.sampleIds);
  expect(r.short).toBe(3);
  expect(r.behind).toEqual(['Chapter 1', 'Chapter 2']);
});

test('?probes-test=<libro> programa ya los capítulos que quedaron atrás de un PDF', async ({ page }) => {
  await page.goto('/index.html');
  await page.evaluate(async ({ BOOK }) => {
    const DB: any = await import('/js/ai/db.js');
    const Lib: any = await import('/js/library/store.js');
    await Lib.putBook({ id: BOOK, title: 'Designing Data-Intensive Applications', format: 'pdf', progress: 72, addedAt: Date.now(), chaptersDoneAt: { 'Chapter 1': 123 } });
    await DB.put('anchors', {
      bookId: BOOK,
      entries: [
        ['a1', { page: 10, chapter: 'Chapter 1' }], ['a2', { page: 40, chapter: 'Chapter 2' }],
        ['a3', { page: 80, chapter: 'Chapter 3' }], ['a4', { page: 100, chapter: 'Chapter 4' }],
      ],
    });
    await DB.addDeck({ bookId: BOOK, name: 'x', cardType: 'basic', scope: 'Chapter 2', cards: [{ front: 'q', back: 'a' }] });
  }, { BOOK });
  await page.goto('/index.html?probes-test=data-intensive');
  await expect(page.locator('.ai-toast')).toContainText('2 capítulos ya leídos programados; 1 con pregunta lista');
  expect(page.url()).not.toContain('probes-test');
  const at = await page.evaluate(async ({ BOOK }) => {
    const Lib: any = await import('/js/library/store.js');
    return (await Lib.getAllBooks()).find((b: any) => b.id === BOOK).chaptersDoneAt;
  }, { BOOK });
  expect(at['Chapter 1']).toBe(123); // lo ya fechado no se toca
  expect(Date.now() - at['Chapter 2']).toBeGreaterThan(14 * DAY);
  expect(at['Chapter 3']).toBeUndefined(); // a medias: acaba en la página 80 y vas por la 72
});

test('lector de PDF: entrar en un capítulo del outline fecha el anterior', async ({ page }) => {
  const fs = await import('fs');
  const path = await import('path');
  const PDF = path.join(__dirname, '..', 'evals', 'fixtures', 'p3-constitucion.pdf');
  test.skip(!fs.existsSync(PDF), 'falta evals/fixtures/p3-constitucion.pdf (npm run eval:fixtures)');
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', PDF);
  await page.waitForSelector('#pdf-container canvas', { timeout: 30000 });
  await page.waitForFunction(() => !!document.querySelector('#toc-list a[data-toc-page]'), null, { timeout: 30000 });
  // Raíz única con los capítulos como hijos (patrón BOE): el criterio es el de la segmentación.
  const target = await page.evaluate(async () => {
    const R: any = await import('/js/pdf-reader.js');
    const S: any = await import('/js/ai/segment-pdf.js');
    const top = await S.chapterStarts(R.getDocument());
    await R.goTo(top[2].page);
    return { prev: top[1].title, later: top[3].title, n: top.length };
  });
  expect(target.n).toBeGreaterThan(3);
  await expect.poll(async () => page.evaluate(async () => {
    const Lib: any = await import('/js/library/store.js');
    const b = (await Lib.getAllBooks()).find((x: any) => x.format === 'pdf');
    return b && b.chaptersDoneAt ? Object.keys(b.chaptersDoneAt) : [];
  }), { timeout: 10000 }).toContain(target.prev);
  const keys = await page.evaluate(async () => {
    const Lib: any = await import('/js/library/store.js');
    return Object.keys((await Lib.getAllBooks()).find((x: any) => x.format === 'pdf').chaptersDoneAt);
  });
  expect(keys).not.toContain(target.later);
});
