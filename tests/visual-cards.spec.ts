import { test, expect } from '@playwright/test';
import { seedProLicense } from './pro-license';

// Tarjetas visuales (WU3): constructores de prompts, parsers tolerantes, validador de
// SVG y los llamadores finos (grounding + oclusión). Los módulos se importan dentro de
// la página (misma convención que figures.spec.ts) y el LLM se stubbea a nivel de
// window.fetch (misma técnica que stubLLM de flashcards.spec.ts).

const DATA_URL = 'data:image/jpeg;base64,AAAA';

// Labels "detectadas" por el grounding, en la forma canónica que produce figures.js.
const LABELS = [
  { text: 'Producer', bbox: { x: 71, y: 56, w: 66, h: 15 } },
  { text: 'Message queue', bbox: { x: 350, y: 30, w: 111, h: 16 } },
  { text: 'Consumer', bbox: { x: 668, y: 55, w: 73, h: 16 } },
];

const CHAPTER_TEXT = 'El productor publica mensajes en el buffer central y el consumidor los extrae después, de modo que el buffer desacopla ambos ritmos.';

// SVG limpio para las pruebas del sanitizador: raíz con viewBox, un rect con id y texto.
const CLEAN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 240">'
  + '<rect class="d-box" id="tgt" x="10" y="10" width="120" height="40"/>'
  + '<text class="d-txt" x="20" y="35">Cola de mensajes</text>'
  + '</svg>';

// Importa el módulo dentro de la página y corre ahí un bloque async (con argumento opcional).
async function inPage(page, fn: (arg: any) => Promise<any>, arg?: any) {
  return page.evaluate(fn, arg);
}

