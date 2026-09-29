import { test, expect } from '@playwright/test';
import { seedProLicense } from './pro-license';

// Tarjetas visuales (WU5b): orquestación del mazo visual (visual-deck.js). Los
// módulos se importan dentro de la página (misma convención que
// visual-cards.spec.ts) y el LLM se stubbea a nivel de window.fetch. A diferencia
// de WU3, una corrida hace VARIAS llamadas (grounding → oclusión → diagramas →
// dibujo), así que el stub responde una SECUENCIA de payloads: cada
// /chat/completions consume el siguiente elemento y el último se repite si
// faltara.

const DATA_URL = 'data:image/jpeg;base64,AAAA';

// Labels canónicas (bbox {x,y,w,h}, la forma que produce parseLabelsResponse).
const LABELS = [
  { text: 'Producer', bbox: { x: 71, y: 56, w: 66, h: 15 } },
  { text: 'Message queue', bbox: { x: 350, y: 30, w: 111, h: 16 } },
  { text: 'Consumer', bbox: { x: 668, y: 55, w: 73, h: 16 } },
];

const CHAPTER_TEXT = 'El productor publica mensajes en el buffer central y el consumidor los extrae después, de modo que el buffer desacopla ambos ritmos.';

// SVG limpio (raíz con viewBox, rect con id): mismo que usa visual-cards.spec.ts.
const CLEAN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 240">'
  + '<rect class="d-box" id="tgt" x="10" y="10" width="120" height="40"/>'
  + '<text class="d-txt" x="20" y="35">Cola de mensajes</text>'
  + '</svg>';

// Respuesta del prompt 2 (tool-call forzado de create_occlusion_cards): dos
// tarjetas cuyas occludedLabel existen en LABELS y una que no (Buffer).
const OCCLUSION_JSON = JSON.stringify({ cards: [
  { occludedLabel: 'Message queue', question: '¿Qué desacopla al productor del consumidor?', contextFact: 'El buffer desacopla ambos ritmos.', difficulty: 'hard' },
  { occludedLabel: 'consumer', question: '¿Quién extrae los mensajes?', contextFact: 'El consumidor extrae después.', difficulty: 'easy' },
  { occludedLabel: 'Buffer', question: 'q', contextFact: 'f' },
] });

const DIAGRAMS_JSON = JSON.stringify({ diagrams: [
  { concept: 'Flujo de mensajes', svg: CLEAN_SVG, answerNodeId: 'tgt', question: '¿Qué componente desacopla los ritmos?', contextFact: 'El buffer desacopla ambos ritmos.' },
] });

const DRAWING_JSON = JSON.stringify({ cards: [
  { question: 'Dibujá de memoria el flujo de mensajes del productor al consumidor.', steps: ['El productor publica en el buffer', 'El buffer acumula los mensajes', 'El consumidor los extrae después'], contextFact: 'El buffer desacopla ambos ritmos.' },
] });

// Figuras de prueba: una con labels (no necesita grounding) y una sin (sí).
const FIGURE_WITH_LABELS = { key: 'book:figures:f1', dataUrl: DATA_URL, width: 810, height: 130, labels: LABELS, caption: 'Fig. 3' };
const FIGURE_WITHOUT_LABELS = { key: 'book:figures:f2', dataUrl: DATA_URL, width: 810, height: 130, labels: [], caption: 'Fig. 4' };

