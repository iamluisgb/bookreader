// P18 · Modo Feynman. Lo que hay que blindar es la LÓGICA DE ANDAMIAJE: que la escalada
// pump→hint→prompt→assert la decida el código y no el modelo (si se la dejas al modelo,
// elige ayudar), y que el diagnóstico salga del estado y no de una llamada nueva —así no
// se puede inventar lo que "te dejaste".
import { test, expect, Page } from '@playwright/test';
import path from 'path';
import { seedProLicense } from './pro-license';

const EPUB = path.join(__dirname, 'test.epub');
const GW = 'https://bookreader-gateway.luisgonzalezb93.workers.dev/v1';
const TOKEN = process.env.GW_TOKEN || '';

const mod = (page: Page) => page.evaluate(() => import('/js/ai/feynman.js').then(() => 'ok'));

async function openApp(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => !!document.getElementById('library'));
}

test.describe('escalada del andamiaje (pura)', () => {
  test('moveFor sube un escalón por intento y se queda en assert', async ({ page }) => {
    await openApp(page);
    const moves = await page.evaluate(async () => {
      const F: any = await import('/js/ai/feynman.js');
      return [0, 1, 2, 3, 4, 9].map((n) => F.moveFor(n));
    });
    expect(moves).toEqual(['pump', 'hint', 'prompt', 'assert', 'assert', 'assert']);
  });

  test('el intento solo se gasta si la expectativa SIGUE sin cubrir', async ({ page }) => {
    await openApp(page);
    const out = await page.evaluate(async () => {
      const F: any = await import('/js/ai/feynman.js');
      let s = F.newSession('atención', {
        expectations: [{ id: 'e1', text: 'a', src: 'a1' }, { id: 'e2', text: 'b', src: 'a2' }],
        misconceptions: [],
      });
      // Vuelta 1: no cubre nada → gasta intento en e1.
      s = F.applyTurn(s, { covered: [], hit: [], say: '¿qué más?', move: 'pump', targetId: 'e1', explanation: 'x' });
      const afterMiss = { plan: F.plan(s), attempts: { ...s.attempts } };
      // Vuelta 2: la cubre → NO debe gastar intento, y el objetivo pasa a e2 en pump.
      s = F.applyTurn(s, { covered: ['e1'], hit: [], say: 'bien', move: 'hint', targetId: 'e1', explanation: 'y' });
      return { afterMiss, afterHit: { plan: F.plan(s), attempts: { ...s.attempts } }, cov: F.coverage(s) };
    });
    expect(out.afterMiss.plan).toEqual({ targetId: 'e1', move: 'hint' });
    expect(out.afterMiss.attempts).toEqual({ e1: 1 });
    // Clave: e2 empieza en pump, no hereda el andamiaje gastado en e1.
    expect(out.afterHit.plan).toEqual({ targetId: 'e2', move: 'pump' });
    expect(out.afterHit.attempts).toEqual({ e1: 1 });
    expect(out.cov).toEqual({ done: 1, total: 2 });
  });

  test('cubrirlo todo termina la sesión', async ({ page }) => {
    await openApp(page);
    const out = await page.evaluate(async () => {
      const F: any = await import('/js/ai/feynman.js');
      let s = F.newSession('c', { expectations: [{ id: 'e1', text: 'a', src: 'a1' }], misconceptions: [] });
      s = F.applyTurn(s, { covered: ['e1'], hit: [], say: '', move: 'pump', targetId: 'e1', explanation: 'x' });
      return { finished: s.finished, target: F.nextTarget(s) };
    });
    expect(out.finished).toBe(true);
    expect(out.target).toBeNull();
  });
});