// Configura la página para los llamadores async: licencia, API key y modelo de visión
// (chatVision los exige) y stub de /chat/completions que registra cada body recibido
// en window.__vc.calls y responde con `payload` como content del mensaje.
async function setupLLMStub(page, payload: string) {
  await page.goto('/index.html');
  await seedProLicense(page);
  await page.evaluate(() => {
    localStorage.setItem('bookreader_ai_key', JSON.stringify('test-key'));
    localStorage.setItem('bookreader_ai_vision_model', JSON.stringify('vision-test'));
  });
  await page.evaluate((content) => {
    const real = window.fetch.bind(window);
    (window as any).__vc = { calls: [] as any[] };
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions') && opts?.body) {
        const body = JSON.parse(opts.body);
        (window as any).__vc.calls.push(body);
        return new Response(
          JSON.stringify({ choices: [{ message: { content } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return real(url, opts);
    };
  }, payload);
}

// Stub que responde a la llamada FORZADA de create_occlusion_cards con un tool_call
// cuyos argumentos son `cardsJson`, y al fallback de texto (stream) con `streamText`.
// Con `noToolCall` el "proveedor" responde SIN tool_calls (simula un modelo que ignora
// la herramienta y fuerza la escalera al fallback de texto).
async function setupOcclusionStub(page, cardsJson: string, streamText: string, noToolCall = false) {
  await page.goto('/index.html');
  await seedProLicense(page);
  await page.evaluate(() => {
    localStorage.setItem('bookreader_ai_key', JSON.stringify('test-key'));
  });
  await page.evaluate(({ cards, stream, noToolCall }) => {
    const real = window.fetch.bind(window);
    (window as any).__vc = { calls: [] as any[] };
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions') && opts?.body) {
        const body = JSON.parse(opts.body);
        (window as any).__vc.calls.push(body);
        if (body.stream) {
          // Camino de texto (fallback): SSE como el que consume chatStream.
          const chunks = [
            `data: ${JSON.stringify({ choices: [{ delta: { content: stream }, finish_reason: null }] })}\n\n`,
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n',
          ];
          const s = new ReadableStream({ start(c) { const e = new TextEncoder(); chunks.forEach(x => c.enqueue(e.encode(x))); c.close(); } });
          return new Response(s, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        const forced = (body.tools || []).some((t: any) => t.function?.name === 'create_occlusion_cards');
        const message = forced && !noToolCall
          ? { content: '', tool_calls: [{ id: 'tc1', function: { name: 'create_occlusion_cards', arguments: cards } }] }
          : { content: stream };
        return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
      }
      return real(url, opts);
    };
  }, { cards: cardsJson, stream: streamText, noToolCall });
}

test('buildGroundingMessages: prompt 1 con contrato JSON, medidas en píxeles y regla de omisión', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const msgs = await inPage(page, async (dataUrl: string) => {
    const VC = await import('/js/ai/visual-cards.js');
    return VC.buildGroundingMessages({ dataUrl, width: 810, height: 130 });
  }, DATA_URL);
  expect(msgs).toHaveLength(1);
  expect(msgs[0].role).toBe('user');
  const content = msgs[0].content;
  expect(Array.isArray(content)).toBe(true);
  // Parte de texto: contrato JSON exacto (con el veredicto kind), medidas, regla
  // del diagrama (solo un diagrama vale la pena ocluir) y orden de omitir lo dudoso.
  expect(content[0].type).toBe('text');
  expect(content[0].text).toContain('{"kind":"diagram|illustration|screenshot|code|other","labels":[{"text":"<texto exacto>","bbox":[x,y,w,h]}]}');
  expect(content[0].text).toContain('La imagen mide 810×130 píxeles');
  expect(content[0].text).toContain('Omite las etiquetas');
  expect(content[0].text).toContain('SOLO un DIAGRAMA');
  expect(content[0].text).toContain('anécdota ilustrada');
  // Parte de imagen: el data URL viaja como image_url.
  expect(content[1]).toEqual({ type: 'image_url', image_url: { url: DATA_URL } });
});

test('buildOcclusionMessages y buildDiagramMessages: regla de Mayer, español y reglas del SVG', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const { occ, dia } = await inPage(page, async ({ labels, chapter }: any) => {
    const VC = await import('/js/ai/visual-cards.js');
    return {
      occ: VC.buildOcclusionMessages({ labels, chapterText: chapter, figureCaption: 'Fig. 3', bookTitle: 'Libro' }),
      dia: VC.buildDiagramMessages({ concept: 'flujo de mensajes', chapterText: chapter }),
    };
  }, { labels: LABELS, chapter: CHAPTER_TEXT });
  // Prompt 2: Mayer (nada decorativo), tope de 3, español, datos rastreables, labels listadas.
  expect(occ).toHaveLength(1);
  expect(occ[0].role).toBe('system');
  expect(occ[0].content).toContain('MAYER');
  expect(occ[0].content).toContain('decorativ');
  expect(occ[0].content).toContain('ESPAÑOL');
  expect(occ[0].content).toContain('rastreable');
  expect(occ[0].content).toContain('máximo 3');
  expect(occ[0].content).toContain('Message queue');
  expect(occ[0].content).toContain(CHAPTER_TEXT);
  expect(occ[0].content).toContain('Fig. 3');
  // Prompt 3: gate de estructura relacional + reglas del SVG.
  expect(dia).toHaveLength(1);
  expect(dia[0].content).toContain('ESTRUCTURA RELACIONAL');
  expect(dia[0].content).toContain('"usable":false');
  expect(dia[0].content).toContain('viewBox="0 0 720 H"');
  expect(dia[0].content).toContain('180');
  expect(dia[0].content).toContain('280');
  expect(dia[0].content).toContain('d-box');
  expect(dia[0].content).toContain('d-txt');
  expect(dia[0].content).toContain('d-cap');
  expect(dia[0].content).toContain('d-line');
  expect(dia[0].content).toContain('is-fill');
  expect(dia[0].content).toContain('is-strong');
  expect(dia[0].content).toContain('answerNodeId');
  expect(dia[0].content).toContain('ESPAÑOL');
});

test('buildOcclusionMessages: el contextFact debe responder la pregunta y nombrar lo tapado (WU3)', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const msgs = await inPage(page, async ({ labels, chapter }: any) => {
    const VC = await import('/js/ai/visual-cards.js');
    return VC.buildOcclusionMessages({ labels, chapterText: chapter, figureCaption: 'Fig. 3' });
  }, { labels: LABELS, chapter: CHAPTER_TEXT });
  expect(msgs).toHaveLength(1);
  const c = msgs[0].content;
  // Cláusula WU3: el dato RESPONDE la pregunta y NOMBRA el contenido tapado.
  expect(c).toContain('RESPONDA la pregunta');
  expect(c).toContain('NOMBRE');
  // El relleno genérico real del backup queda prohibido explícitamente.
  expect(c).toContain('El capítulo explica que');
  expect(c).toContain('oculto');
  // El resto del contrato no se toca: Mayer, tope de 3, JSON-only y español.
  expect(c).toContain('MAYER');
  expect(c).toContain('máximo 3');
  expect(c).toContain('ESPAÑOL');
  expect(c).toContain('rastreable');
});

test('parseGroundingResponse: labels + kind normalizado; kind ausente o desconocido → \'\'', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await inPage(page, async () => {
    const VC = await import('/js/ai/visual-cards.js');
    // JSON envuelto en prosa y fences (modelos reasoning) con kind y labels.
    const good = 'Pensando...\n```json\n' + JSON.stringify({
      kind: 'diagram',
      labels: [{ text: 'Producer', bbox: [71, 56, 66, 15] }, { text: 'Message queue', bbox: [350.4, 30, 111, 16] }],
    }) + '\n```';
    return {
      good: VC.parseGroundingResponse(good, { width: 810, height: 130 }),
      caseInsensitive: VC.parseGroundingResponse('{"kind":"Screenshot","labels":[]}', { width: 810, height: 130 }),
      unknown: VC.parseGroundingResponse('{"kind":"3d-model","labels":[]}', { width: 810, height: 130 }),
      missing: VC.parseGroundingResponse('{"labels":[{"text":"A","bbox":[1,1,10,10]}]}', { width: 810, height: 130 }),
      garbage: VC.parseGroundingResponse('basura { roto sin cerrar', { width: 810, height: 130 }),
      nullInput: VC.parseGroundingResponse(null as any, { width: 810, height: 130 }),
    };
  });
  expect(res.good).toEqual({ kind: 'diagram', labels: [
    { text: 'Producer', bbox: { x: 71, y: 56, w: 66, h: 15 } },
    { text: 'Message queue', bbox: { x: 350, y: 30, w: 111, h: 16 } },
  ] });
  expect(res.caseInsensitive.kind).toBe('screenshot');
  expect(res.caseInsensitive.labels).toEqual([]);
  expect(res.unknown.kind).toBe('');            // valor fuera del contrato → ''
  expect(res.missing.kind).toBe('');            // sin kind → ''
  expect(res.missing.labels).toHaveLength(1);   // las labels sobreviven igual
  expect(res.garbage).toEqual({ labels: [], kind: '' });   // nunca lanza
  expect(res.nullInput).toEqual({ labels: [], kind: '' });
});

