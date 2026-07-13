import { test, expect } from '@playwright/test';

// P11 · Tarjeta-cita: el renderizado a canvas produce un PNG válido, y shareQuote
// cae a descarga cuando el navegador no soporta Web Share de ficheros.

test.describe('P11 · tarjeta-cita', () => {
  test('buildQuoteCard genera un PNG 1080x1080 no vacío', async ({ page }) => {
    await page.goto('/');
    const res = await page.evaluate(async () => {
      const { buildQuoteCard } = await import('/js/share-card.js');
      const blob = await buildQuoteCard({
        quote: 'El cabo Lituma subió a los Andes buscando a los desaparecidos entre la niebla del páramo.',
        title: 'Lituma en los Andes',
        author: 'Mario Vargas Llosa',
      });
      const bmp = await createImageBitmap(blob);
      return { type: blob.type, size: blob.size, w: bmp.width, h: bmp.height };
    });
    expect(res.type).toBe('image/png');
    expect(res.size).toBeGreaterThan(2000);   // no es un canvas en blanco
    expect(res.w).toBe(1080);
    expect(res.h).toBe(1080);
  });

  test('cita muy larga no revienta (auto-ajuste de tamaño)', async ({ page }) => {
    await page.goto('/');
    const size = await page.evaluate(async () => {
      const { buildQuoteCard } = await import('/js/share-card.js');
      const quote = 'Lorem ipsum dolor sit amet '.repeat(60);
      const blob = await buildQuoteCard({ quote, title: 'Libro', author: '' });
      return blob.size;
    });
    expect(size).toBeGreaterThan(2000);
  });

  test('shareQuote sin Web Share de ficheros cae a descarga', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async () => {
      // Forzar el camino de descarga: sin canShare.
      // @ts-ignore
      navigator.canShare = undefined;
      const { shareQuote } = await import('/js/share-card.js');
      // Interceptar la descarga (el <a download> dispara una navegación a blob:).
      let downloaded = false;
      const origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { if (this.download) downloaded = true; };
      const r = await shareQuote({ quote: 'Una cita breve.', title: 'T', author: 'A' });
      HTMLAnchorElement.prototype.click = origClick;
      return { r, downloaded };
    });
    expect(result.r).toBe('downloaded');
    expect(result.downloaded).toBe(true);
  });
});
