import { test, expect } from '@playwright/test';
import path from 'path';

const EPUB_PATH = path.join(__dirname, 'test.epub');

// El chat debe renderizar el Markdown EN VIVO durante el streaming (negritas, listas, tablas…),
// no mostrar texto crudo hasta el final. Aquí el stub emite un fragmento con **negrita**, hace una
// PAUSA a mitad y luego cierra; verificamos que el <strong> ya está pintado MIENTRAS el envío
// sigue ocupado (respuesta aún incompleta).
async function stubStreamWithPause(page) {
  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions') && opts?.body && JSON.parse(opts.body).stream) {
        const steps = [
          'data: {"choices":[{"delta":{"content":"**Idea clave**"},"finish_reason":null}]}\n\n',
          'PAUSE',
          'data: {"choices":[{"delta":{"content":" del capítulo."},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ];
        let i = 0;
        const s = new ReadableStream({
          async pull(c) {
            const e = new TextEncoder();
            const step = steps[i++];
            if (step === undefined) { c.close(); return; }
            if (step === 'PAUSE') { await new Promise((r) => setTimeout(r, 600)); return; }
            c.enqueue(e.encode(step));
          },
        });
        return new Response(s, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      // No-streaming (tools/atenuación): sin tool_calls.
      if (u.includes('/chat/completions')) return new Response(JSON.stringify({ choices: [{ message: { content: 'LISTO' } }] }), { status: 200 });
      return real(url, opts);
    };
  });
}

test('el Markdown se renderiza en vivo durante el streaming (no crudo hasta el final)', async ({ page }) => {
  await page.goto('/index.html');
  await page.evaluate((k) => localStorage.setItem('bookreader_ai_key', JSON.stringify(k)), 'test-key');
  await page.reload();
  await stubStreamWithPause(page);

  const fc = page.waitForEvent('filechooser');
  await page.click('#open-file-btn');
  await (await fc).setFiles(EPUB_PATH);
  await page.waitForSelector('#ai-toggle:not([disabled])', { timeout: 15000 });
  await page.click('#ai-toggle');
  await page.waitForSelector('.ai-onboarding', { timeout: 5000 });
  await page.click('.ai-ob-tpl[data-tpl="t3-juicio"]');
  await page.fill('#ai-ob-goal', 'probar el streaming');
  await page.click('#ai-ob-start');
  await expect(page.locator('#ai-status')).toContainText('Listo', { timeout: 30000 });

  // Pregunta con buen match léxico → va directa a streaming (sin fase agéntica).
  await page.fill('#ai-input', 'Comala Pedro Páramo madre padre pueblo muerte almas caballo');
  await page.click('#ai-send');

  // MIENTRAS sigue ocupado (respuesta incompleta), el fragmento ya debe estar FORMATEADO.
  await page.waitForFunction(() => {
    const bubbles = [...document.querySelectorAll('.ai-msg-assistant .ai-bubble-text')];
    const b = bubbles[bubbles.length - 1] as HTMLElement | undefined;
    const send = document.querySelector('#ai-send') as HTMLButtonElement | null;
    return !!b && b.innerHTML.includes('<strong>Idea clave</strong>') && !!send && send.disabled === true;
  }, { timeout: 5000 });

  // Y al terminar, la respuesta completa sigue formateada y el envío se rehabilita.
  await expect(page.locator('#ai-send')).toBeEnabled({ timeout: 5000 });
  const html = await page.evaluate(() => {
    const bubbles = [...document.querySelectorAll('.ai-msg-assistant .ai-bubble-text')];
    return (bubbles[bubbles.length - 1] as HTMLElement).innerHTML;
  });
  expect(html).toContain('<strong>Idea clave</strong>');
  expect(html).toContain('del capítulo.');
});
