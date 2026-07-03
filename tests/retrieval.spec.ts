import { test, expect } from '@playwright/test';

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
