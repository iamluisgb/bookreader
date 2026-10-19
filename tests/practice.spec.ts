import { test, expect } from '@playwright/test';
import path from 'path';
import { seedProLicense } from './pro-license';
import { openFromStudio } from './studio-nav';

// P43 F3 · La matriz como opción del menú de flashcards: se pide para un capítulo, el agente
// (stub) devuelve el spec, se abre para hacerla, el intento va a `attempts` y lo fallado entra al
// mazo como tarjetas básicas. La matriz es un ejercicio del mazo (`deck.exercises`), no una
// tarjeta: no cuenta en el mazo ni en la cola de FSRS.

const EPUB_PATH = path.join(__dirname, 'test.epub');

// Stub del LLM: el prompt de la matriz (stream, «MATRIZ» en el system) devuelve el spec que el
// test deja en window.__matrix. Lo demás, como en flashcards.spec.ts (sin tarjetas de texto).
async function stubLLM(page) {
  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    (window as any).__calls = { matrix: 0 };
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions') && opts?.body) {
        const body = JSON.parse(opts.body);
        const sys = (body.messages || []).find((m: any) => m.role === 'system')?.content || '';
        if (body.stream) {
          const isMatrix = sys.includes('MATRIZ');
          if (isMatrix) (window as any).__calls.matrix++;
          const out = isMatrix ? JSON.stringify((window as any).__matrix) : '[]';
          const chunks = [
            `data: ${JSON.stringify({ choices: [{ delta: { content: out }, finish_reason: null }] })}\n\n`,
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n',
          ];
          const s = new ReadableStream({ start(c) { const e = new TextEncoder(); chunks.forEach((x) => c.enqueue(e.encode(x))); c.close(); } });
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
  await page.evaluate(() => {
    localStorage.setItem('bookreader_ai_key', JSON.stringify('test-key'));
    localStorage.setItem('bookreader_flashcards_hint_seen', 'true');
  });
  await page.reload();
  await stubLLM(page);
  const fc = page.waitForEvent('filechooser');
  await page.click('.lib-empty .lib-upload');
  await (await fc).setFiles(EPUB_PATH);
  await page.waitForSelector('#ai-toggle:not([disabled])', { timeout: 15000 });
  await page.click('#ai-toggle');
  await page.waitForSelector('.ai-onboarding', { timeout: 5000 });
  await page.click('.ai-ob-tpl[data-tpl="hqa"]');
  await page.fill('#ai-ob-goal', 'memorizar la novela');
  await page.click('#ai-ob-start');
  await expect(page.locator('#ai-status')).toContainText('Listo', { timeout: 30000 });
}

test('matriz desde flashcards: solo con capítulo, se hace, guarda el intento y pasa lo fallado al mazo', async ({ page }) => {
  await setup(page);
  await openFromStudio(page, 'flashcards');
  await page.waitForSelector('#ai-flashcards', { timeout: 5000 });

  // Con el libro entero no se puede pedir: apagada y con el porqué.
  const combo = page.locator('#fc-scope .fc-combo-btn');
  await combo.click();
  await page.locator('#fc-scope .fc-combo-list li').first().click();
  const matrixBox = page.locator('input[name="fc-ptype"][value="matrix"]');
  await expect(matrixBox).toBeDisabled();
  await expect(page.locator('#fc-phint')).toBeVisible();

  // Un capítulo: se enciende.
  await combo.click();
  const opt = page.locator('#fc-scope .fc-combo-list li').nth(1);
  const chapter = ((await opt.textContent()) || '').trim();
  await opt.click();
  await expect(matrixBox).toBeEnabled();
  await expect(page.locator('#fc-phint')).toBeHidden();

  // El spec que «devuelve el modelo», con citas sacadas del texto real del capítulo.
  await page.evaluate(async (chapter) => {
    const R: any = await import('/js/ai/retrieval.js');
    const text = R.passagesByChapter(chapter).map((p: any) => p.text).join('\n\n');
    const q = (at: number) => text.slice(at, at + 60).trim();
    (window as any).__matrix = {
      title: 'Personajes', prompt: '¿Qué hace cada uno?',
      rows: [{ id: 'r1', label: 'Juan' }, { id: 'r2', label: 'Dolores' }],
      columns: [
        { id: 'c1', label: 'Viaja a Comala', options: ['Sí', 'No'] },
        { id: 'c2', label: 'Quién lo pide', options: ['La madre', 'El padre'] },
      ],
      cells: [
        { row: 'r1', col: 'c1', answer: 'Sí', why: 'Va a buscar a su padre.', cite: { quote: q(0) } },
        { row: 'r2', col: 'c1', answer: 'No', why: 'Muere antes.', cite: { quote: q(100) } },
        { row: 'r1', col: 'c2', answer: 'La madre', why: 'Se lo pide al morir.', cite: { quote: q(200) } },
        { row: 'r2', col: 'c2', answer: 'La madre', why: 'Es ella quien lo pide.', cite: { quote: q(300) } },
      ],
    };
  }, chapter);

  // Solo la matriz (sin tarjetas de texto): generar la abre directamente.
  await page.locator('input[name="fc-type"][value="basic"]').uncheck();
  await matrixBox.check();
  await expect(page.locator('#fc-generate')).toBeEnabled();
  await page.click('#fc-generate');
  const practice = page.locator('#ai-practice');
  await expect(practice.locator('.wgt-grid')).toBeVisible({ timeout: 15000 });
  expect(await page.evaluate(() => (window as any).__calls.matrix)).toBe(1);

  // Tres bien, una mal y segura (r2|c1).
  const pick = (k: string, v: string) => practice.locator(`.segmented-btn[data-k="${k}"][data-v="${v}"]`).click();
  await pick('r1|c1', 'Sí');
  await pick('r2|c1', 'Sí');
  await pick('r1|c2', 'La madre');
  await pick('r2|c2', 'La madre');
  await practice.locator('.wgt-commit').click();
  await expect(practice.locator('.wgt-score')).toHaveText('3 de 4 bien');
  await expect(practice.locator('.wgt-practice-note')).toContainText('1 tarjetas al mazo');

  const saved = await page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    const all = await DB.getAllDecks();
    const deck = all.find((d: any) => DB.exercisesOf(d).length);
    const attempts = await DB.getAttempts(deck.bookId);
    return {
      cards: DB.cardsOf(deck).map((c: any) => ({ type: c.type, front: c.front, uid: !!c.uid })),
      ex: DB.exercisesOf(deck).map((e: any) => ({ uid: !!e.uid, type: e.type, last: e.last && [e.last.correct, e.last.total] })),
      attempts: attempts.map((a: any) => ({ mode: a.mode, verdict: a.verdict, widget: a.widget })),
    };
  });
  expect(saved.cards).toEqual([{ type: 'basic', front: 'Dolores · Viaja a Comala (Sí / No)', uid: true }]);
  expect(saved.ex).toEqual([{ uid: true, type: 'matrix', last: [3, 4] }]);
  expect(saved.attempts).toEqual([{ mode: 'widget', verdict: 'partial', widget: { type: 'matrix', correct: 3, total: 4, confidentMisses: 1 } }]);

  // Al cerrar: el mazo del capítulo ofrece «Practicar» y la matriz recuerda la última vez.
  await practice.locator('.ai-ob-close').click();
  await expect(practice).toHaveCount(0);
  const row = page.locator('.fc-deck').first();
  await expect(row).toContainText('1 tarjetas');
  await expect(row).toContainText('matriz para practicar');
  await row.locator('[data-act="practice"]').click();
  await expect(page.locator('#ai-practice .wgt-practice-ctx')).toContainText('La última vez: 3 de 4');
});

