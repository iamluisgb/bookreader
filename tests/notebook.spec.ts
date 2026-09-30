import { test, expect, Page } from '@playwright/test';
import path from 'path';

// NB2 · La libreta que guía. Cada campo tuyo dice CUÁNDO se pregunta y la libreta enseña
// UNA pregunta pendiente («Te toca»); lo que repite el objetivo no se pide dos veces; los
// campos vacíos son una línea; HQ&A lleva tu respuesta al mazo; las plantillas por capítulo
// se agrupan por capítulo; en T3 la tesis del agente espera a la tuya.

const EPUB_PATH = path.join(__dirname, 'test.epub');

type Seed = { tpl: string; goal: string; notes?: { f: string; c: string; ch?: string }[]; done?: string; finished?: boolean };

async function openNotebook(page: Page, seed: Seed) {
  await page.goto('/index.html');
  await page.evaluate(() => {
    localStorage.setItem('bookreader_ai_key', JSON.stringify('sk-test'));
    localStorage.setItem('bookreader_license', JSON.stringify({ key: 'BKRD-TEST-PRO', activationId: 'mock-test', validatedAt: Date.now(), revoked: false }));
  });
  await page.reload();
  await page.setInputFiles('#file-input', EPUB_PATH);
  await page.waitForSelector('#epub-container iframe', { state: 'attached', timeout: 30000 });
  const ids = await page.evaluate(async (seed) => {
    const DB = await import('/js/ai/db.js');
    const Store = await import('/js/library/store.js');
    const books = await Store.getAllBooks();
    const c = await DB.createConvo(books[0].id, seed.tpl, seed.goal);
    for (const n of seed.notes || []) await DB.addNote(c.id, n.f, n.c, [], n.ch ? { chapter: n.ch } : {});
    if (seed.done) localStorage.setItem('bookreader_nb_done_chapter', JSON.stringify({ [c.id]: seed.done }));
    if (seed.finished) await Store.updateBook(books[0].id, { status: 'finished' });
    return { convoId: c.id, bookId: books[0].id };
  }, seed);
  await page.reload();
  // Tras recargar, la app enseña la biblioteca o reabre el último libro según el tiempo:
  // se acepta cualquiera de los dos y, si es la biblioteca, se abre el libro.
  const cover = page.locator('.lib-cover').first();
  const reader = page.locator('#epub-container iframe');
  await expect(cover.or(reader)).toBeVisible({ timeout: 30000 });
  if (await cover.isVisible()) await cover.click();
  await reader.waitFor({ state: 'attached', timeout: 30000 });
  await page.evaluate(async () => { (await import('/js/ai/panel.js')).setOpen(true); });
  await page.locator('.ai-tab[data-view="notebook"]').waitFor({ state: 'attached' });
  await page.evaluate(() => (document.querySelector('.ai-tab[data-view="notebook"]') as HTMLElement).click());
  await expect(page.locator('#ai-view-notebook .ai-nb-goal')).toBeVisible();
  return ids;
}

const nb = (page: Page) => page.locator('#ai-view-notebook');

test('T1: «Te toca» pregunta lo del inicio, no repite el objetivo y avanza a la del capítulo', async ({ page }) => {
  await openNotebook(page, { tpl: 't1-extraccion', goal: 'Mi pipeline pierde eventos', done: 'CAPÍTULO 2' });
  // El objetivo NO se pide otra vez como «Problema».
  await expect(nb(page).locator('.ai-nb-slot[data-field="problema_actual"]')).toHaveCount(0);
  // La pregunta del inicio, una sola, y su campo no se duplica como línea vacía.
  const toca = nb(page).locator('.ai-nb-toca');
  await expect(toca).toHaveCount(1);
  await expect(toca).toHaveAttribute('data-field', 'artefacto_salida');
  await expect(nb(page).locator('.ai-nb-slot[data-field="artefacto_salida"]')).toHaveCount(0);

  await toca.locator('.ai-nb-toca-input').fill('Una checklist de réplica');
  await toca.locator('.ai-nb-toca-save').click();
  await expect(nb(page).locator('.ai-nb-saved')).toContainText('Qué quiero tener al terminar');
  // Siguiente: la del capítulo terminado.
  await expect(toca).toHaveAttribute('data-field', 'por_que_importa');
  await expect(toca).toHaveAttribute('data-chapter', 'CAPÍTULO 2');
  await expect(toca).toContainText('CAPÍTULO 2');

  // «Ahora no» la aparta y no vuelve.
  await toca.locator('.ai-nb-toca-skip').click();
  await expect(nb(page).locator('.ai-nb-toca')).toHaveCount(0);
  await page.evaluate(async () => { const p = await import('/js/ai/panel.js'); p.setOpen(true); });
  const stored = await page.evaluate(async () => {
    const DB = await import('/js/ai/db.js');
    const all = await DB.getAll('notes');
    return all.filter((n: any) => !n.deleted).map((n: any) => ({ f: n.fieldKey, c: n.content }));
  });
  expect(stored).toEqual([{ f: 'artefacto_salida', c: 'Una checklist de réplica' }]);
});

