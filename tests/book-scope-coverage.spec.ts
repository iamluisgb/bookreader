import { test, expect } from '@playwright/test';

// Cobertura del muestreo de LIBRO ENTERO (infografía, resumen, skim del agente). Caso real que lo
// destapó: la infografía de «Protocols» salió de solo dos capítulos. Tres causas encadenadas, una
// por test: el índice anidado aplanado a su primer nivel, el muestreo que solo tomaba el arranque
// de cada capítulo (y las notas) y el compositor que se quedaba con las ideas del último trozo.

// Índice anidado como el de Protocols: cada protocolo es su propio fichero dentro de su parte.
const NESTED_TOC = [
  { label: 'Introduction', href: 'Text/intro.xhtml' },
  {
    label: 'Chapter 1: Sleep',
    href: 'Text/ch1.xhtml',
    subitems: [
      { label: 'Sleep Protocol 1', href: 'Text/ch1-p1.xhtml' },
      { label: 'Sleep Protocol 2', href: 'Text/ch1-p2.xhtml' },
      // Ancla dentro del mismo fichero: el segmentador nunca abre capítulo aquí.
      { label: 'What to do', href: 'Text/ch1-p2.xhtml#todo' },
    ],
  },
  {
    label: 'Chapter 2: Light',
    href: 'Text/ch2.xhtml',
    subitems: [{ label: 'Light Protocol 1', href: 'Text/ch2-p1.xhtml' }],
  },
  { label: 'Notes', href: 'Text/notes.xhtml' },
];

test('tocChapterLabels aplana el índice anidado con el criterio del segmentador', async ({ page }) => {
  await page.goto('/');
  const labels = await page.evaluate(async (toc) => {
    const S = await import('/js/ai/segment.js');
    return S.tocChapterLabels(toc);
  }, NESTED_TOC);
  expect(labels).toEqual([
    'Introduction',
    'Chapter 1: Sleep',
    'Sleep Protocol 1',
    'Sleep Protocol 2',
    'Chapter 2: Light',
    'Light Protocol 1',
    'Notes',
  ]);
});

test('con las etiquetas aplanadas, cada protocolo es capítulo y entra en la muestra', async ({ page }) => {
  await page.goto('/');
  const res = await page.evaluate(async (toc) => {
    const S = await import('/js/ai/segment.js');
    const R = await import('/js/ai/retrieval.js');
    const Sum = await import('/js/ai/summary.js');
    // Libro anotado como lo deja segmentBook: un `## etiqueta` por fichero del spine.
    const lines: string[] = [];
    let n = 0;
    for (const ch of ['Introduction', 'Chapter 1: Sleep', 'Sleep Protocol 1', 'Sleep Protocol 2',
      'Chapter 2: Light', 'Light Protocol 1', 'Notes']) {
      lines.push(`## ${ch}`);
      for (let i = 0; i < 6; i++) lines.push(`[[a${n++}]] ${ch} passage ${i} with enough words to cost tokens.`);
    }
    const annotated = lines.join('\n');
    const chaptersSeen = (labels: string[]) =>
      new Set(R.parsePassages(annotated, new Map(), labels).map((p: any) => p.chapter)).size;
    const before = chaptersSeen(toc.map((t: any) => t.label));          // solo primer nivel
    const labels = S.tocChapterLabels(toc);
    R.buildIndex('nested', R.parsePassages(annotated, new Map(), labels));
    const C = await import('/js/ai/context.js');
    const cost = C.estimateTokens('Sleep Protocol 1 passage 0 with enough words to cost tokens.') + 4;
    // Presupuesto para un pasaje por capítulo de cuerpo (6 capítulos, notas fuera).
    const picked = Sum.bookScopePassages(() => {}, cost * 6 + 2);
    return { before, after: chaptersSeen(labels), chapters: [...new Set(picked.map((p: any) => p.chapter))] };
  }, NESTED_TOC);
  expect(res.before).toBe(4);   // el fallo: los protocolos se fundían en su parte
  expect(res.after).toBe(7);
  expect(res.chapters).toEqual([
    'Introduction', 'Chapter 1: Sleep', 'Sleep Protocol 1', 'Sleep Protocol 2', 'Chapter 2: Light', 'Light Protocol 1',
  ]);
});

test('spreadOrder reparte la muestra por todo el capítulo y es una permutación', async ({ page }) => {
  await page.goto('/');
  const res = await page.evaluate(async () => {
    const S = await import('/js/ai/summary.js');
    const sizes = [0, 1, 2, 3, 7, 26, 100, 1137];
    const perms = sizes.map((n) => {
      const o = S.spreadOrder(n);
      return o.length === n && new Set(o).size === n && o.every((i: number) => i >= 0 && i < n);
    });
    return { perms, first4: S.spreadOrder(100).slice(0, 4), first2: S.spreadOrder(2) };
  });
  expect(res.perms.every(Boolean)).toBe(true);
  expect(res.first4).toEqual([0, 50, 25, 75]); // principio, mitad, cuartos: no el arranque
  expect(res.first2).toEqual([0, 1]);
});

