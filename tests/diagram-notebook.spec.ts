import { test, expect, Page } from '@playwright/test';
import path from 'path';

// Diagramas a la libreta. «A la libreta» resume la respuesta con la IA, y un diagrama
// resumido se pierde: ahora el diagrama se guarda ÍNTEGRO (su bloque Mermaid) y la libreta
// lo vuelve a dibujar. Además cada diagrama del chat tiene su propio «A la libreta».
const EPUB_PATH = path.join(__dirname, 'test.epub');
const DIAGRAM = ['```mermaid', 'flowchart TD', '  A[App escribe socket] --> B[Buffer del SO]', '  B --> C{Cola en router}', '  C -- Llena --> D[Descarte]', '```'].join('\n');
const ANSWER = `Aquí va el recorrido de una petición:\n\n${DIAGRAM}\n\nEl cuello de botella es la cola.`;

// Modelo simulado: el chat responde con el diagrama; el extractor de «A la libreta» guarda
// una nota de texto (y, como pide su prompt, sin copiar el diagrama).
async function stubModel(page: Page, fieldKey: () => string) {
  const extractorPrompts: string[] = [];
  await page.route('**/chat/completions', (route) => {
    const req = JSON.parse(route.request().postData() || '{}');
    const sys = req.messages?.[0]?.content || '';
    if (/extractor de notas/.test(sys)) {
      extractorPrompts.push(sys);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function',
          function: { name: 'upsert_note', arguments: JSON.stringify({ fieldKey: fieldKey(), content: 'La cola del router es el cuello de botella.' }) } }] }, finish_reason: 'tool_calls' }],
      }) });
    }
    const body = 'data: ' + JSON.stringify({ choices: [{ delta: { content: ANSWER }, finish_reason: null }] }) + '\n\ndata: [DONE]\n\n';
    return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body });
  });
  return extractorPrompts;
}

async function openWithConvo(page: Page) {
  await page.addInitScript(() => localStorage.setItem('bookreader_ai_auto_extract', 'false'));
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
    await DB.createConvo(books[0].id, 't1-extraccion', 'Entender TCP');
  });
  await page.reload();
  const cover = page.locator('.lib-cover').first();
  const reader = page.locator('#epub-container iframe');
  await expect(cover.or(reader)).toBeVisible({ timeout: 30000 });
  if (await cover.isVisible()) await cover.click();
  await page.waitForFunction(() => { const tabs = document.getElementById('ai-tabs'); return !!tabs && getComputedStyle(tabs).display !== 'none'; }, null, { timeout: 30000 });
  await page.evaluate(async () => { (await import('/js/ai/panel.js') as any).setOpen(true); });
  await expect(page.locator('#ai-status')).toContainText('Listo', { timeout: 30000 });
  // Campo de información de la plantilla (el extractor simulado escribe ahí).
  return page.evaluate(async () => {
    const T: any = await import('/js/ai/templates.js');
    return T.aiWritableFields(T.getTemplate('t1-extraccion')).find((f: any) => !T.isCognitionField(f)).key;
  });
}

async function askForDiagram(page: Page) {
  await page.locator('.ai-tab[data-view="chat"]').click();
  await page.fill('#ai-input', 'Explícame con un diagrama las limitaciones de TCP');
  await page.locator('#ai-send').click();
  const fig = page.locator('#ai-messages .ai-msg-assistant .ai-diagram').last();
  await expect(fig.locator(':scope > svg')).toBeVisible({ timeout: 30000 });
  return fig;
}