test('parseOcclusionCards: prosa/fences, string de tool-call, filtro por labels y saneo de campos', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await inPage(page, async () => {
    const VC = await import('/js/ai/visual-cards.js');
    const allowed = ['Message queue', 'Consumer'];
    // JSON envuelto en prosa y fences: 'message queue' casa sin caso; Producer/Buffer no están.
    const prose = 'Claro, aquí van:\n```json\n{"cards":['
      + '{"occludedLabel":"message queue","question":"¿Qué desacopla al productor del consumidor?","contextFact":"El buffer desacopla ambos ritmos.","difficulty":"hard"},'
      + '{"occludedLabel":"Producer","question":"q","contextFact":"f"},'
      + '{"occludedLabel":"Buffer","question":"q2","contextFact":"f2"}'
      + ']}\n```';
    // String de argumentos de tool-call (JSON pelado), con difficulty desconocida.
    const toolArgs = '{"cards":[{"occludedLabel":"Consumer","question":"¿Quién extrae?","contextFact":"El consumidor extrae después.","difficulty":"impossible"}]}';
    // Coincidencia sin tildes: 'Configuración' permitida vs 'configuracion' devuelta.
    const accents = '{"cards":[{"occludedLabel":"configuracion","question":"q","contextFact":"f"}]}';
    // Campos vacíos: sin question o sin contextFact se descartan.
    const empties = '{"cards":['
      + '{"occludedLabel":"Message queue","question":"   ","contextFact":"f"},'
      + '{"occludedLabel":"Message queue","question":"q","contextFact":""},'
      + '{"occludedLabel":"Message queue","question":"q","contextFact":"f"}'
      + ']}';
    // Tope de 3: cinco válidas → tres.
    const five = '{"cards":['
      + ['1', '2', '3', '4', '5'].map(n => `{"occludedLabel":"Message queue","question":"q${n}","contextFact":"f${n}"}`).join(',')
      + ']}';
    return {
      prose: VC.parseOcclusionCards(prose, { allowedLabels: allowed }),
      toolArgs: VC.parseOcclusionCards(toolArgs, { allowedLabels: allowed }),
      accents: VC.parseOcclusionCards(accents, { allowedLabels: ['Configuración'] }),
      empties: VC.parseOcclusionCards(empties, { allowedLabels: allowed }),
      five: VC.parseOcclusionCards(five, { allowedLabels: allowed }),
      garbage: VC.parseOcclusionCards('basura total { roto sin cerrar'),
      nullInput: VC.parseOcclusionCards(null as any, { allowedLabels: allowed }),
      noCardsKey: VC.parseOcclusionCards('{"cards":"no soy array"}', { allowedLabels: allowed }),
    };
  });
  expect(res.prose).toEqual([
    { occludedLabel: 'message queue', question: '¿Qué desacopla al productor del consumidor?', contextFact: 'El buffer desacopla ambos ritmos.', difficulty: 'hard' },
  ]);
  expect(res.toolArgs).toEqual([
    { occludedLabel: 'Consumer', question: '¿Quién extrae?', contextFact: 'El consumidor extrae después.', difficulty: 'medium' },
  ]);
  expect(res.accents).toEqual([
    { occludedLabel: 'configuracion', question: 'q', contextFact: 'f', difficulty: 'medium' },
  ]);
  expect(res.empties).toHaveLength(1);   // solo sobrevive la tarjeta completa
  expect(res.five).toHaveLength(3);      // tope duro de 3
  expect(res.garbage).toEqual([]);       // nunca lanza
  expect(res.nullInput).toEqual([]);
  expect(res.noCardsKey).toEqual([]);
});

