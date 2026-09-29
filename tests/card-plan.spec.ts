import { test, expect } from '@playwright/test';
import { seedProLicense } from './pro-license';

// WU4 · Planificador de tarjetas por capítulo: lista de capítulos, reparto proporcional
// (fallback), prompt del planificador, parseo tolerante y — el corazón — la validación
// determinista de la respuesta del agente. suggestPlan se testea con fetch stubbeado
// (mismo shape SSE que usan visual-cards.spec.ts y llm.spec.ts): cero llamadas reales.

// estimateTokens = round(len/4) por PASAJE; los textos de prueba son de longitud controlada.
const INTRO_1 = 'primer pasaje de la introducción con contenido';
const INTRO_2 = 'segundo pasaje';

const CHAPTERS = [
  { name: 'Algebra', tokens: 800 },
  { name: 'Geometría', tokens: 600 },
  { name: 'Topología', tokens: 200 },
  { name: 'Lógica', tokens: 200 },
];
// Reparto proporcional de 20 entre CHAPTERS (mismo criterio que allocateCounts):
// mínimo 1 cada uno, resto 16 proporcional a tokens, fracción a los mayores → 8/6/3/3.
const PROP_20 = [8, 6, 3, 3];

test('chapterList: groups in order, drops boilerplate and malformed, sums tokens, clips sample', async ({ page }) => {
  await page.goto('/index.html');
  const passages = [
    { chapter: 'Introducción', text: INTRO_1 },
    { chapter: 'Introducción', text: INTRO_2 },
    { chapter: 'Índice', text: 'cover index credits' },          // front matter → fuera
    { chapter: 'Licencia', text: 'project gutenberg license' },  // back matter → fuera
    { chapter: 'Método', text: 'texto del método' },
    null, { text: 'sin capítulo' }, { chapter: 'Sin título', text: 42 }, { chapter: '  ', text: 'x' },
  ];
  const r = await page.evaluate(async (ps: any) => {
    const CP: any = await import('/js/ai/card-plan.js');
    return {
      list: CP.chapterList(ps),
      clipped: CP.chapterList(
        [{ chapter: 'A', text: 'palabra uno dos tres cuatro cinco seis siete ocho nueve' }],
        { maxSample: 20 },
      ).map((c: any) => c.sample),
      empty: CP.chapterList(null as any),
    };
  }, passages);
  // Orden de aparición, accesorios y malformados fuera.
  expect(r.list.map((c: any) => c.name)).toEqual(['Introducción', 'Método']);
  // Tokens sumados: estimateTokens se aplica POR PASAJE (46/4→12, 14/4→4).
  expect(r.list[0].tokens).toBe(Math.round(INTRO_1.length / 4) + Math.round(INTRO_2.length / 4));
  expect(r.list[0].sample).toBe(INTRO_1);
  // Muestra recortada a 20 caracteres sin partir una palabra por la mitad.
  expect(r.clipped[0]).toBe('palabra uno dos');
  expect(r.empty).toEqual([]);
});

test('chapterList: with many chapters keeps the largest, result in appearance order', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async () => {
    const CP: any = await import('/js/ai/card-plan.js');
    const mkCh = (n: number) => Array.from({ length: n }, (_, i) => ({
      chapter: `Cap ${i + 1}`,
      text: 'x'.repeat((i + 1) * 40),   // tokens = 10·(i+1): creciente
    }));
    return {
      byOpt: CP.chapterList(mkCh(6), { maxChapters: 2 }).map((c: any) => c.name),
      defaultCount: CP.chapterList(mkCh(14)).length,
      defaultNames: CP.chapterList(mkCh(14)).map((c: any) => c.name),
    };
  });
  // Con maxChapters 2 ganan los dos más grandes (Cap 5 y Cap 6), devueltos en orden.
  expect(r.byOpt).toEqual(['Cap 5', 'Cap 6']);
  // El tope por defecto es MAX_PLAN_CHAPTERS = 12: de 14 capítulos quedan los 12 grandes.
  expect(r.defaultCount).toBe(12);
  expect(r.defaultNames).toEqual(Array.from({ length: 12 }, (_, i) => `Cap ${i + 3}`));
});