test.describe('el prompt impone el movimiento', () => {
  test('cada escalón lleva su regla y prohíbe adelantar la respuesta', async ({ page }) => {
    await openApp(page);
    const prompts = await page.evaluate(async () => {
      const F: any = await import('/js/ai/feynman.js');
      const base = {
        concept: 'atención causal', bookTitle: 'L',
        expectations: [{ id: 'e1', text: 'la máscara impide mirar al futuro', src: 'a1', covered: false }],
        misconceptions: [], explanation: 'algo', targetId: 'e1',
      };
      return ['pump', 'hint', 'prompt', 'assert'].map((m) => F.buildTurnPrompt({ ...base, move: m })[0].content);
    });
    expect(prompts[0]).toContain('PUMP');
    expect(prompts[0]).toContain('NO menciones el contenido que falta');
    expect(prompts[1]).toContain('HINT');
    expect(prompts[2]).toContain('PROMPT');
    // Solo el último escalón autoriza decirlo.
    expect(prompts[3]).toContain('ASSERT');
    for (const p of prompts) expect(p).toContain('Tu trabajo NO es explicar');
  });

  test('el prompt de expectativas exige cita real y prohíbe inventar', async ({ page }) => {
    await openApp(page);
    const sys = await page.evaluate(async () => {
      const F: any = await import('/js/ai/feynman.js');
      return F.buildExpectationsPrompt('atención', 'Libro', [{ id: 'a1', text: 'pasaje' }])[0].content;
    });
    expect(sys).toContain('OBLIGATORIO y real');
    expect(sys).toContain('no inventes');
    expect(sys).toContain('Nada de contenido que no esté en los pasajes');
  });
});

test.describe('parseo tolerante', () => {
  test('parseExpectations sobrevive a razonamiento, vallas y objetos rotos', async ({ page }) => {
    await openApp(page);
    const out = await page.evaluate(async () => {
      const F: any = await import('/js/ai/feynman.js');
      const raw = `<think>a ver...</think>\n\`\`\`json
{"kind":"expectation","text":"Primera idea","src":"[[a3]]"}
{"kind":"misconception","text":"Confundirlo con X","src":"a9"}
{"kind":"expectation","text":"Segunda idea"
\`\`\``;
      return F.parseExpectations(raw);
    });
    expect(out.expectations).toHaveLength(1);          // el tercero está truncado → se descarta
    expect(out.expectations[0]).toMatchObject({ id: 'e1', text: 'Primera idea', src: 'a3', covered: false });
    expect(out.misconceptions[0]).toMatchObject({ id: 'm1', src: 'a9', hit: false });
  });

  test('parseTurn devuelve forma segura ante basura', async ({ page }) => {
    await openApp(page);
    const out = await page.evaluate(async () => {
      const F: any = await import('/js/ai/feynman.js');
      return [F.parseTurn('lo siento, no puedo'), F.parseTurn('{"covered":["e1"],"hit":null,"say":"¿y por qué?"}')];
    });
    expect(out[0]).toEqual({ covered: [], hit: [], say: '' });
    expect(out[1]).toEqual({ covered: ['e1'], hit: [], say: '¿y por qué?' });
  });
});

test('el diagnóstico sale del estado, sin llamar al modelo', async ({ page }) => {
  await openApp(page);
  const d = await page.evaluate(async () => {
    const F: any = await import('/js/ai/feynman.js');
    let s = F.newSession('atención', {
      expectations: [{ id: 'e1', text: 'A', src: 'a1' }, { id: 'e2', text: 'B', src: 'a2' }],
      misconceptions: [{ id: 'm1', text: 'error típico', src: 'a3' }],
    });
    s = F.applyTurn(s, { covered: ['e1'], hit: ['m1'], say: '', move: 'pump', targetId: 'e1', explanation: 'x' });
    return F.diagnosis(s);
  });
  expect(d.covered.map((e: any) => e.id)).toEqual(['e1']);
  expect(d.missing.map((e: any) => e.id)).toEqual(['e2']);
  expect(d.mistakes.map((m: any) => m.id)).toEqual(['m1']);
  // Cada línea del diagnóstico conserva su cita: el criterio es auditable.
  expect(d.missing[0].src).toBe('a2');
});

