import { test, expect, Page } from '@playwright/test';

// El índice de un EPUB tiene que decir la verdad en las dos cosas que se le preguntan: a
// DÓNDE lleva cada entrada (su número de página) y DÓNDE estás (la entrada marcada). Y no
// puede perder entradas. Reportado leyendo *Site Reliability Engineering* (O'Reilly, un
// fichero por capítulo, secciones por ancla, índice de 3 niveles) en un iPad en modo scroll:
//  - todas las subsecciones de un capítulo decían la página donde EMPIEZA el capítulo
//    (241/241/241 en lugar de 241/265/312): `section.load()` del epub.js vendorizado devuelve
//    un Element, sin getElementById, y el catch dejaba todas en la página del fichero;
//  - solo se pintaban 2 de los 3 niveles (221 enlaces de 693 entradas);
//  - la marca no bajaba nunca de capítulo: estando en Career Management marcaba el capítulo.
//
// El libro se GENERA aquí, con el JSZip vendorizado de la propia app, para no meter un EPUB
// binario en el repo: la misma forma que el real (secciones anidadas como <section id> dentro
// de un fichero por capítulo, varias anclas por fichero, 4 niveles en el nav) y texto de
// sobra entre anclas para que cada una caiga en una location distinta (1024 caracteres).

test.use({ viewport: { width: 834, height: 1112 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

type Node = { id: string; label: string; paras: number; kids?: Node[] };

// Capítulo 1: cuatro niveles y la última sección CORTA (no puede subir al borde superior:
// es el caso de la «Conclusion» que dejaba la marca en la sección anterior).
const CH1: Node = {
  id: 'c1', label: 'Uno. Capítulo largo', paras: 4, kids: [
    { id: 'c1-a', label: 'Uno A', paras: 8 },
    { id: 'c1-b', label: 'Uno B', paras: 4, kids: [
      { id: 'c1-b1', label: 'Uno B1', paras: 8, kids: [
        { id: 'c1-b1x', label: 'Uno B1 equis', paras: 8 },
      ] },
      { id: 'c1-b2', label: 'Uno B2', paras: 8 },
    ] },
    { id: 'c1-c', label: 'Uno C final corta', paras: 1 },
  ],
};
// Capítulo 2: varias anclas en un fichero que NO está en pantalla al abrir. Es el caso que
// fallaba: el capítulo que se está renderizando ya tiene `section.document` y resolvía bien;
// los demás pasaban por `section.load()` y caían todos a la página de su inicio.
const CH2: Node = {
  id: 'c2', label: 'Dos. Otro capítulo', paras: 4, kids: [
    { id: 'c2-a', label: 'Dos A', paras: 8 },
    { id: 'c2-b', label: 'Dos B', paras: 4, kids: [
      { id: 'c2-b1', label: 'Dos B1', paras: 8 },
    ] },
  ],
};
const ALL: Node[] = [];
(function flat(ns: Node[]) { for (const n of ns) { ALL.push(n); flat(n.kids || []); } })([CH1, CH2]);

const PARA = 'Texto de relleno para que cada sección ocupe varias localizaciones de epub.js. '.repeat(8);

function body(n: Node, depth: number): string {
  const h = `h${Math.min(depth + 1, 6)}`;
  const ps = Array.from({ length: n.paras }, (_, i) => `<p>${n.label} · párrafo ${i + 1}. ${PARA}</p>`).join('');
  return `<section id="${n.id}"><${h}>${n.label}</${h}>${ps}${(n.kids || []).map((k) => body(k, depth + 1)).join('')}</section>`;
}
function navList(ns: Node[], file: (n: Node) => string): string {
  return `<ol>${ns.map((n) => `<li><a href="${file(n)}#${n.id}">${n.label}</a>${n.kids ? navList(n.kids, file) : ''}</li>`).join('')}</ol>`;
}

async function buildEpub(page: Page): Promise<Buffer> {
  const xhtml = (title: string, inner: string) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${title}</title></head><body>${inner}</body></html>`;
  const fileOf = (n: Node) => (n.id.startsWith('c1') ? 'ch1.xhtml' : 'ch2.xhtml');
  const files: Record<string, string> = {
    'META-INF/container.xml': `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    'OEBPS/content.opf': `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">toc-anchors-test</dc:identifier><dc:title>Índice con anclas</dc:title><dc:language>es</dc:language><meta property="dcterms:modified">2026-11-15T00:00:00Z</meta></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="ch1"/><itemref idref="ch2"/></spine></package>`,
    'OEBPS/nav.xhtml': xhtml('Índice', `<nav epub:type="toc">${navList([CH1, CH2], fileOf)}</nav>`),
    'OEBPS/ch1.xhtml': xhtml(CH1.label, body(CH1, 0)),
    'OEBPS/ch2.xhtml': xhtml(CH2.label, body(CH2, 0)),
  };
  const b64 = await page.evaluate(async (files) => {
    const { loadJsZip } = await import('/js/vendor-loader.js');
    const JSZip: any = await loadJsZip();
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    for (const [name, text] of Object.entries(files)) zip.file(name, text);
    return zip.generateAsync({ type: 'base64', mimeType: 'application/epub+zip' });
  }, files);
  return Buffer.from(b64, 'base64');
}

// Abre el libro en modo scroll y espera a que el índice tenga sus números (las anclas
// resueltas): sin eso la marca aún va por fichero, con el criterio de la apertura.
async function abrir(page: Page) {
  await page.goto('/index.html');
  const buffer = await buildEpub(page);
  await page.setInputFiles('#file-input', { name: 'toc-anchors.epub', mimeType: 'application/epub+zip', buffer });
  await page.waitForSelector('#epub-container iframe', { timeout: 30000 });
  await page.evaluate(async () => {
    const E: any = await import('/js/epub-reader.js');
    await E.setReadingMode('scroll');
  });
  await expect.poll(() => page.evaluate(() => {
    const as = document.querySelectorAll('#toc-list a');
    return as.length > 0 && document.querySelectorAll('#toc-list a .toc-page').length === as.length;
  }), { timeout: 30000 }).toBe(true);
}

const href = (n: Node) => `${n.id.startsWith('c1') ? 'ch1.xhtml' : 'ch2.xhtml'}#${n.id}`;
const byId = (id: string) => ALL.find((n) => n.id === id)!;
const marcada = (page: Page) => page.locator('#toc-list a.current .toc-label').textContent().then((s) => (s || '').trim());

// Posición real de lo que hay arriba en pantalla, en las mismas unidades que el índice.
const paginaReal = (page: Page) => page.evaluate(async () => {
  const E: any = await import('/js/epub-reader.js');
  return E.getPageInfo(E.getRendition().currentLocation().start.cfi)?.page ?? null;
});

test('pinta TODAS las entradas del índice, a cualquier profundidad', async ({ page }) => {
  await abrir(page);
  const nodos = await page.evaluate(async () => {
    const E: any = await import('/js/epub-reader.js');
    let n = 0;
    const w = (xs: any[]) => { for (const x of xs || []) { n++; w(x.subitems); } };
    w(E.getNavigation().toc);
    return n;
  });
  expect(nodos).toBe(ALL.length);   // el nav del fixture: 11 nodos en 4 niveles
  await expect(page.locator('#toc-list a')).toHaveCount(nodos);
  // El cuarto nivel existe en el DOM, pulsable y con su sangría propia.
  const hondo = page.locator(`#toc-list a[data-toc-href="${href(byId('c1-b1x'))}"]`);
  await expect(hondo).toHaveClass(/subitem--deep/);
  await expect(hondo).toHaveAttribute('aria-level', '4');
});

test('cada entrada dice la página de SU ancla, no la del inicio del capítulo', async ({ page }) => {
  await abrir(page);
  const pag = (n: Node) => page.locator(`#toc-list a[data-toc-href="${href(n)}"] .toc-page`).textContent().then(Number);
  // Las que haya en el índice, en orden de lectura (todas, si el índice está entero: eso lo
  // exige el test anterior; aquí solo se juzgan los números).
  const pintadas = await page.locator('#toc-list a').evaluateAll((as) => as.map((a) => (a as HTMLElement).dataset.tocHref!.split('#')[1]));
  const orden = pintadas.map(byId);
  const paginas: number[] = [];
  for (const n of orden) paginas.push(await pag(n));
  // Antes: las de un fichero fuera de pantalla, todas iguales a la de su capítulo. Ahora:
  // estrictamente crecientes en orden de lectura (cada ancla cae en su propia location).
  for (let i = 1; i < paginas.length; i++) expect(paginas[i], `${orden[i].label} tras ${orden[i - 1].label}: ${paginas}`).toBeGreaterThan(paginas[i - 1]);

  // Y cada número es donde de verdad cae el ancla: saltar desde el índice y medir.
  for (const id of ['c1-b', 'c1-b1x', 'c2-a', 'c2-b1']) {
    const n = byId(id);
    await page.evaluate(async (h) => { const E: any = await import('/js/epub-reader.js'); await E.goTo(h); }, href(n));
    await expect.poll(() => paginaReal(page), { message: n.label }).toBe(await pag(n));
  }
});

test('la marca sigue a la sección que se lee, también desplazándose sin el índice', async ({ page }) => {
  await abrir(page);
  const ir = (id: string) => page.evaluate(async (h) => { const E: any = await import('/js/epub-reader.js'); await E.goTo(h); }, href(byId(id)));

  // Salto a una entrada de cuarto nivel: marcada ella, no su capítulo.
  await ir('c1-b1x');
  await expect.poll(() => marcada(page)).toBe('Uno B1 equis');
  await expect(page.locator('#progress-chapter')).toHaveText('Uno B1 equis');

  // Sin tocar el índice: desplazar el lector hasta que el título de «Uno B2» quede arriba.
  // En scroll epub.js no avisa de cambio de capítulo dentro del fichero; la marca tiene que
  // moverse igual.
  await page.evaluate(() => {
    const sc = document.querySelector('#epub-container .epub-container') as HTMLElement;
    const ifr = document.querySelector('#epub-container iframe') as HTMLIFrameElement;
    const el = ifr.contentDocument!.getElementById('c1-b2')!;
    const delta = el.getBoundingClientRect().top + ifr.getBoundingClientRect().top - sc.getBoundingClientRect().top;
    sc.scrollTop += delta + 40;
  });
  await expect.poll(() => marcada(page)).toBe('Uno B2');

  // Un poco hacia atrás, de vuelta dentro de B1 equis: la marca también vuelve.
  await page.evaluate(() => {
    const sc = document.querySelector('#epub-container .epub-container') as HTMLElement;
    sc.scrollTop -= 200;
  });
  await expect.poll(() => marcada(page)).toBe('Uno B1 equis');

  // La sección final corta no puede subir al borde superior: igualmente es la marcada.
  await ir('c1-c');
  await expect.poll(() => marcada(page)).toBe('Uno C final corta');
  expect(await page.locator('#toc-list a.current').count()).toBe(1);
});
