import { test, expect } from '@playwright/test';
import { seedProLicense } from './pro-license';

// Tarjetas visuales (WU5d): FUENTE de figuras por libro. Sin UI ni LLM: se importa el
// módulo dentro de la página y se ejercita con documentos pdf.js falsos (operator lists
// sintéticas), zips reales construidos con el JSZip vendorizado y el store real de
// artefactos (bookIds únicos por test para aislar IndexedDB).

test('cropRectFromCanvas: recorta y reescala; rect degenerado y canvas vacío → null', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await page.evaluate(async () => {
    const F: any = await import('/js/ai/visual-figures.js');
    const decodeSize = (url: string) => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = reject;
      img.src = url;
    });
    // Canvas real 800x600 con contenido (el recorte debe salir de él, no de nada).
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 800, 600);
    const good = await decodeSize(F.cropRectFromCanvas(canvas, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 200));
    // 0.5% de 800x600 = 4x3 px: por debajo del mínimo de 8 px por lado.
    const tiny = F.cropRectFromCanvas(canvas, { x: 0.5, y: 0.5, w: 0.005, h: 0.005 }, 200);
    // Un canvas recién creado mide 300x150: se fuerza a 0 para el caso sin tamaño.
    const empty = document.createElement('canvas');
    empty.width = 0;
    empty.height = 0;
    const zeroCanvas = F.cropRectFromCanvas(empty, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 200);
    const badRect = F.cropRectFromCanvas(canvas, null, 200);
    const negativeRect = F.cropRectFromCanvas(canvas, { x: 0.25, y: 0.25, w: -1, h: 0.5 }, 200);
    return { good, tiny, zeroCanvas, badRect, negativeRect };
  });
  // 800x600 → recorte 400x300 → maxPx 200: lado mayor baja a 200 (200x150).
  expect(res.good).toEqual({ w: 200, h: 150 });
  expect(res.tiny).toBeNull();
  expect(res.zeroCanvas).toBeNull();
  expect(res.badRect).toBeNull();
  expect(res.negativeRect).toBeNull();
});

test('renderPageCanvas: canvas offscreen con lado mayor = maxPx; render que rechaza → null', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await page.evaluate(async () => {
    const F: any = await import('/js/ai/visual-figures.js');
    const renderCalls: any[] = [];
    // Página pdf.js falsa de 1000x1400 (el viewport respeta la escala pedida).
    const fakePage = {
      getViewport: (o: any) => ({ width: 1000 * (o?.scale ?? 1), height: 1400 * (o?.scale ?? 1) }),
      render: (opts: any) => { renderCalls.push(opts); return { promise: Promise.resolve() }; },
    };
    const canvas = await F.renderPageCanvas(fakePage, 700);
    const canvasDefault = await F.renderPageCanvas(fakePage);   // RENDER_MAX_PX = 1400
    // Página cuyo render rechaza: null sin lanzar.
    const badPage = {
      getViewport: () => ({ width: 1000, height: 1400 }),
      render: () => ({ promise: Promise.reject(new Error('render boom')) }),
    };
    let failed = 'ok';
    try {
      failed = (await F.renderPageCanvas(badPage)) === null ? 'null' : 'not-null';
    } catch (err: any) {
      failed = 'threw';
    }
    // Los canvas son del documento, no están montados en el DOM (offscreen).
    const offscreen = canvas ? canvas.ownerDocument === document && !canvas.isConnected : null;
    return {
      scaled: canvas ? { w: canvas.width, h: canvas.height } : null,
      default: canvasDefault ? { w: canvasDefault.width, h: canvasDefault.height } : null,
      renderCalls: renderCalls.length,
      offscreen,
      failed,
    };
  });
  expect(res.scaled).toEqual({ w: 500, h: 700 });      // lado mayor = 700 = maxPx pedido
  expect(res.default).toEqual({ w: 1000, h: 1400 });   // lado mayor = 1400 = RENDER_MAX_PX
  expect(res.renderCalls).toBe(2);
  expect(res.offscreen).toBe(true);
  expect(res.failed).toBe('null');
});

