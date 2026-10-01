import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { seedProLicense } from './pro-license';

// Regresión de la CITA del agente en un PDF: el camino REAL de un click del usuario —
// pregunta → respuesta con [[aN]] → click en el chip .ai-cite → navigateCite →
// goToLocator → PdfReader.goTo(a.page) — debe aterrizar en la página del pasaje. Hasta
// ahora solo pdf-cite-highlight.spec probaba Pdf.goTo directo, sin el click.
const PDF = path.join(__dirname, 'test-multipage.pdf');

const pagina = (page: Page) =>
  page.evaluate(async () => (await import('/js/pdf-reader.js') as any).getCurrentPage());

// chat/completions stubbeado: a la pregunta del test le llega la respuesta que cita [[a5]].
async function stubChat(page: Page) {
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
async function abrirPdfConAgente(page: Page) {
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

// Pregunta y devuelve el chip. Espera el botón HABILITADO: si el turno de onboarding
// siguiera en vuelo, send() retorna en silencio (guard de `busy`) y el test esperaría un
// chip que nunca llega — la causa real de los flakes bajo carga.
async function preguntarYEsperarCita(page: Page) {
  await expect(page.locator('#ai-send')).toBeEnabled({ timeout: 20000 });
  await page.fill('#ai-input', 'respond: donde está el dato');
  await page.click('#ai-send');
  await expect(page.locator('.ai-msg-user').last()).toContainText('respond');
  const cite = page.locator('.ai-cite').first();
  await expect(cite).toContainText('pág. 2', { timeout: 20000 });
  return cite;
}

async function irAPagina(page: Page, n: number) {
  await page.evaluate(async (p) => { await (await import('/js/pdf-reader.js') as any).goTo(p); }, n);
  await expect.poll(() => pagina(page), { timeout: 10000 }).toBe(n);
}

test('repro: cita del agente en PDF navega a la página del pasaje', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await page.evaluate((k) => localStorage.setItem('bookreader_ai_key', JSON.stringify(k)), 'test-key');
  await page.reload();
  await stubChat(page);
  await abrirPdfConAgente(page);

  // El PDF abre en la página 1: anotamos la página del pasaje a5 según el corpus real.
  const anchorPage = await page.evaluate(async () => {
    const Pdf: any = await import('/js/pdf-reader.js');
    const Seg: any = await import('/js/ai/segment-pdf.js');
    const seg = await Seg.segmentPdf(Pdf.getDocument());
    return { total: seg.pages, page5: seg.anchors.get('a5')?.page };
  });
  expect(anchorPage.page5).toBeGreaterThan(1);

  const cite = await preguntarYEsperarCita(page);

  // El chip se pulsa con el panel abierto (gesto real: cerrarlo lo deja fuera del
  // viewport) y desde la página 1, para que el salto sea real y no un no-op.
  await irAPagina(page, 1);
  await cite.click();
  await expect.poll(() => pagina(page), { timeout: 10000 }).toBe(anchorPage.page5);
});

// Regresión (emulador Android real, 2026): chip de cita en modo SCROLL volvía a la
// página 1. Causa: boundingRect leía r.y/r.h pero fractionalFromRects produce
// {left, top, width, height} → Math.min(undefined...) = NaN → revealRegion hacía
// scrollTo({top: NaN}) = volver al tope. En paginado era invisible (scrollTop ya
// estaba en 0) y por eso el test anterior no lo veía. Aquí, el camino completo en
// scroll: el click del chip debe aterrizar en la página citada Y PERMANECER en ella
// tras asentarse el scroll suave.
test('cita del agente en PDF modo scroll aterriza y permanece en la página citada', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await page.evaluate((k) => localStorage.setItem('bookreader_ai_key', JSON.stringify(k)), 'test-key');
  await page.reload();
  await stubChat(page);
  await abrirPdfConAgente(page);

  const anchorPage = await page.evaluate(async () => {
    const Pdf: any = await import('/js/pdf-reader.js');
    const Seg: any = await import('/js/ai/segment-pdf.js');
    const seg = await Seg.segmentPdf(Pdf.getDocument());
    return { page5: seg.anchors.get('a5')?.page };
  });
  expect(anchorPage.page5).toBeGreaterThan(1);

  const cite = await preguntarYEsperarCita(page);

  // Con el libro ya cargado sí persiste: cambiar a scroll POR LIBRO antes del click
  // (el camino del bug real en móvil era el lector en scroll).
  await page.evaluate(async () => { const m = await import('/js/pdf-reader.js'); await m.setReadingMode('scroll'); });
  await expect.poll(async () => page.evaluate(async () => (await import('/js/pdf-reader.js')).getReadingMode())).toBe('scroll');

  await irAPagina(page, 1);
  await cite.click();
  await expect.poll(() => pagina(page), { timeout: 10000 }).toBe(anchorPage.page5);
  // Y PERMANECE: sin el fix, el scroll suave a NaN→0 derivaba a la página 1 en ~500ms.
  await page.waitForTimeout(1500);
  expect(await pagina(page)).toBe(anchorPage.page5);
});
