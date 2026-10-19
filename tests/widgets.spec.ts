import { test, expect } from '@playwright/test';

// P43 F1 · Widgets de estudio: carcasa común (core.js) y tipo «Rellena la matriz» (matrix.js).
// Todo determinista, sin LLM: validación del spec, citas contra el texto, corrección celda a
// celda, tarjetas de lo fallado, registro de intento en el store de P42 y el widget en el DOM.

const QUOTE_A = 'Automatically preventing write skew requires true serializable isolation';
const QUOTE_B = 'Since the database is using snapshot isolation, both checks return 2';

const SPEC = {
  type: 'matrix',
  version: 1,
  bookId: 'bk-wgt',
  chapter: 'Chapter 8. Transactions',
  title: 'Niveles de aislamiento',
  prompt: '¿Evita la anomalía?',
  rows: [
    { id: 'rc', label: 'Read committed' },
    { id: 'si', label: 'Snapshot isolation' },
  ],
  columns: [
    { id: 'lu', label: 'Lost updates', options: ['Sí', 'No', 'Según el motor'] },
    { id: 'ws', label: 'Write skew', options: ['Sí', 'No'] },
  ],
  cells: [
    { row: 'rc', col: 'lu', answer: 'No', given: true },
    { row: 'si', col: 'lu', answer: 'Según el motor', why: 'Unos motores lo detectan y otros no.', cite: { quote: QUOTE_A, src: 'a12' } },
    { row: 'rc', col: 'ws', answer: 'No', why: 'Cada una escribe su fila.', cite: { quote: QUOTE_A } },
    { row: 'si', col: 'ws', answer: 'No', why: 'Las dos leen del mismo snapshot.', cite: { quote: QUOTE_B } },
  ],
};

const CHAPTER_TEXT = `In each transaction, your application first checks that two or more doctors are cur-
rently on call. Since the database is using snapshot isolation, both checks return 2, so both
transactions proceed. … “Automatically preventing write skew requires true serializable isola-
tion” (see “Serializability”).`;

test('validateMatrix: un spec bueno no da errores y cada defecto se nombra', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async (SPEC) => {
    const M: any = await import('/js/ai/widgets/matrix.js');
    const clone = () => JSON.parse(JSON.stringify(SPEC));
    const bad = (mut: (s: any) => void) => { const s = clone(); mut(s); return M.validateMatrix(s); };
    return {
      ok: M.validateMatrix(clone()),
      notObject: M.validateMatrix(null),
      type: bad((s) => { s.type = 'quiz'; }),
      version: bad((s) => { s.version = 2; }),
      missingCell: bad((s) => { s.cells.pop(); }),
      dupCell: bad((s) => { s.cells.push({ ...s.cells[1] }); }),
      notOption: bad((s) => { s.cells[1].answer = 'Quizá'; }),
      dupId: bad((s) => { s.rows[1].id = 'rc'; }),
      noCite: bad((s) => { delete s.cells[2].cite; }),
      shortQuote: bad((s) => { s.cells[2].cite.quote = 'write skew'; }),
      badSrc: bad((s) => { s.cells[1].cite.src = '[[a12]]'; }),
      noWhy: bad((s) => { s.cells[3].why = ''; }),
      tooManyGiven: bad((s) => { s.cells[1].given = true; s.cells[2].given = true; }),
      oneRow: bad((s) => { s.rows.pop(); s.cells = s.cells.filter((c: any) => c.row === 'rc'); }),
      dupOptions: bad((s) => { s.columns[1].options = ['Sí', 'sí']; }),
    };
  }, SPEC);
  expect(r.ok).toEqual([]);
  expect(r.notObject).toEqual(['el spec no es un objeto']);
  expect(r.type.join()).toContain('type desconocido');
  expect(r.version.join()).toContain('version');
  expect(r.missingCell.join()).toContain('faltan celdas');
  expect(r.dupCell.join()).toContain('celda repetida');
  expect(r.notOption.join()).toContain('no es una opción');
  expect(r.dupId.join()).toContain('id repetido');
  expect(r.noCite.join()).toContain('falta cite');
  expect(r.shortQuote.join()).toContain('demasiado corta');
  expect(r.badSrc.join()).toContain('ancla');
  expect(r.noWhy.join()).toContain('falta why');
  expect(r.tooManyGiven.join()).toContain('demasiadas celdas dadas');
  expect(r.oneRow.join()).toContain('rows: entre 2');
  expect(r.dupOptions.join()).toContain('opciones repetidas');
});