test('mergeDeckPair: los ejercicios se funden por uid y un mazo sin ellos no rebota en el sync', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    const base = { uid: 'd1', name: 'M', cardType: 'basic', cards: [], updatedAt: 10 };
    const legacy = DB.mergeDeckPair({ ...base }, { ...base, exercises: [] });
    const exL = { uid: 'e1', type: 'matrix', spec: { t: 1 }, last: null, updatedAt: 10 };
    const exR = { ...exL, last: { correct: 2, total: 4, ts: 5 }, updatedAt: 20 };
    const merged = DB.mergeDeckPair({ ...base, exercises: [exL] }, { ...base, exercises: [exR] });
    const added = DB.mergeDeckPair({ ...base, exercises: [exL] }, { ...base, exercises: [exL, { ...exL, uid: 'e2' }] });
    const gone = DB.mergeDeckPair({ ...base, exercises: [exL] }, { ...base, deleted: true, updatedAt: 30 });
    return { legacy, merged: merged.exercises.map((e: any) => e.last), added: added.exercises.length, gone: gone.exercises };
  });
  expect(r.legacy).toBeNull();
  expect(r.merged).toEqual([{ correct: 2, total: 4, ts: 5 }]);
  expect(r.added).toBe(2);
  expect(r.gone).toEqual([]);
});