test('sanitizeSvg: acepta SVG limpio con el nodo de respuesta y rechaza scripts, handlers, javascript:, foreignObject y XML roto', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await inPage(page, async ({ clean }: any) => {
    const VC = await import('/js/ai/visual-cards.js');
    return {
      clean: VC.sanitizeSvg(clean, { answerNodeId: 'tgt' }),
      script: VC.sanitizeSvg(clean.replace('<text', '<script>alert(1)</script><text'), { answerNodeId: 'tgt' }),
      onload: VC.sanitizeSvg(clean.replace('<svg ', '<svg onload="steal()" '), { answerNodeId: 'tgt' }),
      jsHref: VC.sanitizeSvg(clean.replace('<text', '<a href="javascript:alert(1)"><text'), { answerNodeId: 'tgt' }),
      foreign: VC.sanitizeSvg(clean.replace('<text', '<foreignObject><p>x</p></foreignObject><text'), { answerNodeId: 'tgt' }),
      broken: VC.sanitizeSvg('<svg viewBox="0 0 10 10"><rect><text>sinferrar</text></svg>', { answerNodeId: '' }),
      missingId: VC.sanitizeSvg(clean, { answerNodeId: 'no-existe' }),
      empty: VC.sanitizeSvg('', {}),
      notSvgRoot: VC.sanitizeSvg('<div>nope</div>', {}),
      noIdCheck: VC.sanitizeSvg(clean, {}),
    };
  }, { clean: CLEAN_SVG });
  expect(res.clean.ok).toBe(true);
  expect(res.clean.svg).toContain('id="tgt"');
  expect(res.clean.svg).toContain('d-box');
  expect(res.script.ok).toBe(false);
  expect(res.onload.ok).toBe(false);
  expect(res.jsHref.ok).toBe(false);
  expect(res.foreign.ok).toBe(false);
  expect(res.broken.ok).toBe(false);   // XML mal balanceado → parsererror
  expect(res.missingId.ok).toBe(false);
  expect(res.empty.ok).toBe(false);
  expect(res.notSvgRoot.ok).toBe(false);
  expect(res.noIdCheck.ok).toBe(true); // sin answerNodeId no se exige el id
});

test('parseDiagramResponse: gate usable:false, camino útil con SVG, SVG inválido y basura', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await inPage(page, async ({ clean }: any) => {
    const VC = await import('/js/ai/visual-cards.js');
    // El gate del modelo: sin estructura relacional, no hay diagrama.
    const gate = VC.parseDiagramResponse('{"usable":false,"reason":"el concepto no tiene estructura relacional"}');
    // JSON envuelto en prosa (modelos reasoning) con el SVG como string escapado.
    const okObj = { usable: true, svg: clean, answerNodeId: 'tgt', question: '¿Qué componente desacopla?', contextFact: 'El buffer desacopla ambos ritmos.' };
    const usable = VC.parseDiagramResponse('Analizando la estructura:\n```json\n' + JSON.stringify(okObj) + '\n```');
    // SVG con script dentro: el validador lo tumba.
    const evil = VC.parseDiagramResponse(JSON.stringify({ ...okObj, svg: clean.replace('<text', '<script>x()</script><text') }));
    // Falta el nodo de respuesta en el SVG.
    const missingNode = VC.parseDiagramResponse(JSON.stringify({ ...okObj, answerNodeId: 'fantasma' }));
    // Falta la pregunta.
    const noQuestion = VC.parseDiagramResponse(JSON.stringify({ ...okObj, question: '  ' }));
    return { gate, usable, evil, missingNode, noQuestion, garbage: VC.parseDiagramResponse('sin json útil') };
  }, { clean: CLEAN_SVG });
  expect(res.gate).toEqual({ usable: false, reason: 'el concepto no tiene estructura relacional' });
  expect(res.usable.usable).toBe(true);
  expect(res.usable.answerNodeId).toBe('tgt');
  expect(res.usable.question).toBe('¿Qué componente desacopla?');
  expect(res.usable.contextFact).toBe('El buffer desacopla ambos ritmos.');
  expect(res.usable.svg).toContain('<svg');
  expect(res.usable.svg).toContain('id="tgt"');
  expect(res.evil.usable).toBe(false);
  expect(res.evil.reason).toContain('invalid svg');
  expect(res.missingNode.usable).toBe(false);
  expect(res.noQuestion.usable).toBe(false);
  expect(res.garbage.usable).toBe(false);
});

