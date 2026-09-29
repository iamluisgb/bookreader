import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { seedProLicense } from './pro-license';

// Tarjetas visuales (WU4): detección de figuras PDF (rects de imágenes raster en la
// operator list) + pipeline de recorte/persistencia. Sin UI ni LLM: se importa el módulo
// dentro de la página y se ejercitan las funciones con una operator list SINTÉTICA
// (no dependemos de internals de pdf.js).

// Mapa OPS sintético (los números son arbitrarios: solo tienen que ser estables).
const OPS = {
  save: 10,
  restore: 11,
  transform: 12,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  paintImageMaskXObject: 87,
};

// Operator list sintética a partir de pares [fn, args].
function ops(pairs: any[]) {
  return {
    fnArray: pairs.map(p => p[0]),
    argsArray: pairs.map(p => p[1]),
    OPS,
  };
}

// Página 612x792 (carta) con una sola imagen pintada por la transform dada.
const PAGE = { pageWidth: 612, pageHeight: 792 };

// Importa el módulo dentro de la página y corre ahí un bloque async (con argumento opcional).
async function inPage(page: any, fn: (arg: any) => Promise<any>, arg?: any) {
  return page.evaluate(fn, arg);
}

test('mulMatrix: la identidad no altera y un producto conocido es correcto', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await inPage(page, async () => {
    const M = await import('/js/ai/figures-pdf.js');
    const I = [1, 0, 0, 1, 0, 0];
    const scale2Translate = [2, 0, 0, 2, 10, 20];
    const scale3x = [3, 0, 0, 1, 5, 5];
    return {
      // Identidad por izquierda y por derecha: cada matriz sale igual.
      left: M.mulMatrix(I, scale2Translate),
      right: M.mulMatrix(scale2Translate, I),
      // Escalar x2 + trasladar (10,20), luego escalar x3 en x + trasladar (5,5):
      // punto (1,0): (2*1+10)*3+5 = 41 → a*1+e = 41 → e = 35; punto (0,1): (2*1+20)*1+5 = 27 → f = 25.
      product: M.mulMatrix(scale2Translate, scale3x),
      // Orden NO conmuta: aplicar el primero el scale x3 da otro resultado.
      swapped: M.mulMatrix(scale3x, scale2Translate),
    };
  });
  expect(res.left).toEqual([2, 0, 0, 2, 10, 20]);
  expect(res.right).toEqual([2, 0, 0, 2, 10, 20]);
  expect(res.product).toEqual([6, 0, 0, 2, 35, 25]);
  // Orden NO conmuta: primero el scale x3 da otro producto.
  expect(res.swapped).toEqual([6, 0, 0, 2, 20, 30]);
});

test('imageRectsFromOps: una imagen pintada da el rect fraccional con Y invertido', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const rect = await inPage(page, async (arg) => {
    const M = await import('/js/ai/figures-pdf.js');
    // Imagen de 200x150 con esquina inferior-izquierda en (100,300) en unidades PDF.
    const list = M.imageRectsFromOps(
      { fnArray: [arg.OPS.transform, arg.OPS.paintImageXObject], argsArray: [[200, 0, 0, 150, 100, 300], []], OPS: arg.OPS },
      { pageWidth: arg.pageWidth, pageHeight: arg.pageHeight },
    );
    return list[0] ?? null;
  }, { OPS, pageWidth: PAGE.pageWidth, pageHeight: PAGE.pageHeight });
  // En PDF la esquina inferior queda en y=300, la superior en y=450 → top fraccional
  // = (792-450)/792 = 342/792. Eje Y invertido: PDF crece hacia arriba.
  expect(rect.x).toBeCloseTo(100 / 612, 6);
  expect(rect.y).toBeCloseTo(342 / 792, 6);
  expect(rect.w).toBeCloseTo(200 / 612, 6);
  expect(rect.h).toBeCloseTo(150 / 792, 6);
});

test('imageRectsFromOps: save/restore anidado restaura el CTM previo', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const rects = await inPage(page, async (arg) => {
    const M = await import('/js/ai/figures-pdf.js');
    // save → transform externa → save → transform interna (absurda) → restore → paint.
    // Tras el restore el CTM vuelve a la externa: el rect no debe reflejar la interna.
    const list = M.imageRectsFromOps({
      fnArray: [arg.OPS.save, arg.OPS.transform, arg.OPS.save, arg.OPS.transform, arg.OPS.restore, arg.OPS.paintImageXObject, arg.OPS.restore],
      argsArray: [[], [200, 0, 0, 150, 100, 300], [], [999, 999, 999, 999, 999, 999], [], [], []],
      OPS: arg.OPS,
    }, { pageWidth: arg.pageWidth, pageHeight: arg.pageHeight });
    return list;
  }, { OPS, pageWidth: PAGE.pageWidth, pageHeight: PAGE.pageHeight });
  expect(rects).toHaveLength(1);
  expect(rects[0].x).toBeCloseTo(100 / 612, 6);
  expect(rects[0].y).toBeCloseTo(342 / 792, 6);
});

