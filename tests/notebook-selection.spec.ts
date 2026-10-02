import { test, expect, Page } from '@playwright/test';
import path from 'path';

// Auditoría de libretas, F1 · Del fragmento a la libreta. La barra de selección lleva
// «A la libreta» (con HQ&A: «Hazme la pregunta»): el fragmento entra en la libreta con su
// pasaje, en el campo que elijas. Y HQ&A deja de crear notas sola con cualquier selección.
// La barra es la misma en EPUB, PDF y táctil, así que esto vale para los tres.

const EPUB_PATH = path.join(__dirname, 'test.epub');
const PDF_PATH = path.join(__dirname, 'test-multipage.pdf');

// Devuelve cuántas veces se pidió una PREGUNTA HQ&A (no cualquier llamada: al cruzar de
// capítulo, HQ&A hace además su repaso de capítulo en el chat, y eso es otra cosa).
async function stubModel(page: Page) {
  let calls = 0;
  await page.route('**/chat/completions', (route) => {
    const sys = JSON.parse(route.request().postData() || '{}').messages?.[0]?.content || '';
    if (/método HQ&A/.test(sys)) calls++;
    const body = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'P: ¿Qué busca Juan Preciado?' }, finish_reason: null }] }) + '\n\ndata: [DONE]\n\n';
    return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body });
  });
  return () => calls;
}

// Abre el EPUB con una conversación de la plantilla dada (sembrada) y el panel abierto.
async function openWithConvo(page: Page, tpl: string) {
  await page.goto('/index.html');
  await page.evaluate(() => {
    localStorage.setItem('bookreader_ai_key', JSON.stringify('sk-test'));
    localStorage.setItem('bookreader_license', JSON.stringify({ key: 'BKRD-TEST-PRO', activationId: 'mock-test', validatedAt: Date.now(), revoked: false }));
  });
  await page.reload();
  await page.setInputFiles('#file-input', EPUB_PATH);
  await page.waitForSelector('#epub-container iframe', { state: 'attached', timeout: 30000 });
  await page.evaluate(async (tpl) => {
    const DB: any = await import('/js/ai/db.js');
    const Store: any = await import('/js/library/store.js');
    let books: any[] = [];
    for (let i = 0; i < 100 && !books.length; i++) { books = await Store.getAllBooks(); if (!books.length) await new Promise(r => setTimeout(r, 100)); }
    await DB.createConvo(books[0].id, tpl, 'Entender Comala');
  }, tpl);
  await page.reload();
  const cover = page.locator('.lib-cover').first();
  const reader = page.locator('#epub-container iframe');
  await expect(cover.or(reader)).toBeVisible({ timeout: 30000 });
  if (await cover.isVisible()) await cover.click();
  await page.waitForFunction(() => !!document.querySelector('#toc-list a'), null, { timeout: 30000 });
  // La conversación sembrada se activa en segundo plano al abrir el libro: abrir el panel
  // antes enseñaría el onboarding (que tapa la barra de selección).
  await page.waitForFunction(() => { const tabs = document.getElementById('ai-tabs'); return !!tabs && getComputedStyle(tabs).display !== 'none'; }, null, { timeout: 30000 });
  await page.evaluate(async () => { (await import('/js/ai/panel.js') as any).setOpen(true); });
}

