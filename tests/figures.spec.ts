import { test, expect } from '@playwright/test';
import { seedProLicense } from './pro-license';

// Tarjetas visuales (WU2): capa de datos pura (validación/normalización de etiquetas y
// persistencia de figuras). Sin UI ni LLM: se importan los módulos dentro de la página y
// se ejercitan las funciones directamente.

// Importa el módulo dentro de la página y corre ahí un bloque async (con argumento opcional).
async function inPage(page, fn: (arg: any) => Promise<any>, arg?: any) {
  return page.evaluate(fn, arg);
}

test('clampBbox: clampea a enteros dentro de límites, tolera 2px de exceso y descarta inválidos', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await inPage(page, async () => {
    const F = await import('/js/ai/figures.js');
    return {
      // Box válido con floats: se redondea a enteros.
      valid: F.clampBbox([10.4, 20.6, 100.3, 50.7], { width: 612, height: 792 }),
      // Se pasa 2px por arriba/izquierda: dentro de la tolerancia → clampeado.
      tolerance: F.clampBbox([-2, -2, 50, 50], { width: 612, height: 792 }),
      // Degenerado: ancho 0 y ancho 4 (< minSize 5) → null.
      zeroW: F.clampBbox([10, 10, 0, 50], { width: 612, height: 792 }),
      tinyW: F.clampBbox([10, 10, 4, 50], { width: 612, height: 792 }),
      // Más de 2px fuera de la imagen → null.
      outside: F.clampBbox([-10, 0, 50, 50], { width: 612, height: 792 }),
      // Entradas no numéricas → null (nunca lanza).
      nan: F.clampBbox([1, 2, 'x', 4] as any, { width: 612, height: 792 }),
      notArray: F.clampBbox('nope' as any, { width: 612, height: 792 }),
      // Se va 38px por la derecha (≫ tolerance 2): descartado entero, no clampeado.
      farOutsideRight: F.clampBbox([600, 100, 50, 50], { width: 612, height: 792 }),
    };
  });
  expect(res.valid).toEqual({ x: 10, y: 21, w: 100, h: 51 });
  expect(res.tolerance).toEqual({ x: 0, y: 0, w: 48, h: 48 });
  expect(res.zeroW).toBeNull();
  expect(res.tinyW).toBeNull();
  expect(res.outside).toBeNull();
  expect(res.nan).toBeNull();
  expect(res.notArray).toBeNull();
  expect(res.farOutsideRight).toBeNull();
});

test('normalizeText y dedupeLabels: fusiona por texto (caso/tildes) y por solape de boxes', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await inPage(page, async () => {
    const F = await import('/js/ai/figures.js');
    const norm = F.normalizeText('¡Hóla,  Mun_do!');
    // Misma etiqueta en distinto caso/acentos → una sola (se queda la primera).
    const byText = F.dedupeLabels([
      { text: 'Mitocondria', bbox: [10, 10, 50, 50] },
      { text: 'MITOCONDRIA', bbox: [200, 10, 50, 50] },
    ]);
    // Etiquetas distintas con boxes que NO se solapan → siguen siendo dos.
    const distinct = F.dedupeLabels([
      { text: 'Núcleo', bbox: [10, 10, 50, 50] },
      { text: 'Membrana', bbox: [100, 100, 50, 50] },
    ]);
    // Etiquetas distintas pero boxes casi idénticos (IoU > 0.55) → una sola, la primera.
    const byIou = F.dedupeLabels([
      { text: 'Núcleo', bbox: [10, 10, 50, 50] },
      { text: 'Membrana', bbox: [12, 12, 50, 50] },
    ]);
    return { norm, byText, distinct, byIou };
  });
  expect(res.norm).toBe('hola mun do');
  expect(res.byText).toHaveLength(1);
  expect(res.byText[0]).toEqual({ text: 'Mitocondria', bbox: [10, 10, 50, 50] });
  expect(res.distinct).toHaveLength(2);
  expect(res.byIou).toHaveLength(1);
  expect(res.byIou[0].text).toBe('Núcleo');
});