// Stub de secuencia: cada /chat/completions consume el siguiente item y registra
// el body en window.__vd.calls. Un item es:
//   - string → respuesta OK cuyo `content` (o argumentos de tool-call, o SSE)
//     lleva ese texto, con la forma que pide la propia llamada:
//     tools → tool_calls forzados; stream → SSE; resto → content pelado (visión).
//   - number → respuesta HTTP con ese status (para simular errores del proveedor).
async function setupDeckStub(page, items: (string | number)[]) {
  await page.goto('/index.html');
  await seedProLicense(page);
  await page.evaluate(() => {
    localStorage.setItem('bookreader_ai_key', JSON.stringify('test-key'));
    localStorage.setItem('bookreader_ai_vision_model', JSON.stringify('vision-test'));
  });
  await page.evaluate((seq: (string | number)[]) => {
    const real = window.fetch.bind(window);
    (window as any).__vd = { calls: [] as any[] };
    let n = 0;
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions') && opts?.body) {
        const body = JSON.parse(opts.body);
        (window as any).__vd.calls.push(body);
        const item = seq[Math.min(n++, seq.length - 1)];
        if (typeof item === 'number') {
          return new Response('provider boom', { status: item });
        }
        if (body.stream) {
          // Camino de texto (chatStream): SSE como el que consume llm.js.
          const sse = [
            `data: ${JSON.stringify({ choices: [{ delta: { content: item }, finish_reason: null }] })}\n\n`,
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n',
          ];
          const s = new ReadableStream({ start(c) { const e = new TextEncoder(); sse.forEach(x => c.enqueue(e.encode(x))); c.close(); } });
          return new Response(s, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        if ((body.tools || []).length) {
          // Llamada forzada a herramienta: los argumentos SON el payload.
          const name = body.tool_choice?.function?.name || body.tools[0].function.name;
          const message = { content: '', tool_calls: [{ id: 'tc' + n, function: { name, arguments: item } }] };
          return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
        }
        // Llamada de visión (chatVision): content pelado.
        return new Response(JSON.stringify({ choices: [{ message: { content: item } }] }), { status: 200 });
      }
      return real(url, opts);
    };
  }, items);
}

// Importa el módulo dentro de la página y corre ahí un bloque async.
async function inPage(page, fn: (arg: any) => Promise<any>, arg?: any) {
  return page.evaluate(fn, arg);
}

test('VISUAL_TYPES e isVisualType: los tres tipos válidos y rechazo de lo demás', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await inPage(page, async () => {
    const VD = await import('/js/ai/visual-deck.js');
    return {
      types: VD.VISUAL_TYPES,
      valid: ['occlusion', 'diagram', 'drawing'].map(t => VD.isVisualType(t)),
      invalid: ['basic', 'cloze', '', 'occlusions', null, undefined, 42].map(t => VD.isVisualType(t)),
    };
  });
  expect(res.types).toEqual(['occlusion', 'diagram', 'drawing']);
  expect(res.valid).toEqual([true, true, true]);
  expect(res.invalid).toEqual([false, false, false, false, false, false, false]);
});

test('pickLabeledFigure: coincide sin caso ni tildes y devuelve null si la etiqueta no está', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await inPage(page, async (labels: any) => {
    const VD = await import('/js/ai/visual-deck.js');
    return {
      exact: VD.pickLabeledFigure(labels, 'Message queue'),
      case: VD.pickLabeledFigure(labels, 'message queue'),
      accents: VD.pickLabeledFigure([{ text: 'Configuración', bbox: { x: 1, y: 2, w: 3, h: 4 } }], 'configuracion'),
      missing: VD.pickLabeledFigure(labels, 'Buffer'),
      empty: VD.pickLabeledFigure(labels, '   '),
      garbage: VD.pickLabeledFigure('no soy lista' as any, 'Producer'),
    };
  }, LABELS);
  expect(res.exact).toEqual(LABELS[1]);
  expect(res.case).toEqual(LABELS[1]);
  expect(res.accents).toEqual({ text: 'Configuración', bbox: { x: 1, y: 2, w: 3, h: 4 } });
  expect(res.missing).toBeNull();
  expect(res.empty).toBeNull();
  expect(res.garbage).toBeNull();
});

