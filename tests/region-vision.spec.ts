// IA6 v2 · Preguntar por una ZONA de la página, no por la página entera. Lo que hay que
// blindar es la geometría (el recorte tiene que salir de donde el usuario arrastró, con el
// PDF scrolleado o no) y la construcción del turno multi-imagen: cada zona ETIQUETADA antes
// de su imagen, porque sin etiqueta el modelo funde las dos en una respuesta promedio.
import { test, expect, Page } from '@playwright/test';
import path from 'path';

const PDF_PATH = path.join(__dirname, 'test.pdf');

async function openPdf(page: Page) {
  await page.goto('/index.html');
  const fc = page.waitForEvent('filechooser');
  await page.click('#open-file-btn');
  await (await fc).setFiles(PDF_PATH);
  await page.waitForSelector('#pdf-container canvas', { timeout: 15000 });
}

test('normalize acepta las esquinas en cualquier orden', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async () => {
    const R: any = await import('/js/region-select.js');
    return [
      R.normalize({ x: 0.2, y: 0.3 }, { x: 0.6, y: 0.8 }),   // ↘
      R.normalize({ x: 0.6, y: 0.8 }, { x: 0.2, y: 0.3 }),   // ↖ (mismo rect)
    ];
  });
  // Coma flotante: 0.6 - 0.2 no es exactamente 0.4.
  for (const rect of r) {
    expect(rect.x).toBeCloseTo(0.2, 6);
    expect(rect.y).toBeCloseTo(0.3, 6);
    expect(rect.w).toBeCloseTo(0.4, 6);
    expect(rect.h).toBeCloseTo(0.5, 6);
  }
});

test('el marco se dibuja donde se arrastra y devuelve el rect de esa página', async ({ page }) => {
  await openPdf(page);
  const box = await page.evaluate(async () => {
    const RS: any = await import('/js/region-select.js');
    return new Promise((resolve) => {
      RS.start({ onPick: resolve, onCancel: () => resolve(null) });
      const wrapper = document.querySelector('#pdf-container .pdf-page[data-page]')!;
      const w = wrapper.getBoundingClientRect();
      const overlay = document.querySelector('.region-overlay')!;
      const at = (fx: number, fy: number, type: string) => overlay.dispatchEvent(new PointerEvent(type, {
        clientX: w.left + fx * w.width, clientY: w.top + fy * w.height,
        bubbles: true, pointerId: 1,
      }));
      at(0.25, 0.30, 'pointerdown');
      at(0.75, 0.60, 'pointermove');
      // El marco visible debe cubrir lo arrastrado ANTES de soltar (es la garantía que
      // ve el usuario de qué va a recortar).
      const b = (document.querySelector('.region-box') as HTMLElement).getBoundingClientRect();
      (window as any).__box = { left: b.left - w.left, width: b.width, pageW: w.width };
      at(0.75, 0.60, 'pointerup');
    }).then((picked) => ({ picked, drawn: (window as any).__box }));
  }) as any;

  expect(box.picked.page).toBe(1);
  expect(box.picked.rect.x).toBeCloseTo(0.25, 2);
  expect(box.picked.rect.y).toBeCloseTo(0.30, 2);
  expect(box.picked.rect.w).toBeCloseTo(0.50, 2);
  expect(box.picked.rect.h).toBeCloseTo(0.30, 2);
  // El marco pintado coincide con el arrastre (±2px), no desplazado por el scroll.
  expect(box.drawn.left).toBeCloseTo(0.25 * box.drawn.pageW, 0);
  expect(box.drawn.width).toBeCloseTo(0.50 * box.drawn.pageW, 0);
  // Y la capa se desmonta al soltar.
  expect(await page.locator('.region-overlay').count()).toBe(0);
});

test('un toque sin arrastre cancela en vez de recortar un sello', async ({ page }) => {
  await openPdf(page);
  const r = await page.evaluate(async () => {
    const RS: any = await import('/js/region-select.js');
    return new Promise((resolve) => {
      RS.start({ onPick: () => resolve('pick'), onCancel: () => resolve('cancel') });
      const wrapper = document.querySelector('#pdf-container .pdf-page[data-page]')!;
      const w = wrapper.getBoundingClientRect();
      const overlay = document.querySelector('.region-overlay')!;
      const at = (type: string) => overlay.dispatchEvent(new PointerEvent(type, {
        clientX: w.left + 0.5 * w.width, clientY: w.top + 0.5 * w.height, bubbles: true, pointerId: 1,
      }));
      at('pointerdown');
      at('pointerup');
    });
  });
  expect(r).toBe('cancel');
});