// Rendirse a medias NO es haberlo cubierto todo. El handler pasaba el MouseEvent como
// `complete` y, siendo truthy, felicitaba al usuario justo cuando abandonaba.
test('rendirse a medias no felicita: el diagnóstico dice cuántas faltan', async ({ page }) => {
  test.setTimeout(60000);
  await openApp(page);
  await page.evaluate(async () => {
    const F: any = await import('/js/ai/feynman.js');
    F.open({ bookId: 'x', bookTitle: 'L', tocLabels: [], ensureIndex: () => {}, anchors: new Map() });
    // Sesión a medias inyectada por el mismo camino que usaría el flujo real.
    F.__setSessionForTest(F.newSession('atención', {
      expectations: [{ id: 'e1', text: 'A', src: 'a1' }, { id: 'e2', text: 'B', src: 'a2' }],
      misconceptions: [],
    }));
  });
  await page.locator('#fey-finish').click();
  const sub = await page.locator('#ai-feynman .ai-ob-sub').textContent();
  expect(sub).toMatch(/0 de 2|0 of 2/);
  expect(sub).not.toMatch(/cubierto entero|covered all/i);
  await expect(page.locator('.fey-missing li')).toHaveCount(2);
});

test('sin API key, la sesión no arranca y lo dice', async ({ page }) => {
  test.setTimeout(60000);
  await page.goto('/');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Subir tu primer libro' }).click(),
  ]);
  await chooser.setFiles(EPUB);
  await expect(page.locator('#reader-title')).toHaveText('Pedro Páramo', { timeout: 15000 });

  await page.evaluate(async () => {
    const F: any = await import('/js/ai/feynman.js');
    F.open({ bookId: 'x', bookTitle: 'Pedro Páramo', tocLabels: [], ensureIndex: () => {}, anchors: new Map() });
  });
  await page.locator('#fey-concept').fill('la muerte en Comala');
  await page.locator('#fey-start').click();
  await expect(page.locator('#fey-error')).toContainText(/API key/);
});

test('el ciclo completo funciona contra un modelo real @live', async ({ page }) => {
  test.skip(!TOKEN, 'define GW_TOKEN (token br-… del gateway) para esta prueba');
  test.setTimeout(240000);
  await page.addInitScript(([gw, tok]) => {
    localStorage.setItem('bookreader_ai_base_url', JSON.stringify(gw));
    localStorage.setItem('bookreader_ai_key', JSON.stringify(tok));
    localStorage.setItem('bookreader_ai_model', JSON.stringify('bookreader-fast'));
  }, [GW, TOKEN]);
  await page.goto('/');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Subir tu primer libro' }).click(),
  ]);
  await chooser.setFiles(path.join(__dirname, '..', 'evals', 'fixtures', 'p1-relativity.epub'));
  await page.waitForSelector('#reader-footer', { state: 'visible', timeout: 30000 });
  // El panel construye el índice de pasajes; hay que esperar a que el libro esté listo.
  await page.locator('#ai-toggle').click();
  await page.locator('.ai-ob-quickchat').click().catch(() => { /* ya hay conversación */ });
  await page.waitForFunction(
    () => /Listo|Ready/.test(document.getElementById('ai-status')?.textContent || ''), null, { timeout: 60000 });

  // Camino real: Studio → tarjeta "Explícamelo tú". Importa hacerlo así y no llamando a
  // Feynman.open() a mano: el `ensureIndex` que pasa el panel es lo que construye el índice
  // de pasajes, y sin él la extracción de expectativas no tiene de dónde sacarlas.
  await seedProLicense(page);
  await page.locator('.ai-tab[data-view="studio"]').click();
  await page.locator('[data-act="gen"][data-kind="feynman"]').click();

  await page.locator('#fey-concept').fill('the relativity of simultaneity');
  await page.locator('#fey-start').click();

  // Las expectativas se extraen ANTES de que el usuario diga nada.
  await expect(page.locator('#fey-input')).toBeVisible({ timeout: 120000 });
  const total = await page.evaluate(() => Number(document.querySelector('.fey-progress-n')!.textContent!.match(/\d+\s*\D+(\d+)/)![1]));
  expect(total).toBeGreaterThanOrEqual(3);

  // Una explicación deliberadamente pobre: el tutor debe PREGUNTAR, no resolverla.
  await page.locator('#fey-input').fill('Two events that look simultaneous are not always simultaneous.');
  await page.locator('#fey-send').click();
  await page.waitForFunction(() => !document.querySelector('#fey-say .ai-typing'), null, { timeout: 120000 });
  const say = (await page.locator('#fey-say').textContent())!;
  expect(say.length).toBeGreaterThan(5);
  expect(say.split(/[.!?]/).filter((s) => s.trim().length > 3).length).toBeLessThanOrEqual(3);  // una intervención breve

  // Y el cierre da el diagnóstico con sus citas, sin otra llamada.
  await page.locator('#fey-finish').click();
  await expect(page.locator('.fey-diag')).toBeVisible();
});