test('imageRectsFromOps: filtros de lado mínimo, área máxima, dedupe y malformados', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await inPage(page, async (arg) => {
    const M = await import('/js/ai/figures-pdf.js');
    const run = (pairs: any[], opts?: any) => M.imageRectsFromOps(
      { fnArray: pairs.map(p => p[0]), argsArray: pairs.map(p => p[1]), OPS: arg.OPS },
      { pageWidth: arg.pageWidth, pageHeight: arg.pageHeight, ...opts },
    );
    const paint = [arg.OPS.paintImageXObject, []];
    return {
      // Icono de 20x20: descartado por minSidePx (60).
      tiny: run([[arg.OPS.transform, [20, 0, 0, 20, 100, 300]], paint]),
      // Fondo a página completa (área relativa 1 > 0.95): descartado.
      fullPage: run([[arg.OPS.transform, [612, 0, 0, 792, 0, 0]], paint]),
      // Dos imágenes casi idénticas + una distinta: se colapsan a 2. Cada imagen va en su
      // propio save/restore (sin él, los transform consecutivos se COMPONDRÍAN, semántica PDF).
      dupes: run([
        [arg.OPS.save, []], [arg.OPS.transform, [200, 0, 0, 150, 100, 300]], paint, [arg.OPS.restore, []],
        [arg.OPS.save, []], [arg.OPS.transform, [200, 0, 0, 150, 100.0001, 300]], paint, [arg.OPS.restore, []],
        [arg.OPS.save, []], [arg.OPS.transform, [200, 0, 0, 150, 400, 300]], paint, [arg.OPS.restore, []],
      ]),
      // Orden: arriba a abajo y de izquierda a derecha (misma protección save/restore).
      sorted: run([
        [arg.OPS.save, []], [arg.OPS.transform, [100, 0, 0, 100, 300, 600]], paint, [arg.OPS.restore, []],   // arriba, derecha
        [arg.OPS.save, []], [arg.OPS.transform, [100, 0, 0, 100, 100, 600]], paint, [arg.OPS.restore, []],   // arriba, izquierda
        [arg.OPS.save, []], [arg.OPS.transform, [100, 0, 0, 100, 200, 300]], paint, [arg.OPS.restore, []],   // abajo
      ]).map((r: any) => [Math.round(r.x * 612), Math.round(r.y * 792)]),
      // Entradas malformadas: [] sin lanzar.
      nullInput: M.imageRectsFromOps(null as any, { pageWidth: 612, pageHeight: 792 }),
      noArrays: M.imageRectsFromOps({ OPS: arg.OPS } as any, { pageWidth: 612, pageHeight: 792 }),
      noOps: M.imageRectsFromOps({ fnArray: [1], argsArray: [[]] } as any, { pageWidth: 612, pageHeight: 792 }),
      badPageSize: run([[arg.OPS.transform, [200, 0, 0, 150, 100, 300]], paint], { pageWidth: NaN, pageHeight: 792 }),
    };
  }, { OPS, pageWidth: PAGE.pageWidth, pageHeight: PAGE.pageHeight });
  expect(res.tiny).toEqual([]);
  expect(res.fullPage).toEqual([]);
  expect(res.dupes).toHaveLength(2);
  // Orden por y ascendente; a igual y, x ascendente. (en unidades de página, redondeado)
  // Orden por y ascendente; a igual y, x ascendente (en unidades de página, redondeado).
  // top PDF = 700 → yPx = 792-700 = 92; top = 400 → yPx = 392.
  expect(res.sorted).toEqual([[100, 92], [300, 92], [200, 392]]);
  expect(res.nullInput).toEqual([]);
  expect(res.noArrays).toEqual([]);
  expect(res.noOps).toEqual([]);
  expect(res.badPageSize).toEqual([]);
});

