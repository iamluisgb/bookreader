import { test, expect, Page } from '@playwright/test';
import path from 'path';

// P43 · Al pasar al capítulo siguiente, la libreta ofrece la matriz del que acabas de terminar
// (sin interrumpir). «Practicar» la genera, la guarda en el mazo del capítulo y la abre; la
// segunda vez abre la misma sin generar. «Ahora no» la quita para ese capítulo.

const EPUB_PATH = path.join(__dirname, 'test.epub');

let matrixSpec: any = null;
let matrixCalls = 0;

async function openWithAgent(page: Page) {
  matrixCalls = 0;
  await page.route('**/chat/completions', (route) => {
    const req = JSON.parse(route.request().postData() || '{}');
    const sys = (req.messages || []).find((m: any) => m.role === 'system')?.content || '';
    const isMatrix = sys.includes('MATRIZ');
    if (isMatrix) matrixCalls++;
    const content = isMatrix ? JSON.stringify(matrixSpec) : 'Repaso — ¿Qué pasó? [[a1]]';
    const body = 'data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] }) + '\n\ndata: [DONE]\n\n';
    return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body });
  });
  await page.goto('/index.html');
  await page.evaluate(() => {
    localStorage.setItem('bookreader_ai_key', JSON.stringify('sk-test'));
    localStorage.setItem('bookreader_license', JSON.stringify({ key: 'BKRD-TEST-PRO', activationId: 'mock-test', validatedAt: Date.now(), revoked: false }));
  });
  await page.reload();
  await page.setInputFiles('#file-input', EPUB_PATH);
  await page.waitForSelector('#epub-container iframe', { state: 'attached', timeout: 30000 });
  await page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    const Store: any = await import('/js/library/store.js');
    let books: any[] = [];
    for (let i = 0; i < 100 && !books.length; i++) { books = await Store.getAllBooks(); if (!books.length) await new Promise(r => setTimeout(r, 100)); }
    await DB.createConvo(books[0].id, 'hqa', 'Entender Comala');
  });
  await page.reload();
  const cover = page.locator('.lib-cover').first();
  const reader = page.locator('#epub-container iframe');
  await expect(cover.or(reader)).toBeVisible({ timeout: 30000 });
  if (await cover.isVisible()) await cover.click();
  await page.waitForFunction(() => !!document.querySelector('#toc-list a'), null, { timeout: 30000 });
  await page.waitForFunction(() => { const tabs = document.getElementById('ai-tabs'); return !!tabs && getComputedStyle(tabs).display !== 'none'; }, null, { timeout: 30000 });
  await expect(page.locator('#ai-status')).toContainText('Listo', { timeout: 30000 });
}

// Un capítulo con texto de sobra y el siguiente; el spec cita su texto real.
async function pickChapter(page: Page) {
  return page.evaluate(async () => {
    const R: any = await import('/js/ai/retrieval.js');
    (await import('/js/ai/panel.js') as any).__ensureIndexForTest();
    const labels = [...document.querySelectorAll('#toc-list .toc-label')].map((e) => (e.textContent || '').trim());
    // Un capítulo de verdad (no preliminares: esos no se ofrecen) con texto de sobra.
    for (let i = 0; i < labels.length; i++) {
      const text = R.passagesByChapter(labels[i]).map((p: any) => p.text).join('\n\n');
      if (text.length >= 4000 && !R.isBoilerplate(labels[i])) return { chapter: labels[i], next: labels[i + 1] || 'Siguiente', text };
    }
    return null;
  });
}

const specFor = (text: string) => {
  const q = (at: number) => text.slice(at, at + 60).trim();
  return {
    title: 'Comala', prompt: 'Rellena',
    rows: [{ id: 'r1', label: 'Juan' }, { id: 'r2', label: 'Dolores' }],
    columns: [{ id: 'c1', label: 'Viaja', options: ['Sí', 'No'] }, { id: 'c2', label: 'Quién', options: ['Madre', 'Padre'] }],
    cells: [
      { row: 'r1', col: 'c1', answer: 'Sí', why: 'a', cite: { quote: q(0) } },
      { row: 'r2', col: 'c1', answer: 'No', why: 'b', cite: { quote: q(100) } },
      { row: 'r1', col: 'c2', answer: 'Madre', why: 'c', cite: { quote: q(200) } },
      { row: 'r2', col: 'c2', answer: 'Madre', why: 'd', cite: { quote: q(300) } },
    ],
  };
};

async function finishChapter(page: Page, ch: { chapter: string, next: string }) {
  await page.evaluate((ls) => {
    for (const l of ls) window.dispatchEvent(new CustomEvent('reader:chapter-changed', { detail: { label: l } }));
  }, [ch.chapter, ch.next]);
  await page.evaluate(async () => { (await import('/js/ai/panel.js') as any).setOpen(true); });
  await page.locator('.ai-tab[data-view="notebook"]').click();
}

test('al terminar un capítulo, la libreta ofrece su matriz; Practicar la genera, la guarda y la abre', async ({ page }) => {
  await openWithAgent(page);
  const ch = await pickChapter(page);
  expect(ch).not.toBeNull();
  matrixSpec = specFor(ch!.text);
  await finishChapter(page, ch!);
  const offer = page.locator('.ai-nb-matrix');
  await expect(offer).toContainText(`Has terminado «${ch!.chapter}»`);
  await offer.locator('.ai-nb-matrix-go').click();
  await expect(page.locator('#ai-practice .wgt-grid')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.ai-nb-matrix')).toHaveCount(0);
  expect(matrixCalls).toBe(1);
  const decks = await page.evaluate(async (chapter) => {
    const DB: any = await import('/js/ai/db.js');
    const P: any = await import('/js/ai/widgets/practice.js');
    const all = await DB.getAllDecks();
    const again = await P.chapterMatrix({ bookId: all[0].bookId, bookTitle: 'x', chapter, text: '' });
    return { n: all.length, scope: all[0].scope, cards: DB.cardsOf(all[0]).length, ex: DB.exercisesOf(all[0]).length, sameUid: again.exercise.uid === DB.exercisesOf(all[0])[0].uid };
  }, ch!.chapter);
  expect(decks).toEqual({ n: 1, scope: ch!.chapter, cards: 0, ex: 1, sameUid: true });
  expect(matrixCalls).toBe(1);   // la segunda vez no genera
});

test('«Ahora no» quita la oferta de ese capítulo', async ({ page }) => {
  await openWithAgent(page);
  const ch = await pickChapter(page);
  matrixSpec = specFor(ch!.text);
  await finishChapter(page, ch!);
  await page.locator('.ai-nb-matrix-skip').click();
  await expect(page.locator('.ai-nb-matrix')).toHaveCount(0);
  expect(matrixCalls).toBe(0);
});