test('campo vacío = una línea; al tocarla se escribe con la instrucción como ejemplo', async ({ page }) => {
  await openNotebook(page, { tpl: 't4-sabiduria', goal: 'Ser más paciente' });
  const slot = nb(page).locator('.ai-nb-slot[data-field="espejo"]');
  await expect(slot).toContainText('El espejo');
  await expect(slot).toContainText('al terminar el libro');
  await expect(nb(page).locator('.ai-nb-empty')).toHaveCount(0);   // se acabó el «—»
  await slot.click();
  const input = nb(page).locator('.ai-nb-editor .ai-nb-input');
  await expect(input).toHaveAttribute('placeholder', 'Qué haría yo en una encrucijada equivalente');
  await input.fill('Esperaría un día antes de responder');
  await nb(page).locator('.ai-nb-save').click();
  await expect(nb(page).locator('.ai-nb-field.is-mine .ai-nb-note-text')).toContainText('Esperaría un día');
});

test('libro terminado: aparecen las preguntas del final', async ({ page }) => {
  await openNotebook(page, { tpl: 't4-sabiduria', goal: 'Ser más paciente', finished: true });
  const toca = nb(page).locator('.ai-nb-toca');
  await expect(toca).toHaveAttribute('data-field', 'espejo');
  await expect(toca).toContainText('Has terminado el libro');
});

test('HQ&A: tu respuesta pasa al mazo y editarla actualiza la misma tarjeta', async ({ page }) => {
  const { bookId } = await openNotebook(page, {
    tpl: 'hqa', goal: 'Memorizar',
    notes: [{ f: 'hqa', c: '> Comala es un pueblo de muertos.\n\n**P:** ¿Qué es Comala?\n**R:** _(escribe tu respuesta)_', ch: 'CAPÍTULO 1' }],
  });
  const group = nb(page).locator('.ai-nb-chapter[data-chapter="CAPÍTULO 1"]');
  await group.locator('summary').click();
  await group.locator('.ai-nb-answer').click();
  // Solo se edita la respuesta: la pregunta queda a la vista.
  await expect(nb(page).locator('.ai-nb-editor-q')).toContainText('¿Qué es Comala?');
  await nb(page).locator('.ai-nb-input').fill('Un pueblo de ánimas');
  await nb(page).locator('.ai-nb-save').click();

  const cards = async () => page.evaluate(async (bookId) => {
    const DB = await import('/js/ai/db.js');
    const decks = await DB.getDecks(bookId);
    return decks.flatMap((d: any) => (d.cards || []).filter((c: any) => !c.deleted).map((c: any) => ({ front: c.front, back: c.back, chapter: c.chapter })));
  }, bookId);
  await expect.poll(cards).toEqual([{ front: '¿Qué es Comala?', back: 'Un pueblo de ánimas', chapter: 'CAPÍTULO 1' }]);

  await group.locator('.ai-nb-note-text').click();
  await nb(page).locator('.ai-nb-input').fill('Un pueblo donde hablan los muertos');
  await nb(page).locator('.ai-nb-save').click();
  await expect.poll(cards).toEqual([{ front: '¿Qué es Comala?', back: 'Un pueblo donde hablan los muertos', chapter: 'CAPÍTULO 1' }]);
});

test('plantilla por capítulos: notas agrupadas y el capítulo actual abierto', async ({ page }) => {
  await openNotebook(page, {
    tpl: 't6-implementacion', goal: 'Construir un LLM',
    notes: [
      { f: 'que_construyo', c: 'Un tokenizador BPE', ch: 'CAPÍTULO 1' },
      { f: 'que_construyo', c: 'Embeddings', ch: 'CAPÍTULO 2' },
    ],
  });
  const groups = nb(page).locator('.ai-nb-chapter');
  await expect(groups).toHaveCount(3);                      // actual (Cubierta) + 2 con notas
  await expect(groups.first().locator('.ai-nb-chapter-now')).toBeVisible();
  await expect(groups.first()).toHaveAttribute('open', '');
  const c1 = nb(page).locator('.ai-nb-chapter[data-chapter="CAPÍTULO 1"]');
  await expect(c1).not.toHaveAttribute('open', '');
  await expect(c1.locator('.ai-nb-chapter-n')).toHaveText('1');
  await c1.locator('summary').click();
  await expect(c1.locator('.ai-nb-note-text')).toHaveText('Un tokenizador BPE');
  // La nota dentro de su capítulo no repite el capítulo.
  await expect(c1.locator('.ai-nb-chap')).toHaveCount(0);
});