// Seleccionar un párrafo dentro del iframe del EPUB hasta que la app reacciona. El gesto se
// repite y, si la página no tiene prosa, AVANZA: bajo carga el lector restaura la posición
// guardada tarde y puede volver a la cubierta después de que el test ya hubiera avanzado.
async function selectInEpub(page: Page) {
  const gesto = () => page.evaluate(async () => {
    const doc = (document.querySelector('#epub-container iframe') as HTMLIFrameElement)?.contentDocument;
    const p = doc?.body && [...doc.body.querySelectorAll('p')].find(el => (el.textContent || '').trim().length > 40);
    if (!p) { try { await (await import('/js/epub-reader.js') as any).next(); } catch { /* aún cargando */ } return; }
    const w = doc.createTreeWalker(p, 4);
    let tn = w.nextNode() as Text | null;
    while (tn && tn.length < 20) tn = w.nextNode() as Text | null;
    if (!tn) return;
    const range = doc.createRange();
    range.setStart(tn, 0); range.setEnd(tn, Math.min(tn.length, 60));
    const sel = doc.defaultView!.getSelection()!;
    sel.removeAllRanges(); sel.addRange(range);
    doc.dispatchEvent(new Event('selectionchange', { bubbles: true }));
    doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await expect.poll(async () => {
    if (await page.locator('#highlight-tooltip').isVisible()) return true;
    await gesto();
    return false;
  }, { timeout: 30000 }).toBe(true);
}

const notes = (page: Page) => page.evaluate(async () => {
  const DB: any = await import('/js/ai/db.js');
  return (await DB.getAll('notes')).filter((n: any) => !n.deleted).map((n: any) => ({ f: n.fieldKey, c: n.content, src: n.sourceCfis }));
});

test('«A la libreta»: el fragmento entra en el campo que eliges, con su pasaje', async ({ page }) => {
  await stubModel(page);
  await openWithConvo(page, 't1-extraccion');
  await selectInEpub(page);
  const btn = page.locator('#sel-notebook');
  await expect(btn).toContainText('A la libreta');
  await btn.click();

  const nb = page.locator('#ai-view-notebook');
  const clip = nb.locator('.ai-nb-clip');
  await expect(clip).toBeVisible();
  // Primero tus campos.
  await expect(clip.locator('.ai-nb-clip-field').first()).toHaveClass(/is-mine/);
  await clip.locator('.ai-nb-clip-field[data-field="por_que_importa"]').click();

  // El editor nace con la cita y el cursor debajo, listo para tu comentario.
  const ed = nb.locator('.ai-nb-editor .ai-nb-input');
  await expect(ed).toBeFocused();
  expect(await ed.inputValue()).toMatch(/^> .+\n\n$/);
  await page.keyboard.type('Esto explica por qué vuelve.');
  await nb.locator('.ai-nb-save').click();

  const saved = (await notes(page)).find((n: any) => n.f === 'por_que_importa')!;
  expect(saved.c).toContain('Esto explica por qué vuelve.');
  expect(saved.src.some((s: string) => s.startsWith('epubcfi('))).toBe(true);    // vuelve al pasaje
  await expect(nb.locator('.ai-nb-note', { hasText: 'Esto explica' }).locator('.ai-nb-loc')).toBeVisible();
  await expect(nb.locator('.ai-nb-clip')).toHaveCount(0);
});

test('HQ&A: seleccionar ya no crea notas sola; «Hazme la pregunta» sí', async ({ page }) => {
  const calls = await stubModel(page);
  await openWithConvo(page, 'hqa');
  await selectInEpub(page);
  await page.waitForTimeout(1200);
  expect(calls()).toBe(0);                                  // nadie pidió una pregunta
  expect((await notes(page)).length).toBe(0);

  const btn = page.locator('#sel-notebook');
  await expect(btn).toContainText('Hazme la pregunta');
  await btn.click();
  const note = page.locator('#ai-view-notebook .ai-nb-note.is-unanswered');
  await expect(note).toContainText('¿Qué busca Juan Preciado?');
  const saved = await notes(page);
  expect(saved).toHaveLength(1);
  expect(saved[0].src.some((s: string) => s.startsWith('epubcfi('))).toBe(true);
});

test('PDF: el fragmento a la libreta guarda su página y vuelve a ella', async ({ page }) => {
  await stubModel(page);
  await page.goto('/index.html');
  await page.evaluate(() => localStorage.setItem('bookreader_ai_key', JSON.stringify('sk-test')));
  await page.reload();
  await page.setInputFiles('#file-input', PDF_PATH);
  await page.waitForSelector('#pdf-container .textLayer span', { timeout: 30000 });
  await page.evaluate(async () => { (await import('/js/ai/panel.js') as any).setOpen(true); });
  await page.locator('.ai-ob-tpl[data-tpl="t1-extraccion"]').click();
  await page.fill('#ai-ob-goal', 'Entender el documento');
  await page.locator('#ai-ob-start').click();
  await expect(page.locator('#ai-onboarding')).toHaveCount(0);

  const gesto = () => page.evaluate(() => {
    const span = document.querySelector('#pdf-container .textLayer span');
    if (!span) return;
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection()!;
    sel.removeAllRanges(); sel.addRange(range);
    document.getElementById('pdf-container')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await gesto();
  await expect.poll(async () => {
    if (await page.locator('#highlight-tooltip').isVisible()) return true;
    await gesto();
    return false;
  }, { timeout: 20000 }).toBe(true);
  await page.locator('#sel-notebook').click();
  const nb = page.locator('#ai-view-notebook');
  await nb.locator('.ai-nb-clip-field[data-field="por_que_importa"]').click();
  await nb.locator('.ai-nb-save').click();

  const saved = (await notes(page)).find((n: any) => n.f === 'por_que_importa')!;
  expect(saved.src).toContain('page:1');
  await expect(nb.locator('.ai-nb-loc')).toContainText('pág. 1');
});

// Carrera real (salió con la suite bajo carga): abrir el agente ANTES de que llegue la
// conversación que ya tenías enseña «elige un objetivo»; al llegar, ese onboarding se
// quedaba encima tapando la libreta y el chat. Ahora se cierra solo.
test('el onboarding abierto por adelantarse a la conversación se cierra cuando esta llega', async ({ page }) => {
  await page.goto('/index.html');
  await page.evaluate(() => localStorage.setItem('bookreader_ai_key', JSON.stringify('sk-test')));
  await page.reload();
  await page.setInputFiles('#file-input', EPUB_PATH);
  await page.waitForFunction(() => !!document.querySelector('#toc-list a'), null, { timeout: 30000 });
  // Sin conversación aún: el agente abre el onboarding (por adelantarse).
  await page.evaluate(async () => { (await import('/js/ai/panel.js') as any).setOpen(true); });
  await expect(page.locator('#ai-onboarding')).toBeVisible();
  // La conversación «llega»: existe en la base y el panel carga las del libro, como hace
  // app.js al abrirlo (aquí, DESPUÉS de haber abierto el agente: la carrera).
  await page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    const Store: any = await import('/js/library/store.js');
    const ER: any = await import('/js/epub-reader.js');
    const panel: any = await import('/js/ai/panel.js');
    const books = await Store.getAllBooks();
    await DB.createConvo(books[0].id, 't1-extraccion', 'Entender Comala');
    await panel.setBook(ER.getBook(), books[0].id, ER.getTitle(), { author: ER.getAuthor() });
  });
  await expect(page.locator('#ai-onboarding')).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator('#ai-tabs')).toBeVisible();
});
