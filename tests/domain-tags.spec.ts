import { test, expect } from '@playwright/test';

// WU2a · Módulo puro de dominios para el post-filtro de la revisión de flashcards
// (odd/tasks/flashcards-dominio.md). Sin API, sin DOM, sin llm.js/db.js: igual que
// card-plan.spec.ts, importa el módulo y ejercita las funciones puras directamente.

test('normalizeDomain: trims, collapses whitespace, caps length, falsy → ""', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async () => {
    const DT: any = await import('/js/ai/domain-tags.js');
    return {
      spaces: DT.normalizeDomain('  Bio   informática \t médica '),
      capped: DT.normalizeDomain('x'.repeat(60)).length,
      collapsed: DT.normalizeDomain('a\nb\t c'),
      empty: DT.normalizeDomain('   '),
      falsy0: DT.normalizeDomain(''),
      falsy1: DT.normalizeDomain(null as any),
      falsy2: DT.normalizeDomain(undefined as any),
      falsy3: DT.normalizeDomain(0 as any),
    };
  });
  expect(r.spaces).toBe('Bio informática médica');
  expect(r.capped).toBe(40);
  expect(r.collapsed).toBe('a b c');
  expect(r.empty).toBe('');
  expect(r.falsy0).toBe('');
  expect(r.falsy1).toBe('');
  expect(r.falsy2).toBe('');
  expect(r.falsy3).toBe('');
});

test('parseDomainSuggestions: clean array, prose/fences/<think> around it, exact n', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async () => {
    const DT: any = await import('/js/ai/domain-tags.js');
    const labels = ['Grafos de conocimiento', 'Biomedicina', 'LLMs'];
    return {
      clean: DT.parseDomainSuggestions(JSON.stringify(labels), 3),
      fenced: DT.parseDomainSuggestions('Claro:\n```json\n' + JSON.stringify(labels) + '\n```', 3),
      reasoning: DT.parseDomainSuggestions('<think>pensando…</think>\n' + JSON.stringify(labels), 3),
      prose: DT.parseDomainSuggestions('Aquí tienes:\n' + JSON.stringify(labels) + '\nSaludos.', 3),
      fewer: DT.parseDomainSuggestions(JSON.stringify(labels), 5),   // menos de n → lo que haya
      more: DT.parseDomainSuggestions(JSON.stringify(labels), 2),    // más de n → recorta a n
    };
  });
  const expectLabels = ['Grafos de conocimiento', 'Biomedicina', 'LLMs'];
  expect(r.clean).toEqual(expectLabels);
  expect(r.fenced).toEqual(expectLabels);
  expect(r.reasoning).toEqual(expectLabels);
  expect(r.prose).toEqual(expectLabels);
  expect(r.fewer).toEqual(expectLabels);
  expect(r.more).toEqual(expectLabels.slice(0, 2));
});

test('parseDomainSuggestions: truncated, garbage and non-strings → [] or best effort, NEVER throws', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async () => {
    const DT: any = await import('/js/ai/domain-tags.js');
    return {
      truncated: DT.parseDomainSuggestions('["Grafos","Biom', 2),
      garbage: DT.parseDomainSuggestions('no hay nada útil [[ {', 2),
      empty: DT.parseDomainSuggestions('', 2),
      nullish: DT.parseDomainSuggestions(null as any, 2),
      nonStrings: DT.parseDomainSuggestions('[1, "Grafos", null, true, "Biomedicina"]', 4),
      emptyDropped: DT.parseDomainSuggestions('["", "Grafos", "   "]', 3),
      overlongDropped: DT.parseDomainSuggestions(JSON.stringify(['y'.repeat(80), 'Grafos']), 2),
      zeroN: DT.parseDomainSuggestions('["Grafos"]', 0),
    };
  });
  expect(r.truncated).toEqual([]);                       // truncado → nada aprovechable
  expect(r.garbage).toEqual([]);
  expect(r.empty).toEqual([]);
  expect(r.nullish).toEqual([]);
  expect(r.nonStrings).toEqual(['Grafos', 'Biomedicina']); // no-strings fuera, best effort
  expect(r.emptyDropped).toEqual(['Grafos']);              // vacíos fuera
  expect(r.overlongDropped).toEqual(['Grafos']);           // sobre-longitud fuera
  expect(r.zeroN).toEqual([]);
});

test('groupCardsByDomain: first-appearance order, no-domain cards share the "" group', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async () => {
    const DT: any = await import('/js/ai/domain-tags.js');
    const cards = [
      { front: 'a', domain: 'Física' },
      { front: 'b' },                              // sin domain → grupo ''
      { front: 'c', domain: 'Química' },
      { front: 'd', domain: 'Física' },
      { front: 'e', domain: '' },                  // vacío cuenta como sin dominio
      { front: 'f', domain: 'Química' },
    ];
    return { groups: DT.groupCardsByDomain(cards), none: DT.groupCardsByDomain([]), nullish: DT.groupCardsByDomain(null as any) };
  });
  expect(r.groups).toEqual([
    { domain: 'Física', indices: [0, 3] },
    { domain: '', indices: [1, 4] },          // aparece en el índice 1: primera aparición antes que Química
    { domain: 'Química', indices: [2, 5] },
  ]);
  expect(r.none).toEqual([]);
  expect(r.nullish).toEqual([]);
});

test('domainTagMessages: system/user data contract, numbered fronts with chapters, JSON-array-only output', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async () => {
    const DT: any = await import('/js/ai/domain-tags.js');
    return {
      es: DT.domainTagMessages(['¿Qué es un grafo?', 'Genoma humano'], ['Cap 1', 'Apéndice'], 'es'),
      en: DT.domainTagMessages(['What is a graph?'], ['Ch 1'], 'en'),
      noLang: DT.domainTagMessages(['Pregunta'], ['Cap'], ''),
    };
  });
  // Forma de datos plana: dos mensajes, roles correctos.
  expect(r.es.system).toBeTruthy();
  expect(r.es.user).toBeTruthy();
  // El system pide SOLO un array JSON de n strings, en orden, etiquetas cortas.
  expect(r.es.system).toContain('JSON');
  expect(r.es.system).toContain('mismo orden');
  expect(r.es.system).toContain('1-3');
  // El user numera los frentes y nombra el capítulo de cada uno.
  expect(r.es.user).toContain('1. ¿Qué es un grafo?');
  expect(r.es.user).toContain('Cap 1');
  expect(r.es.user).toContain('2. Genoma humano');
  // Idioma de las etiquetas: la directiva nombra el idioma explícito o "el de los frentes".
  expect(r.es.system).toContain('español');
  expect(r.en.system).toContain('inglés');
  expect(r.noLang.system).not.toContain('español');
  expect(r.noLang.system).not.toContain('inglés');
});