test('groundFigure: envía imagen + dimensiones con max_tokens≥4000, parsea labels; ante JSON truncado reintenta una vez', async ({ page }) => {
  // Camino feliz: el stub devuelve el JSON de labels + kind y solo hace falta una llamada.
  await setupLLMStub(page, JSON.stringify({ kind: 'diagram', labels: [
    { text: 'Producer', bbox: [71, 56, 66, 15] },
    { text: 'Message queue', bbox: [350.4, 30, 111, 16] },
  ] }));
  const res = await inPage(page, async (dataUrl: string) => {
    const VC = await import('/js/ai/visual-cards.js');
    return VC.groundFigure({ dataUrl, width: 810, height: 130 });
  }, DATA_URL);
  expect(res.attempts).toBe(1);
  expect(res.truncated).toBe(false);
  expect(res.kind).toBe('diagram');                 // el veredicto kind viaja en el resultado
  expect(res.labels).toEqual(LABELS.slice(0, 2));   // bbox canónico {x,y,w,h}
  const state = await page.evaluate(() => (window as any).__vc);
  expect(state.calls).toHaveLength(1);
  const body = state.calls[0];
  expect(body.model).toBe('vision-test');          // chatVision usa el modelo de visión
  expect(body.max_tokens).toBeGreaterThanOrEqual(4000);
  const content = body.messages[0].content;
  expect(content.some((p: any) => p.type === 'image_url')).toBe(true);
  expect(content[0].text).toContain('La imagen mide 810×130 píxeles');

  // Truncamiento: el stub devuelve prosa + JSON cortado a mitad (el modo reasoning lo
  // trunca), las DOS llamadas → labels vacías, truncated=true, y el reintento pide 6000.
  await setupLLMStub(page, 'Aquí va el JSON: {"labels":[{"text":"A","bbox":[1,1,10,10]}');
  const res2 = await inPage(page, async (dataUrl: string) => {
    const VC = await import('/js/ai/visual-cards.js');
    return VC.groundFigure({ dataUrl, width: 810, height: 130 });
  }, DATA_URL);
  const state2 = await page.evaluate(() => (window as any).__vc);
  expect(state2.calls).toHaveLength(2);            // exactamente UN reintento
  expect(state2.calls[0].max_tokens).toBe(4000);
  expect(state2.calls[1].max_tokens).toBe(6000);
  expect(res2.attempts).toBe(2);
  expect(res2.labels).toEqual([]);
  expect(res2.kind).toBe('');                       // el truncado tampoco trajo kind
  expect(res2.truncated).toBe(true);
});

test('groundFigure: un abort del usuario propaga el AbortError y no reintenta', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await page.evaluate(() => {
    localStorage.setItem('bookreader_ai_key', JSON.stringify('test-key'));
    localStorage.setItem('bookreader_ai_vision_model', JSON.stringify('vision-test'));
  });
  // El "proveedor" aborta: la cancelación de la generación no debe tragarse (antes
  // groundFigure devolvía labels vacías y la generación seguía como si no hubiera labels).
  await page.evaluate(() => {
    (window as any).__vc = { calls: 0 };
    window.fetch = async () => { (window as any).__vc.calls++; throw new DOMException('aborted', 'AbortError'); };
  });
  const out = await page.evaluate(async (dataUrl: string) => {
    const VC: any = await import('/js/ai/visual-cards.js');
    try {
      await VC.groundFigure({ dataUrl, width: 810, height: 130 });
      return 'resolvió';
    } catch (e: any) {
      return e.name;
    }
  }, DATA_URL);
  expect(out).toBe('AbortError');
  expect(await page.evaluate(() => (window as any).__vc.calls)).toBe(1);   // sin reintento
});

