import { test, expect } from '@playwright/test';
import path from 'path';
import { seedProLicense } from './pro-license';

// Las tarjetas NUEVAS de un capítulo no entran en el repaso de hoy hasta que lo has dejado atrás
// (ai/chapter-gate.js). Abrir un mazo a mano no filtra. El lector registra los capítulos que
// quedan atrás en la ficha del libro.

const EPUB_PATH = path.join(__dirname, 'test.epub');

test('chapter-gate: avanzar solo suma lo de atrás; bloquea las nuevas de capítulos sin leer', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async () => {
    const G: any = await import('/js/ai/chapter-gate.js');
    const order = G.flattenToc([{ label: 'Uno' }, { label: 'Dos', subitems: [{ label: 'Dos.1' }] }, { label: 'Tres' }, { label: ' Uno ' }]);
    const a = G.advance({}, order, 'Dos.1');
    const back = G.advance({ chapterOrder: order, chaptersDone: a.chaptersDone }, order, 'Uno');
    const book = { chapterOrder: order, chaptersDone: a.chaptersDone };
    const card = (chapter: string, reps = 0) => ({ chapter, front: 'x', srs: reps ? { reps } : undefined });
    return {
      order,
      done: a.chaptersDone,
      back,
      unknown: G.advance({}, order, 'Otro'),
      locked: {
        leido: G.isLocked(card('Uno'), {}, book),
        actual: G.isLocked(card('Dos.1'), {}, book),
        futuro: G.isLocked(card('tres'), {}, book),
        empezada: G.isLocked(card('Tres', 2), {}, book),
        porMazo: G.isLocked(card(''), { scope: 'Tres' }, book),
        fueraDelIndice: G.isLocked(card('Capítulo inventado'), {}, book),
        terminado: G.isLocked(card('Tres'), {}, { ...book, status: 'finished' }),
        sinDatos: G.isLocked(card('Tres'), {}, { status: 'reading' }),
      },
    };
  });
  expect(r.order).toEqual(['Uno', 'Dos', 'Dos.1', 'Tres']);
  expect(r.done).toEqual(['Uno', 'Dos']);
  expect(r.back).toBeNull();                 // volver atrás no cambia nada
  expect(r.unknown).toBeNull();
  expect(r.locked).toEqual({ leido: false, actual: true, futuro: true, empezada: false, porMazo: true, fueraDelIndice: false, terminado: false, sinDatos: false });
});

test('repaso de hoy: las nuevas del capítulo sin leer esperan; abrir el mazo a mano no filtra', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    const Lib: any = await import('/js/library/store.js');
    await Lib.putBook({ id: 'bk-gate', title: 'Libro', addedAt: Date.now(), lastOpenedAt: Date.now(), status: 'reading',
      chapterOrder: ['Uno', 'Dos', 'Tres'], chaptersDone: ['Uno'] });
    await DB.addDeck({ bookId: 'bk-gate', name: 'Libro — plan', cardType: 'basic', scope: '', cards: [
      { type: 'basic', front: 'Pregunta del uno', back: 'a', chapter: 'Uno' },
      { type: 'basic', front: 'Pregunta del dos', back: 'b', chapter: 'Dos' },
      { type: 'basic', front: 'Pregunta del tres', back: 'c', chapter: 'Tres' },
    ] });
  });
  const due = await page.evaluate(async () => {
    const S: any = await import('/js/ai/study.js');
    return (await S.dueToday()).cards;
  });
  expect(due).toBe(1);

  await page.evaluate(async () => { const S: any = await import('/js/ai/study.js'); await S.openToday(); });
  const study = page.locator('#ai-study');
  await expect(study.locator('.study-q')).toContainText('Pregunta del uno');
  await study.locator('.study-flip').click();
  await study.locator('.study-grade.is-good').click();
  await expect(study.locator('.study-waiting')).toContainText('2 tarjetas nuevas esperan a que leas su capítulo');
  await study.locator('.ai-ob-close').click();

  // A mano, el mazo entero (lo has pedido tú).
  const n = await page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    const S: any = await import('/js/ai/study.js');
    const deck = (await DB.getDecks('bk-gate'))[0];
    S.open({ decks: [deck] });
    return document.querySelector('#ai-study .study-left')?.textContent;
  });
  expect(n).toContain('2 pendientes');
});

test('el lector guarda en la ficha los capítulos que quedan atrás al avanzar', async ({ page }) => {
  await page.goto('/');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Subir tu primer libro' }).click(),
  ]);
  await chooser.setFiles(EPUB_PATH);
  await page.waitForSelector('#epub-container iframe', { timeout: 30000 });
  await page.waitForFunction(() => !!document.querySelector('#toc-list a'), null, { timeout: 30000 });
  await page.getByRole('button', { name: 'Índice y notas', exact: true }).click();
  const links = page.locator('#toc-list a');
  const n = await links.count();
  expect(n).toBeGreaterThan(2);
  await links.nth(2).click();
  await expect.poll(async () => page.evaluate(async () => {
    const Lib: any = await import('/js/library/store.js');
    const b = (await Lib.getAllBooks())[0];
    return b && Array.isArray(b.chaptersDone) ? { order: b.chapterOrder.length, done: b.chaptersDone.length } : null;
  }), { timeout: 15000 }).toMatchObject({ done: 2 });
});