test('proportionalPlan: exact sum, even split for equals, huge chapter dominates', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async (chs: any) => {
    const CP: any = await import('/js/ai/card-plan.js');
    const even = chs.map((c: any) => ({ name: c.name, tokens: 500 }));
    const huge = [{ name: 'Enorme', tokens: 1000 }, { name: 'chico', tokens: 10 }, { name: 'chico2', tokens: 10 }];
    return {
      even: CP.proportionalPlan(even, 20),
      few: CP.proportionalPlan(chs, 2),          // menos tarjetas que capítulos
      huge: CP.proportionalPlan(huge, 20),
      zero: CP.proportionalPlan(chs, 0),
    };
  }, CHAPTERS);
  // 20 entre 4 capítulos parejos → 5/5/5/5, suma exacta.
  expect(r.even.map((p: any) => p.cards)).toEqual([5, 5, 5, 5]);
  expect(r.even.reduce((s: number, p: any) => s + p.cards, 0)).toBe(20);
  // total < nº de capítulos: 1 a los más grandes (por tokens), 0 al resto.
  expect(r.few.map((p: any) => p.cards)).toEqual([1, 1, 0, 0]);
  // Un capítulo enorme se lleva la mayor parte; la suma sigue siendo exacta.
  const [h, a, b] = r.huge.map((p: any) => p.cards);
  expect(h).toBeGreaterThan(a + b);
  expect(h + a + b).toBe(20);
  // Total 0 → todo en 0 (nada que repartir).
  expect(r.zero.every((p: any) => p.cards === 0)).toBe(true);
});

test('buildPlanMessages: asks for the name/cards/reason JSON, names the total, warns it is editable', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async (chs: any) => {
    const CP: any = await import('/js/ai/card-plan.js');
    return CP.buildPlanMessages({ bookTitle: 'Mi Libro', goal: 'aprobar el parcial', chapters: chs, total: 20 });
  }, CHAPTERS);
  expect(r).toHaveLength(2);
  expect(r[0].role).toBe('system');
  expect(r[1].role).toBe('user');
  const sys: string = r[0].content;
  // Contrato de salida SOLO JSON con la forma exacta.
  expect(sys).toContain('"chapters"');
  expect(sys).toContain('"name"');
  expect(sys).toContain('"cards"');
  expect(sys).toContain('"reason"');
  expect(sys).toContain('EXACTO');                       // título exacto de la lista
  expect(sys).toContain('NO inventes capítulos');
  expect(sys).toContain('al menos 1');                   // mínimo por capítulo con contenido
  expect(sys).toContain('densidad de conceptos');        // justificación en reason
  expect(sys).toContain('SUGERENCIA');                   // el lector puede editar
  expect(sys).toContain('editar');
  const user: string = r[1].content;
  expect(user).toContain('TOTAL DE TARJETAS A REPARTIR: 20');
  expect(user).toContain('aprobar el parcial');
  for (const c of CHAPTERS) expect(user).toContain(c.name);
});

test('parsePlan: clean JSON, fences and prose; truncated and garbage → null without throwing', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async () => {
    const CP: any = await import('/js/ai/card-plan.js');
    const plan = { chapters: [{ name: 'A', cards: 3, reason: 'denso' }], total: 10 };
    return {
      clean: CP.parsePlan(JSON.stringify(plan)),
      fenced: CP.parsePlan('Claro:\n```json\n' + JSON.stringify(plan) + '\n```'),
      reasoning: CP.parsePlan('<think>{"x":1}</think>\n' + JSON.stringify(plan)),
      truncated: CP.parsePlan('{"chapters":[{"name":"A","cards":3'),
      garbage: CP.parsePlan('no hay json útil {'),
      empty: CP.parsePlan(''),
      nullish: CP.parsePlan(null as any),
    };
  });
  expect(r.clean).toEqual({ chapters: [{ name: 'A', cards: 3, reason: 'denso' }], total: 10 });
  expect(r.fenced.chapters).toEqual(r.clean.chapters);   // quita fences
  expect(r.reasoning.chapters).toEqual(r.clean.chapters);// ignora <think> y toma el JSON real
  expect(r.truncated).toBeNull();                        // truncado → null (reintento/fallback)
  expect(r.garbage).toBeNull();
  expect(r.empty).toBeNull();
  expect(r.nullish).toBeNull();
});

