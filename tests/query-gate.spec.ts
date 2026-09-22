import { test, expect } from '@playwright/test';
import path from 'path';

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

// ---- IA7 F3 · Caché por pregunta y gate agéntico sobre el union ------------

const EPUB = path.join(__dirname, 'test.epub');   // Pedro Páramo (ES): cross-lingüe = pregunta EN

// Endpoint fingido OpenAI-compatible: la expansión va por streaming (SSE), el agéntico es
// no-streaming con `tools`, la respuesta final es streaming. `log` registra qué fases pidió
// el panel — es la aserción de las dos pruebas de abajo.
async function mockLLM(page: any, expansionContent: string, log: string[]) {
  await page.route('**/chat/completions', async (route: any) => {
    const body = route.request().postDataJSON() || {};
    const sys = body.messages?.[0]?.content || '';
    if (sys.startsWith('Preparas una BÚSQUEDA')) {
      log.push('expansion');
      const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: expansionContent } }] })}\n\ndata: [DONE]\n\n`;
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: payload });
    }
    if (body.tools) {
      log.push('agentic');
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: 'Busco más contexto.' }, finish_reason: 'stop' }] }) });
    }
    log.push('answer');
    const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: 'Respuesta mock' } }] })}\n\ndata: [DONE]\n\n`;
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: payload });
  });
}

async function preguntarEnLibro(page: any, q: string) {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('bookreader_ai_key', JSON.stringify('test-key'));
    localStorage.setItem('bookreader_ai_base_url', JSON.stringify('https://mock.test/v1'));
  });
  await page.reload();
  const [fc] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Subir tu primer libro' }).click(),
  ]);
  await fc.setFiles(EPUB);
  await page.click('#ai-toggle');
  await page.click('.ai-ob-quickchat');
  await expect(page.locator('#ai-status')).toContainText('Listo', { timeout: 30000 });
  await page.fill('#ai-input', q);
  await page.click('#ai-send');
  await expect(page.locator('.ai-msg-assistant .ai-bubble-text').last()).toContainText('Respuesta mock', { timeout: 30000 });
}

const EN_Q = 'Why did Juan Preciado go to the town and what did he find there?';

test('con expansión buena el turno cross-lingüe NO dispara la ronda agéntica', async ({ page }) => {
  const log: string[] = [];
  // Términos que SÍ están en el libro (ES): el union recupera de sobra y el gate —que mide
  // el crudo ∪ expansión, no el crudo— deja el turno ir directo a streaming.
  await mockLLM(page, JSON.stringify({ terms: ['Pedro Páramo', 'Comala', 'los muertos', 'madre'], hypothetical: 'El pueblo está habitado por los muertos.' }), log);
  await preguntarEnLibro(page, EN_Q);
  expect(log).toEqual(['expansion', 'answer']);
});

test('con expansión rota el fallback conserva la ronda agéntica', async ({ page }) => {
  const log: string[] = [];
  // Respuesta sin JSON → parseExpansion null → pregunta cruda → el gate abre la ronda
  // agéntica, como antes de IA7. Es la red de seguridad intacta. La pregunta va en un
  // idioma sin NINGÚN solapamiento léxico (CJK) para forzar crudo ≈ 0 aciertos — una EN
  // con nombres propios ("Juan Preciado") matchea el libro igual cruzando idiomas.
  await mockLLM(page, 'Lo siento, no puedo ayudarte con eso.', log);
  await preguntarEnLibro(page, '他为什么去了那个村子？他在那里发现了什么？');
  expect(log[0]).toBe('expansion');
  expect(log).toContain('agentic');
});

test('la caché: misma pregunta, una sola llamada; el null no se cachea', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('bookreader_ai_key', JSON.stringify('test-key'));
    localStorage.setItem('bookreader_ai_base_url', JSON.stringify('https://mock.test/v1'));
  });
  await page.reload();
  let calls = 0;
  await page.route('**/chat/completions', async (route: any) => {
    calls++;
    if (calls === 3) {   // 3ª llamada distinta: falla (400 no-reintentable) → null
      await route.fulfill({ status: 400, body: 'kaput' });
      return;
    }
    const json = JSON.stringify({ terms: ['Comala', 'los muertos'], hypothetical: 'El pueblo de los muertos.' });
    const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: json } }] })}\n\ndata: [DONE]\n\n`;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: payload });
  });
  const r = await page.evaluate(async () => {
    const Q: any = await import('/js/ai/query-expand.js');
    const a1 = await Q.expandQuery('¿Por qué los muertos de Comala no descansan?', { signal: null });
    const a2 = await Q.expandQuery('  ¿por qué los muertos de COMALA no descansan?  ', { signal: null });  // misma, normalizada
    const b  = await Q.expandQuery('¿Quién busca a su hijo en el pueblo?', { signal: null });              // distinta → llamada
    const a3 = await Q.expandQuery('¿Por qué los muertos de Comala no descansan?', { signal: null });      // sigue en caché
    const c  = await Q.expandQuery('¿Qué pasa con el padre Rentería?', { signal: null });                  // 400 → null
    const c2 = await Q.expandQuery('¿Qué pasa con el padre Rentería?', { signal: null });                  // el null NO se cachea → reintenta
    return { a1, a2, b, a3, c, c2 };
  });
  expect(calls).toBe(4);   // a1, b, c(400), c2 — a2 y a3 salieron de caché
  expect(r.a1).toBeTruthy();
  expect(r.a2).toEqual(r.a1);
  expect(r.a3).toEqual(r.a1);
  expect(r.b).toBeTruthy();
  expect(r.c).toBeNull();
  expect(r.c2).toBeTruthy();
});
