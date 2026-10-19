import { test, expect } from '@playwright/test';

// P43 F4 · Tipo 5 «Pregunta con distractores que enseñan»: motor puro (mcq.js) y generación
// (generate-mcq.js). Determinista, sin LLM. La unidad es la pregunta: una mala se descarta y las
// demás valen.

const QUOTE = 'Since the database is using snapshot isolation, both checks return 2';
const CHAPTER_TEXT = `In each transaction, your application first checks that two or more doctors are cur-
rently on call. Since the database is using snapshot isolation, both checks return 2, so both
transactions proceed.`;

const item = (over: any = {}) => ({
  id: 'q1',
  stem: 'Dos médicos piden la baja a la vez con snapshot isolation. ¿Qué pasa?',
  options: [
    { id: 'a', text: 'Los dos se van y no queda nadie de guardia', correct: true, feedback: 'Cada una lee el mismo snapshot.' },
    { id: 'b', text: 'La base de datos rechaza la segunda baja', correct: false, feedback: 'Eso haría la serializable.' },
    { id: 'c', text: 'Solo se va el primero en confirmar su cambio', correct: false, feedback: 'No hay conflicto de escritura.' },
  ],
  cite: { quote: QUOTE },
  ...over,
});

const SPEC = { type: 'mcq', version: 1, bookId: 'bk', chapter: 'Ch 7', title: 'Write skew', prompt: 'Elige.', items: [item()] };

test('validateMcqItem: una buena no da errores y cada defecto se nombra', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async ({ SPEC, base }) => {
    const M: any = await import('/js/ai/widgets/mcq.js');
    const it = (mut: (x: any) => void) => { const x = JSON.parse(JSON.stringify(base)); mut(x); return M.validateMcqItem(x, 'q'); };
    return {
      ok: M.validateMcq(SPEC),
      dos: it((x) => { x.options[1].correct = true; }),
      ninguna: it((x) => { x.options[0].correct = false; }),
      pocas: it((x) => { x.options = x.options.slice(0, 2); }),
      repetidas: it((x) => { x.options[2].text = x.options[1].text.toUpperCase(); }),
      sinFeedback: it((x) => { delete x.options[1].feedback; }),
      sinCita: it((x) => { delete x.cite; }),
      tipo: M.validateMcq({ ...SPEC, type: 'quiz' }),
    };
  }, { SPEC, base: item() });
  expect(r.ok).toEqual([]);
  expect(r.dos).toEqual(['q: tiene que haber exactamente una opción correcta (hay 2)']);
  expect(r.ninguna).toEqual(['q: tiene que haber exactamente una opción correcta (hay 0)']);
  expect(r.pocas).toEqual(['q: entre 3 y 4 opciones (hay 2)']);
  expect(r.repetidas).toEqual(['q: opciones repetidas']);
  expect(r.sinFeedback).toEqual(['q.options[1]: falta feedback']);
  expect(r.sinCita).toEqual(['q: falta cite']);
  expect(r.tipo).toContain('type desconocido: quiz');
});

test('scoreMcqItem, barajado estable y señales de calidad', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async ({ base }) => {
    const M: any = await import('/js/ai/widgets/mcq.js');
    const ids = (s: number) => M.shuffledOptions(base, s).map((o: any) => o.id).join('');
    const seeds = new Set([0, 1, 2, 3, 4, 5, 6, 7].map(ids));
    const larga = { ...base, options: base.options.map((o: any) => (o.correct ? { ...o, text: o.text + ', porque las dos transacciones leen el mismo estado y ninguna ve la otra' } : o)) };
    const absolutas = { ...base, options: [base.options[0], { ...base.options[1], text: 'La base de datos rechaza siempre la segunda baja' }, { ...base.options[2], text: 'Nunca se va ninguno de los dos' }] };
    const comodin = { ...base, options: [...base.options.slice(0, 2), { ...base.options[2], text: 'Ninguna de las anteriores' }] };
    return {
      bien: M.scoreMcqItem(base, 'a'),
      mal: M.scoreMcqItem(base, 'b', { unsure: true }),
      nada: M.scoreMcqItem(base, 'zz').ok,
      estable: ids(3) === ids(3),
      varia: seeds.size > 1,
      completo: ids(5).split('').sort().join(''),
      flags: [M.mcqItemFlags(base), M.mcqItemFlags(larga), M.mcqItemFlags(comodin), M.mcqItemFlags(absolutas)],
    };
  }, { base: item() });
  expect(r.bien).toMatchObject({ ok: true, choice: 'a', answer: 'a', feedback: 'Cada una lee el mismo snapshot.' });
  expect(r.mal).toMatchObject({ ok: false, choice: 'b', answer: 'a', unsure: true, feedback: 'Eso haría la serializable.' });
  expect(r.nada).toBe(false);
  expect(r.estable).toBe(true);
  expect(r.varia).toBe(true);
  expect(r.completo).toBe('abc');
  expect(r.flags).toEqual([[], ['larga'], ['comodin'], ['absolutas']]);
});

test('generate-mcq: ids que faltan, validez por pregunta con la cita y reintento solo de las malas', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async ({ base, CHAPTER_TEXT }) => {
    const G: any = await import('/js/ai/widgets/generate-mcq.js');
    const P: any = await import('/js/ai/widgets/generate.js');
    const sinIds = { title: 'T', prompt: 'P', items: [
      { ...base, id: undefined, options: base.options.map(({ id, ...o }: any) => o) },
      { ...base, id: 'q2', cite: { quote: 'esta frase no está en el capítulo de ninguna manera' } },
    ] };
    const raw = '<think>x</think>```json\n' + JSON.stringify(sinIds) + '\n```';
    const spec = G.finishMcq(P.parseSpec(raw), { bookId: 'bk', chapter: 'Ch 7' });
    const res = G.itemResults(spec, CHAPTER_TEXT);
    const failed = res.filter((x: any) => x.errors.length);
    const retry = G.retryMcqMessages(G.mcqMessages({ chapter: 'Ch 7', text: CHAPTER_TEXT }), raw, failed);
    const fixed = G.mergeRetry(spec, { items: [{ ...base, id: 'q2' }] });
    return {
      ids: spec.items.map((it: any) => [it.id, it.options.map((o: any) => o.id).join('')]),
      meta: [spec.type, spec.version, spec.bookId, spec.chapter],
      res: res.map((x: any) => [x.id, x.errors]),
      kept: G.keepValid(spec, CHAPTER_TEXT).items.map((it: any) => it.id),
      retryLast: retry[retry.length - 1].content.includes('q2:'),
      roles: retry.map((m: any) => m.role),
      fixed: G.itemResults(fixed, CHAPTER_TEXT).every((x: any) => !x.errors.length),
      sinJson: G.mcqSpecErrors(null),
    };
  }, { base: item(), CHAPTER_TEXT });
  expect(r.ids).toEqual([['q1', 'abc'], ['q2', 'abc']]);
  expect(r.meta).toEqual(['mcq', 1, 'bk', 'Ch 7']);
  expect(r.res).toEqual([['q1', []], ['q2', ['items[1] (q2): la cita no aparece literal en el capítulo']]]);
  expect(r.kept).toEqual(['q1']);
  expect(r.retryLast).toBe(true);
  expect(r.roles).toEqual(['system', 'user', 'assistant', 'user']);
  expect(r.fixed).toBe(true);
  expect(r.sinJson).toEqual(['la respuesta no contiene un objeto JSON']);
});
