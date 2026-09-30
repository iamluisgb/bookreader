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
// tarjetas cuyas occludedLabel existen en LABELS y una que no (Buffer). Desde
// WU1 los contextFact RESPONDEN su etiqueta: un dorso genérico sería descartado
// por el validador antes de llegar al mazo.
const OCCLUSION_JSON = JSON.stringify({ cards: [
  { occludedLabel: 'Message queue', question: '¿Qué desacopla al productor del consumidor?', contextFact: 'La message queue (buffer central) desacopla ambos ritmos.', difficulty: 'hard' },
  { occludedLabel: 'consumer', question: '¿Quién extrae los mensajes?', contextFact: 'El consumer extrae los mensajes después del productor.', difficulty: 'easy' },
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
// figureKey, bbox canónico del label elegido y type 'occlusion'. Los dorsos de
// las dos tarjetas válidas responden su etiqueta (WU1): si no, el validador las
// descartaría y esta prueba del contrato de figuraKey/bbox no podría correr.
test('buildVisualCards (solo occlusion, con labels): sin llamadas de visión y tarjetas con figureKey+bbox', async ({ page }) => {
  // La figura trae además un label SIN bbox ('Ghost'): el texto pasa el filtro de
  // visual-cards.js, pero sin coordenadas no hay tarjeta → stats.skipped sube acá
  // (antes del validador de dorso, que corre después del chequeo de bbox).
  const figure = { ...FIGURE_WITH_LABELS, labels: [...LABELS, { text: 'Ghost', bbox: null }] };
  const occlusionJson = JSON.stringify({ cards: [
    { occludedLabel: 'Message queue', question: '¿Qué desacopla al productor del consumidor?', contextFact: 'La message queue desacopla ambos ritmos.', difficulty: 'hard' },
    { occludedLabel: 'consumer', question: '¿Quién extrae los mensajes?', contextFact: 'El consumer extrae después.', difficulty: 'easy' },
    { occludedLabel: 'Ghost', question: 'q', contextFact: 'f' },
  ] });
  await setupDeckStub(page, [occlusionJson]);
  const res = await inPage(page, async ({ figure, chapter, occlusionJson }: any) => {
    const VD = await import('/js/ai/visual-deck.js');
    // 'basic' NO es tipo visual: tiene que ignorarse sin romper la corrida.
    return VD.buildVisualCards({ types: ['occlusion', 'basic'], chapterText: chapter, figures: [figure], bookTitle: 'Libro' });
  }, { figure, chapter: CHAPTER_TEXT, occlusionJson });
  expect(res.cards).toEqual([
    { type: 'occlusion', front: '¿Qué desacopla al productor del consumidor?', back: 'La message queue desacopla ambos ritmos.', figureKey: 'book:figures:f1', bbox: { x: 350, y: 30, w: 111, h: 16 }, occludedLabel: 'Message queue', chapter: '', src: '' },
    // 'consumer' casa sin caso con la label 'Consumer'.
    { type: 'occlusion', front: '¿Quién extrae los mensajes?', back: 'El consumer extrae después.', figureKey: 'book:figures:f1', bbox: { x: 668, y: 55, w: 73, h: 16 }, occludedLabel: 'consumer', chapter: '', src: '' },
  ]);
  expect(res.stats).toEqual({ figures: 1, grounded: 0, occlusion: 2, diagram: 0, drawing: 0, skipped: 1, rejectedFacts: 0 });
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
  expect(res2.stats).toEqual({ figures: 1, grounded: 0, occlusion: 0, diagram: 0, drawing: 0, skipped: 1, rejectedFacts: 0 });
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
  expect(res.stats).toEqual({ figures: 1, grounded: 0, occlusion: 2, diagram: 1, drawing: 1, skipped: 0, rejectedFacts: 0 });
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
  expect(res.stats).toEqual({ figures: 2, grounded: 0, occlusion: 2, diagram: 0, drawing: 0, skipped: 1, rejectedFacts: 0 });
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

// ---------------------------------------------------------------------------
// figureSize + grounding sin dimensiones persistidas: el modelo de figura
// (saveFigure en figures.js) NO guarda width/height, así que el tamaño hay que
// sacarlo del propio dataUrl cuando la figura no lo trae.
// ---------------------------------------------------------------------------

// Con width/height finitos y > 0 NO se decodifica nada: se devuelven tal cual.
// El dataUrl es basura a propósito: si figureSize intentara decodificarlo,
// onerror daría null y este test fallaría.
test('figureSize: width/height finitos se devuelven sin decodificar (el dataUrl no se toca)', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await inPage(page, async () => {
    const VD = await import('/js/ai/visual-deck.js');
    return VD.figureSize({ key: 'book:figures:f1', dataUrl: 'data:image/jpeg;base64,ZZZZ', width: 810, height: 130, labels: [] });
  });
  expect(res).toEqual({ width: 810, height: 130 });
});

// Sin width/height: el dataUrl real (canvas 40x30 dibujado en la página) se
// decodifica con un <img> y las dimensiones naturales son exactas.
test('figureSize: dataUrl real de canvas 40x30 decodifica exactamente {width: 40, height: 30}', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await inPage(page, async () => {
    const VD = await import('/js/ai/visual-deck.js');
    const c = document.createElement('canvas');
    c.width = 40;
    c.height = 30;
    c.getContext('2d').fillRect(0, 0, 40, 30);
    return VD.figureSize({ key: 'book:figures:f2', dataUrl: c.toDataURL('image/png'), labels: [] });
  });
  expect(res).toEqual({ width: 40, height: 30 });
});

// DataUrl ilegible: null y SIN colgarse (los caminos de error resuelven enseguida;
// si el timeout interno de 5 s estuviera roto, el test tardaría más de ~6 s).
test('figureSize: dataUrl basura devuelve null sin colgar el test', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await inPage(page, async () => {
    const VD = await import('/js/ai/visual-deck.js');
    const t0 = Date.now();
    const size = await VD.figureSize({ key: 'book:figures:f3', dataUrl: 'esto no es un dataUrl', labels: [] });
    return { size, elapsed: Date.now() - t0 };
  });
  expect(res.size).toBeNull();
  expect(res.elapsed).toBeLessThan(6000);
});

// La figura no trae dimensiones pero sí un dataUrl real: figureSize decodifica
// 40x30 ANTES de llamar al modelo de visión, y el prompt del grounding lleva la
// dimensión real (buildGroundingMessages arma "La imagen mide 40×30 píxeles.").
test('buildVisualCards: figura sin dimensiones y dataUrl real → grounding con el tamaño decodificado', async ({ page }) => {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 40;
    c.height = 30;
    c.getContext('2d').fillRect(0, 0, 40, 30);
    return c.toDataURL('image/png');
  });
  // Labels dentro de una imagen de 40x30: clampBbox las rechazaría si el
  // tamaño que llega al modelo no fuera el real.
  const groundedLabels = JSON.stringify({ labels: [
    { text: 'Eje X', bbox: [5, 5, 10, 6] },
    { text: 'Eje Y', bbox: [25, 20, 10, 6] },
  ] });
  const occlusionJson = JSON.stringify({ cards: [
    { occludedLabel: 'Eje X', question: '¿Qué eje del gráfico marca el tiempo?', contextFact: 'El eje X marca el tiempo.', difficulty: 'easy' },
  ] });
  await setupDeckStub(page, [groundedLabels, occlusionJson]);
  const res = await inPage(page, async ({ figure, chapter }: any) => {
    const VD = await import('/js/ai/visual-deck.js');
    return VD.buildVisualCards({ types: ['occlusion'], chapterText: chapter, figures: [figure] });
  }, { figure: { key: 'book:figures:f9', dataUrl, labels: [], caption: 'Fig. 9' }, chapter: CHAPTER_TEXT });
  // La tarjeta de oclusión SALE (con el fix latente no salía nunca).
  expect(res.cards).toHaveLength(1);
  expect(res.cards[0].type).toBe('occlusion');
  expect(res.cards[0].figureKey).toBe('book:figures:f9');
  expect(res.cards[0].bbox).toEqual({ x: 5, y: 5, w: 10, h: 6 });
  expect(res.stats.grounded).toBe(1);
  const state = await page.evaluate(() => (window as any).__vd);
  expect(state.calls).toHaveLength(2);   // grounding + pedagogía
  // El body del grounding lleva la dimensión REAL decodificada del dataUrl.
  const groundingText = state.calls[0].messages[0].content.find((p: any) => p.type === 'text').text;
  expect(groundingText).toContain('40×30');
  expect(state.calls[0].messages[0].content.some((p: any) => p.type === 'image_url')).toBe(true);
});

