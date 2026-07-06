import { test, expect } from '@playwright/test';

// PDF1 · Segmentador de PDF: produce el mismo "libro anotado" que el EPUB ([[aN]] + anclas)
// pero con locator de PÁGINA y capítulos por getOutline(). Probamos la lógica real con un
// pdfDoc *mock* (contrato de pdf.js: numPages/getPage/getTextContent/getOutline/…), sin
// depender de un binario PDF con outline (imposible de tallar a mano de forma fiable).

async function run(page, spec) {
  return page.evaluate(async (s) => {
    const { segmentPdf } = await import('/js/ai/segment-pdf.js');
    const mkDoc = (pages, outline) => ({
      numPages: pages.length,
      async getPage(p) {
        return { async getTextContent() { return { items: pages[p - 1] }; }, cleanup() {} };
      },
      async getOutline() { return outline?.entries || null; },
      async getDestination(name) { return outline?.dests[name] || null; },
      async getPageIndex(ref) { return ref.page - 1; },   // 0-based
    });
    const doc = mkDoc(s.pages, s.outline);
    const seg = await segmentPdf(doc);
    // Serializamos anchors (Map) para poder afirmarlo fuera del navegador.
    return { ...seg, anchors: [...seg.anchors.entries()] };
  }, spec);
}

// Líneas de texto: cada item {str, hasEOL}. hasEOL cierra la línea (fiable en pdf.js 3.x).
const line = (str) => ({ str, hasEOL: true });

test('extrae pasajes con anclas por página y capítulos del outline', async ({ page }) => {
  await page.goto('/index.html');
  const seg = await run(page, {
    pages: [
      [line('The quick brown fox jumps over the lazy dog again and again today.')],
      [line('Consistency and consensus are central themes discussed at length here.')],
      [line('Chapter two opens with a new idea about distributed systems and time.')],
      [line('More elaboration follows on clocks, ordering and causality in systems.')],
    ],
    outline: {
      entries: [
        { title: 'Chapter One', dest: 'c1' },
        { title: 'Chapter Two', dest: 'c2' },
      ],
      dests: { c1: [{ page: 1 }, { name: 'XYZ' }], c2: [{ page: 3 }, { name: 'XYZ' }] },
    },
  });

  expect(seg.scanned).toBe(false);
  expect(seg.blockCount).toBeGreaterThan(0);
  expect(seg.pages).toBe(4);
  expect(seg.tocLabels).toEqual(['Chapter One', 'Chapter Two']);

  // Los marcadores de capítulo salen en el texto anotado.
  expect(seg.annotatedText).toContain('## Chapter One');
  expect(seg.annotatedText).toContain('## Chapter Two');

  // Atribución: las anclas de las páginas 1-2 son "Chapter One"; las de 3-4 "Chapter Two".
  const byPage = Object.fromEntries(seg.anchors.map(([, a]) => [a.page, a.chapter]));
  expect(byPage[1]).toBe('Chapter One');
  expect(byPage[2]).toBe('Chapter One');
  expect(byPage[3]).toBe('Chapter Two');
  expect(byPage[4]).toBe('Chapter Two');

  // Toda ancla lleva un número de página válido (locator de la cita en PDF).
  for (const [id, a] of seg.anchors) {
    expect(id).toMatch(/^a\d+$/);
    expect(a.page).toBeGreaterThanOrEqual(1);
    expect(a.page).toBeLessThanOrEqual(4);
  }
});

test('las subsecciones del outline heredan el capítulo padre (no lo roban)', async ({ page }) => {
  await page.goto('/index.html');
  const seg = await run(page, {
    pages: [
      [line('Chapter one intro paragraph about the overall topic being introduced now.')],
      [line('The subsection dives deeper into one specific detail of the same chapter here.')],
      [line('Chapter two begins a completely different discussion on another matter.')],
    ],
    outline: {
      entries: [
        // "A Subsection" cuelga de "Chapter One" (nivel 1) → NO debe abrir capítulo.
        { title: 'Chapter One', dest: 'c1', items: [{ title: 'A Subsection', dest: 'sub' }] },
        { title: 'Chapter Two', dest: 'c2' },
      ],
      dests: { c1: [{ page: 1 }], sub: [{ page: 2 }], c2: [{ page: 3 }] },
    },
  });

  // La subsección NO es una etiqueta de capítulo (no entra en el router/MAPA).
  expect(seg.tocLabels).toEqual(['Chapter One', 'Chapter Two']);
  // Pero SÍ aparece como marcador estructural en el texto.
  expect(seg.annotatedText).toContain('## A Subsection');

  // La página 2 (bajo la subsección) sigue atribuida a "Chapter One", no a la subsección.
  const byPage = Object.fromEntries(seg.anchors.map(([, a]) => [a.page, a.chapter]));
  expect(byPage[2]).toBe('Chapter One');
  expect(byPage[3]).toBe('Chapter Two');
});

test('las "Parts" son contenedores: los capítulos reales son sus hijos', async ({ page }) => {
  await page.goto('/index.html');
  const seg = await run(page, {
    pages: [
      [line('Front matter with acknowledgments and prefaces occupying this page fully.')],
      [line('Part one opens and chapter one immediately explains graphs in detail here.')],
      [line('Chapter two continues the first part with large language models content.')],
      [line('Part two starts with chapter three about building knowledge graphs today.')],
    ],
    outline: {
      entries: [
        { title: 'acknowledgments', dest: 'ack' },
        { title: 'Part 1 Foundations', dest: 'p1', items: [
          { title: '1 Knowledge graphs', dest: 'c1', items: [{ title: '1.1 Basics', dest: 's11' }] },
          { title: '2 LLMs', dest: 'c2' },
        ] },
        { title: 'Part 2 Building', dest: 'p2', items: [
          { title: '3 Structured sources', dest: 'c3' },
        ] },
      ],
      dests: {
        ack: [{ page: 1 }], p1: [{ page: 2 }], c1: [{ page: 2 }], s11: [{ page: 3 }],
        c2: [{ page: 3 }], p2: [{ page: 4 }], c3: [{ page: 4 }],
      },
    },
  });

  // Los capítulos del TOC/router son los HIJOS de las Parts (más el front matter);
  // las Parts NO aparecen como capítulo.
  expect(seg.tocLabels).toEqual(['acknowledgments', '1 Knowledge graphs', '2 LLMs', '3 Structured sources']);

  // Atribución por página: los capítulos ganan a la Part que empieza en la misma página.
  const byPage = Object.fromEntries(seg.anchors.map(([, a]) => [a.page, a.chapter]));
  expect(byPage[2]).toBe('1 Knowledge graphs');
  expect(byPage[3]).toBe('2 LLMs');           // '1.1 Basics' (subsección) no roba el capítulo
  expect(byPage[4]).toBe('3 Structured sources');
});

test('detecta PDF escaneado (páginas sin texto seleccionable)', async ({ page }) => {
  await page.goto('/index.html');
  const seg = await run(page, {
    pages: [[], [line('')], []],   // sin texto extraíble
    outline: null,
  });
  expect(seg.scanned).toBe(true);
  expect(seg.blockCount).toBe(0);
});

test('une los guiones de corte de línea (de-hyphenation)', async ({ page }) => {
  await page.goto('/index.html');
  const seg = await run(page, {
    pages: [[
      { str: 'This paragraph talks about the over-', hasEOL: true },
      { str: 'all architecture of the whole distributed reading system in detail.', hasEOL: true },
    ]],
    outline: null,
  });
  expect(seg.annotatedText).toContain('overall architecture');
  expect(seg.annotatedText).not.toContain('over- all');
});