test('figuresForPdf: detecta, renderiza solo páginas con imágenes y persiste con dimensiones', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await page.evaluate(async () => {
    const F: any = await import('/js/ai/visual-figures.js');
    // Decodifica un data URL para medir sus dimensiones reales.
    const decodeSize = (url: string) => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = reject;
      img.src = url;
    });
    // Página 1: una imagen pintada (200x150 en (100,300) de una carta 612x792).
    const OPS = { save: 10, restore: 11, transform: 12, paintImageXObject: 85 };
    const page1 = {
      getViewport: (o: any) => ({ width: 612 * (o?.scale ?? 1), height: 792 * (o?.scale ?? 1) }),
      renderCalls: 0,
      getOperatorList: async () => ({
        fnArray: [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore],
        argsArray: [[], [200, 0, 0, 150, 100, 300], [], []],
        OPS,
      }),
      render() { this.renderCalls++; return { promise: Promise.resolve() }; },
    };
    // Página 2: solo texto (sin paint de imagen): NO debe renderizarse.
    const page2 = {
      getViewport: (o: any) => ({ width: 612 * (o?.scale ?? 1), height: 792 * (o?.scale ?? 1) }),
      renderCalls: 0,
      getOperatorList: async () => ({ fnArray: [OPS.transform], argsArray: [[100, 0, 0, 100, 0, 0]], OPS }),
      render() { this.renderCalls++; return { promise: Promise.resolve() }; },
    };
    const doc = { numPages: 2, getPage: async (n: number) => (n === 1 ? page1 : page2) };
    const saveCalls: any[] = [];
    const out = await F.figuresForPdf({
      bookId: 't-vf-pdf-1',
      doc,
      save: async (figure: any) => { saveCalls.push({ ...figure }); return 'key-1'; },
    });
    // Las dimensiones declaradas deben coincidir con el tamaño REAL del recorte.
    const decoded = saveCalls[0] ? await decodeSize(saveCalls[0].dataUrl) : null;
    return { out, saveCalls, decoded, page1RenderCalls: page1.renderCalls, page2RenderCalls: page2.renderCalls };
  });
  expect(res.out.figures).toHaveLength(1);
  expect(res.out.saved).toEqual([{ key: 'key-1', page: 1 }]);
  expect(res.out.failed).toEqual([]);
  expect(res.out.pagesScanned).toBe(2);
  expect(res.out.truncated).toBe(false);
  // Payload de save: contrato completo con dimensiones reales del recorte.
  expect(res.saveCalls).toHaveLength(1);
  const fig = res.saveCalls[0];
  expect(fig.source).toBe('pdf');
  expect(fig.page).toBe(1);
  expect(fig.caption).toBe('p. 1');
  expect(fig.labels).toEqual([]);
  // El render offscreen escala la página a RENDER_MAX_PX (1400) y el recorte amplifica
  // hasta 2× los recortes chicos: las dimensiones persistidas son los píxeles REALES del
  // dataUrl (sin ellas el grounding descarta todas las etiquetas, ver WU5c).
  expect(fig.width).toBe(res.decoded.w);
  expect(fig.height).toBe(res.decoded.h);
  expect(fig.width).toBeGreaterThan(0);
  expect(fig.width).toBeLessThanOrEqual(1024);   // tope del recorte
  expect(fig.dataUrl.startsWith('data:image/jpeg')).toBe(true);
  expect(fig.rect.x).toBeCloseTo(100 / 612, 6);
  // Solo la página con imágenes se renderizó.
  expect(res.page1RenderCalls).toBe(1);
  expect(res.page2RenderCalls).toBe(0);
});

