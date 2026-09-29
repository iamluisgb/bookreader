import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { seedProLicense } from './pro-license';

// Tarjetas visuales (WU4b): detección y extracción de figuras en EPUB. Sin UI ni LLM: se
// importa el módulo dentro de la página y se ejercitan las funciones puras con datos
// sintéticos, más un test de integración contra el EPUB real (tests/test.epub) cargado
// con el JSZip vendorizado. El acceso al zip va siempre inyectado (zipReader): el módulo
// no depende de jszip.

// PNG 1x1 transparente (70 bytes): suficiente para probar la lectura de imagen.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('isImagePath y mimeOf: extensiones, mayúsculas, query y no-imágenes', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await page.evaluate(async () => {
    const F: any = await import('/js/ai/figures-epub.js');
    const cases = [
      'images/a.png',
      'images/a.PNG',
      'b.jpg',
      'b.JPG',
      'c.jpeg',
      'd.gif',
      'e.svg',
      'f.webp',
      'img/p.png?v=2#frag',
      'chapter.xhtml',
      'style.css',
      'font.otf',
      'README',
      'dir/',
    ];
    return cases.map((p) => ({ path: p, isImage: F.isImagePath(p), mime: F.mimeOf(p) }));
  });
  const byPath = new Map(res.map((r: any) => [r.path, r]));
  const check = (p: string, isImage: boolean, mime: string) => {
    expect(byPath.get(p).isImage, p).toBe(isImage);
    expect(byPath.get(p).mime, p).toBe(mime);
  };
  check('images/a.png', true, 'image/png');
  check('images/a.PNG', true, 'image/png');       // case-insensitive
  check('b.jpg', true, 'image/jpeg');
  check('b.JPG', true, 'image/jpeg');
  check('c.jpeg', true, 'image/jpeg');
  check('d.gif', true, 'image/gif');
  check('e.svg', true, 'image/svg+xml');
  check('f.webp', true, 'image/webp');
  check('img/p.png?v=2#frag', true, 'image/png'); // query/fragment no molestan
  check('chapter.xhtml', false, '');
  check('style.css', false, '');
  check('font.otf', false, '');
  check('README', false, '');                     // sin extensión
  check('dir/', false, '');                       // directorio
});

test('resolveHref: relativos, raíz del zip, absolutos y descartes', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await page.evaluate(async () => {
    const F: any = await import('/js/ai/figures-epub.js');
    const base = 'OEBPS/xhtml/ch1.xhtml';
    return {
      parent: F.resolveHref(base, '../images/a.jpg'),
      dot: F.resolveHref(base, './img/b.png'),
      root: F.resolveHref(base, '/OEBPS/img/c.png'),
      absolute: F.resolveHref(base, 'OEBPS/img/d.png'),
      bare: F.resolveHref(base, 'img/e.png'),
      // Normalización: barras dobles colapsan y '..' se clampea en la raíz.
      doubleSlash: F.resolveHref(base, 'img//f.png'),
      beyondRoot: F.resolveHref('ch1.xhtml', '../../g.png'),
      // Descartes: externas, embebidas, vacías y solo-fragmento.
      http: F.resolveHref(base, 'http://example.com/x.png'),
      https: F.resolveHref(base, 'https://example.com/x.png'),
      data: F.resolveHref(base, 'data:image/png;base64,AAAA'),
      blob: F.resolveHref(base, 'blob:uuid'),
      empty: F.resolveHref(base, ''),
      blank: F.resolveHref(base, '   '),
      fragOnly: F.resolveHref(base, '#anchor'),
      // Query/fragmento se recortan de la ruta resultante.
      withQuery: F.resolveHref(base, '../images/h.png?v=2'),
    };
  });
  expect(res.parent).toBe('OEBPS/images/a.jpg');
  expect(res.dot).toBe('OEBPS/xhtml/img/b.png');
  expect(res.root).toBe('OEBPS/img/c.png');
  expect(res.absolute).toBe('OEBPS/img/d.png');
  expect(res.bare).toBe('OEBPS/xhtml/img/e.png');
  expect(res.doubleSlash).toBe('OEBPS/xhtml/img/f.png');
  expect(res.beyondRoot).toBe('g.png');
  expect(res.http).toBe('');
  expect(res.https).toBe('');
  expect(res.data).toBe('');
  expect(res.blob).toBe('');
  expect(res.empty).toBe('');
  expect(res.blank).toBe('');
  expect(res.fragOnly).toBe('');
  expect(res.withQuery).toBe('OEBPS/images/h.png');
});

test('refsFromXhtml: img, svg image con xlink:href e href; data: se descarta', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const refs = await page.evaluate(async (html: string) => {
    const F: any = await import('/js/ai/figures-epub.js');
    return F.refsFromXhtml(html, { chapterPath: 'OEBPS/xhtml/ch1.xhtml' });
  }, `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink">
  <body>
    <img src="../images/a.jpg"/>
    <svg xmlns="http://www.w3.org/2000/svg"><image xlink:href="img/b.png"/></svg>
    <svg xmlns="http://www.w3.org/2000/svg"><image href="/OEBPS/img/c.png"/></svg>
    <img src="data:image/png;base64,AAAA"/>
  </body>
</html>`);
  // 3 referencias resueltas, en orden de documento, con el capítulo de origen.
  expect(refs.map((r: any) => r.path)).toEqual([
    'OEBPS/images/a.jpg',
    'OEBPS/xhtml/img/b.png',
    'OEBPS/img/c.png',
  ]);
  expect(refs.every((r: any) => r.chapterPath === 'OEBPS/xhtml/ch1.xhtml')).toBe(true);
});