test('validatePlan: invented name goes to dropped and the plan stays complete', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async (chs: any) => {
    const CP: any = await import('/js/ai/card-plan.js');
    return CP.validatePlan(
      { chapters: [{ name: 'Algebra', cards: 8 }, { name: 'Capítulo inventado', cards: 5 }], total: 20 },
      { chapters: chs, total: 20 },
    );
  }, CHAPTERS);
  expect(r.dropped).toEqual(['Capítulo inventado']);
  // El plan sigue válido: los capítulos no mencionados reciben su reparto proporcional.
  expect(r.plan.map((p: any) => p.cards)).toEqual(PROP_20);
  expect(r.plan.reduce((s: number, p: any) => s + p.cards, 0)).toBe(20);
  expect(r.total).toBe(20);
  expect(r.adjusted).toBe(false);   // los números del agente no necesitaban corrección
});

test('validatePlan: non-integer (or negative) cards drops the entry', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async (chs: any) => {
    const CP: any = await import('/js/ai/card-plan.js');
    return CP.validatePlan(
      { chapters: [
        { name: 'Algebra', cards: 2.5 },   // no entero → fuera
        { name: 'Geometría', cards: -1 },  // negativo → fuera
        { name: 'Topología', cards: 4 },   // válido
      ], total: 20 },
      { chapters: chs, total: 20 },
    );
  }, CHAPTERS);
  expect(r.dropped).toEqual(['Algebra', 'Geometría']);
  // Los descartados y el no mencionado vuelven a su reparto proporcional; Topología pidió
  // 4 pero la suma (21) se normaliza al total bajando al que excede su proporcional (3).
  expect(r.plan.find((p: any) => p.name === 'Geometría').cards).toBe(6);
  expect(r.plan.find((p: any) => p.name === 'Topología').cards).toBe(3);
  expect(r.plan.reduce((s: number, p: any) => s + p.cards, 0)).toBe(20);
});

test('validatePlan: exaggerated number gets the 3× cap and adjusted=true', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async (chs: any) => {
    const CP: any = await import('/js/ai/card-plan.js');
    return CP.validatePlan(
      { chapters: [{ name: 'Algebra', cards: 100 }], total: 20 },
      { chapters: chs, total: 20 },
    );
  }, CHAPTERS);
  expect(r.adjusted).toBe(true);
  expect(r.notes.some((n: string) => n.includes('tope'))).toBe(true);
  // Tope 3×8=24 aplicado; después la suma se normaliza a 20 quitando el excedente
  // (el único capítulo por encima de su proporcional), así que vuelve a 8.
  expect(r.plan.find((p: any) => p.name === 'Algebra').cards).toBe(8);
  expect(r.plan.reduce((s: number, p: any) => s + p.cards, 0)).toBe(20);
});

test('validatePlan: unmentioned chapters get their proportional share and the sum matches', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async (chs: any) => {
    const CP: any = await import('/js/ai/card-plan.js');
    return CP.validatePlan(
      { chapters: [{ name: 'Algebra', cards: 10 }], total: 20 },
      { chapters: chs, total: 20 },
    );
  }, CHAPTERS);
  expect(r.plan).toHaveLength(4);                        // todos los capítulos están
  expect(r.plan.map((p: any) => p.cards).every((n: number) => n >= 1)).toBe(true);
  expect(r.plan.reduce((s: number, p: any) => s + p.cards, 0)).toBe(20);   // EXACTAMENTE el total
  // Los no mencionados arrancan de su proporcional; el ajuste de suma toca al que más
  // margen tiene (Algebra, que excedía su proporcional) → 10 - 2 = 8.
  expect(r.plan.find((p: any) => p.name === 'Geometría').cards).toBe(6);
  expect(r.plan.find((p: any) => p.name === 'Topología').cards).toBe(3);
});