test('figuresForPdf: maxFigures corta y reporta truncated', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await page.evaluate(async () => {
    const F: any = await import('/js/ai/visual-figures.js');
    const OPS = { save: 10, restore: 11, transform: 12, paintImageXObject: 85 };
    const makePage = () => ({
      getViewport: (o: any) => ({ width: 612 * (o?.scale ?? 1), height: 792 * (o?.scale ?? 1) }),
      getOperatorList: async () => ({
        fnArray: [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore],
        argsArray: [[], [200, 0, 0, 150, 100, 300], [], []],
        OPS,
      }),
      render: () => ({ promise: Promise.resolve() }),
    });
    const doc = { numPages: 2, getPage: async (n: number) => pages[n - 1] };
    const pages = [makePage(), makePage()];
    const out = await F.figuresForPdf({ bookId: 't-vf-pdf-2', doc, save: async () => 'k' + Math.random(), maxFigures: 1 });
    return out;
  });
  // Una figura alcanzó el tope: la página 2 no se escanea y se reporta truncado.
  expect(res.figures).toHaveLength(1);
  expect(res.pagesScanned).toBe(1);
  expect(res.truncated).toBe(true);
});

test('figuresForEpub: zip real con jszip, guarda con source epub y caption del capítulo', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await page.evaluate(async () => {
    // PNG aleatorio "chico" pero >= MIN_IMAGE_BYTES (8 KB): píxeles aleatorios comprimen
    // mal, así que un canvas 160x120 con ruido pasa el filtro de collectEpubFigures.
    const noisyPngBytes = () => {
      const c = document.createElement('canvas');
      c.width = 160;
      c.height = 120;
      const cctx = c.getContext('2d');
      const img = cctx.createImageData(160, 120);
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = Math.floor(Math.random() * 256);
        img.data[i + 1] = Math.floor(Math.random() * 256);
        img.data[i + 2] = Math.floor(Math.random() * 256);
        img.data[i + 3] = 255;
      }
      cctx.putImageData(img, 0, 0);
      return Uint8Array.from(atob(c.toDataURL('image/png').split(',')[1]), (ch) => ch.charCodeAt(0));
    };
    const F: any = await import('/js/ai/visual-figures.js');
    const VL: any = await import('/js/vendor-loader.js');
    const JSZip = await VL.loadJsZip();
    const png = noisyPngBytes();
    if (png.length < 8 * 1024) return { tooSmall: png.length };   // guarda del filtro de tamaño
    const builder = new JSZip();
    builder.file('OEBPS/xhtml/ch1.xhtml', '<html><body><img src="../images/fig.png"/></body></html>');
    builder.file('OEBPS/images/fig.png', png);
    const bytes = await builder.generateAsync({ type: 'uint8array' });
    const saveCalls: any[] = [];
    const out = await F.figuresForEpub({
      bookId: 't-vf-epub-1',
      bytes: bytes.buffer,
      JSZip,
      save: async (figure: any) => { saveCalls.push({ ...figure }); return 'key-epub-1'; },
    });
    return { out, saveCalls, pngSize: png.length };
  });
  expect(res.tooSmall).toBeUndefined();
  expect(res.out.figures).toHaveLength(1);
  expect(res.out.saved).toEqual([{ key: 'key-epub-1', path: 'OEBPS/images/fig.png' }]);
  expect(res.out.failed).toEqual([]);
  expect(res.out.truncated).toBe(false);
  // Payload de save: contrato EPUB (page/rect null, caption = capítulo referenciante,
  // dimensiones decodificadas del dataUrl).
  expect(res.saveCalls[0]).toEqual({
    bookId: 't-vf-epub-1',
    page: null,
    rect: null,
    dataUrl: expect.stringContaining('data:image/png;base64,'),
    labels: [],
    caption: 'OEBPS/xhtml/ch1.xhtml',
    source: 'epub',
    width: 160,
    height: 120,
  });
});

