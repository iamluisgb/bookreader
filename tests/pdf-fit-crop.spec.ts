import { test, expect } from '@playwright/test';
import path from 'path';

// ADR-033 · "Ajustar al texto": el zoom mínimo del lector era "página entera, márgenes
// incluidos", así que para que la mancha llenara la pantalla había que ampliar — y ampliar
// saca scroll horizontal, que es lo que descolocaba la columna al leer. El recorte hace que
// la unidad de ajuste sea la mancha y no el papel, y con eso el eje X desaparece solo.
//
// Lo que se fija aquí es el CONTRATO geométrico, que es donde puede romperse en silencio:
//   1. con recorte no hay scroll horizontal (el objetivo entero),
//   2. la caja se estrecha pero el contenido no se deforma (misma escala en los dos ejes),
//   3. los subrayados se guardan en fracciones de PÁGINA COMPLETA y siguen sobre el mismo
//      texto al quitar el recorte (si no, cambiar de ajuste movería los subrayados).

const PDF = path.join(__dirname, 'test-multipage.pdf');

async function abrir(page) {
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', PDF);
  await page.waitForSelector('#pdf-container .pdf-page canvas', { timeout: 20000 });
}

// El selector vive en los ajustes de lectura (engranaje de la cabecera del sidebar, cerrado
// al arrancar), igual que el de modo de lectura.
async function abrirAjustes(page) {
  await page.click('#sidebar-toggle');
  await page.click('#reading-settings');
  await page.waitForSelector('.pdf-fit-btn[data-fit="text"]', { state: 'visible' });
}

// Espera a que el layout refleje el recorte pedido (rerender + re-rasterizado).
function esperarRecorte(page, recortado: boolean) {
  return page.waitForFunction((r) => {
    const w = document.querySelector('#pdf-container .pdf-page') as HTMLElement;
    if (!w) return false;
    const cw = parseFloat(w.dataset.cropw || '1');
    return r ? cw < 1 : cw === 1;
  }, recortado, { timeout: 20000 });
}

// Geometría de la primera página, medida en el DOM real.
function medir(page) {
  return page.evaluate(() => {
    const c = document.querySelector('#pdf-container') as HTMLElement;
    const w = document.querySelector('#pdf-container .pdf-page') as HTMLElement;
    const s = w.querySelector('.pdf-scaler') as HTMLElement;
    const cv = w.querySelector('canvas') as HTMLCanvasElement;
    return {
      caja: w.getBoundingClientRect().width,
      alto: w.getBoundingClientRect().height,
      contenido: parseFloat(s.style.width),          // la página entera, en unidades fit
      canvasAlto: parseFloat(cv.style.height),
      cropw: parseFloat(w.dataset.cropw || '1'),
      cropx: parseFloat(w.dataset.cropx || '0'),
      scrollX: c.scrollWidth - c.clientWidth,
      dispo: c.clientWidth,
    };
  });
}

test('«Texto» recorta los márgenes y deja el ancho sin scroll horizontal', async ({ page }) => {
  await abrir(page);
  const antes = await medir(page);
  expect(antes.cropw).toBe(1);                       // por defecto se ajusta al papel

  await abrirAjustes(page);
  await page.click('.pdf-fit-btn[data-fit="text"]');
  await expect(page.locator('.pdf-fit-btn[data-fit="text"]')).toHaveClass(/active/);
  await esperarRecorte(page, true);

  const dsp = await medir(page);
  // El recorte quita márgenes de verdad, pero nunca más de la mitad del ancho (red de
  // seguridad de computeCrop: una tabla ancha tiene que seguir viéndose).
  expect(dsp.cropw).toBeLessThan(0.98);
  expect(dsp.cropw).toBeGreaterThanOrEqual(0.5);
  // EL OBJETIVO: la mancha llena el ancho y el eje X ya no tiene recorrido.
  expect(dsp.scrollX).toBeLessThanOrEqual(1);
  expect(dsp.caja).toBeGreaterThan(antes.caja * 0.98);   // llena al menos tanto como antes
  expect(dsp.caja).toBeLessThanOrEqual(dsp.dispo + 1);
  // La caja es una VENTANA sobre la página, no una página estrujada: el contenido sigue
  // midiendo más que la caja, y la letra creció en los DOS ejes por igual (sin deformar).
  expect(dsp.contenido).toBeGreaterThan(dsp.caja);
  expect(dsp.canvasAlto / antes.canvasAlto).toBeCloseTo(dsp.alto / antes.alto, 2);
});