test('validatePlan: exact agent plan passes untouched; empty plan stays empty', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async (chs: any) => {
    const CP: any = await import('/js/ai/card-plan.js');
    return {
      exact: CP.validatePlan(
        { chapters: chs.map((c: any, i: number) => ({ name: c.name, cards: [6, 7, 4, 3][i], reason: 'ok' })), total: 20 },
        { chapters: chs, total: 20 },
      ),
      emptyNull: CP.validatePlan(null as any, { chapters: chs, total: 20 }),
      emptyArr: CP.validatePlan({ chapters: [] }, { chapters: chs, total: 20 }),
      allInvalid: CP.validatePlan({ chapters: [{ name: 'X', cards: 'mucho' }] }, { chapters: chs, total: 20 }),
      fewer: CP.validatePlan({ chapters: [{ name: 'Algebra', cards: 1 }] }, { chapters: chs, total: 2 }),
      capped: CP.validatePlan(
        { chapters: [{ name: 'Cap 1', cards: 5 }], total: 20 },
        { chapters: Array.from({ length: 14 }, (_, i) => ({ name: `Cap ${i + 1}`, tokens: 100 })), total: 20 },
      ),
      noTotal: CP.validatePlan({ chapters: [{ name: 'Algebra', cards: 5 }] }, { chapters: chs, total: 0 }),
    };
  }, CHAPTERS);
  // Plan que ya cuadra: ni tope ni normalización → adjusted false.
  expect(r.exact.adjusted).toBe(false);
  expect(r.exact.plan.map((p: any) => p.cards)).toEqual([6, 7, 4, 3]);
  expect(r.exact.plan.every((p: any) => p.cards >= 1)).toBe(true);
  // Sin entradas utilizables: plan vacío para que el caller caiga al fallback.
  expect(r.emptyNull.plan).toEqual([]);
  expect(r.emptyArr.plan).toEqual([]);
  expect(r.allInvalid.plan).toEqual([]);
  // total < nº de capítulos: reparto proporcional puro (1 a los más grandes), ajustado.
  expect(r.fewer.plan.map((p: any) => p.cards)).toEqual([1, 1, 0, 0]);
  expect(r.fewer.adjusted).toBe(true);
  // MAX_PLAN_CHAPTERS se respeta: 14 capítulos → plan de 12.
  expect(r.capped.plan).toHaveLength(12);
  // Sin total no hay nada que validar.
  expect(r.noTotal.plan).toEqual([]);
});

// Stub SSE para /chat/completions (espejo de setupStreamStub en visual-cards.spec.ts):
// responde con payloads[i] como stream y registra cada body en window.__cp.calls.
async function setupStreamStub(page: any, payloads: string | string[]) {
  const chunks = Array.isArray(payloads) ? payloads : [payloads];
  await page.goto('/index.html');
  await seedProLicense(page);
  await page.evaluate(async () => {
    localStorage.setItem('bookreader_ai_key', JSON.stringify('test-key'));
  });
  await page.evaluate((texts: string[]) => {
    const real = window.fetch.bind(window);
    (window as any).__cp = { calls: [] as any[] };
    let n = 0;
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions') && opts?.body) {
        const body = JSON.parse(opts.body);
        (window as any).__cp.calls.push(body);
        const content = texts[Math.min(n++, texts.length - 1)];
        const sse = [
          `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`,
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ];
        const s = new ReadableStream({ start(c) { const e = new TextEncoder(); sse.forEach(x => c.enqueue(e.encode(x))); c.close(); } });
        return new Response(s, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return real(url, opts);
    };
  }, chunks);
}

const SMALL_CHS = [{ name: 'Cap 1', tokens: 100 }, { name: 'Cap 2', tokens: 100 }];