test('captureRegionImage recorta de la zona pedida y rechaza lo degenerado', async ({ page }) => {
  await openPdf(page);
  const r = await page.evaluate(async () => {
    const P: any = await import('/js/pdf-reader.js');
    const load = (url: string) => new Promise<{ w: number, h: number }>((res, rej) => {
      const im = new Image();
      im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
      im.onerror = rej;
      im.src = url;
    });
    const half = P.captureRegionImage(1, { x: 0.25, y: 0.25, w: 0.5, h: 0.25 }, 400);
    const tiny = P.captureRegionImage(1, { x: 0, y: 0, w: 0.001, h: 0.001 }, 400);
    const canvas = document.querySelector('#pdf-container canvas') as HTMLCanvasElement;
    return { half: half ? await load(half) : null, tiny, srcW: canvas.width, srcH: canvas.height };
  });
  expect(r.tiny).toBeNull();                       // recorte degenerado: null, no un sello ilegible
  expect(r.half).not.toBeNull();
  // La proporción del recorte es la del ÁREA pedida sobre la página real (no la del papel):
  // medio ancho por un cuarto de alto.
  const expected = (0.5 * r.srcW) / (0.25 * r.srcH);
  expect(r.half!.w / r.half!.h).toBeCloseTo(expected, 1);
  expect(Math.max(r.half!.w, r.half!.h)).toBeLessThanOrEqual(400);
});

// El turno multi-imagen: se intercepta la llamada al proveedor y se comprueba lo que SALE.
// Es lo único que decide si el modelo puede hablar de "la Zona 1" o funde las dos.
test('dos zonas viajan etiquetadas y en el mismo turno', async ({ page }) => {
  let body: any = null;
  await page.route('**/chat/completions', async (route) => {
    body = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: 'La Zona 1 alimenta a la Zona 2.' } }] }),
    });
  });
  await page.addInitScript(() => {
    localStorage.setItem('bookreader_ai_key', JSON.stringify('sk-test'));
    localStorage.setItem('bookreader_ai_base_url', JSON.stringify('https://example.invalid/v1'));
    localStorage.setItem('bookreader_ai_vision_model', JSON.stringify('vision-test'));
  });
  await openPdf(page);

  // Se adjuntan dos zonas por la vía real del panel (captura + estado) y se envía.
  const label = await page.evaluate(async () => {
    const Panel: any = await import('/js/ai/panel.js');
    const P: any = await import('/js/pdf-reader.js');
    const z = (i: number, y: number) => ({
      dataUrl: P.captureRegionImage(1, { x: 0.1, y, w: 0.6, h: 0.2 }, 300),
      page: 1, rect: { x: 0.1, y, w: 0.6, h: 0.2 }, label: `Zona ${i} · p. 1`,
    });
    await Panel.__deliverVisionForTest('¿cómo se relacionan?', [z(1, 0.1), z(2, 0.5)]);
    return document.querySelectorAll('#ai-messages .ai-bubble')[0]?.textContent || '';
  });

  expect(body).not.toBeNull();
  expect(body.model).toBe('vision-test');
  const content = body.messages[1].content;
  const images = content.filter((c: any) => c.type === 'image_url');
  const texts = content.filter((c: any) => c.type === 'text').map((c: any) => c.text);
  // Las dos imágenes, en UN turno...
  expect(images).toHaveLength(2);
  expect(body.messages).toHaveLength(2);
  // ...cada una precedida de su etiqueta, y en orden.
  expect(content.map((c: any) => c.type)).toEqual(['text', 'text', 'image_url', 'text', 'image_url']);
  expect(texts).toContain('Zona 1 · p. 1:');
  expect(texts).toContain('Zona 2 · p. 1:');
  // Y el sistema le dice que la zona la recortó el usuario (que no se vaya a la página).
  expect(body.messages[0].content).toMatch(/RECORTES|recortado/);
  expect(label).toContain('Zona 1');
});