test('ensureBookFigures: figuras en el store → cached true y cero extracción', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await page.evaluate(async () => {
    const F: any = await import('/js/ai/visual-figures.js');
    const FIG: any = await import('/js/ai/figures.js');
    const bookId = 't-vf-ensure-a';
    await FIG.saveFigure({
      bookId, page: 3, rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 },
      dataUrl: 'data:image/jpeg;base64,AAAA', labels: [], caption: 'p. 3', source: 'pdf',
    });
    const getDocument = async () => { throw new Error('should not be called'); };
    const out = await F.ensureBookFigures({ bookId, format: 'pdf', deps: { getDocument } });
    return out;
  });
  expect(res.cached).toBe(true);
  expect(res.figures).toHaveLength(1);
  expect(res.figures[0].page).toBe(3);
  expect(res.figures[0].source).toBe('pdf');
});

test('ensureBookFigures: PDF sin documento abierto → reason no-document, sin extraer', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await page.evaluate(async () => {
    const F: any = await import('/js/ai/visual-figures.js');
    // Sin deps.getDocument: cae al lector real, que en esta página no tiene PDF abierto.
    return F.ensureBookFigures({ bookId: 't-vf-ensure-b', format: 'pdf' });
  });
  expect(res.cached).toBe(false);
  expect(res.figures).toEqual([]);
  expect(res.reason).toBe('no-document');
});

test('ensureBookFigures: EPUB sin figuras + deps.readBytes → extrae y guarda (cached false)', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await page.evaluate(async () => {
    const noisyPngBytes = () => {
      const c = document.createElement('canvas');
      c.width = 160;
      c.height = 120;
      const cctx = c.getContext('2d');
      const img = cctx.createImageData(160, 120);
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = Math.floor(Math.random() * 256);
        img.data[i + 1] = Math.floor(Math.random() * 256);
        img.data[i + 2] = Math.floor(Math.random() * 256);
        img.data[i + 3] = 255;
      }
      cctx.putImageData(img, 0, 0);
      return Uint8Array.from(atob(c.toDataURL('image/png').split(',')[1]), (ch) => ch.charCodeAt(0));
    };
    const F: any = await import('/js/ai/visual-figures.js');
    const FIG: any = await import('/js/ai/figures.js');
    const VL: any = await import('/js/vendor-loader.js');
    const JSZip = await VL.loadJsZip();
    const png = noisyPngBytes();
    const builder = new JSZip();
    builder.file('OEBPS/xhtml/ch1.xhtml', '<html><body><img src="../images/fig.png"/></body></html>');
    builder.file('OEBPS/images/fig.png', png);
    const bytes = await builder.generateAsync({ type: 'uint8array' });
    const bookId = 't-vf-ensure-c';
    const record = { format: 'epub', title: 'Test EPUB' };
    const out = await F.ensureBookFigures({
      bookId,
      format: 'epub',
      record,
      deps: { readBytes: async (r: any) => (r === record ? bytes.buffer : null) },
    });
    // Lo guardado quedó en el store real: la próxima llamada sería cached true.
    const stored = await FIG.getFigures(bookId);
    const again = await F.ensureBookFigures({ bookId, format: 'epub', record, deps: {
      readBytes: async () => { throw new Error('should not be called'); },
    } });
    return { out, stored, again };
  });
  expect(res.out.cached).toBe(false);
  expect(res.out.reason).toBe('');
  expect(res.out.figures).toHaveLength(1);
  // Persistido con el contrato EPUB (page/rect null, caption = capítulo).
  expect(res.stored).toHaveLength(1);
  expect(res.stored[0].source).toBe('epub');
  expect(res.stored[0].page).toBeNull();
  expect(res.stored[0].rect).toBeNull();
  expect(res.stored[0].caption).toBe('OEBPS/xhtml/ch1.xhtml');
  // Segunda llamada: servido desde el store.
  expect(res.again.cached).toBe(true);
  expect(res.again.figures).toHaveLength(1);
});