test('entriesFromZip + zipReader: entradas con tamaño, texto e imagen desde JSZip real', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await page.evaluate(async (pngB64: string) => {
    const VL: any = await import('/js/vendor-loader.js');
    const JSZip = await VL.loadJsZip();
    // Arma un zip en la página y lo recarga: en un zip CARGADO (loadAsync) los ZipObject
    // traen _data.uncompressedSize, que es de donde entriesFromZip saca el tamaño.
    const built = new JSZip();
    built.file('OEBPS/ch1.xhtml', '<html><body>hola</body></html>');
    built.file('OEBPS/img/a.png', pngB64, { base64: true });
    const u8 = await built.generateAsync({ type: 'uint8array' });
    const zip = await JSZip.loadAsync(u8);
    const F: any = await import('/js/ai/figures-epub.js');
    const entries = F.entriesFromZip(zip);
    const reader = F.zipReader(zip);
    return {
      entries,
      text: await reader.readText('OEBPS/ch1.xhtml'),
      missingText: await reader.readText('no/existe.xhtml'),
      image: await reader.readImage('OEBPS/img/a.png'),
      missingImage: await reader.readImage('no/existe.png'),
    };
  }, TINY_PNG_B64);
  const paths = res.entries.map((e: any) => e.path).sort();
  expect(paths).toEqual(['OEBPS/ch1.xhtml', 'OEBPS/img/a.png']);
  const byPath = new Map(res.entries.map((e: any) => [e.path, e]));
  expect(byPath.get('OEBPS/ch1.xhtml').size).toBe('<html><body>hola</body></html>'.length); // largo exacto
  expect(byPath.get('OEBPS/img/a.png').size).toBeGreaterThan(0);
  expect(res.text).toBe('<html><body>hola</body></html>');
  expect(res.missingText).toBe('');
  expect(res.image.startsWith('data:image/png;base64,')).toBe(true);
  expect(res.missingImage).toBe('');
});

test('collectEpubFigures: filtros de tamaño, capítulo compartido, fallos de lectura y orden', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await page.evaluate(async (minBytes: number) => {
    const F: any = await import('/js/ai/figures-epub.js');
    const entries = [
      { path: 'OEBPS/xhtml/ch1.xhtml', size: 100 },
      { path: 'OEBPS/xhtml/ch2.xhtml', size: 100 },
      { path: 'OEBPS/css/style.css', size: 5000 },      // no imagen: ignorada
      { path: 'OEBPS/images/small.png', size: minBytes - 1 }, // debajo del mínimo: descartada
      { path: 'OEBPS/images/unknown.png', size: 0 },    // size desconocido: se CONSERVA
      { path: 'OEBPS/images/shared.jpg', size: 20000 }, // referenciada por DOS capítulos
      { path: 'OEBPS/images/broken.jpg', size: 20000 }, // la lectura falla: omitida
    ];
    const html = (refs: string) =>
      `<html><body>${refs.map((r) => `<img src="${r}"/>`).join('')}</body></html>`;
    const readText = async (path: string) => {
      if (path === 'OEBPS/xhtml/ch1.xhtml') return html(['../images/small.png', '../images/shared.jpg']);
      if (path === 'OEBPS/xhtml/ch2.xhtml') return html(['../images/shared.jpg']);
      return '';
    };
    const readImage = async (path: string) => {
      if (path === 'OEBPS/images/broken.jpg') return '';           // falla: '' y se omite
      if (path === 'OEBPS/images/unknown.png') return 'data:image/png;base64,ZZZZ';
      if (path === 'OEBPS/images/shared.jpg') return 'data:image/jpeg;base64,YYYY';
      return '';
    };
    const figures = await F.collectEpubFigures({ entries, readText, readImage });
    // Abort pre-abortada ⇒ AbortError.
    const controller = new AbortController();
    controller.abort();
    let abortName = '';
    try {
      await F.collectEpubFigures({ entries, readText, readImage, signal: controller.signal });
    } catch (err: any) {
      abortName = err.name;
    }
    return { figures, abortName };
  }, 8 * 1024);
  // Orden = orden de las entradas: unknown.png antes que shared.jpg.
  expect(res.figures.map((f: any) => f.path)).toEqual([
    'OEBPS/images/unknown.png',
    'OEBPS/images/shared.jpg',
  ]);
  // size 0 se conservó y, al no estar referenciada, sin capítulo.
  expect(res.figures[0]).toEqual({ path: 'OEBPS/images/unknown.png', dataUrl: 'data:image/png;base64,ZZZZ', chapter: '', size: 0 });
  // La imagen compartida aparece UNA vez, con el capítulo de la primera referencia.
  expect(res.figures[1]).toEqual({ path: 'OEBPS/images/shared.jpg', dataUrl: 'data:image/jpeg;base64,YYYY', chapter: 'OEBPS/xhtml/ch1.xhtml', size: 20000 });
  expect(res.abortName).toBe('AbortError');
});

