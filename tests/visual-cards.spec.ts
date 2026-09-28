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
  // Parte de texto: contrato JSON exacto, medidas y la orden de omitir lo dudoso.
  expect(content[0].type).toBe('text');
  expect(content[0].text).toContain('{"labels":[{"text":"<texto exacto>","bbox":[x,y,w,h]}]}');
  expect(content[0].text).toContain('La imagen mide 810×130 píxeles');
  expect(content[0].text).toContain('Omite las etiquetas');
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
  // Camino feliz: el stub devuelve el JSON de labels y solo hace falta una llamada.
  await setupLLMStub(page, JSON.stringify({ labels: [
    { text: 'Producer', bbox: [71, 56, 66, 15] },
    { text: 'Message queue', bbox: [350.4, 30, 111, 16] },
  ] }));
  const res = await inPage(page, async (dataUrl: string) => {
    const VC = await import('/js/ai/visual-cards.js');
    return VC.groundFigure({ dataUrl, width: 810, height: 130 });
  }, DATA_URL);
  expect(res.attempts).toBe(1);
  expect(res.truncated).toBe(false);
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