// P18 · Sugerencias de concepto. El riesgo aquí no es el modelo: es ofrecer basura como si
// fuera un concepto ("brief contents", "Exercises", el propio título del capítulo) y que el
// usuario se quede igual de a ciegas que con el campo vacío.
test.describe('qué concepto explicar (puro)', () => {
  test('cleanConcept quita el numeral de sección y la puntuación de cierre', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(async () => {
      const F: any = await import('/js/ai/feynman.js');
      return [
        F.cleanConcept('3.2 Encoding word positions'),
        F.cleanConcept('2. Working with Text Data'),
        F.cleanConcept('Chapter 4 — Implementing a GPT model'),
        F.cleanConcept('  byte pair   encoding.  '),
        F.cleanConcept('Self-attention'),        // sin numeral: intacto
      ];
    });
    expect(r).toEqual([
      'Encoding word positions',
      'Working with Text Data',
      'Implementing a GPT model',
      'byte pair encoding',
      'Self-attention',
    ]);
  });

  test('looksLikeConcept descarta aparato del libro y frases enteras', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(async () => {
      const F: any = await import('/js/ai/feynman.js');
      const ok = ['embeddings', 'byte pair encoding', 'atención causal multi-cabeza'];
      const no = [
        'Exercises', 'Summary', 'Further reading', 'Figure 3.2', 'brief contents', 'about this book',
        'ab',                                                        // demasiado corto
        'Cómo se comporta el modelo cuando la secuencia crece más allá de la ventana de contexto entrenada',
      ];
      return { ok: ok.map(F.looksLikeConcept), no: no.map(F.looksLikeConcept) };
    });
    expect(r.ok).toEqual([true, true, true]);
    expect(r.no.every((v: boolean) => v === false)).toBe(true);
  });

  test('suggestConcepts prioriza el capítulo actual, deduplica y excluye su título', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(async () => {
      const F: any = await import('/js/ai/feynman.js');
      return F.suggestConcepts({
        leaves: [
          { label: 'attention scores', chapter: '3. Coding Attention' },   // otro capítulo → al final
          { label: 'Byte pair encoding', chapter: '2. Working with Text Data' },
          { label: 'Exercises', chapter: '2. Working with Text Data' },    // no es un concepto
        ],
        sections: [
          { label: '2.5 Byte pair encoding', count: 4 },                   // duplicado del leaf
          { label: 'Encoding word positions', count: 3 },
          { label: '2. Working with Text Data', count: 9 },                // el propio capítulo
        ],
        currentChapter: '2. Working with Text Data',
      });
    });
    // Devuelve {label, term}: lo que se PINTA y con lo que se BUSCA. Las fuentes heurísticas
    // ya vienen en el idioma del libro, así que su término es su propio rótulo.
    expect(r.map((x: any) => x.label)).toEqual(['Byte pair encoding', 'Encoding word positions', 'attention scores']);
    expect(r.every((x: any) => x.term === x.label)).toBe(true);
  });

  test('parseConcepts tolera prosa y razonamiento alrededor del JSON', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(async () => {
      const F: any = await import('/js/ai/feynman.js');
      return F.parseConcepts(`<think>a ver…</think>
Aquí van:
\`\`\`json
{"concept":"3.1 self-attention","term":"self-attention"}
{"concept":"Summary"}
{"concept":"self-attention"}
{"concept":"Embeddings posicionales","term":"positional embeddings"}
{"concept": "truncado a mit
\`\`\``);
    });
    // "Summary" fuera, el duplicado (tras limpiar el numeral) fuera, y el objeto truncado
    // al final —lo que pasa de verdad cuando la respuesta se corta— no tumba a los anteriores.
    expect(r.map((x: any) => x.label)).toEqual(['self-attention', 'Embeddings posicionales']);
    // El TÉRMINO viaja aparte del rótulo: es lo que arregla el chip en español sobre libro
    // en inglés. Y sin `term` se cae al rótulo, que es el comportamiento de antes.
    expect(r.map((x: any) => x.term)).toEqual(['self-attention', 'positional embeddings']);
  });

  // BUG REAL (2026-07-28): con la app en español y el libro en inglés, la app ofrecía
  // "Tokenización de texto" y al pulsarlo respondía "No encuentro ese concepto en el libro".
  // El prompt pide los conceptos en el idioma de la INTERFAZ, pero el retrieval es BM25
  // LÉXICO sobre el texto del LIBRO: "tokenizacion"/"texto" no aparecen en ningún sitio.
  // Sobrevivían de casualidad los que se escriben igual en los dos idiomas.
  test('el chip busca por el término del libro, no por su etiqueta traducida', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(async () => {
      const F: any = await import('/js/ai/feynman.js');
      const R: any = await import('/js/ai/retrieval.js');
      const texto = [
        '## Working with Text Data',
        '[[a1]] Tokenizing text is the first step: we split the input text into individual tokens.',
        '[[a2]] These tokens are then converted into token IDs using a vocabulary.',
        '[[a3]] Byte pair encoding is the tokenizer used by GPT-2 and GPT-3.',
      ].join('\n');
      R.buildIndex('libro-en', R.parsePassages(texto, new Map(), ['Working with Text Data']));
      const [c] = F.parseConcepts('{"concept":"Tokenización de texto","term":"tokenizing text"}');
      return {
        label: c.label,
        term: c.term,
        porEtiqueta: F.passagesFor(c.label).length,   // lo que hacía antes → 0
        porTermino: F.passagesFor(c.term).length,     // lo que hace ahora
      };
    });
    expect(r.label).toBe('Tokenización de texto');
    expect(r.term).toBe('tokenizing text');
    expect(r.porEtiqueta).toBe(0);          // la etiqueta traducida NO aparece en el libro
    expect(r.porTermino).toBeGreaterThan(0);
  });

  // Segunda mitad del mismo bug: las hojas del MAPA MENTAL se redactan en el idioma de la
  // interfaz, así que como consulta léxica contra un libro en inglés no valen NUNCA — ni
  // traducidas ni con expansión. Pero traen `src`, el ancla del pasaje del que salieron: con
  // ella no hay que buscar nada. La sugerencia debe arrastrar ese ancla hasta el chip.
  test('las sugerencias arrastran el ancla de origen hasta el chip', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(async () => {
      const F: any = await import('/js/ai/feynman.js');
      return F.suggestConcepts({
        leaves: [
          { label: 'Atención escalada', src: 'a42', chapter: 'Coding Attention' },  // hoja del mapa, en español
          { label: 'Bloques Transformer', src: 'a77', chapter: 'Coding Attention' },
        ],
        sections: [{ label: 'Encoding word positions', count: 3 }],                 // del libro: sin ancla
        currentChapter: 'Coding Attention',
      });
    });
    const byLabel = Object.fromEntries(r.map((x: any) => [x.label, x]));
    expect(byLabel['Atención escalada'].src).toBe('a42');
    expect(byLabel['Bloques Transformer'].src).toBe('a77');
    // Las secciones vienen del propio libro y se localizan por texto: no necesitan ancla.
    expect(byLabel['Encoding word positions'].src).toBe('');
  });

  test('sampleForConcepts reparte por todo el capítulo en vez de coger el principio', async ({ page }) => {
    await openApp(page);
    const r = await page.evaluate(async () => {
      const F: any = await import('/js/ai/feynman.js');
      const passages = Array.from({ length: 100 }, (_, i) => ({ id: `a${i}`, text: 'x'.repeat(100) }));
      const picked = F.sampleForConcepts(passages, 1000);
      return { n: picked.length, first: picked[0].id, last: picked[picked.length - 1].id };
    });
    expect(r.n).toBeLessThanOrEqual(10);
    expect(r.first).toBe('a0');
    // Llega al final del capítulo: si cortara por el principio, el último sería ~a9.
    expect(Number(r.last.slice(1))).toBeGreaterThan(80);
  });
});

