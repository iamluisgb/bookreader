import { test, expect } from '@playwright/test';
import path from 'path';

// IA5 · Retrieval por pasaje. Tests deterministas del módulo (sin depender de un EPUB):
// se ejercita en el navegador importando el módulo real, con texto anotado sintético que
// reproduce el fallo real de DDIA — un capítulo del TOC con muchos SUBTÍTULOS (H2/H3),
// que segment.js también emite como `## `. La atribución de capítulo debe seguir siendo
// la del TOC, no la del subtítulo; si no, `passagesByChapter("9. …")` no recupera nada.

const ANNOTATED = [
  '## 8. The Trouble with Distributed Systems',
  '[[a0]] Networks are unreliable and messages can be lost or delayed.',
  '## Unreliable Clocks',
  '[[a1]] Clocks drift and cannot be fully trusted across nodes.',
  '## 9. Consistency and Consensus',
  '[[a2]] This chapter covers consistency guarantees and consensus.',
  '## Linearizability',              // subtítulo (NO es del TOC): hereda el Cap. 9
  '[[a3]] Linearizability is the strongest single-object consistency model.',
  '## Total Order Broadcast',        // subtítulo
  '[[a4]] Total order broadcast is equivalent to consensus.',
  '## Fault-Tolerant Consensus',     // subtítulo
  '[[a5]] Consensus algorithms like Raft and Paxos let nodes agree on a value.',
  '## 10. Batch Processing',
  '[[a6]] MapReduce processes large datasets in batch across many machines.',
].join('\n');

const TOC = [
  '8. The Trouble with Distributed Systems',
  '9. Consistency and Consensus',
  '10. Batch Processing',
];

test('retrieval attributes sub-heading passages to their TOC chapter', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async ({ annotated, toc }) => {
    const R = await import('/js/ai/retrieval.js');
    R.buildIndex('t', R.parsePassages(annotated, new Map(), toc));
    const ch9 = R.passagesByChapter('9. Consistency and Consensus').map((p: any) => p.id);
    return {
      ch9,
      routedNum: R.matchChapters('flashcards del capítulo 9', toc),
      routedEn: R.matchChapters('make flashcards for chapter 9', toc),
      routedTitle: R.matchChapters('explain consistency and consensus', toc),
      routedNone: R.matchChapters('what is batch mapreduce here', toc).filter((c: string) => /9\./.test(c)),
      bm25: R.search('raft paxos consensus', 3).map((p: any) => p.id),
    };
  }, { annotated: ANNOTATED, toc: TOC });

  // Todo el Cap. 9 (incluidos los pasajes bajo subtítulos) se atribuye al capítulo del TOC.
  expect(r.ch9).toEqual(['a2', 'a3', 'a4', 'a5']);
  // El router lo detecta por número (ES/EN) y por título; no da falsos positivos.
  expect(r.routedNum).toContain('9. Consistency and Consensus');
  expect(r.routedEn).toContain('9. Consistency and Consensus');
  expect(r.routedTitle).toContain('9. Consistency and Consensus');
  expect(r.routedNone).toEqual([]);
  // BM25 recupera el pasaje de consenso por contenido.
  expect(r.bm25).toContain('a5');
});

// Muchos libros numeran los capítulos en ROMANOS (Lituma: I, II, III…). "capítulo 3"
// debe casar con "III" y recuperar sus pasajes; antes solo se entendían números árabes.
test('el router casa capítulos en números romanos ("capítulo 3" → "III")', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const R: any = await import('/js/ai/retrieval.js');
    const annotated = [
      '## II', '[[a0]] Segundo capítulo sobre pishtacos.',
      '## III', '[[a1]] Tercer capítulo: Casimiro Huarcaya en la cantina.',
      '## IV', '[[a2]] Cuarto capítulo.',
    ].join('\n');
    const toc = ['Primera parte', 'I', 'II', 'III', 'IV', 'Segunda parte'];
    R.buildIndex('roman', R.parsePassages(annotated, new Map(), toc));
    return {
      routed3: R.matchChapters('hazme un resumen del capítulo 3', toc),
      routedRoman: R.matchChapters('resume el capítulo III', toc),
      ch3: R.passagesByChapter('III').map((p: any) => p.id),
      // Un capítulo árabe sigue funcionando (no regresión).
      arabic: R.matchChapters('capítulo 9', ['8. Foo', '9. Bar']),
    };
  });
  expect(r.routed3).toEqual(['III']);        // "3" → "III"
  expect(r.routedRoman).toEqual(['III']);    // "III" en la pregunta también
  expect(r.ch3).toEqual(['a1']);             // recupera los pasajes del capítulo III
  expect(r.arabic).toContain('9. Bar');      // los árabes siguen casando
});