test('extractPageFigures: recorta cada rect superviviente con el crop inyectado', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await inPage(page, async (arg) => {
    const M = await import('/js/ai/figures-pdf.js');
    const stubPage = { getOperatorList: async () => ({ fnArray: arg.fnArray, argsArray: arg.argsArray }) };
    const crop = async () => 'data:image/jpeg;base64,AAAA';
    return M.extractPageFigures({
      page: stubPage,
      ops: { OPS: arg.OPS },
      crop,
      pageWidth: arg.pageWidth,
      pageHeight: arg.pageHeight,
    });
  }, {
    OPS,
    pageWidth: PAGE.pageWidth,
    pageHeight: PAGE.pageHeight,
    fnArray: [OPS.transform, OPS.paintImageXObject],
    argsArray: [[200, 0, 0, 150, 100, 300], []],
  });
  expect(res).toHaveLength(1);
  expect(res[0].dataUrl).toBe('data:image/jpeg;base64,AAAA');
  expect(res[0].rect.x).toBeCloseTo(100 / 612, 6);
});

test('extractPageFigures: un crop que falla se omite y los demás siguen', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await inPage(page, async (arg) => {
    const M = await import('/js/ai/figures-pdf.js');
    const stubPage = { getOperatorList: async () => ({ fnArray: arg.fnArray, argsArray: arg.argsArray }) };
    // Falla solo el primer rect (el de x≈100); el segundo (x≈400) sale bien. Cada imagen
    // en su propio save/restore para que los transforms no se compongan entre sí.
    const crop = async (_p: any, rect: any) => {
      if (rect.x < 0.5) throw new Error('crop boom');
      return 'data:image/jpeg;base64,BBBB';
    };
    return M.extractPageFigures({
      page: stubPage,
      ops: { OPS: arg.OPS },
      crop,
      pageWidth: arg.pageWidth,
      pageHeight: arg.pageHeight,
    });
  }, {
    OPS,
    pageWidth: PAGE.pageWidth,
    pageHeight: PAGE.pageHeight,
    fnArray: [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore,
              OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore],
    argsArray: [[], [200, 0, 0, 150, 100, 300], [], [],
                [], [200, 0, 0, 150, 400, 300], [], []],
  });
  expect(res).toHaveLength(1);
  expect(res[0].dataUrl).toBe('data:image/jpeg;base64,BBBB');
  expect(res[0].rect.x).toBeCloseTo(400 / 612, 6);
});

test('extractPageFigures: signal abortada ⇒ rechaza con AbortError', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const name = await inPage(page, async (arg) => {
    const M = await import('/js/ai/figures-pdf.js');
    const stubPage = { getOperatorList: async () => ({ fnArray: arg.fnArray, argsArray: arg.argsArray }) };
    const controller = new AbortController();
    controller.abort();
    try {
      await M.extractPageFigures({
        page: stubPage,
        ops: { OPS: arg.OPS },
        crop: async () => 'data:image/jpeg;base64,AAAA',
        pageWidth: arg.pageWidth,
        pageHeight: arg.pageHeight,
        signal: controller.signal,
      });
      return 'no-reject';
    } catch (err: any) {
      return err.name;
    }
  }, {
    OPS,
    pageWidth: PAGE.pageWidth,
    pageHeight: PAGE.pageHeight,
    fnArray: [OPS.transform, OPS.paintImageXObject],
    argsArray: [[200, 0, 0, 150, 100, 300], []],
  });
  expect(name).toBe('AbortError');
});

test('extractBookFigures: recorre secuencial, reporta progreso y respeta el orden', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await inPage(page, async (arg) => {
    const M = await import('/js/ai/figures-pdf.js');
    const pageOps = { OPS: arg.OPS };
    const pages = [
      { page: { getOperatorList: async () => ({ fnArray: arg.fnArray, argsArray: arg.argsArray }) }, pageWidth: 612, pageHeight: 792, pageNumber: 3 },
      { page: { getOperatorList: async () => ({ fnArray: arg.fnArray, argsArray: arg.argsArray }) }, pageWidth: 612, pageHeight: 792, pageNumber: 7 },
    ];
    const saveCalls: any[] = [];
    const progress: any[] = [];
    const out = await M.extractBookFigures({
      pages,
      crop: async () => 'data:image/jpeg;base64,AAAA',
      ops: pageOps,
      save: async (figure: any) => {
        saveCalls.push(figure);
        return `key-${saveCalls.length}`;
      },
      onProgress: (p: any) => progress.push({ ...p }),
    });
    return { out, saveCalls, progress };
  }, {
    OPS,
    fnArray: [OPS.transform, OPS.paintImageXObject],
    argsArray: [[200, 0, 0, 150, 100, 300], []],
  });
  // Orden secuencial: primero la página 3, después la 7.
  expect(res.saveCalls.map((f: any) => f.page)).toEqual([3, 7]);
  // saved conserva las claves que devolvió save.
  expect(res.out.saved.map((s: any) => s.key)).toEqual(['key-1', 'key-2']);
  expect(res.out.saved.map((s: any) => s.page)).toEqual([3, 7]);
  expect(res.out.failed).toEqual([]);
  // Progreso creciente con total = cantidad de páginas.
  expect(res.progress).toEqual([
    { done: 1, total: 2, page: 3 },
    { done: 2, total: 2, page: 7 },
  ]);
  expect(res.out.figures).toHaveLength(2);
  expect(res.out.figures[0].dataUrl).toBe('data:image/jpeg;base64,AAAA');
});