// "Sugerir conceptos" pedía maxTokens: 1200 mientras el propio módulo documenta, para la
// extracción de expectativas, que con un techo bajo el razonamiento se come el presupuesto y
// el contenido sale VACÍO — sin error, simplemente sin texto. Con un modelo de razonamiento
// detrás, el botón "fallaba". Se sube a 3000 y se distingue "no respondió" de "respondió algo
// que no sirve", que para el usuario son dos arreglos distintos.
test('sugerir conceptos: presupuesto holgado, fallo legible y se puede reintentar', async ({ page }) => {
  test.setTimeout(120000);
  await page.addInitScript(() => {
    localStorage.setItem('bookreader_ai_key', JSON.stringify('sk-test'));
    localStorage.setItem('bookreader_ai_base_url', JSON.stringify('https://stub.invalid/v1'));
  });
  await page.goto('/');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Subir tu primer libro' }).click(),
  ]);
  await chooser.setFiles(path.join(__dirname, '..', 'evals', 'fixtures', 'p2-progit.epub'));
  await page.waitForSelector('#reader-footer', { state: 'visible', timeout: 30000 });
  await page.locator('#ai-toggle').click();
  await page.locator('.ai-ob-quickchat').click().catch(() => { /* ya hay conversación */ });
  await page.waitForFunction(
    () => /Listo|Ready/.test(document.getElementById('ai-status')?.textContent || ''), null, { timeout: 60000 });

  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    (window as any).__emptyReply = true;
    (window as any).fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions')) {
        (window as any).__lastBody = JSON.parse(opts.body);
        const payload = (window as any).__emptyReply
          ? ''                                              // razonamiento que agota el cupo
          : '{"concept":"byte pair encoding"}\n{"concept":"self-attention"}';
        const chunks = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: payload }, finish_reason: null }] })}\n\n`,
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ];
        const s = new ReadableStream({ start(c) { const e = new TextEncoder(); chunks.forEach((x) => c.enqueue(e.encode(x))); c.close(); } });
        return new Response(s, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return real(url, opts);
    };
  });

  await seedProLicense(page);
  await page.locator('.ai-tab[data-view="studio"]').click();
  await page.locator('[data-act="gen"][data-kind="feynman"]').click();
  await page.waitForSelector('#fey-more', { timeout: 10000 });

  // 1) Respuesta vacía: mensaje que dice qué hacer, y el botón vuelve a estar disponible.
  await page.locator('#fey-more').click();
  await expect(page.locator('#fey-error')).toContainText('modelo de razonamiento', { timeout: 10000 });
  await expect(page.locator('#fey-more')).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__lastBody.max_tokens)).toBe(3000);

  // 2) Reintento con respuesta buena: los chips pasan a ser los conceptos del modelo.
  await page.evaluate(() => { (window as any).__emptyReply = false; });
  await page.locator('#fey-more').click();
  await expect(page.locator('.fey-chip').first()).toHaveText('byte pair encoding', { timeout: 10000 });
});