test('T3: la tesis del agente espera a la tuya', async ({ page }) => {
  await openNotebook(page, {
    tpl: 't3-juicio', goal: 'Juzgar la tesis',
    notes: [{ f: 'mapa_global', c: 'La tesis del agente' }],
  });
  await expect(nb(page).locator('.ai-nb-slot.is-locked')).toContainText('se muestra cuando escribas la tuya');
  await expect(nb(page).getByText('La tesis del agente')).toHaveCount(0);
  await nb(page).locator('.ai-nb-slot[data-field="tesis"]').click();
  await nb(page).locator('.ai-nb-input').fill('Mi tesis en tres frases');
  await nb(page).locator('.ai-nb-save').click();
  await expect(nb(page).getByText('La tesis del agente')).toBeVisible();
});

test('menú ⋯: sin iconos fijos; ofrece revisar, tarjeta, editar y borrar', async ({ page }) => {
  await openNotebook(page, {
    tpl: 't1-extraccion', goal: 'Mi problema',
    notes: [{ f: 'por_que_importa', c: 'Pasar a acks=all', ch: 'CAPÍTULO 2' }],
  });
  const note = nb(page).locator('.ai-nb-note').first();
  await expect(note.locator('.ai-nb-menu')).toHaveCount(0);
  await note.locator('.ai-nb-more').click();
  const menu = note.locator('.ai-nb-menu');
  await expect(menu.locator('.ai-nb-review')).toBeVisible();
  await expect(menu.locator('.ai-nb-card')).toBeVisible();
  await expect(menu.locator('.ai-nb-edit')).toBeVisible();
  await menu.locator('.ai-nb-del').click();
  await expect(nb(page).locator('.ai-nb-note')).toHaveCount(0);
});

test('lógica pura: parseQA, groupByChapter y pendingPrompt', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async () => {
    const NB = await import('/js/ai/notebook.js');
    const T = await import('/js/ai/templates.js');
    const blank = NB.parseQA('> frase\n\n**P:** ¿qué?\n**R:** _(escribe tu respuesta)_');
    const full = NB.parseQA('> frase\n\n**P:** ¿qué?\n**R:** esto');
    const groups = NB.groupByChapter(
      [{ chapter: 'B' }, { chapter: 'A' }, { chapter: '' }] as any,
      { order: ['A', 'B', 'C'], current: 'C' },
    ).map((g: any) => [g.chapter, g.notes.length]);
    const t1 = T.getTemplate('t1-extraccion');
    const none = NB.pendingPrompt(t1, [{ fieldKey: 'artefacto_salida' }] as any, { convoId: 999 });
    const fin = NB.pendingPrompt(t1, [{ fieldKey: 'artefacto_salida' }] as any, { convoId: 999, finished: true });
    return { blank, full, groups, none, fin: fin?.field.key };
  });
  expect(r.blank).toEqual({ q: '¿qué?', a: '', quote: 'frase' });
  expect(r.full.a).toBe('esto');
  expect(r.groups).toEqual([['A', 1], ['B', 1], ['C', 0], ['', 1]]);
  expect(r.none).toBeNull();
  expect(r.fin).toBe('plan_accion');
});

test('al pasar de capítulo leyendo, la libreta pregunta por el que terminaste', async ({ page }) => {
  await openNotebook(page, {
    tpl: 't1-extraccion', goal: 'Mi problema',
    notes: [{ f: 'artefacto_salida', c: 'Una checklist' }],
  });
  await expect(nb(page).locator('.ai-nb-toca')).toHaveCount(0);
  // Avanza páginas hasta cruzar dos cambios de capítulo (el primero solo fija el de partida).
  const left = await page.evaluate(async () => {
    const R = await import('/js/epub-reader.js') as any;
    const seen: string[] = [];
    const push = () => { const l = R.getCurrentChapterLabel?.() || ''; if (l && seen[seen.length - 1] !== l) seen.push(l); };
    push();
    for (let i = 0; i < 60 && seen.length < 3; i++) { await R.next(); await new Promise(r => setTimeout(r, 150)); push(); }
    return seen;
  });
  expect(left.length).toBeGreaterThanOrEqual(2);
  const toca = nb(page).locator('.ai-nb-toca');
  await expect(toca).toHaveAttribute('data-field', 'por_que_importa');
  await expect(toca).not.toHaveAttribute('data-chapter', '');
});
