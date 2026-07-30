import { test, expect } from '@playwright/test';

// IA7 · Gate de la expansión de consulta. Determinista (sin LLM): fija QUÉ preguntas merecen
// una llamada de expansión. El golden con modelo real vive en retrieval-hyde.spec.ts (@live).
//
// El cambio que fija este fichero: antes el único criterio era "no se nombró capítulo". Ahora
// el idioma manda por encima, porque cruzando idiomas BM25 crudo no tiene NADA que emparejar
// (medido en IA7 F2: ES→EN pasa de 0/5 a 4/5).

// Índice mínimo en inglés, con suficientes stopwords para que detectLang no dude.
const indexEN = async (page) => page.evaluate(async () => {
  const R: any = await import('/js/ai/retrieval.js');
  const passages = Array.from({ length: 12 }, (_, i) => ({
    id: `a${i + 1}`, chapter: 'Chapter 1',
    text: 'The database writes the log to the disk and the replica reads that log with all of the changes as they happen.',
  }));
  R.buildIndex('libro-en', passages);
  return R.indexLang();
});

test('detectLang distingue es/en y el idioma del libro se cachea por índice', async ({ page }) => {
  await page.goto('/');
  const lang = await indexEN(page);
  expect(lang).toBe('en');

  const r = await page.evaluate(async () => {
    const R: any = await import('/js/ai/retrieval.js');
    return {
      es: R.detectLang('¿Por qué el nodo primario replica los cambios a las réplicas de la base de datos?'),
      en: R.detectLang('Why does the primary node replicate the changes to the replicas of the database?'),
    };
  });
  expect(r.es).toBe('es');
  expect(r.en).toBe('en');
});

test('cruzando idiomas se expande SIEMPRE, aunque se nombre el capítulo', async ({ page }) => {
  await page.goto('/');
  await indexEN(page);
  const r = await page.evaluate(async () => {
    const Q: any = await import('/js/ai/query-expand.js');
    const es = '¿Por qué el nodo primario replica los cambios de la base de datos a las réplicas?';
    const en = 'Why does the primary node replicate the changes of the database to the replicas?';
    return {
      // Antes: con capítulo nombrado NO se expandía nunca. Ahora el idioma manda: sin puente
      // léxico da igual lo explícita que sea la intención.
      cruzadoConCapitulo: Q.shouldExpand({ question: es, chapterNamed: true }),
      cruzadoSinCapitulo: Q.shouldExpand({ question: es, chapterNamed: false }),
      // Mismo idioma: el gate original se mantiene intacto (BM25 crudo ya rinde 6/6).
      mismoIdiomaConCapitulo: Q.shouldExpand({ question: en, chapterNamed: true }),
      mismoIdiomaSinCapitulo: Q.shouldExpand({ question: en, chapterNamed: false }),
      vacia: Q.shouldExpand({ question: '   ', chapterNamed: false }),
    };
  });
  expect(r.cruzadoConCapitulo).toBe(true);      // el cambio
  expect(r.cruzadoSinCapitulo).toBe(true);
  expect(r.mismoIdiomaConCapitulo).toBe(false); // sin regresión
  expect(r.mismoIdiomaSinCapitulo).toBe(true);
  expect(r.vacia).toBe(false);
});

test('sin libro indexado el gate cae al criterio de siempre (no rompe)', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const Q: any = await import('/js/ai/query-expand.js');
    return {
      conCapitulo: Q.shouldExpand({ question: '¿Qué es el consenso?', chapterNamed: true }),
      sinCapitulo: Q.shouldExpand({ question: '¿Qué es el consenso?', chapterNamed: false }),
    };
  });
  expect(r.conCapitulo).toBe(false);
  expect(r.sinCapitulo).toBe(true);
});
