import { test, expect } from '@playwright/test';
import path from 'path';

const EPUB_PATH = path.join(__dirname, 'test.epub');

// Espera a que el re-ajuste del iframe TERMINE, en vez de apostar una cantidad de
// milisegundos. La condición es la que el test aserta después (el iframe encaja en su
// contenedor) más estabilidad entre dos lecturas: si nunca se cumple, el test falla
// igual, pero por un timeout explícito en lugar de por una medida tomada a destiempo.
// `changedFrom` exige además que la altura haya cambiado, para los giros.
async function settled(page, changedFrom: number | null = null) {
  // Devuelve las medidas que VALIDÓ. Antes el test volvía a llamar a dims() después, y
  // epub.js puede recrear el iframe entre ambas lecturas: se aseraba sobre un estado
  // transitorio que el helper nunca había dado por bueno.
  const res = await page.evaluate(async ({ prev }) => {
    const c = document.getElementById('epub-container')!;
    let last: number | null = null;
    for (let i = 0; i < 150; i++) {                  // tope 15 s
      await new Promise((r) => setTimeout(r, 100));
      const f = c.querySelector('iframe');
      const fh = f ? f.clientHeight : 0;
      const encaja = fh > 100 && Math.abs(fh - c.clientHeight) <= 4;
      const cambio = prev === null || Math.abs(fh - prev) > 20;
      if (encaja && cambio && fh === last) {
        return { cw: c.clientWidth, ch: c.clientHeight, fw: f!.clientWidth, fh };
      }
      last = fh;
    }
    return null;
  }, { prev: changedFrom });
  if (!res) throw new Error(`el iframe no se re-ajustó al contenedor${changedFrom !== null ? ` (partiendo de ${changedFrom}px)` : ''}`);
  return res;
}

// Espera a que la posición deje de moverse (una navegación de epub.js puede emitir varios
// `relocated`). NO exige que cambie: hay pasos que legítimamente no mueven el cfi.
async function cfiSettled(page) {
  await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    let prev: string | null = null;
    for (let i = 0; i < 100; i++) {                  // tope 10 s
      await new Promise((r) => setTimeout(r, 100));
      const cur = R.getCurrentCfi();
      if (cur && cur === prev) return;
      prev = cur;
    }
  });
}

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
  await page.click('.lib-empty .lib-upload');
  await (await fc).setFiles(EPUB_PATH);

  // Esperar a que el iframe del libro exista y tenga tamaño.
  await page.waitForSelector('#epub-container iframe', { timeout: 15000 });
  await page.waitForFunction(() => {
    const f = document.querySelector('#epub-container iframe') as HTMLIFrameElement;
    return f && f.clientHeight > 100;
  });

  // Esperar al re-ajuste diferido tras mostrarse el footer.
  const portrait = await settled(page);
  console.log('PORTRAIT', portrait);
  // En vertical, el iframe debe coincidir con el contenedor (no cortado).
  expect(Math.abs(portrait.fh - portrait.ch)).toBeLessThanOrEqual(4);
  expect(portrait.fw).toBeLessThanOrEqual(portrait.cw + 4);

  // Rotar a horizontal.
  await page.setViewportSize({ width: 844, height: 390 });
  // Esperar al debounce (150ms) + repaginado. Antes se esperaba 500 ms y luego se
  // comprobaba el cambio de altura con `.catch(() => {})`: si nunca llegaba, se seguía
  // adelante y el fallo salía en la aserción de tamaño, tres líneas más abajo.
  const landscape = await settled(page, portrait.fh);
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
  // epub.js RECREA el iframe al repaginar, así que entre el re-ajuste y esta lectura
  // puede no haber ninguno: leerlo a pelo reventaba con "contentDocument of null".
  const colW = await page.evaluate(async () => {
    for (let i = 0; i < 100; i++) {                  // tope 10 s
      const f = document.querySelector('#epub-container iframe') as HTMLIFrameElement | null;
      const body = f?.contentDocument?.body;
      if (body) {
        const w = parseFloat(getComputedStyle(body).columnWidth);
        if (w > 0) return w;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return 0;
  });
  console.log('LANDSCAPE columnWidth', colW);
  expect(colW).toBeGreaterThan(landscape.cw * 0.6); // una sola columna ancha

  // Volver a vertical y comprobar que también se re-ajusta.
  await page.setViewportSize({ width: 390, height: 844 });
  const portrait2 = await settled(page, landscape.fh);
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
  await page.click('.lib-empty .lib-upload');
  await (await fc).setFiles(EPUB_PATH);
  await page.waitForSelector('#epub-container iframe', { timeout: 15000 });
  await page.waitForFunction(() => {
    const f = document.querySelector('#epub-container iframe') as HTMLIFrameElement;
    return f && f.clientHeight > 100;
  });
  await settled(page);

  const cfi = () => page.evaluate(async () => (await import('/js/epub-reader.js')).getCurrentCfi());
  const next = async () => {
    await page.evaluate(async () => (await import('/js/epub-reader.js')).next());
    await cfiSettled(page);
  };
  // Avanzar a una posición a mitad de párrafo (offset != 0, donde la deriva se manifiesta).
  for (let i = 0; i < 14; i++) await next();
  const before = await cfi();

  // Varias rotaciones seguidas.
  for (const [w, h] of [[844, 390], [390, 844], [844, 390], [390, 844]] as const) {
    const prev = (await dims(page)).fh;
    await page.setViewportSize({ width: w, height: h });
    await settled(page, prev);
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
  const prevFh = (await dims(page)).fh;
  await page.setViewportSize({ width: 844, height: 390 });
  await settled(page, prevFh);
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