test('sanitizeVisualCards: campos obligatorios por tipo, dedupe por front, cap y basura → []', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await inPage(page, async (clean: string) => {
    const VD = await import('/js/ai/visual-deck.js');
    const occ = { type: 'occlusion', front: '¿Qué desacopla?', back: 'El buffer.', figureKey: 'b:figures:f1', bbox: { x: 71, y: 56, w: 66, h: 15 }, occludedLabel: 'Producer' };
    const dia = { type: 'diagram', front: '¿Qué flujo es?', back: 'El de mensajes.', svg: clean, answerNodeId: 'tgt' };
    const draw = { type: 'drawing', front: 'Dibujá el flujo.', back: 'ctx', steps: ['a', 'b', 'c'] };
    return {
      good: VD.sanitizeVisualCards([occ, dia, draw]),
      badType: VD.sanitizeVisualCards([{ type: 'basic', front: 'x' }, { type: 'cloze', front: 'y' }, occ]),
      occNoBbox: VD.sanitizeVisualCards([{ ...occ, bbox: null }]),
      occBadBbox: VD.sanitizeVisualCards([{ ...occ, bbox: { x: 1, y: 2 } }]),
      occNoKey: VD.sanitizeVisualCards([{ ...occ, figureKey: '  ' }]),
      diaNoSvg: VD.sanitizeVisualCards([{ ...dia, svg: '' }]),
      diaNoFront: VD.sanitizeVisualCards([{ ...dia, front: '   ' }]),
      drawTwoSteps: VD.sanitizeVisualCards([{ ...draw, steps: ['a', 'b'] }]),
      dup: VD.sanitizeVisualCards([occ, { ...occ, back: 'otra' }]),
      dupAccents: VD.sanitizeVisualCards([occ, { ...occ, front: '¿QUE desacopla?' }]),
      capped: VD.sanitizeVisualCards([occ, dia, draw], { max: 2 }),
      garbage: VD.sanitizeVisualCards(['basura', null, 42, { noType: true }] as any),
      empty: VD.sanitizeVisualCards([]),
      // bbox en forma array (la del modelo) también se acepta y se canonicaliza.
      bboxArray: VD.sanitizeVisualCards([{ ...occ, bbox: [71.4, 56, 66, 15] }]),
    };
  }, CLEAN_SVG);
  // Las tres buenas salen completas: se normalizan chapter/src a '' y el resto
  // queda tal cual (ya estaban recortadas y sin campos de más).
  expect(res.good).toEqual([
    { type: 'occlusion', front: '¿Qué desacopla?', back: 'El buffer.', figureKey: 'b:figures:f1', bbox: { x: 71, y: 56, w: 66, h: 15 }, occludedLabel: 'Producer', chapter: '', src: '' },
    { type: 'diagram', front: '¿Qué flujo es?', back: 'El de mensajes.', svg: CLEAN_SVG, answerNodeId: 'tgt', chapter: '', src: '' },
    { type: 'drawing', front: 'Dibujá el flujo.', back: 'ctx', steps: ['a', 'b', 'c'], chapter: '', src: '' },
  ]);
  expect(res.badType).toHaveLength(1);          // solo sobrevive la occlusion válida
  expect(res.badType[0].type).toBe('occlusion');
  expect(res.occNoBbox).toEqual([]);
  expect(res.occBadBbox).toEqual([]);
  expect(res.occNoKey).toEqual([]);
  expect(res.diaNoSvg).toEqual([]);
  expect(res.diaNoFront).toEqual([]);
  expect(res.drawTwoSteps).toEqual([]);          // 2 pasos no es rúbrica
  expect(res.dup).toHaveLength(1);               // dedupe por front
  expect(res.dupAccents).toHaveLength(1);        // dedupe sin caso ni tildes
  expect(res.capped).toHaveLength(2);            // cap a max
  expect(res.garbage).toEqual([]);               // nunca lanza
  expect(res.empty).toEqual([]);
  expect(res.bboxArray[0].bbox).toEqual({ x: 71, y: 56, w: 66, h: 15 });
});