test('sentence-window: cada acierto arrastra sus vecinos del mismo capítulo', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async ({ annotated, toc }) => {
    const R = await import('/js/ai/retrieval.js');
    R.buildIndex('t', R.parsePassages(annotated, new Map(), toc));
    const hit = R.search('raft paxos consensus', 1);                 // → a5 (Fault-Tolerant Consensus)
    const expanded = R.withNeighbors(hit, 1).map((p: any) => p.id).sort();
    return { hit: hit.map((p: any) => p.id), expanded };
  }, { annotated: ANNOTATED, toc: TOC });
  // a5 arrastra a4 (vecino, mismo Cap. 9); NO arrastra a6 (Cap. 10, otra frontera).
  expect(r.hit).toEqual(['a5']);
  expect(r.expanded).toEqual(['a4', 'a5']);
});

test('eval recall@k del retrieval sobre corpus sintético', async ({ page }) => {
  await page.goto('/');
  const golden = [
    { q: 'raft paxos consensus agree on a value', expect: 'a5' },
    { q: 'linearizability strongest consistency model', expect: 'a3' },
    { q: 'networks unreliable messages lost delayed', expect: 'a0' },
    { q: 'mapreduce batch large datasets machines', expect: 'a6' },
  ];
  const recall = await page.evaluate(async ({ annotated, toc, golden }) => {
    const R = await import('/js/ai/retrieval.js');
    R.buildIndex('t', R.parsePassages(annotated, new Map(), toc));
    let hits = 0;
    for (const g of golden) {
      const top = R.search(g.q, 3).map((p: any) => p.id);
      if (top.includes(g.expect)) hits++;
    }
    return hits / golden.length;   // recall@3
  }, { annotated: ANNOTATED, toc: TOC, golden });
  console.log('recall@3 =', recall);
  expect(recall).toBe(1);          // el arnés: floor de recall (regresión si baja)
});

test('isBackMatter/isBoilerplate: licencias y promo fuera; capítulos y apéndices dentro', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const R = await import('/js/ai/retrieval.js');
    return {
      license: R.isBackMatter('THE FULL PROJECT GUTENBERG™ LICENSE'),
      licencia: R.isBackMatter('Licencia'),
      transcriber: R.isBackMatter("Transcriber's Notes"),
      elogios: R.isBackMatter('Elogios para Pedro Páramo'),
      acerca: R.isBackMatter('Acerca del autor'),
      alsoBy: R.isBackMatter('Also by Juan Rulfo'),
      // Contenido REAL que no debe vetarse (conservador a propósito):
      appendix: R.isBackMatter('APPENDIX III THE EXPERIMENTAL CONFIRMATION'),
      chapter: R.isBackMatter('XI. THE LORENTZ TRANSFORMATION'),
      novela: R.isBackMatter('Pedro Páramo'),
      // isBoilerplate = unión con el front matter existente:
      boilerCover: R.isBoilerplate('Cover'),
      boilerLicense: R.isBoilerplate('License'),
      boilerChapter: R.isBoilerplate('9. Consistency and Consensus'),
    };
  });
  expect(r.license).toBe(true);
  expect(r.licencia).toBe(true);
  expect(r.transcriber).toBe(true);
  expect(r.elogios).toBe(true);
  expect(r.acerca).toBe(true);
  expect(r.alsoBy).toBe(true);
  expect(r.appendix).toBe(false);
  expect(r.chapter).toBe(false);
  expect(r.novela).toBe(false);
  expect(r.boilerCover).toBe(true);
  expect(r.boilerLicense).toBe(true);
  expect(r.boilerChapter).toBe(false);
});