// DataUrl indescifrable y sin dimensiones: figureSize da null y la figura se
// saltea ANTES de llamar al modelo de visión (cero llamadas con image_url).
test('buildVisualCards: figura con dataUrl indescifrable se saltea sin llamar al modelo de visión', async ({ page }) => {
  await setupDeckStub(page, ['{"labels":[]}']);   // no debería consumirse nunca
  const res = await inPage(page, async ({ chapter }: any) => {
    const VD = await import('/js/ai/visual-deck.js');
    return VD.buildVisualCards({
      types: ['occlusion'],
      chapterText: chapter,
      figures: [{ key: 'book:figures:f10', dataUrl: 'data:image/jpeg;base64,NOPE', labels: [], caption: 'Fig. 10' }],
    });
  }, { chapter: CHAPTER_TEXT });
  expect(res.cards).toEqual([]);
  expect(res.stats.skipped).toBe(1);
  const state = await page.evaluate(() => (window as any).__vd);
  expect(state.calls).toHaveLength(0);   // ni grounding ni pedagogía
  expect(JSON.stringify(state.calls)).not.toContain('image_url');
});

// ---------------------------------------------------------------------------
// WU1: validador determinista de oclusiones. Con los datos reales del backup
// (2026-09-30), 0 de 6 dorsi mencionaban el contenido de la etiqueta tapada y
// dos tarjetas compartían exactamente el mismo dorso genérico: una tarjeta cuya
// respuesta no está en el dorso no se puede contestar, y es peor que no enviarla.
// ---------------------------------------------------------------------------