// buildVisualCards solo occlusion, figuras que YA traen labels: ni una llamada
// al modelo de visión (todo body sin image_url) y una tarjeta por oclusión con
// figureKey, bbox canónico del label elegido y type 'occlusion'.
test('buildVisualCards (solo occlusion, con labels): sin llamadas de visión y tarjetas con figureKey+bbox', async ({ page }) => {
  // La figura trae además un label SIN bbox ('Ghost'): el texto pasa el filtro de
  // visual-cards.js, pero sin coordenadas no hay tarjeta → stats.skipped sube acá.
  const figure = { ...FIGURE_WITH_LABELS, labels: [...LABELS, { text: 'Ghost', bbox: null }] };
  const occlusionJson = JSON.stringify({ cards: [
    { occludedLabel: 'Message queue', question: '¿Qué desacopla al productor del consumidor?', contextFact: 'El buffer desacopla ambos ritmos.', difficulty: 'hard' },
    { occludedLabel: 'consumer', question: '¿Quién extrae los mensajes?', contextFact: 'El consumidor extrae después.', difficulty: 'easy' },
    { occludedLabel: 'Ghost', question: 'q', contextFact: 'f' },
  ] });
  await setupDeckStub(page, [occlusionJson]);
  const res = await inPage(page, async ({ figure, chapter, occlusionJson }: any) => {
    const VD = await import('/js/ai/visual-deck.js');
    // 'basic' NO es tipo visual: tiene que ignorarse sin romper la corrida.
    return VD.buildVisualCards({ types: ['occlusion', 'basic'], chapterText: chapter, figures: [figure], bookTitle: 'Libro' });
  }, { figure, chapter: CHAPTER_TEXT, occlusionJson });
  expect(res.cards).toEqual([
    { type: 'occlusion', front: '¿Qué desacopla al productor del consumidor?', back: 'El buffer desacopla ambos ritmos.', figureKey: 'book:figures:f1', bbox: { x: 350, y: 30, w: 111, h: 16 }, occludedLabel: 'Message queue', chapter: '', src: '' },
    // 'consumer' casa sin caso con la label 'Consumer'.
    { type: 'occlusion', front: '¿Quién extrae los mensajes?', back: 'El consumidor extrae después.', figureKey: 'book:figures:f1', bbox: { x: 668, y: 55, w: 73, h: 16 }, occludedLabel: 'consumer', chapter: '', src: '' },
  ]);
  expect(res.stats).toEqual({ figures: 1, grounded: 0, occlusion: 2, diagram: 0, drawing: 0, skipped: 1 });
  const state = await page.evaluate(() => (window as any).__vd);
  expect(state.calls).toHaveLength(1);                    // UNA llamada de pedagogía
  expect(state.calls[0].tools[0].function.name).toBe('create_occlusion_cards');
  // Ninguna parte del pedido lleva imagen: el grounding no hizo falta.
  expect(JSON.stringify(state.calls)).not.toContain('image_url');
  expect(state.calls[0].messages[0].content).toContain('MAYER');
});

// Figura SIN labels: primero grounding (la PRIMERA llamada lleva image_url) y
// después la de oclusión. Y el caso triste: grounding con labels vacías → la
// figura se salta y stats.skipped sube.
test('buildVisualCards (figura sin labels): grounding primero, y con labels vacías se salta', async ({ page }) => {
  // (a) Grounding rendidor: labels nuevas → la 2ª llamada es la de oclusión.
  const groundedLabels = JSON.stringify({ labels: [
    { text: 'Producer', bbox: [71, 56, 66, 15] },
    { text: 'Message queue', bbox: [350, 30, 111, 16] },
    { text: 'Consumer', bbox: [668, 55, 73, 16] },
  ] });
  await setupDeckStub(page, [groundedLabels, OCCLUSION_JSON]);
  const res = await inPage(page, async ({ figure, chapter }: any) => {
    const VD = await import('/js/ai/visual-deck.js');
    return VD.buildVisualCards({ types: ['occlusion'], chapterText: chapter, figures: [figure] });
  }, { figure: FIGURE_WITHOUT_LABELS, chapter: CHAPTER_TEXT });
  expect(res.cards).toHaveLength(2);
  expect(res.cards[0].figureKey).toBe('book:figures:f2');
  expect(res.cards[0].bbox).toEqual({ x: 350, y: 30, w: 111, h: 16 });
  expect(res.stats.grounded).toBe(1);
  const state = await page.evaluate(() => (window as any).__vd);
  expect(state.calls).toHaveLength(2);
  // PRIMERA llamada: multimodal, con la imagen (grounding). SEGUNDA: solo texto.
  expect(state.calls[0].messages[0].content.some((p: any) => p.type === 'image_url')).toBe(true);
  expect(state.calls[0].model).toBe('vision-test');
  expect(JSON.stringify(state.calls[1])).not.toContain('image_url');

  // (b) Grounding sordo (labels vacías en ambos intentos de groundFigure): la
  // figura se salta sin llamada de oclusión y skipped sube.
  await setupDeckStub(page, ['{"labels":[]}']);
  const res2 = await inPage(page, async ({ figure, chapter }: any) => {
    const VD = await import('/js/ai/visual-deck.js');
    return VD.buildVisualCards({ types: ['occlusion'], chapterText: chapter, figures: [figure] });
  }, { figure: FIGURE_WITHOUT_LABELS, chapter: CHAPTER_TEXT });
  expect(res2.cards).toEqual([]);
  expect(res2.stats).toEqual({ figures: 1, grounded: 0, occlusion: 0, diagram: 0, drawing: 0, skipped: 1 });
  const state2 = await page.evaluate(() => (window as any).__vd);
  expect(state2.calls).toHaveLength(2);   // 2 intentos de visión, 0 de pedagogía
  expect(state2.calls.every((b: any) => b.model === 'vision-test')).toBe(true);
});