test('verifyQuotes: encuentra la cita pese a comillas, mayúsculas y guiones de fin de línea', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async ({ SPEC, CHAPTER_TEXT }) => {
    const C: any = await import('/js/ai/widgets/core.js');
    const M: any = await import('/js/ai/widgets/matrix.js');
    const cites = M.matrixCites(SPEC);
    const invented = [...cites, { where: 'x', cite: { quote: 'snapshot isolation always prevents write skew' } }];
    return {
      where: cites.map((c: any) => c.where),
      ok: C.verifyQuotes(cites, CHAPTER_TEXT),
      invented: C.verifyQuotes(invented, CHAPTER_TEXT),
      empty: C.verifyQuotes(cites, ''),
      norm: C.normalizeQuote('Consis-\ntency «Raft» — Ágil'),
      pdfHyphen: C.normalizeQuote('every\u2010\nthing will turn out'),
    };
  }, { SPEC, CHAPTER_TEXT });
  expect(r.where).toEqual(['si|lu', 'rc|ws', 'si|ws']);
  expect(r.ok).toEqual([]);
  expect(r.invented).toEqual(['x']);
  expect(r.empty).toEqual(['si|lu', 'rc|ws', 'si|ws']);
  expect(r.norm).toBe('consistency raft agil');
  expect(r.pdfHyphen).toBe('everything will turn out');
});

test('scoreMatrix y matrixCards: celda a celda, fallos seguros aparte, tarjetas de lo fallado y lo dudado', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async (SPEC) => {
    const M: any = await import('/js/ai/widgets/matrix.js');
    const answers = {
      'si|lu': { value: 'Sí' },                    // fallo seguro
      'rc|ws': { value: 'No', unsure: true },      // acierto dudado
      // 'si|ws' sin responder: fallo, pero no «seguro»
    };
    const res = M.scoreMatrix(SPEC, answers);
    return { res, cards: M.matrixCards(SPEC, res), all: M.scoreMatrix(SPEC, { 'si|lu': { value: 'Según el motor' }, 'rc|ws': { value: 'No' }, 'si|ws': { value: 'No' } }) };
  }, SPEC);
  expect(r.res.total).toBe(3);
  expect(r.res.correct).toBe(1);
  expect(r.res.confidentMisses).toBe(1);
  expect(r.res.cells.map((c: any) => c.ok)).toEqual([false, true, false]);
  expect(r.all.correct).toBe(3);
  // Fallo seguro + acierto dudado + sin responder = 3 tarjetas, con la forma del mazo.
  expect(r.cards).toHaveLength(3);
  expect(r.cards[0]).toEqual({
    type: 'basic',
    front: 'Snapshot isolation · Lost updates (Sí / No / Según el motor)',
    back: `Según el motor\n\nUnos motores lo detectan y otros no.\n\n«${QUOTE_A}»`,
    chapter: 'Chapter 8. Transactions',
    src: 'a12',
  });
});

