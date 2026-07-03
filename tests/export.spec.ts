import { test, expect } from '@playwright/test';
import path from 'path';

const EPUB_PATH = path.join(__dirname, 'test.epub');

// P8 · Export legible y selectivo de UNA conversación (libreta + chat). Sembramos el store
// (convo + notas + mensajes + anclas) y verificamos el Markdown: incluye el chat, preserva el
// contenido de las notas y resuelve las citas [[aN]] a "(pág. N)".

test('buildConvoMarkdown: libreta + chat, formato y citas resueltas', async ({ page }) => {
  await page.goto('/index.html');

  const md = await page.evaluate(async () => {
    const DB = await import('/js/ai/db.js');
    const Backup = await import('/js/backup.js');
    const bookId = 'book-p8-test';

    // Anclas para resolver citas (como si el libro estuviera segmentado).
    await DB.saveSegmented(bookId, 'Libro P8', {
      annotatedText: '', tokenEstimate: 0, blockCount: 1,
      anchors: new Map([['a5', { page: 42, chapter: 'Cap 6' }]]),
    });

    const convo = await DB.createConvo(bookId, 't3-juicio', 'entender el capítulo 6', 'Mi sesión');
    await DB.addNote(convo.id, 'claim', 'La **tesis** central es X según [[a5]].');
    await DB.addMessage(convo.id, 'user', '¿Qué dice la Figure 6.2?');
    await DB.addMessage(convo.id, 'assistant', 'Explica el flujo, ver [[a5]].');

    return Backup.buildConvoMarkdown(convo.id, { includeChat: true, includeNotebook: true });
  });

  // Cabecera con objetivo.
  expect(md).toContain('entender el capítulo 6');
  // Libreta con la nota, preservando el markdown (negritas intactas).
  expect(md).toContain('## Libreta');
  expect(md).toContain('La **tesis** central es X');
  // Chat incluido con ambos roles y su contenido.
  expect(md).toContain('## Conversación');
  expect(md).toContain('🧑 Tú');
  expect(md).toContain('¿Qué dice la Figure 6.2?');
  expect(md).toContain('🤖 Agente');
  // Citas resueltas a pág.
  expect(md).toContain('(pág. 42)');
  expect(md).not.toContain('[[a5]]');
});

test('el botón de exportar del panel descarga un .md', async ({ page }) => {
  await page.goto('/index.html');
  await page.evaluate((k) => localStorage.setItem('bookreader_ai_key', JSON.stringify(k)), 'test-key');
  await page.reload();
  // Stub del LLM para completar el onboarding sin red.
  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions')) return new Response(JSON.stringify({ choices: [{ message: { content: 'LISTO' } }] }), { status: 200 });
      return real(url, opts);
    };
  });

  const fc = page.waitForEvent('filechooser');
  await page.click('#open-file-btn');
  await (await fc).setFiles(EPUB_PATH);
  await page.waitForSelector('#ai-toggle:not([disabled])', { timeout: 15000 });
  await page.click('#ai-toggle');
  await page.waitForSelector('.ai-onboarding', { timeout: 5000 });
  await page.click('.ai-ob-tpl[data-tpl="t3-juicio"]');
  await page.fill('#ai-ob-goal', 'objetivo de prueba');
  await page.click('#ai-ob-start');
  await expect(page.locator('#ai-convo-export')).toBeVisible({ timeout: 5000 });

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }),
    page.click('#ai-convo-export'),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.md$/);
});

test('buildConvoMarkdown: solo libreta (sin chat)', async ({ page }) => {
  await page.goto('/index.html');
  const md = await page.evaluate(async () => {
    const DB = await import('/js/ai/db.js');
    const Backup = await import('/js/backup.js');
    const convo = await DB.createConvo('book-p8-b', 't3-juicio', 'obj', 'S2');
    await DB.addNote(convo.id, 'claim', 'Nota A');
    await DB.addMessage(convo.id, 'user', 'mensaje que NO debe salir');
    return Backup.buildConvoMarkdown(convo.id, { includeChat: false, includeNotebook: true });
  });
  expect(md).toContain('Nota A');
  expect(md).not.toContain('## Conversación');
  expect(md).not.toContain('mensaje que NO debe salir');
});