// Stub para los llamadores que van por chatStream (lote de diagramas y tarjetas de
// dibujo): responde cada /chat/completions con `payloads[i]` como SSE —misma forma que el
// fallback de texto de setupOcclusionStub— y registra cada body en window.__vc.calls.
// Con más de un payload, el último se repite (así se prueba la regeneración única).
async function setupStreamStub(page, payloads: string | string[]) {
  const chunks = Array.isArray(payloads) ? payloads : [payloads];
  await page.goto('/index.html');
  await seedProLicense(page);
  await page.evaluate(() => {
    localStorage.setItem('bookreader_ai_key', JSON.stringify('test-key'));
  });
  await page.evaluate((texts: string[]) => {
    const real = window.fetch.bind(window);
    (window as any).__vc = { calls: [] as any[] };
    let n = 0;
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions') && opts?.body) {
        const body = JSON.parse(opts.body);
        (window as any).__vc.calls.push(body);
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

test('generateOcclusions: llamada forzada a create_occlusion_cards, tarjetas filtradas por labels; sin tool_call cae al texto', async ({ page }) => {
  const cardsJson = JSON.stringify({ cards: [
    { occludedLabel: 'Message queue', question: '¿Qué desacopla al productor del consumidor?', contextFact: 'El buffer desacopla ambos ritmos.', difficulty: 'hard' },
    { occludedLabel: 'Núcleo', question: 'q', contextFact: 'f' },         // label fuera de la lista → fuera
    { occludedLabel: 'Consumer', question: '   ', contextFact: 'f' },      // question vacía → fuera
  ] });
  await setupOcclusionStub(page, cardsJson, '{"cards":[]}');
  const cards = await inPage(page, async ({ labels, chapter }: any) => {
    const VC = await import('/js/ai/visual-cards.js');
    return VC.generateOcclusions({ labels, chapterText: chapter, figureCaption: 'Fig. 3', bookTitle: 'Libro' });
  }, { labels: LABELS, chapter: CHAPTER_TEXT });
  expect(cards).toEqual([
    { occludedLabel: 'Message queue', question: '¿Qué desacopla al productor del consumidor?', contextFact: 'El buffer desacopla ambos ritmos.', difficulty: 'hard' },
  ]);
  const state = await page.evaluate(() => (window as any).__vc);
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0].tools[0].function.name).toBe('create_occlusion_cards');
  expect(state.calls[0].tool_choice).toEqual({ type: 'function', function: { name: 'create_occlusion_cards' } });
  expect(state.calls[0].messages[0].content).toContain('MAYER');

  // Fallback a texto: el "proveedor" no emite tool_calls (mensaje sin tool_calls) →
  // la escalera baja a chatStream y el parser tolerante rescata el JSON del stream.
  await setupOcclusionStub(page, 'no-json', JSON.stringify({ cards: [
    { occludedLabel: 'Consumer', question: '¿Quién extrae?', contextFact: 'El consumidor extrae después.', difficulty: 'easy' },
  ] }), true);
  const cards2 = await inPage(page, async ({ labels, chapter }: any) => {
    const VC = await import('/js/ai/visual-cards.js');
    return VC.generateOcclusions({ labels, chapterText: chapter });
  }, { labels: LABELS, chapter: CHAPTER_TEXT });
  expect(cards2).toEqual([
    { occludedLabel: 'Consumer', question: '¿Quién extrae?', contextFact: 'El consumidor extrae después.', difficulty: 'easy' },
  ]);
  const state2 = await page.evaluate(() => (window as any).__vc);
  expect(state2.calls).toHaveLength(2);            // tools (sin tool_call) + stream
  expect(state2.calls[1].stream).toBe(true);
});

test('buildDiagramBatchMessages: pide count diagramas, gate relacional, reglas de viewBox/clases y español', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const msgs = await inPage(page, async ({ chapter }: any) => {
    const VC = await import('/js/ai/visual-cards.js');
    return VC.buildDiagramBatchMessages({ chapterText: chapter, count: 3 });
  }, { chapter: CHAPTER_TEXT });
  expect(msgs).toHaveLength(1);
  expect(msgs[0].role).toBe('system');
  const c = msgs[0].content;
  expect(c).toContain('hasta 3');                       // pide `count` diagramas
  expect(c).toContain('ESTRUCTURA RELACIONAL');         // mismo gate que el single
  expect(c).toContain('viewBox="0 0 720 H"');
  expect(c).toContain('180');
  expect(c).toContain('280');
  expect(c).toContain('d-box');
  expect(c).toContain('d-txt');
  expect(c).toContain('d-cap');
  expect(c).toContain('d-line');
  expect(c).toContain('is-fill');
  expect(c).toContain('is-strong');
  expect(c).toContain('answerNodeId');
  expect(c).toContain('ESPAÑOL');
  expect(c).toContain('"diagrams"');                    // contrato de salida por lote
  expect(c).toContain(CHAPTER_TEXT);
});