// Los tres tipos juntos: occlusion + diagram + drawing, stats coherentes (una
// llamada por familia) y onProgress reporta las fases en orden.
test('buildVisualCards (tres tipos): mazo mixto, una llamada por familia y fases en orden', async ({ page }) => {
  await setupDeckStub(page, [OCCLUSION_JSON, DIAGRAMS_JSON, DRAWING_JSON]);
  const res = await inPage(page, async ({ figure, chapter }: any) => {
    const VD = await import('/js/ai/visual-deck.js');
    const phases: any[] = [];
    const out = await VD.buildVisualCards({
      types: ['occlusion', 'diagram', 'drawing'],
      chapterText: chapter,
      figures: [figure],
      onProgress: (p: any) => phases.push(p),
    });
    return { ...out, phases };
  }, { figure: FIGURE_WITH_LABELS, chapter: CHAPTER_TEXT });
  const types = res.cards.map((c: any) => c.type);
  expect(types).toEqual(['occlusion', 'occlusion', 'diagram', 'drawing']);
  expect(res.stats).toEqual({ figures: 1, grounded: 0, occlusion: 2, diagram: 1, drawing: 1, skipped: 0 });
  expect(res.cards[2].svg).toContain('<svg');
  expect(res.cards[2].answerNodeId).toBe('tgt');
  expect(res.cards[3].steps).toHaveLength(3);
  expect(res.phases).toEqual([
    { phase: 'occlusion', done: 1, total: 1 },
    { phase: 'diagram', done: 1, total: 1 },
    { phase: 'drawing', done: 1, total: 1 },
  ]);
  const state = await page.evaluate(() => (window as any).__vd);
  expect(state.calls).toHaveLength(3);   // una por familia: tools + stream + stream
  expect(state.calls[0].tools).toBeTruthy();
  expect(state.calls[1].stream).toBe(true);
  expect(state.calls[2].stream).toBe(true);
});

// Un error HTTP en el grounding de la primera figura NO corta la corrida: la
// segunda figura (con labels) sí produce tarjeta y skipped refleja el fallo.
// Status 400 a propósito: no es retryable, así que el fallo es inmediato.
test('buildVisualCards: error HTTP en el grounding de una figura no corta la corrida', async ({ page }) => {
  await setupDeckStub(page, [400, OCCLUSION_JSON]);
  const res = await inPage(page, async ({ chapter, figure }: any) => {
    const VD = await import('/js/ai/visual-deck.js');
    return VD.buildVisualCards({
      types: ['occlusion'],
      chapterText: chapter,
      figures: [
        { key: 'book:figures:bad', dataUrl: 'data:image/jpeg;base64,BBBB', width: 810, height: 130, labels: [] },
        figure,
      ],
    });
  }, { chapter: CHAPTER_TEXT, figure: FIGURE_WITH_LABELS });
  expect(res.cards).toHaveLength(2);
  expect(res.cards.every((c: any) => c.figureKey === 'book:figures:f1')).toBe(true);
  expect(res.stats).toEqual({ figures: 2, grounded: 0, occlusion: 2, diagram: 0, drawing: 0, skipped: 1 });
  const state = await page.evaluate(() => (window as any).__vd);
  expect(state.calls).toHaveLength(2);   // grounding fallido + oclusión de la 2ª figura
});

// AbortError del signal propaga: buildVisualCards rechaza con name 'AbortError'.
test('buildVisualCards: el abort del signal propaga AbortError', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await page.evaluate(() => {
    localStorage.setItem('bookreader_ai_key', JSON.stringify('test-key'));
    localStorage.setItem('bookreader_ai_vision_model', JSON.stringify('vision-test'));
  });
  const out = await page.evaluate(async () => {
    const VD: any = await import('/js/ai/visual-deck.js');
    const controller = new AbortController();
    controller.abort();   // señal ya abortada: la primera llamada debe cortar
    try {
      await VD.buildVisualCards({
        types: ['occlusion'],
        chapterText: 'texto',
        figures: [{ key: 'book:figures:f1', dataUrl: 'data:image/jpeg;base64,AAAA', labels: [{ text: 'Producer', bbox: { x: 1, y: 1, w: 10, h: 10 } }] }],
        signal: controller.signal,
      });
      return 'resolvió';
    } catch (e: any) {
      return e.name;
    }
  });
  expect(out).toBe('AbortError');
});
