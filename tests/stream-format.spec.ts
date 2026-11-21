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
  await page.click('.lib-empty .lib-upload');
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

// Con un diagrama en la respuesta el chat SALTABA en cada línea nueva y no dejaba leer: cada trozo
// rehacía el HTML, el diagrama volvía un frame a su código (mucho más alto) antes de repintarse, y
// además el panel se forzaba al fondo aunque el lector hubiera subido. Ahora: caja fija mientras el
// bloque no se ha cerrado, diagrama dibujado estable en cada frame, y sin arrastrar al que lee arriba.
test('con un diagrama en streaming el chat no salta ni arrastra al que lee arriba', async ({ page }) => {
  await page.goto('/index.html');
  await page.evaluate((k) => localStorage.setItem('bookreader_ai_key', JSON.stringify(k)), 'test-key');
  await page.reload();
  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    const intro = Array.from({ length: 30 }, (_, i) => `Línea de introducción número ${i + 1}.\n\n`);
    const diagram = ['```mermaid\n', 'sequenceDiagram\n', '  App->>SO: write()\n', '  SO->>Red: paquete\n', '  Red-->>App: ACK\n', '```\n\n'];
    const tail = Array.from({ length: 40 }, (_, i) => `Línea posterior número ${i + 1}.\n\n`);
    const chunks = [...intro, ...diagram, 'PAUSE', ...tail];
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions') && opts?.body && JSON.parse(opts.body).stream) {
        let i = 0;
        const s = new ReadableStream({
          async pull(c) {
            const e = new TextEncoder();
            if (i > chunks.length) { c.close(); return; }
            const ch = chunks[i++];
            if (ch === undefined) {
              c.enqueue(e.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
              return;
            }
            // Pausa larga tras cerrar el bloque (Mermaid se baja y dibuja). Cada pull encola
            // algo: un pull que vuelve sin encolar puede no repetirse.
            await new Promise((r) => setTimeout(r, ch === 'PAUSE' ? 1500 : 60));
            if (ch === 'PAUSE') { c.enqueue(e.encode(': pausa\n\n')); return; }
            c.enqueue(e.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: ch }, finish_reason: null }] }) + '\n\n'));
          },
        });
        return new Response(s, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (u.includes('/chat/completions')) return new Response(JSON.stringify({ choices: [{ message: { content: 'LISTO' } }] }), { status: 200 });
      return real(url, opts);
    };
  });

  const fc = page.waitForEvent('filechooser');
  await page.click('.lib-empty .lib-upload');
  await (await fc).setFiles(EPUB_PATH);
  await page.waitForSelector('#ai-toggle:not([disabled])', { timeout: 15000 });
  await page.click('#ai-toggle');
  await page.waitForSelector('.ai-onboarding', { timeout: 5000 });
  await page.click('.ai-ob-tpl[data-tpl="t3-juicio"]');
  await page.fill('#ai-ob-goal', 'probar el streaming');
  await page.click('#ai-ob-start');
  await expect(page.locator('#ai-status')).toContainText('Listo', { timeout: 30000 });

  // Muestreo por frame: el diagrama, una vez dibujado, no vuelve nunca a su código.
  await page.evaluate(() => {
    (window as any).__regressed = 0; (window as any).__drawing = 0; (window as any).__rawFence = 0;
    let svgSeen = false;
    const tick = () => {
      const b = [...document.querySelectorAll('.ai-msg-assistant .ai-bubble-text')].pop() as HTMLElement | undefined;
      if (b) {
        const f = b.querySelector('.ai-diagram:not(.ai-diagram--drawing)');
        if (f?.querySelector('svg')) svgSeen = true;
        else if (svgSeen && f) (window as any).__regressed++;
        if (b.querySelector('.ai-diagram--drawing')) (window as any).__drawing++;
        if (/sequenceDiagram/.test(b.textContent || '') && !f) (window as any).__rawFence++;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  await page.fill('#ai-input', 'Comala Pedro Páramo madre padre pueblo muerte almas caballo');
  await page.click('#ai-send');

  // Dibujado el diagrama, el lector sube a leer: el resto de la respuesta no lo baja.
  await page.waitForSelector('.ai-msg-assistant .ai-diagram svg', { timeout: 20000 });
  await page.evaluate(() => { (document.querySelector('#ai-messages') as HTMLElement).scrollTop = 0; });
  // …y siguen llegando líneas mientras está arriba.
  await page.waitForFunction(() => /Línea posterior número 15\./.test(
    ([...document.querySelectorAll('.ai-msg-assistant .ai-bubble-text')].pop() as HTMLElement | undefined)?.textContent || ''),
  null, { timeout: 20000 });
  const top = await page.evaluate(() => (document.querySelector('#ai-messages') as HTMLElement).scrollTop);
  expect(top).toBe(0);

  await expect(page.locator('#ai-send')).toBeEnabled({ timeout: 20000 });
  const r = await page.evaluate(() => ({ regressed: (window as any).__regressed, drawing: (window as any).__drawing, raw: (window as any).__rawFence }));
  expect(r.drawing).toBeGreaterThan(0);    // se vio la caja fija mientras el bloque estaba abierto
  expect(r.raw).toBe(0);                   // nunca el código Mermaid suelto como texto
  expect(r.regressed).toBe(0);             // ni el diagrama volviendo a su código
});