test('parseDiagramBatchResponse: lote válido, inválidas descartadas sin tirar las demás, cap, dedupe y truncado', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await inPage(page, async ({ clean }: any) => {
    const VC = await import('/js/ai/visual-cards.js');
    const d1 = { concept: 'Flujo de mensajes', svg: clean, answerNodeId: 'tgt', question: '¿Qué desacopla al productor del consumidor?', contextFact: 'El buffer desacopla ambos ritmos.' };
    const d2 = { concept: 'Ciclo de extracción', svg: clean.replace('tgt', 'tgt2'), answerNodeId: 'tgt2', question: '¿Quién extrae los mensajes?', contextFact: 'El consumidor extrae después.' };
    // Lote válido envuelto en prosa y fences (modelos reasoning).
    const batch = 'Claro, aquí van:\n```json\n' + JSON.stringify({ diagrams: [d1, d2] }) + '\n```';
    // Una entrada con <script> (sanitizeSvg la tumba) y la otra sana: solo sobrevive la sana.
    const withScript = JSON.stringify({ diagrams: [{ ...d1, svg: clean.replace('<text', '<script>x()</script><text') }, d2] });
    // answerNodeId que no está en el markup → fuera.
    const ghostNode = JSON.stringify({ diagrams: [{ ...d1, answerNodeId: 'fantasma' }, d2] });
    // question vacía → fuera.
    const noQuestion = JSON.stringify({ diagrams: [{ ...d1, question: '  ' }, d2] });
    // Concepto duplicado (sin caso ni tildes) → colapsa a uno.
    const dup = JSON.stringify({ diagrams: [d1, { ...d2, concept: 'flujo DE mensajes' }] });
    // Cap: dos válidas con maxCards=1 → una.
    return {
      batch: VC.parseDiagramBatchResponse(batch),
      withScript: VC.parseDiagramBatchResponse(withScript),
      ghostNode: VC.parseDiagramBatchResponse(ghostNode),
      noQuestion: VC.parseDiagramBatchResponse(noQuestion),
      dup: VC.parseDiagramBatchResponse(dup),
      capped: VC.parseDiagramBatchResponse(batch, { maxCards: 1 }),
      truncated: VC.parseDiagramBatchResponse('Analizando: {"diagrams":[{"concept":"roto"'),
      garbage: VC.parseDiagramBatchResponse('sin json útil {'),
      nullInput: VC.parseDiagramBatchResponse(null as any),
    };
  }, { clean: CLEAN_SVG });
  expect(res.batch).toEqual([
    { concept: 'Flujo de mensajes', svg: expect.stringContaining('<svg'), answerNodeId: 'tgt', question: '¿Qué desacopla al productor del consumidor?', contextFact: 'El buffer desacopla ambos ritmos.' },
    { concept: 'Ciclo de extracción', svg: expect.stringContaining('id="tgt2"'), answerNodeId: 'tgt2', question: '¿Quién extrae los mensajes?', contextFact: 'El consumidor extrae después.' },
  ]);
  expect(res.withScript).toHaveLength(1);          // la del script fuera, la sana sobrevive
  expect(res.withScript[0].concept).toBe('Ciclo de extracción');
  expect(res.ghostNode).toHaveLength(1);
  expect(res.noQuestion).toHaveLength(1);
  expect(res.dup).toHaveLength(1);                 // concepto duplicado colapsa
  expect(res.dup[0].answerNodeId).toBe('tgt');     // queda la primera
  expect(res.capped).toHaveLength(1);
  expect(res.truncated).toEqual([]);               // truncado → [] sin lanzar
  expect(res.garbage).toEqual([]);
  expect(res.nullInput).toEqual([]);
});

test('generateDiagrams: lote usable en 1 intento; basura la primera vez → exactamente una regeneración (2 llamadas)', async ({ page }) => {
  const batch = JSON.stringify({ diagrams: [
    { concept: 'Flujo de mensajes', svg: CLEAN_SVG, answerNodeId: 'tgt', question: '¿Qué desacopla al productor del consumidor?', contextFact: 'El buffer desacopla ambos ritmos.' },
    { concept: 'Ciclo de extracción', svg: CLEAN_SVG.replace('tgt', 'tgt2'), answerNodeId: 'tgt2', question: '¿Quién extrae los mensajes?', contextFact: 'El consumidor extrae después.' },
  ] });
  await setupStreamStub(page, batch);
  const res = await inPage(page, async (chapter: string) => {
    const VC = await import('/js/ai/visual-cards.js');
    return VC.generateDiagrams({ chapterText: chapter, count: 2 });
  }, CHAPTER_TEXT);
  expect(res.attempts).toBe(1);
  expect(res.diagrams).toHaveLength(2);
  expect(res.diagrams[0].question).toBe('¿Qué desacopla al productor del consumidor?');
  expect(res.diagrams[1].answerNodeId).toBe('tgt2');
  let state = await page.evaluate(() => (window as any).__vc);
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0].stream).toBe(true);
  expect(state.calls[0].max_tokens).toBeGreaterThanOrEqual(4000);
  expect(state.calls[0].messages[0].content).toContain('ESTRUCTURA RELACIONAL');

  // Primera llamada basura (JSON truncado), segunda usable: exactamente UNA regeneración.
  await setupStreamStub(page, ['Aquí va: {"diagrams":[{"concept":"roto"', batch]);
  const res2 = await inPage(page, async (chapter: string) => {
    const VC = await import('/js/ai/visual-cards.js');
    return VC.generateDiagrams({ chapterText: chapter, count: 2 });
  }, CHAPTER_TEXT);
  expect(res2.attempts).toBe(2);
  expect(res2.diagrams).toHaveLength(2);
  state = await page.evaluate(() => (window as any).__vc);
  expect(state.calls).toHaveLength(2);             // solo una regeneración
});