test('widgetAttempt: mismo registro que el repaso, en el store attempts, con la huella del spec', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async (SPEC) => {
    const C: any = await import('/js/ai/widgets/core.js');
    const DB: any = await import('/js/ai/db.js');
    const result = { correct: 1, total: 3, confidentMisses: 1 };
    const rec = C.widgetAttempt({ uid: 'w1', spec: SPEC, ts: 1000, latencyMs: 42, result, answer: { 'si|lu': { value: 'Sí' } } });
    await DB.addAttempt(rec);
    const reordered = Object.fromEntries(Object.entries(SPEC).reverse());
    const long = C.widgetAttempt({ uid: 'w2', spec: SPEC, ts: 2, result: { correct: 3, total: 3 }, answer: 'x'.repeat(900) });
    return {
      rec,
      back: await DB.getAttempts('bk-wgt'),
      sameHash: C.specHash(reordered) === C.specHash(SPEC),
      otherHash: C.specHash({ ...SPEC, title: 'Otro' }) !== C.specHash(SPEC),
      long: { verdict: long.verdict, exact: long.exact, len: long.answer.length },
      none: C.widgetAttempt({ uid: 'w3', spec: SPEC, ts: 3, result: { correct: 0, total: 3 }, answer: {} }).verdict,
    };
  }, SPEC);
  expect(Object.keys(r.rec).sort()).toEqual(
    ['answer', 'arm', 'bookId', 'cardHash', 'cardUid', 'deckUid', 'exact', 'grade', 'latencyMs', 'mode', 'prevInterval', 'ts', 'uid', 'verdict', 'widget'],
  );
  expect(r.rec).toMatchObject({ mode: 'widget', verdict: 'partial', exact: false, bookId: 'bk-wgt', cardUid: null, widget: { type: 'matrix', correct: 1, total: 3, confidentMisses: 1 } });
  expect(r.rec.cardHash).toMatch(/^[0-9a-f]{8}$/);
  expect(r.back).toHaveLength(1);
  expect(r.back[0].uid).toBe('w1');
  expect(r.sameHash).toBe(true);
  expect(r.otherHash).toBe(true);
  expect(r.long).toEqual({ verdict: 'good', exact: true, len: 500 });
  expect(r.none).toBe('wrong');
});