test('extractBookFigures: un save que rechaza va a failed sin cortar la corrida', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await inPage(page, async (arg) => {
    const M = await import('/js/ai/figures-pdf.js');
    const pages = [
      { page: { getOperatorList: async () => ({ fnArray: arg.fnArray, argsArray: arg.argsArray }) }, pageWidth: 612, pageHeight: 792, pageNumber: 1 },
      { page: { getOperatorList: async () => ({ fnArray: arg.fnArray, argsArray: arg.argsArray }) }, pageWidth: 612, pageHeight: 792, pageNumber: 2 },
    ];
    return M.extractBookFigures({
      pages,
      crop: async () => 'data:image/jpeg;base64,AAAA',
      ops: { OPS: arg.OPS },
      save: async (figure: any) => {
        if (figure.page === 1) throw new Error('disk full');
        return 'key-ok';
      },
    });
  }, {
    OPS,
    fnArray: [OPS.transform, OPS.paintImageXObject],
    argsArray: [[200, 0, 0, 150, 100, 300], []],
  });
  expect(res.failed).toEqual([{ page: 1, error: 'disk full' }]);
  expect(res.saved).toEqual([
    { key: 'key-ok', page: 2, rect: expect.any(Object) },
  ]);
  expect(res.figures).toHaveLength(1);
});

// El resto de los tests usan operator lists SINTÉTICAS. Este es el único que corre contra
// pdf.js real y un PDF real: valida que la matemática del operator list coincide con lo que
// pdf.js produce de verdad (los números de OPS cambian entre versiones y nadie los fija en
// los tests sintéticos). Fixture: tests/test-figure.pdf — página 1 con una imagen insertada
// en el rect (120, 300, 480, 525) con origen arriba-izquierda, página 2 solo texto.
test('integración real: encuentra la figura del PDF con pdf.js y descarta la página sin imágenes', async ({ page }) => {
  const b64 = readFileSync('tests/test-figure.pdf').toString('base64');
  await page.goto('/index.html');
  await seedProLicense(page);
  const out = await page.evaluate(async (data: string) => {
    const VL: any = await import('/js/vendor-loader.js');
    const lib = await VL.loadPdfJs();
    lib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker-3.11.174.min.js';   // igual que pdf-reader.js
    const F: any = await import('/js/ai/figures-pdf.js');
    const bin = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    const doc = await lib.getDocument({ data: bin }).promise;
    const page1 = await doc.getPage(1);
    const vp = page1.getViewport({ scale: 1 });
    const ops = await page1.getOperatorList();
    const args = { fnArray: ops.fnArray, argsArray: ops.argsArray, OPS: lib.OPS };
    const rects = F.imageRectsFromOps(args, { pageWidth: vp.width, pageHeight: vp.height });
    const page2 = await doc.getPage(2);
    const ops2 = await page2.getOperatorList();
    const rects2 = F.imageRectsFromOps(
      { fnArray: ops2.fnArray, argsArray: ops2.argsArray, OPS: lib.OPS },
      { pageWidth: 612, pageHeight: 792 },
    );
    const cropped = await F.extractPageFigures({
      page: page1, ops: args, pageWidth: vp.width, pageHeight: vp.height,
      crop: async () => 'data:image/jpeg;base64,HUELLA',
    });
    return { rects, rects2, cropped };
  }, b64);

  expect(out.rects).toHaveLength(1);
  const r = out.rects[0];
  expect(r.x).toBeCloseTo(120 / 612, 4);
  expect(r.w).toBeCloseTo(360 / 612, 4);
  expect(r.h).toBeCloseTo(225 / 792, 4);
  expect(r.y).toBeCloseTo(300 / 792, 4);          // Y invertido: 300 px desde el borde superior
  expect(out.rects2).toEqual([]);                 // página sin imágenes
  expect(out.cropped).toHaveLength(1);            // el pipeline de recorte recibe el rect detectado
  expect(out.cropped[0].dataUrl).toBe('data:image/jpeg;base64,HUELLA');
});