test('buildDrawingCardMessages y parseDrawingCards: consigna en español, rúbrica de ≥3 pasos, descartes y cap', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const { msgs, parsed } = await inPage(page, async ({ chapter }: any) => {
    const VC = await import('/js/ai/visual-cards.js');
    const msgs = VC.buildDrawingCardMessages({ chapterText: chapter, count: 2 });
    const good = { question: 'Dibujá de memoria el flujo de mensajes del productor al consumidor.', steps: ['El productor publica en el buffer', 'El buffer acumula los mensajes', 'El consumidor los extrae después'], contextFact: 'El buffer desacopla ambos ritmos.' };
    const twoSteps = { question: 'Dibujá de memoria algo.', steps: ['paso 1', 'paso 2'], contextFact: 'f' };
    const blankSteps = { question: 'Dibujá de memoria el ciclo.', steps: ['El productor publica', '   ', 'El buffer acumula', 'El consumidor extrae'], contextFact: 'f' };
    const noQuestion = { question: '   ', steps: ['a', 'b', 'c'], contextFact: 'f' };
    const wrapped = 'Claro:\n```json\n' + JSON.stringify({ cards: [good, twoSteps, noQuestion] }) + '\n```';
    return {
      msgs,
      parsed: {
        wrapped: VC.parseDrawingCards(wrapped),
        blankSteps: VC.parseDrawingCards(JSON.stringify({ cards: [blankSteps] })),
        capped: VC.parseDrawingCards(JSON.stringify({ cards: [good, good] }), { maxCards: 1 }),
        garbage: VC.parseDrawingCards('basura { sin cerrar'),
        nullInput: VC.parseDrawingCards(null as any),
      },
    };
  }, { chapter: CHAPTER_TEXT });
  // Prompt: consigna con "Dibuja de memoria" (español neutro, sin voseo), rúbrica de 3..7
  // pasos, rastreable y español.
  expect(msgs).toHaveLength(1);
  expect(msgs[0].role).toBe('system');
  expect(msgs[0].content).toContain('Dibuja de memoria');
  expect(msgs[0].content).not.toContain('Dibujá');
  expect(msgs[0].content).not.toMatch(/\bgenerá\b|\belegí\b/);
  expect(msgs[0].content).toContain('hasta 2');
  expect(msgs[0].content).toContain('entre 3 y 7');
  expect(msgs[0].content).toContain('rúbrica');
  expect(msgs[0].content).toContain('rastreable');
  expect(msgs[0].content).toContain('ESPAÑOL');
  expect(msgs[0].content).toContain('"cards"');
  expect(msgs[0].content).toContain(CHAPTER_TEXT);
  // Parseo: solo la tarjeta completa sobrevive (2 pasos no es rúbrica); pasos en blanco
  // se filtran; cap; basura → [] sin lanzar.
  expect(parsed.wrapped).toEqual([
    { question: 'Dibujá de memoria el flujo de mensajes del productor al consumidor.', steps: ['El productor publica en el buffer', 'El buffer acumula los mensajes', 'El consumidor los extrae después'], contextFact: 'El buffer desacopla ambos ritmos.' },
  ]);
  expect(parsed.blankSteps).toHaveLength(1);       // 3 pasos reales tras filtrar blanks
  expect(parsed.blankSteps[0].steps).toHaveLength(3);
  expect(parsed.capped).toHaveLength(1);
  expect(parsed.garbage).toEqual([]);
  expect(parsed.nullInput).toEqual([]);
});

test('generateDrawingCards: rúbrica válida via stream → { cards: [...] }', async ({ page }) => {
  const payload = JSON.stringify({ cards: [
    { question: 'Dibujá de memoria el flujo de mensajes del productor al consumidor.', steps: ['El productor publica en el buffer', 'El buffer acumula los mensajes', 'El consumidor los extrae después'], contextFact: 'El buffer desacopla ambos ritmos.' },
  ] });
  await setupStreamStub(page, payload);
  const res = await inPage(page, async (chapter: string) => {
    const VC = await import('/js/ai/visual-cards.js');
    return VC.generateDrawingCards({ chapterText: chapter, count: 1 });
  }, CHAPTER_TEXT);
  expect(res.cards).toEqual([
    { question: 'Dibujá de memoria el flujo de mensajes del productor al consumidor.', steps: ['El productor publica en el buffer', 'El buffer acumula los mensajes', 'El consumidor los extrae después'], contextFact: 'El buffer desacopla ambos ritmos.' },
  ]);
  const state = await page.evaluate(() => (window as any).__vc);
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0].stream).toBe(true);
  // El prompt pide la consigna en español NEUTRO (antes pedía voseo y las tarjetas
  // salían con «Dibujá», que no es el registro del producto).
  expect(state.calls[0].messages[0].content).toContain('Dibuja de memoria');
  expect(state.calls[0].messages[0].content).toContain('ESPAÑOL NEUTRO');
});
