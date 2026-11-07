import { test, expect } from '@playwright/test';
import path from 'path';

// IA16 · En nan el tope de salida incluye el razonamiento. Si el modelo razona hasta agotarlo, la
// respuesta llega VACÍA con finish_reason «length»: el chat repite una vez sin razonamiento en vez de
// dejar una burbuja en blanco. Y las respuestas del chat piden un tope holgado (CHAT_MAX_TOKENS).
const EPUB_PATH = path.join(__dirname, 'test.epub');

test('respuesta vacía por el tope: se repite sin razonar y la burbuja no queda en blanco', async ({ page }) => {
  await page.goto('/index.html');
  await page.evaluate(() => {
    localStorage.setItem('bookreader_ai_key', JSON.stringify('test-key'));
    localStorage.setItem('bookreader_flashcards_hint_seen', 'true');
  });
  await page.reload();
  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    const log: any[] = [];
    (window as any).__answers = log;
    const sse = (chunks: any[]) => {
      const e = new TextEncoder();
      const s = new ReadableStream({ start(c) { chunks.forEach(x => c.enqueue(e.encode(`data: ${JSON.stringify(x)}\n\n`))); c.enqueue(e.encode('data: [DONE]\n\n')); c.close(); } });
      return new Response(s, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (!(u.includes('/chat/completions') && opts?.body)) return real(url, opts);
      const body = JSON.parse(opts.body);
      const sys = (body.messages || []).find((m: any) => m.role === 'system')?.content || '';
      if (!body.stream) return new Response(JSON.stringify({ choices: [{ message: { content: 'LISTO' } }] }), { status: 200 });
      if (/BÚSQUEDA por palabras clave/i.test(sys)) return sse([{ choices: [{ delta: { content: '{"terms":["Comala"],"hypothetical":"x"}' } }] }]);
      const isAnswer = (body.messages || []).some((m: any) => /^EXTRACTO DEL LIBRO/.test(m.content || ''));
      if (!isAnswer) return sse([{ choices: [{ delta: { content: 'ok' } }] }]);
      log.push({ max_tokens: body.max_tokens, thinking: body.thinking || null });
      // 1.ª: todo se fue en razonar → sin contenido y cortada. 2.ª: responde.
      if (log.length === 1) return sse([{ choices: [{ delta: { reasoning_content: 'pienso…' } }] }, { choices: [{ delta: {}, finish_reason: 'length' }] }]);
      return sse([{ choices: [{ delta: { content: 'Respuesta tras repetir.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    };
  });

  const fc = page.waitForEvent('filechooser');
  await page.click('.lib-empty .lib-upload');
  await (await fc).setFiles(EPUB_PATH);
  await page.waitForSelector('#ai-toggle:not([disabled])', { timeout: 15000 });
  await page.click('#ai-toggle');
  await page.waitForSelector('.ai-onboarding', { timeout: 5000 });
  await page.click('.ai-ob-quickchat');
  await expect(page.locator('#ai-status')).toContainText('Listo', { timeout: 30000 });

  await page.fill('#ai-input', '¿qué sensación transmite el pueblo y por qué?');
  await page.click('#ai-send');
  const last = page.locator('.ai-msg-assistant').last();
  await expect(last.locator('.ai-bubble-text')).toContainText('Respuesta tras repetir', { timeout: 15000 });
  await expect(last.locator('.ai-continue')).toHaveCount(0);   // ya no está cortada: sin «Continuar»

  const calls = await page.evaluate(() => (window as any).__answers);
  expect(calls).toHaveLength(2);                 // una repetición, no un bucle
  expect(calls[0].max_tokens).toBe(16384);       // tope holgado del chat
  expect(calls[1].max_tokens).toBe(16384);
});