test('parseLabelsResponse: JSON limpio, con fences y prosa, truncado sin lanzar, y bboxes fuera de imagen', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await inPage(page, async () => {
    const F = await import('/js/ai/figures.js');
    const clean = F.parseLabelsResponse(
      '{"labels":[{"text":"Iron Man","bbox":[10.5,20,100.4,50]}]}',
      { width: 612, height: 792 },
    );
    const fenced = F.parseLabelsResponse(
      'Aquí tienes:\n```json\n{"labels":[{"text":"Torre","bbox":[0,0,80,30]}]}\n```\nEspero que sirva.',
      { width: 612, height: 792 },
    );
    const truncated = F.parseLabelsResponse(
      '{"labels":[{"text":"A","bbox":[1,1,10,10]},{"text":"B"',
      { width: 612, height: 792 },
    );
    // bbox que cae a más de 2px fuera de la imagen → etiqueta descartada.
    const oob = F.parseLabelsResponse(
      '{"labels":[{"text":"Fuera","bbox":[600,780,100,100]},{"text":"Dentro","bbox":[5,5,40,20]}]}',
      { width: 612, height: 792 },
    );
    return { clean, fenced, truncated, oob };
  });
  expect(res.clean).toEqual([{ text: 'Iron Man', bbox: { x: 11, y: 20, w: 100, h: 50 } }]);
  // Con fences y prosa alrededor: el extractor de objetos balanceados rescata el JSON.
  expect(res.fenced).toEqual([{ text: 'Torre', bbox: { x: 0, y: 0, w: 80, h: 30 } }]);
  expect(res.truncated).toEqual([]);  // truncado: sin objeto balanceado → vacío, sin lanzar
  expect(res.oob).toEqual([{ text: 'Dentro', bbox: { x: 5, y: 5, w: 40, h: 20 } }]);
});

test('figureRectToBox: rect fraccional 0..1 a píxeles enteros sobre página 612x792, con clamp', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await inPage(page, async () => {
    const F = await import('/js/ai/figures.js');
    return {
      center: F.figureRectToBox({ x: 0.5, y: 0.25, w: 0.25, h: 0.5 }, { pageWidth: 612, pageHeight: 792 }),
      // Rect que se pasa de 1: se clampea a los bordes de la página.
      overflow: F.figureRectToBox({ x: 0.9, y: 0, w: 0.3, h: 1 }, { pageWidth: 612, pageHeight: 792 }),
      invalid: F.figureRectToBox({ x: 0.5, y: 'x', w: 0.2, h: 0.2 } as any, { pageWidth: 612, pageHeight: 792 }),
    };
  });
  expect(res.center).toEqual({ x: 306, y: 198, w: 153, h: 396 });
  expect(res.overflow).toEqual({ x: 551, y: 0, w: 61, h: 792 });
  expect(res.invalid).toBeNull();
});

test('persistencia: saveFigure → getFigures devuelve la figura con sus campos; deleteFigure la quita', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  // bookId único por corrida: cada worker usa su propio libro y no se pisan entre tests.
  const bookId = `bk-figures-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const { key, figures } = await inPage(page, async (bookId: string) => {
    const F = await import('/js/ai/figures.js');
    const rect = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    const labels = [{ text: 'Cristo redentor', bbox: [12, 34, 100, 200] }];
    const savedKey = await F.saveFigure({
      bookId,
      page: 3,
      rect,
      dataUrl: 'data:image/png;base64,AAAA',
      labels,
      caption: 'Figura de prueba',
      width: 320,
      height: 200,
    });
    return { key: savedKey, figures: await F.getFigures(bookId) };
  }, bookId);
  expect(typeof key).toBe('string');
  expect(key).toContain(':figures:');
  expect(figures).toHaveLength(1);
  expect(figures[0].key).toBe(key);
  expect(figures[0].page).toBe(3);
  expect(figures[0].rect).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  expect(figures[0].dataUrl).toBe('data:image/png;base64,AAAA');
  expect(figures[0].labels).toEqual([{ text: 'Cristo redentor', bbox: [12, 34, 100, 200] }]);
  expect(figures[0].caption).toBe('Figura de prueba');
  expect(figures[0].source).toBe('pdf');
  // Los píxeles reales del recorte se persisten: sin ellos el grounding descarta los labels
  // (clampBbox exige width/height) y habría que re-decodificar el dataUrl en cada generación.
  expect(figures[0].width).toBe(320);
  expect(figures[0].height).toBe(200);

  const after = await inPage(page, async ({ bookId: bk, key: k }: any) => {
    const F = await import('/js/ai/figures.js');
    await F.deleteFigure(k);
    return F.getFigures(bk);
  }, { bookId, key });
  expect(after).toHaveLength(0);
});