// Núcleo puro del validador con los CASOS REALES del backup: el dorso del
// granjero no responde la etiqueta de la barca, y el dorso genérico del grafo no
// responde SUBCLASSOF. Cuando el dorso nombra la etiqueta, pasa.
test('answersLabel: casos reales — dorso genérico no responde, dorso que nombra la etiqueta sí', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await inPage(page, async () => {
    const VD = await import('/js/ai/visual-deck.js');
    return {
      // Caso barca: el dorso genérico del granjero NO responde la etiqueta tapada.
      boat: VD.answersLabel(
        'El granjero no puede dejar a la oveja sola en ninguno de los dos lados.',
        'The boat can hold one person and one animal.'),
      // Caso SUBCLASSOF: dorso genérico sobre el grafo de conocimiento.
      subclassGeneric: VD.answersLabel(
        'El capítulo explica que el grafo de conocimiento «contains entities and relationships».',
        'SUBCLASSOF'),
      // La misma etiqueta, ahora nombrada en el dorso: pasa.
      subclassNamed: VD.answersLabel(
        'La relación SUBCLASSOF indica subclase de otra clase en la ontología.',
        'SUBCLASSOF'),
      // Etiqueta corta multi-palabra nombrada en el dorso.
      diabetes: VD.answersLabel(
        'La diabetes mellitus tipo 2 es un trastorno del metabolismo.',
        'Diabetes mellitus'),
      // Sin caso ni tildes: la comparación pasa igual.
      accents: VD.answersLabel('la configuracion basica del sistema', 'Configuración'),
      // Vacíos o basura: no se puede verificar → false.
      emptyFact: VD.answersLabel('', 'Productor'),
      emptyLabel: VD.answersLabel('El productor publica mensajes.', '   '),
      garbage: VD.answersLabel(null, undefined),
    };
  });
  expect(res.boat).toBe(false);
  expect(res.subclassGeneric).toBe(false);
  expect(res.subclassNamed).toBe(true);
  expect(res.diabetes).toBe(true);
  expect(res.accents).toBe(true);
  expect(res.emptyFact).toBe(false);
  expect(res.emptyLabel).toBe(false);
  expect(res.garbage).toBe(false);
});