test('suggestPlan: valid agent plan → source "agent" with a single call', async ({ page }) => {
  const payload = JSON.stringify({
    chapters: [
      { name: 'Cap 1', cards: 7, reason: 'más denso en definiciones' },
      { name: 'Cap 2', cards: 3, reason: 'más narrativo' },
    ],
    total: 10,
  });
  await setupStreamStub(page, payload);
  const res = await page.evaluate(async (chs: any) => {
    const CP: any = await import('/js/ai/card-plan.js');
    return CP.suggestPlan({ bookTitle: 'Libro', goal: '', chapters: chs, total: 10 });
  }, SMALL_CHS);
  expect(res.source).toBe('agent');
  expect(res.plan).toEqual([
    { name: 'Cap 1', cards: 7, reason: 'más denso en definiciones' },
    { name: 'Cap 2', cards: 3, reason: 'más narrativo' },
  ]);
  expect(res.adjusted).toBe(false);
  expect(await page.evaluate(() => (window as any).__cp.calls)).toHaveLength(1);
  // El prompt del planificador viajó con el total y los capítulos.
  const call = await page.evaluate(() => (window as any).__cp.calls[0]);
  expect(call.messages[1].content).toContain('TOTAL DE TARJETAS A REPARTIR: 10');
  expect(call.messages[1].content).toContain('Cap 1');
});

test('suggestPlan: garbage twice → "proportional" with the proportional numbers', async ({ page }) => {
  await setupStreamStub(page, 'primera basura {sin json');   // el último payload se repite
  const res = await page.evaluate(async (chs: any) => {
    const CP: any = await import('/js/ai/card-plan.js');
    const out = await CP.suggestPlan({ chapters: chs, total: 10 });
    return { out, prop: CP.proportionalPlan(chs, 10) };
  }, SMALL_CHS);
  expect(res.out.source).toBe('proportional');
  expect(res.out.plan.map((p: any) => p.cards)).toEqual(res.prop.map((p: any) => p.cards));
  expect(res.out.plan.reduce((s: number, p: any) => s + p.cards, 0)).toBe(10);
  // Exactamente UN reintento: dos llamadas y ni una más.
  expect(await page.evaluate(() => (window as any).__cp.calls)).toHaveLength(2);
});

test('suggestPlan: network error → "fallback-error" with the message in notes and proportional plan', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await page.evaluate(async () => {
    localStorage.setItem('bookreader_ai_key', JSON.stringify('test-key'));
    window.fetch = async () => { throw new TypeError('network down'); };
  });
  const res = await page.evaluate(async (chs: any) => {
    const CP: any = await import('/js/ai/card-plan.js');
    return CP.suggestPlan({ chapters: chs, total: 10 });
  }, SMALL_CHS);
  expect(res.source).toBe('fallback-error');
  expect(res.notes.some((n: string) => n.includes('network down'))).toBe(true);
  // El fallback nunca bloquea: números proporcionales con suma exacta.
  expect(res.plan.map((p: any) => p.cards)).toEqual([5, 5]);
  expect(res.plan.reduce((s: number, p: any) => s + p.cards, 0)).toBe(10);
});

test('suggestPlan: a user abort propagates the AbortError and does not retry', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await page.evaluate(async () => {
    localStorage.setItem('bookreader_ai_key', JSON.stringify('test-key'));
    (window as any).__cp = { calls: 0 };
    window.fetch = async () => {
      (window as any).__cp.calls++;
      throw new DOMException('aborted', 'AbortError');
    };
  });
  const out = await page.evaluate(async (chs: any) => {
    const CP: any = await import('/js/ai/card-plan.js');
    try {
      await CP.suggestPlan({ chapters: chs, total: 10 });
      return 'resolvió';
    } catch (e: any) {
      return e.name;
    }
  }, SMALL_CHS);
  expect(out).toBe('AbortError');
  expect(await page.evaluate(() => (window as any).__cp.calls)).toBe(1);   // sin reintento
});