test('renderMatrix: no se comprueba hasta rellenarlo todo, marca cada celda y explica los fallos con la cita', async ({ page }) => {
  await page.goto('/patterns.html');
  await page.evaluate(async (SPEC) => {
    const M: any = await import('/js/ai/widgets/matrix.js');
    const host = document.createElement('div');
    host.id = 'wgt-test';
    document.body.prepend(host);
    // El spec viene del modelo: una etiqueta con HTML tiene que salir como texto.
    const spec = JSON.parse(JSON.stringify(SPEC));
    spec.rows[1].label = 'Snapshot <img src=x onerror="window.__xss=1">';
    (window as any).__commits = [];
    M.renderMatrix(host, spec, { onCommit: (res: any, ans: any) => (window as any).__commits.push({ res, ans }) });
  }, SPEC);
  const w = page.locator('#wgt-test');
  const commit = w.locator('.wgt-commit');
  await expect(commit).toBeDisabled();
  await expect(w.locator('.wgt-given')).toHaveCount(1);
  await expect(w.locator('tbody th').nth(1)).toHaveText('Snapshot <img src=x onerror="window.__xss=1">');
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();

  const cell = (k: string) => w.locator(`td[data-k="${k}"]`);
  await cell('si|lu').getByRole('button', { name: 'Sí', exact: true }).click();
  await cell('rc|ws').getByRole('button', { name: 'No', exact: true }).click();
  await expect(commit).toBeDisabled();
  await cell('si|ws').getByRole('button', { name: 'Sí', exact: true }).click();
  await cell('si|ws').getByLabel('Dudo').check();
  await expect(cell('si|ws').getByRole('button', { name: 'Sí', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(commit).toBeEnabled();
  await commit.click();

  await expect(cell('rc|ws')).toHaveClass(/wgt-ok/);
  await expect(cell('si|lu')).toHaveClass(/wgt-ko/);
  await expect(cell('si|lu').locator('.wgt-fix')).toHaveText('Era: Según el motor');
  await expect(w.locator('.wgt-score')).toHaveText('1 de 3 bien');
  // El fallo seguro va primero y lleva su cita con el ancla.
  const first = w.locator('.wgt-miss').first();
  await expect(first.locator('.wgt-sure')).toHaveText('Ibas seguro');
  await expect(first.locator('.ai-cite')).toHaveAttribute('data-id', 'a12');
  await expect(w.locator('.wgt-miss')).toHaveCount(2);
  await expect(commit).toBeDisabled();
  await expect(cell('si|ws').getByRole('button', { name: 'No', exact: true })).toBeDisabled();

  const commits = await page.evaluate(() => (window as any).__commits);
  expect(commits).toHaveLength(1);
  expect(commits[0].res.confidentMisses).toBe(1);
  expect(commits[0].ans['si|ws']).toEqual({ value: 'Sí', unsure: true });
});

test('generate: parseo tolerante, campos que no decide el modelo, errores para el reintento y señales de calidad', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async ({ SPEC, CHAPTER_TEXT }) => {
    const G: any = await import('/js/ai/widgets/generate.js');
    const { type, version, bookId, chapter, ...fromModel } = SPEC;
    const json = JSON.stringify(fromModel);
    const wrapped = `<think>{"borrador": 1}</think>Aquí va:\n\`\`\`json\n${json.replace(/}]}$/, '},]}')}\n\`\`\``;
    const parsed = G.parseSpec(wrapped);
    const done = G.finishSpec({ ...parsed, type: 'quiz' }, { bookId: 'bk', chapter: 'Ch 8' });
    const invented = G.finishSpec(JSON.parse(json.replace('both checks return 2', 'both checks return 3')), { bookId: 'bk' });
    const msgs = G.matrixMessages({ chapter: 'Ch 8', text: 'x'.repeat(G.CHAPTER_CHAR_CAP + 50) });
    const leak = { ...done, rows: [{ id: 'rc', label: 'Read committed' }, { id: 'si', label: 'Snapshot isolation, según el motor' }] };
    return {
      parsed: !!parsed && parsed.rows.length === 2,
      none: G.parseSpec('no hay json'),
      meta: [done.type, done.version, done.bookId, done.chapter],
      ok: G.specErrors(done, CHAPTER_TEXT),
      invented: G.specErrors(invented, CHAPTER_TEXT),
      nothing: G.specErrors(null, CHAPTER_TEXT),
      capped: msgs[1].content.length < G.CHAPTER_CHAR_CAP + 200,
      retry: G.retryMessages(msgs, 'resp', ['e1']).map((m: any) => m.role),
      flags: G.qualityFlags(leak),
    };
  }, { SPEC, CHAPTER_TEXT });
  expect(r.parsed).toBe(true);
  expect(r.none).toBeNull();
  expect(r.meta).toEqual(['matrix', 1, 'bk', 'Ch 8']);
  expect(r.ok).toEqual([]);
  expect(r.invented).toEqual(['celda si|ws: la cita no aparece literal en el capítulo']);
  expect(r.nothing).toEqual(['la respuesta no contiene un objeto JSON']);
  expect(r.capped).toBe(true);
  expect(r.retry).toEqual(['system', 'user', 'assistant', 'user']);
  // ws es «No» en las dos filas (constante); «según el motor» está en la etiqueta de si (fuga).
  expect(r.flags).toEqual([{ kind: 'fuga', where: 'si|lu' }, { kind: 'constante', where: 'ws' }]);
});

test('patterns.html: el ejemplo vivo de la matriz se pinta sin errores', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/patterns.html');
  await expect(page.locator('#pl-wgt-matrix .wgt-grid')).toBeVisible();
  await expect(page.locator('#pl-wgt-matrix .wgt-cell[data-k]')).toHaveCount(4);
  expect(errors).toEqual([]);
});