test('extractAndSaveEpubFigures: save fallido va a failed sin cortar; progreso y payload', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await page.evaluate(async () => {
    const F: any = await import('/js/ai/figures-epub.js');
    const entries = [
      { path: 'OEBPS/xhtml/ch1.xhtml', size: 100 },
      { path: 'OEBPS/images/bad.jpg', size: 20000 },
      { path: 'OEBPS/images/good.jpg', size: 20000 },
    ];
    const readText = async (path: string) =>
      path === 'OEBPS/xhtml/ch1.xhtml' ? '<html><body><img src="../images/bad.jpg"/><img src="../images/good.jpg"/></body></html>' : '';
    const readImage = async (path: string) => {
      if (path === 'OEBPS/images/bad.jpg') return 'data:image/jpeg;base64,BADD';
      if (path === 'OEBPS/images/good.jpg') return 'data:image/jpeg;base64,OKKK';
      return '';
    };
    const saveCalls: any[] = [];
    const progress: any[] = [];
    const out = await F.extractAndSaveEpubFigures({
      entries,
      readText,
      readImage,
      bookId: 'book-1',
      save: async (figure: any) => {
        saveCalls.push({ ...figure });
        if (figure.dataUrl === 'data:image/jpeg;base64,BADD') throw new Error('disk full');
        return `key-${saveCalls.length}`;
      },
      onProgress: (p: any) => progress.push({ ...p }),
    });
    return { out, saveCalls, progress };
  });
  // Payload de save: el contrato de saveFigure para EPUB (page/rect null, source epub,
  // caption = capítulo).
  expect(res.saveCalls[0]).toEqual({ bookId: 'book-1', page: null, rect: null, dataUrl: 'data:image/jpeg;base64,BADD', labels: [], caption: 'OEBPS/xhtml/ch1.xhtml', source: 'epub' });
  expect(res.saveCalls[1].dataUrl).toBe('data:image/jpeg;base64,OKKK');
  // El save que rechaza aterriza en failed y la corrida sigue.
  expect(res.out.failed).toEqual([{ path: 'OEBPS/images/bad.jpg', error: 'disk full' }]);
  expect(res.out.saved).toEqual([{ key: 'key-2', path: 'OEBPS/images/good.jpg' }]);
  expect(res.out.figures).toEqual([{ key: 'key-2', path: 'OEBPS/images/good.jpg', dataUrl: 'data:image/jpeg;base64,OKKK', chapter: 'OEBPS/xhtml/ch1.xhtml' }]);
  // Progreso creciente con total = cantidad de figuras recolectadas.
  expect(res.progress).toEqual([{ done: 1, total: 2 }, { done: 2, total: 2 }]);
});

// El resto de los tests usan entradas sintéticas. Este es el único que corre contra un
// EPUB real: valida la cadena completa (loadAsync → entriesFromZip → refsFromXhtml sobre
// los XHTML del zip → readImage base64) con un libro de verdad. Fixture: tests/test.epub
// (Pedro Páramo) — dos imágenes JPEG: la cubierta y la página de título, cada una
// referenciada desde su propio XHTML.
test('integración real: extrae las 2 figuras del EPUB con JSZip y jszip-reader reales', async ({ page }) => {
  const b64 = readFileSync('tests/test.epub').toString('base64');
  await page.goto('/index.html');
  await seedProLicense(page);
  const figures = await page.evaluate(async (data: string) => {
    const VL: any = await import('/js/vendor-loader.js');
    const JSZip = await VL.loadJsZip();
    const F: any = await import('/js/ai/figures-epub.js');
    const bin = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const zip = await JSZip.loadAsync(bin);
    const reader = F.zipReader(zip);
    return F.collectEpubFigures({
      entries: F.entriesFromZip(zip),
      readText: reader.readText,
      readImage: reader.readImage,
    });
  }, b64);
  // Exactamente las 2 figuras del libro, ambas JPEG.
  expect(figures).toHaveLength(2);
  const byPath = new Map(figures.map((f: any) => [f.path, f]));
  const cover = byPath.get('OEBPS/images/9780525566533_cover.jpg');
  const title = byPath.get('OEBPS/images/9780525566533_title_page.jpg');
  expect(cover).toBeDefined();
  expect(title).toBeDefined();
  expect(cover.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
  expect(title.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
  // El capítulo apunta al XHTML que referencia cada imagen.
  expect(cover.chapter).toBe('OEBPS/xhtml/Rulf_9780525566533_epub3_cvi_r1.xhtml');
  expect(title.chapter).toBe('OEBPS/xhtml/Rulf_9780525566533_epub3_tp_r1.xhtml');
  // Tamaños reales desde el zip cargado.
  expect(cover.size).toBeGreaterThan(8 * 1024);
  expect(title.size).toBeGreaterThan(8 * 1024);
});