test('bookScopePassages con presupuesto corto no se queda en el arranque ni coge notas', async ({ page }) => {
  await page.goto('/');
  const res = await page.evaluate(async () => {
    const R = await import('/js/ai/retrieval.js');
    const S = await import('/js/ai/summary.js');
    const C = await import('/js/ai/context.js');
    const SENT = 'Uniform passage with a fixed length so every token cost is equal here.';
    const lines = ['## 1. Alpha'];
    for (let i = 0; i < 20; i++) lines.push(`[[a${i}]] ${SENT}`);
    lines.push('## Notes');
    for (let i = 20; i < 40; i++) lines.push(`[[a${i}]] ${SENT}`);
    R.buildIndex('spread', R.parsePassages(lines.join('\n'), new Map(), ['1. Alpha', 'Notes']));
    const cost = C.estimateTokens(SENT) + 4;
    return S.bookScopePassages(() => {}, cost * 4).map((p: any) => p.id);
  });
  expect(res).toEqual(['a0', 'a5', 'a10', 'a15']);   // repartido por el capítulo, sin notas
});

test('la infografía mete la muestra entera en sus trozos y agrupa ideas por capítulo', async ({ page }) => {
  await page.goto('/');
  const res = await page.evaluate(async () => {
    const IG = await import('/js/ai/infographic.js');
    const F = await import('/js/ai/flashcards.js');
    // ~30k tokens en pasajes de ~150: con el trozo fijo de 10k salía un cuarto trozo.
    const text = 'x'.repeat(584);
    const passages = Array.from({ length: 200 }, (_, i) => ({ id: `a${i}`, chapter: `Ch ${Math.floor(i / 20)}`, text }));
    const chunks = F.buildChunks(passages, IG.mapChunkTokens(passages));
    const fixed = F.buildChunks(passages, 10000);
    const small = IG.mapChunkTokens(passages.slice(0, 10));
    const chapterOf = new Map([['a1', 'Sleep'], ['a2', 'Sleep'], ['a9', 'Light']]);
    const grouped = IG.groupCandidates(
      ['**A**: uno. [[a1]]', '**B**: dos. [[a9]]', '**C**: tres. [[a2]]', '**D**: sin ancla.'],
      chapterOf,
    );
    const flat = IG.groupCandidates(['**A**: uno. [[a1]]', '**C**: tres. [[a2]]'], chapterOf);
    return { n: chunks.length, fixedN: fixed.length, small, grouped, flat };
  });
  expect(res.fixedN).toBe(4);   // el fallo: el cuarto trozo se descartaba con el slice
  expect(res.n).toBeLessThanOrEqual(3);
  expect(res.small).toBe(10000); // libro corto: mismo trozo de siempre, una sola llamada
  expect(res.grouped).toBe(
    '## Sleep\n- **A**: uno. [[a1]]\n- **C**: tres. [[a2]]\n\n## Light\n- **B**: dos. [[a9]]\n\n## (sin capítulo)\n- **D**: sin ancla.',
  );
  expect(res.flat).toBe('- **A**: uno. [[a1]]\n- **C**: tres. [[a2]]'); // un solo capítulo: lista plana
});

test('chapterPassages: el capítulo entero si cabe; si no, repartido y sin titulares', async ({ page }) => {
  await page.goto('/');
  const res = await page.evaluate(async () => {
    const IG = await import('/js/ai/infographic.js');
    const C = await import('/js/ai/context.js');
    const SENT = 'Uniform passage with a fixed length so every token cost is equal here.';
    const list = [{ id: 'a0', text: 'Sleep Protocol 1', chapter: 'Sleep Protocol 1', section: '' }];
    for (let i = 1; i <= 20; i++) list.push({ id: `a${i}`, text: SENT, chapter: 'Sleep Protocol 1', section: '' });
    const cost = C.estimateTokens(SENT) + 4;
    return {
      all: IG.chapterPassages(list, 1e9).map((p: any) => p.id),
      four: IG.chapterPassages(list, cost * 4).map((p: any) => p.id),
    };
  });
  expect(res.all.length).toBe(20);
  expect(res.all[0]).toBe('a1');                       // el titular no entra
  expect(res.four).toEqual(['a1', 'a6', 'a11', 'a16']); // repartido por el capítulo, en orden
});