test('el recorte se recuerda por libro y se reaplica al reabrirlo', async ({ page }) => {
  await abrir(page);
  await abrirAjustes(page);
  await page.click('.pdf-fit-btn[data-fit="text"]');
  await esperarRecorte(page, true);

  const guardado = await page.evaluate(async () => {
    const S: any = await import('/js/storage.js');
    return Object.keys(localStorage)
      .filter(k => k.startsWith('bookreader_pdfFit_'))
      .map(k => S.get(k.replace('bookreader_', '')));
  });
  expect(guardado).toContain('text');

  await page.reload();
  await page.waitForSelector('#pdf-container .pdf-page canvas', { timeout: 20000 });
  const tras = await medir(page);
  expect(tras.cropw).toBeLessThan(0.98);
  expect(tras.scrollX).toBeLessThanOrEqual(1);
  await abrirAjustes(page);
  await expect(page.locator('.pdf-fit-btn[data-fit="text"]')).toHaveClass(/active/);
});

test('un subrayado hecho con recorte no se mueve al quitar el recorte', async ({ page }) => {
  await abrir(page);
  await abrirAjustes(page);
  await page.click('.pdf-fit-btn[data-fit="text"]');
  await esperarRecorte(page, true);
  await page.waitForSelector('#pdf-container .pdf-page .textLayer span', { timeout: 20000 });

  // Subrayado sobre un trozo REAL de la capa de texto, capturado por el mismo camino que la
  // selección del usuario (fractionalFromRects), y su posición en pantalla con recorte.
  const conRecorte = await page.evaluate(async () => {
    const HL: any = await import('/js/highlights-ui.js');
    const w = document.querySelector('#pdf-container .pdf-page') as HTMLElement;
    const span = w.querySelector('.textLayer span');
    if (!span) return null;
    const range = document.createRange();
    range.selectNodeContents(span);
    const rects = HL.pdfFractionalRects(range, w);      // se guardan en fracciones de página
    const pant = span.getBoundingClientRect();
    const caja = w.getBoundingClientRect();
    return {
      rects,
      xRel: (pant.left - caja.left) / caja.width,        // dónde está de verdad, en la caja
      pintado: HL.pdfRectToBox(w, rects[0]).left,        // dónde lo pintaría el overlay
      cropx: parseFloat(w.dataset.cropx || '0'),
      texto: span.textContent,
    };
  });
  expect(conRecorte).not.toBeNull();
  expect(conRecorte!.rects.length).toBeGreaterThan(0);
  // Con recorte, guardar y volver a pintar tiene que ser la identidad sobre la pantalla.
  expect(conRecorte!.pintado).toBeCloseTo(conRecorte!.xRel, 2);
  // Y lo guardado NO es la fracción de la caja: lleva sumado el margen recortado.
  expect(conRecorte!.rects[0].left).toBeGreaterThan(conRecorte!.cropx - 0.001);

  await page.click('.pdf-fit-btn[data-fit="page"]');
  await esperarRecorte(page, false);
  await page.waitForSelector('#pdf-container .pdf-page .textLayer span', { timeout: 20000 });

  // Las fracciones guardadas son de página COMPLETA: sin recorte, el mismo rect tiene que
  // caer sobre el mismo texto. Se compara contra dónde está AHORA ese span en la caja.
  const sinRecorte = await page.evaluate(async (rects) => {
    const HL: any = await import('/js/highlights-ui.js');
    const w = document.querySelector('#pdf-container .pdf-page') as HTMLElement;
    const span = w.querySelector('.textLayer span');
    const pant = span!.getBoundingClientRect();
    const caja = w.getBoundingClientRect();
    return {
      caja: HL.pdfRectToBox(w, rects[0]),
      xRel: (pant.left - caja.left) / caja.width,
      texto: span!.textContent,
    };
  }, conRecorte!.rects);

  expect(sinRecorte.texto).toBe(conRecorte!.texto);      // el mismo trozo de texto
  // Sin recorte, la fracción de caja ES la de página: el rect guardado con recorte cae
  // sobre el mismo span. Antes de mapear por cropx/cropw, se iba justo lo recortado.
  expect(sinRecorte.caja.left).toBeCloseTo(sinRecorte.xRel, 2);
  // Y el recorte movía de verdad la referencia: si no, el test no probaría nada.
  expect(Math.abs(sinRecorte.xRel - conRecorte!.xRel)).toBeGreaterThan(0.01);
});
