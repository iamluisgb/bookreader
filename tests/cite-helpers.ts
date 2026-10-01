import { expect, Page } from '@playwright/test';
import path from 'path';

// Andamiaje compartido de los tests de CITAS del agente en PDF (pdf-agent-cite y
// pdf-cite-restore). Las esperas son por SEÑAL, no por tiempo: bajo carga, los flaky
// venían de enviar mientras el turno de onboarding seguía en vuelo (send() retorna en
// silencio con el guard de `busy`) y de asumir que el libro ya estaba segmentado.
export const PDF = path.join(__dirname, 'test-multipage.pdf');

export const pagina = (page: Page) =>
  page.evaluate(async () => (await import('/js/pdf-reader.js') as any).getCurrentPage());

// chat/completions stubbeado: a la pregunta del test le llega la respuesta que cita [[a5]].
export async function stubChat(page: Page) {
  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions') && opts?.body) {
        const body = JSON.parse(opts.body);
        const out = /respond/i.test(String(body.messages?.at(-1)?.content || ''))
          ? 'El dato está aquí. [[a5]]'
          : 'Listo.';
        const chunks = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: out }, finish_reason: null }] })}\n\n`,
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ];
        const s = new ReadableStream({ start(c) { const e = new TextEncoder(); chunks.forEach(x => c.enqueue(e.encode(x))); c.close(); } });
        return new Response(s, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return real(url, opts);
    };
  });
}

// Sube el PDF, abre el panel, completa el onboarding y espera a que el libro esté indexado.
export async function abrirPdfConAgente(page: Page) {
  const fc = page.waitForEvent('filechooser');
  await page.click('.lib-empty .lib-upload');
  await (await fc).setFiles(PDF);
  await page.waitForSelector('#ai-toggle:not([disabled])', { timeout: 15000 });
  await page.click('#ai-toggle');
  await page.waitForSelector('.ai-onboarding', { timeout: 5000 });
  await page.click('.ai-ob-tpl[data-tpl="hqa"]');
  await page.fill('#ai-ob-goal', 'entender el documento');
  await page.click('#ai-ob-start');
  await expect(page.locator('#ai-status')).toContainText('Listo', { timeout: 30000 });
}

// Pregunta y devuelve el chip, esperando señales reales: botón habilitado (turno previo
// terminado), burbuja del usuario (el envío se aceptó) y la cita renderizada.
export async function preguntarYEsperarCita(page: Page) {
  await expect(page.locator('#ai-send')).toBeEnabled({ timeout: 20000 });
  await page.fill('#ai-input', 'respond: donde está el dato');
  await page.click('#ai-send');
  await expect(page.locator('.ai-msg-user').last()).toContainText('respond');
  const cite = page.locator('.ai-cite').first();
  await expect(cite).toContainText('pág. 2', { timeout: 20000 });
  return cite;
}

export async function irAPagina(page: Page, n: number) {
  await page.evaluate(async (p) => { await (await import('/js/pdf-reader.js') as any).goTo(p); }, n);
  await expect.poll(() => pagina(page), { timeout: 10000 }).toBe(n);
}