// Los subtítulos internos (H2/H3) se parseaban y se TIRABAN: solo abrían capítulo los del
// TOC. Ahora se conservan en `section`, que es la granularidad a la que el libro nombra sus
// conceptos — de ahí salen las sugerencias del modo Feynman sin gastar una llamada.
test('parsePassages guarda el subtítulo vigente sin romper la frontera de capítulo', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const R: any = await import('/js/ai/retrieval.js');
    const text = [
      '## 2. Working with Text Data',
      '[[a1]] Intro del capítulo.',
      '## Byte pair encoding',
      '[[a2]] BPE parte de caracteres sueltos.',
      '[[a3]] Y va fusionando los pares más frecuentes.',
      '## Encoding word positions',
      '[[a4]] Los embeddings posicionales resuelven el orden.',
      '## 3. Coding Attention Mechanisms',
      '[[a5]] Empieza otro capítulo.',
    ].join('\n');
    const toc = ['2. Working with Text Data', '3. Coding Attention Mechanisms'];
    const ps = R.parsePassages(text, new Map(), toc);
    R.buildIndex('k', ps);
    return {
      shape: ps.map((p: any) => [p.id, p.chapter, p.section]),
      // minPassages=2 descarta el titulillo con un solo pasaje debajo (pies de figura y
      // rótulos sueltos, que no son secciones).
      sections: R.sectionsByChapter('2. Working with Text Data'),
      all: R.sectionsByChapter('2. Working with Text Data', 1).map((s: any) => s.label),
      otro: R.sectionsByChapter('3. Coding Attention Mechanisms', 1),
    };
  });
  // El subtítulo NO abre capítulo: los pasajes siguen siendo del capítulo 2.
  expect(r.shape).toEqual([
    ['a1', '2. Working with Text Data', ''],
    ['a2', '2. Working with Text Data', 'Byte pair encoding'],
    ['a3', '2. Working with Text Data', 'Byte pair encoding'],
    ['a4', '2. Working with Text Data', 'Encoding word positions'],
    ['a5', '3. Coding Attention Mechanisms', ''],
  ]);
  expect(r.sections).toEqual([{ label: 'Byte pair encoding', count: 2 }]);
  expect(r.all).toEqual(['Byte pair encoding', 'Encoding word positions']);
  // Abrir capítulo reinicia la sección: el capítulo 3 no hereda subtítulos del 2.
  expect(r.otro).toEqual([]);
});

// Regresión del segmentador: en XHTML (que es como se parsean los capítulos de un EPUB)
// `tagName` CONSERVA la caja del documento, así que el viejo `HEADINGS.has(el.tagName)`
// —un Set en mayúsculas— no casaba nunca y NINGÚN encabezado interno se marcaba como tal.
// El libro anotado salía sin fronteras de sección y todo el aparato que depende de ellas
// (las sugerencias de concepto del modo Feynman) se quedaba a cero.
test('segmentBook marca los encabezados internos y los conserva como pasaje', async ({ page }) => {
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', path.join(__dirname, 'test.epub'));
  await page.waitForSelector('#epub-container iframe', { timeout: 15000 });
  const r = await page.evaluate(async () => {
    const Epub: any = await import('/js/epub-reader.js');
    const Seg: any = await import('/js/ai/segment.js');
    const seg = await Seg.segmentBook(Epub.getBook());
    const lines = seg.annotatedText.split('\n');
    const heads = lines.filter((l: string) => l.startsWith('## '));
    // Todo `## X` debe tener su pasaje `[[aN]] X`: el encabezado marca frontera Y sigue
    // indexado (si desapareciera del índice, se moverían las anclas y las citas guardadas
    // dejarían de apuntar donde apuntaban).
    const bodies = new Set(lines.map((l: string) => (l.match(/^\[\[a\d+\]\]\s+(.*)$/) || [])[1]).filter(Boolean));
    return {
      heads: heads.length,
      headsSinPasaje: heads.map((h: string) => h.slice(3).trim()).filter((h: string) => !bodies.has(h)).slice(0, 3),
    };
  });
  expect(r.heads).toBeGreaterThan(0);
  expect(r.headsSinPasaje).toEqual([]);
});