// Dorsos repetidos: se queda la PRIMERA tarjeta de cada dorso normalizado (sin
// caso ni tildes). Las entradas sin dorso utilizable pasan de largo acá: quien
// las saca del mazo es sanitizeVisualCards.
test('dedupeFacts: el dorso repetido (sin caso ni tildes) deja pasar solo la primera', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const res = await inPage(page, async () => {
    const VD = await import('/js/ai/visual-deck.js');
    return {
      dup: VD.dedupeFacts([
        { front: 'q1', back: 'El buffer desacopla ambos ritmos.' },
        { front: 'q2', back: 'EL BUFFER desacopla ambos RITMOS!' },   // mismo dorso normalizado
        { front: 'q3', back: 'El consumidor extrae después.' },
      ]),
      distintos: VD.dedupeFacts([
        { front: 'q1', back: 'Primer dorso.' },
        { front: 'q2', back: 'Segundo dorso distinto.' },
      ]),
      vacio: VD.dedupeFacts([]),
      basura: VD.dedupeFacts(['x', null, 42] as any),
    };
  });
  expect(res.dup.map((c: any) => c.front)).toEqual(['q1', 'q3']);   // q2 repite el dorso de q1
  expect(res.distintos).toHaveLength(2);
  expect(res.vacio).toEqual([]);
  expect(res.basura).toEqual(['x', null, 42]);   // pasan de largo: los filtra sanitize
});

// Extremo a extremo: (a) un dorso que responde su etiqueta sobrevive, (b) un
// dorso genérico se descarta y (c) un dorso que repite el de (a) también. Solo
// UNA tarjeta llega al mazo y stats.rejectedFacts === 2.
test('buildVisualCards: el validador descarta el dorso genérico y el repetido (rejectedFacts = 2)', async ({ page }) => {
  const occJson = JSON.stringify({ cards: [
    // (a) responde su etiqueta: sobrevive.
    { occludedLabel: 'Message queue', question: '¿Qué desacopla al productor del consumidor?', contextFact: 'La message queue desacopla al productor del consumidor.', difficulty: 'hard' },
    // (b) dorso genérico real del backup: no menciona 'Producer' → descartada.
    { occludedLabel: 'Producer', question: '¿Quién publica los mensajes?', contextFact: 'El granjero no puede dejar a la oveja sola en ninguno de los dos lados.', difficulty: 'easy' },
    // (c) responde su etiqueta PERO repite el dorso de (a) → descartada por dedupe.
    { occludedLabel: 'Message queue', question: '¿Quién consume de la cola?', contextFact: 'La message queue desacopla al productor del consumidor.', difficulty: 'medium' },
  ] });
  await setupDeckStub(page, [occJson]);
  const res = await inPage(page, async ({ figure, chapter }: any) => {
    const VD = await import('/js/ai/visual-deck.js');
    return VD.buildVisualCards({ types: ['occlusion'], chapterText: chapter, figures: [figure] });
  }, { figure: FIGURE_WITH_LABELS, chapter: CHAPTER_TEXT });
  expect(res.cards).toEqual([
    { type: 'occlusion', front: '¿Qué desacopla al productor del consumidor?', back: 'La message queue desacopla al productor del consumidor.', figureKey: 'book:figures:f1', bbox: { x: 350, y: 30, w: 111, h: 16 }, occludedLabel: 'Message queue', chapter: '', src: '' },
  ]);
  expect(res.stats).toEqual({ figures: 1, grounded: 0, occlusion: 1, diagram: 0, drawing: 0, skipped: 0, rejectedFacts: 2 });
  const state = await page.evaluate(() => (window as any).__vd);
  expect(state.calls).toHaveLength(1);   // solo la llamada de pedagogía
});

// Guardia de regresión: grounding sin labels (no devuelve nada) → no se produce
// NINGUNA tarjeta y no se cuela una con dorso vacío (no hubo candidatas que
// validar: rejectedFacts queda en 0 y skipped refleja la figura salteada).
test('buildVisualCards: figura sin labels útiles no produce tarjetas ni dorsi vacíos', async ({ page }) => {
  await setupDeckStub(page, ['{"labels":[]}']);
  const res = await inPage(page, async ({ chapter }: any) => {
    const VD = await import('/js/ai/visual-deck.js');
    return VD.buildVisualCards({
      types: ['occlusion'],
      chapterText: chapter,
      figures: [{ key: 'book:figures:f11', dataUrl: 'data:image/jpeg;base64,CCCC', width: 810, height: 130, labels: [] }],
    });
  }, { chapter: CHAPTER_TEXT });
  expect(res.cards).toEqual([]);
  expect(res.stats).toEqual({ figures: 1, grounded: 0, occlusion: 0, diagram: 0, drawing: 0, skipped: 1, rejectedFacts: 0 });
  const state = await page.evaluate(() => (window as any).__vd);
  expect(state.calls.every((b: any) => b.model === 'vision-test')).toBe(true);   // solo grounding, 0 pedagogía
});