test('el diagrama del chat va a la libreta entero, y allí se dibuja', async ({ page }) => {
  let key = '';
  await stubModel(page, () => key);
  key = await openWithConvo(page);
  const fig = await askForDiagram(page);

  const btn = fig.locator('[data-dg-act="notebook"]');
  await btn.click();
  await expect(btn).toContainText('En la libreta');
  await page.locator('.ai-tab[data-view="notebook"]').click();
  const note = page.locator('#ai-view-notebook .ai-nb-note-text').filter({ has: page.locator('.ai-diagram') });
  await expect(note).toHaveCount(1);
  await expect(note.locator('.ai-diagram > svg')).toBeVisible({ timeout: 20000 });
  await expect(note).toContainText('Explícame con un diagrama');      // la pregunta como título
  // En la libreta: compartir sí, «A la libreta» no (ya está).
  await expect(note.locator('[data-dg-act="notebook"]')).toHaveCount(0);
  await expect(note.locator('[data-dg-act="png"]')).toHaveCount(1);

  // Exportar a Markdown: el diagrama viaja como bloque ```mermaid intacto (Obsidian, GitHub
  // o Notion lo dibujan), aunque un nodo se llame como una cita (`a1`).
  const md = await page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    const Store: any = await import('/js/library/store.js');
    const Backup: any = await import('/js/backup.js');
    const [book] = await Store.getAllBooks();
    const [convo] = await DB.getConvos(book.id);
    await DB.addNote(convo.id, (await DB.getNotes(convo.id))[0].fieldKey, '```mermaid\nflowchart TD\n  a1[Origen] --> a2[Destino]\n```', []);
    return Backup.buildConvoMarkdown(convo.id, { includeChat: false, includeNotebook: true });
  });
  expect(md).toContain('```mermaid\nflowchart TD\n  A[App escribe socket]');
  expect(md).toContain('a1[Origen] --> a2[Destino]');

  // Hecho: el botón se queda en «En la libreta» y no se puede duplicar.
  await page.locator('.ai-tab[data-view="chat"]').click();
  await expect(btn).toBeDisabled();
});

test('«A la libreta» de la respuesta: la IA resume el texto y el diagrama se guarda íntegro', async ({ page }) => {
  let key = '';
  const prompts = await stubModel(page, () => key);
  key = await openWithConvo(page);
  const fig = await askForDiagram(page);
  const msg = fig.locator('xpath=ancestor::div[contains(@class,"ai-msg")][1]');
  await msg.locator('.ai-extract').click();
  await expect(msg.locator('.ai-extract')).toContainText('2 a la libreta', { timeout: 20000 });
  expect(prompts[0]).toContain('No copies los bloques');
  const contents = await page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    const convos = await DB.getAllConvos?.() || [];
    void convos;
    return [...document.querySelectorAll('#ai-view-notebook .ai-nb-note-text')].map(n => n.textContent || '');
  });
  expect(contents.some(c => c.includes('cuello de botella'))).toBe(true);
  await expect(page.locator('#ai-view-notebook .ai-nb-note-text .ai-diagram > svg')).toBeVisible({ timeout: 20000 });
});

test('compartir: la imagen sale en claro, con firma, y el código como bloque mermaid', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/index.html');
  // Tema oscuro activo: la imagen debe salir clara igualmente.
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  const r = await page.evaluate(async (code) => {
    const D: any = await import('/js/ai/diagram.js');
    window.dispatchEvent(new CustomEvent('book:meta', { detail: { title: 'Redes de computadoras' } }));
    const blob: Blob = await D.diagramPng(code);
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d')!; ctx.drawImage(bmp, 0, 0);
    const corner = [...ctx.getImageData(4, 4, 1, 1).data];
    return { type: blob.type, w: bmp.width, h: bmp.height, corner };
  }, DIAGRAM.split('\n').slice(1, -1).join('\n'));
  expect(r.type).toBe('image/png');
  expect(r.corner.slice(0, 3)).toEqual([255, 255, 255]);          // fondo claro
  expect(r.w).toBeGreaterThanOrEqual(1040);                        // doble resolución

  // Los botones, sobre un diagrama del chat.
  await page.evaluate(async (md) => {
    const R: any = await import('/js/ai/render.js');
    const box = document.createElement('div'); box.id = 'ai-messages';
    box.innerHTML = `<div class="ai-msg ai-msg-assistant">${R.renderWithCitations(md, new Map())}</div>`;
    document.body.appendChild(box);
  }, DIAGRAM);
  const fig = page.locator('#ai-messages .ai-diagram');
  await expect(fig.locator(':scope > svg')).toBeVisible({ timeout: 20000 });
  await fig.locator('[data-dg-act="code"]').click();
  await expect(fig.locator('[data-dg-act="code"]')).toContainText('Copiado');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(DIAGRAM);
  await fig.locator('[data-dg-act="png"]').click();
  await expect(fig.locator('[data-dg-act="png"]')).toContainText(/Imagen copiada|Descargado/);
});
