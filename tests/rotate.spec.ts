import { test, expect } from '@playwright/test';
import path from 'path';

const EPUB_PATH = path.join(__dirname, 'test.epub');

// Helper: dimensions of the epub.js iframe vs its container.
async function dims(page) {
  return await page.evaluate(() => {
    const c = document.getElementById('epub-container')!;
    const f = c.querySelector('iframe');
    return {
      cw: c.clientWidth,
      ch: c.clientHeight,
      fw: f ? f.clientWidth : 0,
      fh: f ? f.clientHeight : 0,
    };
  });
}

test('epub re-paginates on rotation (no cut-off)', async ({ page }) => {
  // Empezamos en móvil vertical.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const fc = page.waitForEvent('filechooser');
  await page.click('#open-file-btn');
  await (await fc).setFiles(EPUB_PATH);

  // Esperar a que el iframe del libro exista y tenga tamaño.
  await page.waitForSelector('#epub-container iframe', { timeout: 15000 });
  await page.waitForFunction(() => {
    const f = document.querySelector('#epub-container iframe') as HTMLIFrameElement;
    return f && f.clientHeight > 100;
  });

  // Esperar al re-ajuste diferido tras mostrarse el footer.
  await page.waitForTimeout(400);
  const portrait = await dims(page);
  console.log('PORTRAIT', portrait);
  // En vertical, el iframe debe coincidir con el contenedor (no cortado).
  expect(Math.abs(portrait.fh - portrait.ch)).toBeLessThanOrEqual(4);
  expect(portrait.fw).toBeLessThanOrEqual(portrait.cw + 4);

  // Rotar a horizontal.
  await page.setViewportSize({ width: 844, height: 390 });
  // Esperar al debounce (150ms) + repaginado.
  await page.waitForTimeout(500);
  await page.waitForFunction((prevH) => {
    const f = document.querySelector('#epub-container iframe') as HTMLIFrameElement;
    return f && Math.abs(f.clientHeight - prevH) > 20; // la altura cambió tras rotar
  }, portrait.fh, { timeout: 5000 }).catch(() => {});

  const landscape = await dims(page);
  console.log('LANDSCAPE', landscape);
  // Tras rotar, el iframe debe haberse re-dimensionado a la nueva altura del contenedor.
  expect(Math.abs(landscape.fh - landscape.ch)).toBeLessThanOrEqual(4);
  expect(landscape.fw).toBeLessThanOrEqual(landscape.cw + 4);
  // Y la altura realmente cambió respecto al modo vertical.
  expect(landscape.fh).toBeLessThan(portrait.fh - 50);

  // En horizontal: UNA sola columna que aprovecha el ancho de la pantalla.
  // El contenedor debe llenar casi todo el viewport (no una columna estrecha
  // centrada) y la columna del contenido ocupa prácticamente todo el ancho.
  expect(landscape.cw).toBeGreaterThan(700); // llena los ~844 disponibles
  const colW = await page.evaluate(() => {
    const f = document.querySelector('#epub-container iframe') as HTMLIFrameElement;
    const body = f.contentDocument?.body;
    return body ? parseFloat(getComputedStyle(body).columnWidth) : 0;
  });
  console.log('LANDSCAPE columnWidth', colW);
  expect(colW).toBeGreaterThan(landscape.cw * 0.6); // una sola columna ancha

  // Volver a vertical y comprobar que también se re-ajusta.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  const portrait2 = await dims(page);
  console.log('PORTRAIT2', portrait2);
  expect(Math.abs(portrait2.fh - portrait2.ch)).toBeLessThanOrEqual(4);
});

// La posición de lectura NO se debe perder al girar (regresión histórica: al re-paginar,
// epub.js reporta el inicio de página y "caminaba hacia atrás" giro tras giro). Se fija
// un PIN al CFI real que dura hasta la próxima navegación del usuario.
test('rotation preserves reading position (no walk-back)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const fc = page.waitForEvent('filechooser');
  await page.click('#open-file-btn');
  await (await fc).setFiles(EPUB_PATH);
  await page.waitForSelector('#epub-container iframe', { timeout: 15000 });
  await page.waitForFunction(() => {
    const f = document.querySelector('#epub-container iframe') as HTMLIFrameElement;
    return f && f.clientHeight > 100;
  });
  await page.waitForTimeout(500);

  const cfi = () => page.evaluate(async () => (await import('/js/epub-reader.js')).getCurrentCfi());
  const next = async () => {
    await page.evaluate(async () => (await import('/js/epub-reader.js')).next());
    await page.waitForTimeout(300);
  };
  // Avanzar a una posición a mitad de párrafo (offset != 0, donde la deriva se manifiesta).
  for (let i = 0; i < 14; i++) await next();
  const before = await cfi();

  // Varias rotaciones seguidas.
  for (const [w, h] of [[844, 390], [390, 844], [844, 390], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(700);
  }
  expect(await cfi()).toBe(before);   // posición intacta tras 4 giros

  // Navegar tras girar debe AVANZAR (el pin se libera con next/prev/goTo). Cruzar un
  // límite de sección de spine puede requerir 2 pasos en epub.js (carga + avance), así
  // que probamos hasta dos: lo que se comprueba es que el pin NO congela la navegación.
  await next();
  if (await cfi() === before) await next();
  const advanced = await cfi();
  expect(advanced).not.toBe(before);

  // La nueva posición también se conserva al volver a girar.
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(700);
  expect(await cfi()).toBe(advanced);

  // Caso duro: un 'relocated' TARDÍO (el reflow que asienta en un móvil lento, pasado el
  // antiguo margen de 800 ms) NO debe mover la posición mientras el pin siga puesto.
  const afterLate = await page.evaluate(async () => {
    const R = await import('/js/epub-reader.js');
    R.getRendition().emit('relocated', { start: { cfi: 'epubcfi(/6/2!/4/1:0)' }, end: { cfi: 'epubcfi(/6/2!/4/1:0)' } });
    await new Promise(r => setTimeout(r, 100));
    return R.getCurrentCfi();
  });
  expect(afterLate).toBe(advanced);
});
