import { test, expect } from '@playwright/test';

// Alcance de LIBRO ENTERO para el agente (summary.js + panel-template.js). Cuando el
// usuario pregunta por el conjunto ("¿lo más importante?"), el top-k por relevancia es
// una muestra sesgada; el agente pide una síntesis del libro. Tests DETERMINISTAS (sin
// LLM): el muestreo transversal, el reuso de caché del resumen y el framing del prompt.

const SENT = 'Uniform passage with a fixed length so every token cost is equal here.';
const ANNOTATED = [
  '## 1. Alpha', `[[a0]] ${SENT}`, `[[a1]] ${SENT}`,
  '## 2. Beta',  `[[a2]] ${SENT}`, `[[a3]] ${SENT}`,
  '## 3. Gamma', `[[a4]] ${SENT}`, `[[a5]] ${SENT}`,
].join('\n');
const TOC = ['1. Alpha', '2. Beta', '3. Gamma'];

test('bookScopePassages muestrea round-robin por capítulo y respeta el presupuesto', async ({ page }) => {
  await page.goto('/');
  const res = await page.evaluate(async ({ annotated, toc }) => {
    const R = await import('/js/ai/retrieval.js');
    const S = await import('/js/ai/summary.js');
    const C = await import('/js/ai/context.js');
    R.buildIndex('scope', R.parsePassages(annotated, new Map(), toc));
    const all = S.bookScopePassages(() => {}, 1e9);
    const cost = C.estimateTokens(all[0].text) + 4;   // textos idénticos → coste uniforme
    // Presupuesto para exactamente 3 pasajes: debe coger el PRIMERO de cada capítulo
    // (a0, a2, a4) antes que un segundo de cualquiera — cobertura antes que profundidad.
    const small = S.bookScopePassages(() => {}, cost * 3).map((p: any) => p.id);
    return { small, all: all.map((p: any) => p.id) };
  }, { annotated: ANNOTATED, toc: TOC });
  expect(res.small).toEqual(['a0', 'a2', 'a4']);                 // cobertura antes que profundidad
  expect(res.all).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'a5']); // presupuesto amplio: todo, en orden
});

test('ensureBookSummary reutiliza el resumen cacheado sin generar (sin LLM)', async ({ page }) => {
  await page.goto('/');
  const md = await page.evaluate(async () => {
    const S = await import('/js/ai/summary.js');
    const DB = await import('/js/ai/db.js');
    const Jobs = await import('/js/ai/jobs.js');
    await DB.putArtifact({ bookId: 'bk-cache', kind: 'summary', result: '# Resumen cacheado\n\n- punto [[a0]]', params: { scopeName: 'Libro' }, id: 'art1' });
    await Jobs.loadForBook('bk-cache');
    // Sin API key ni índice: si intentara generar, fallaría. Debe devolver la caché.
    return S.ensureBookSummary({
      bookId: 'bk-cache', bookTitle: 'Libro', goal: '', tocLabels: [],
      ensureIndex: () => {}, anchors: new Map(), onCite: () => {},
    });
  });
  expect(md).toContain('Resumen cacheado');
});

test('systemPrompt cambia el framing según el alcance del contexto', async ({ page }) => {
  await page.goto('/');
  const res = await page.evaluate(async () => {
    const PT = await import('/js/ai/panel-template.js');
    const opts = { tocLabels: ['1. Alpha'] };
    return {
      base: PT.systemPrompt('objetivo', null, null, opts),
      sum: PT.systemPrompt('objetivo', null, null, { ...opts, hasBookSummary: true }),
      trans: PT.systemPrompt('objetivo', null, null, { ...opts, transversal: true }),
    };
  });
  // Por defecto: extracto local, con el aviso de "no es el libro entero".
  expect(res.base).toContain('ÚNICAMENTE en el EXTRACTO');
  expect(res.base).toContain('NO es el libro entero');
  // Con síntesis: hablar del conjunto, sin la cláusula de "solo extractos".
  expect(res.sum).toContain('SÍNTESIS del libro completo');
  expect(res.sum).not.toContain('ÚNICAMENTE en el EXTRACTO');
  // Transversal: muestra de todo el libro, tampoco la cláusula restrictiva.
  expect(res.trans).toContain('MUESTRA TRANSVERSAL');
  expect(res.trans).not.toContain('ÚNICAMENTE en el EXTRACTO');
});
