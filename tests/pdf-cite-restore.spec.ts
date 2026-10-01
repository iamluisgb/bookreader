import { test, expect, Page } from '@playwright/test';
import { seedProLicense } from './pro-license';
import { stubChat, abrirPdfConAgente, preguntarYEsperarCita, irAPagina, pagina } from './cite-helpers';

// Regresión de la CITA del agente en un PDF: el camino REAL de un click del usuario —
// pregunta → respuesta con [[aN]] → click en el chip .ai-cite → navigateCite →
// goToLocator → PdfReader.goTo(a.page) — debe aterrizar en la página del pasaje. Hasta
// ahora solo pdf-cite-highlight.spec probaba Pdf.goTo directo, sin el click.

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

// Las citas de una conversación RESTAURADA. Al abrir el panel, activateConvo() →
// restoreChat() pinta los mensajes guardados ANTES de que prepareBook() segmente el libro
// y llene `anchors`. renderWithCitations() con el mapa vacío no genera chips y
// citeReplace() descarta los `[[aN]]`: las respuestas viejas quedaban sin citas
// clicables (visto en el emulador Android al recargar la app). Este test recarga la
// página —el libro y la conversación vuelven solos de IndexedDB— y exige que el chip
// reaparezca y siga navegando.
test('una conversación restaurada conserva sus chips de cita', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await page.evaluate((k) => localStorage.setItem('bookreader_ai_key', JSON.stringify(k)), 'test-key');
  await page.reload();
  await stubChat(page);
  await abrirPdfConAgente(page);

  const cite = await preguntarYEsperarCita(page);

  await page.reload();
  await page.waitForSelector('#pdf-container .pdf-page canvas', { timeout: 20000 });
  await page.waitForSelector('#ai-toggle:not([disabled])', { timeout: 20000 });
  // Espera ORDENADA a que el libro esté segmentado: el repintado de citas (repaintCites)
  // corre justo ahí. Sin esto se competía con la segmentación y el chip podía tardar de
  // más bajo carga.
  await expect(page.locator('#ai-status')).toContainText('Listo', { timeout: 30000 });
  await page.click('#ai-toggle');

  const restaurado = page.locator('.ai-cite').first();
  await expect(restaurado).toContainText('pág. 2', { timeout: 20000 });
  await expect(page.locator('.ai-cite')).toHaveCount(1);

  // Y navega: el chip restaurado no es decorativo.
  await irAPagina(page, 1);
  await restaurado.click();
  await expect.poll(() => pagina(page), { timeout: 10000 }).toBe(2);
});
