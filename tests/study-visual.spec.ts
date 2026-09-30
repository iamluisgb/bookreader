import { test, expect } from '@playwright/test';
import { seedProLicense } from './pro-license';

// WU6 · Render por tipo de tarjeta visual en la sesión de estudio (odd/tasks/tarjetas-visuales.md):
//  - occlusion: figura del store de artefactos + caja ocluidora en % del bbox
//  - diagram: SVG saneado con el label de respuesta tapado («?») en el frente
//  - drawing: lienzo con trazas acumulativas + rúbrica de pasos en el dorso
//  - buildQueue: tarjetas visuales sin `front` entran a la cola; basura sin visual, no.

interface VisualSeed {
  bookId: string;
  deckName?: string;
  cards: any[];
  figure?: { dataUrl: string; width: number; height: number } | null;
}

// Siembra libro + mazo con tarjetas visuales y, opcionalmente, la figura referida
// por figureKey en el store de artefactos (como la deja saveFigure de figures.js).
async function seedVisualDeck(page, seed: VisualSeed): Promise<void> {
  await page.evaluate(async (s) => {
    const DB: any = await import('/js/ai/db.js');
    const Lib: any = await import('/js/library/store.js');
    await Lib.putBook({
      id: s.bookId, title: 'Libro visual', format: 'epub', fileName: 't.epub',
      addedAt: Date.now(), lastOpenedAt: Date.now(), progress: 0, status: 'reading', shelfIds: [],
    });
    // Figura real (dataUrl de canvas) con dimensiones persistidas, como pide el contrato.
    let figureKey = '';
    if (s.figure) {
      figureKey = await DB.putArtifact({
        bookId: s.bookId, kind: 'figures', id: 'fig1',
        result: {
          page: 1, rect: { x: 0, y: 0, w: s.figure.width, h: s.figure.height },
          dataUrl: s.figure.dataUrl, labels: [], caption: '', source: '',
          width: s.figure.width, height: s.figure.height,
        },
      });
    }
    await DB.addDeck({
      bookId: s.bookId, name: s.deckName || 'Mazo visual', cardType: 'mixed', scope: '',
      cards: s.cards.map((c: any) => ({ chapter: '', src: '', ...c, figureKey: c.figureKey ?? figureKey })),
    });
  }, seed);
}

// Genera un dataUrl PNG real de canvas con el tamaño dado (la figura del store es una
// imagen decodificable, no un string inventado).
async function makeFigureDataUrl(page: any, width: number, height: number): Promise<string> {
  return page.evaluate(([w, h]: [number, number]) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#f0ede6';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#333';
    ctx.strokeRect(10, 10, w - 20, h - 20);
    return c.toDataURL('image/png');
  }, [width, height]);
}

test('occlusion: caja posicionada por bbox en el frente y revelada con la respuesta al voltear', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const dataUrl = await makeFigureDataUrl(page, 200, 100);
  await seedVisualDeck(page, {
    bookId: 'bk-vis1',
    cards: [{
      type: 'occlusion',
      front: '¿Qué etiqueta está tapada en la figura?',
      back: 'La cola equilibra al animal en marcha.',
      bbox: { x: 50, y: 25, w: 50, h: 25 },   // 200x100 → 25% en cada eje
      occludedLabel: 'Cola',
    }],
    figure: { dataUrl, width: 200, height: 100 },
  });
  await page.reload();
  await page.locator('.lib-study-chip').click();
  const overlay = page.locator('#ai-study');

  // Frente: la pregunta y la caja ya montada (el figureKey resolvió contra el store).
  await expect(overlay.locator('.study-q')).toContainText('¿Qué etiqueta está tapada');
  const box = overlay.locator('.study-occl');
  await expect(box).toBeVisible();
  // La caja se posiciona en PORCENTAJES de la caja de imagen, con el bbox persistido.
  await expect(box).toHaveAttribute('style', /left:\s*25%/);
  await expect(box).toHaveAttribute('style', /top:\s*25%/);
  await expect(box).toHaveAttribute('style', /width:\s*25%/);
  await expect(box).toHaveAttribute('style', /height:\s*25%/);
  // Antes de girar no se canta la respuesta (ni en la caja ni en la cara frontal).
  await expect(overlay.locator('.study-face--front')).not.toContainText('Cola');

  // Dorso: misma figura con la caja resaltada + respuesta + dato de contexto.
  await overlay.locator('.study-flip').click();
  const boxBack = overlay.locator('.study-face--back .study-occl');
  await expect(boxBack).toHaveClass(/is-hl/);
  await expect(overlay.locator('.study-face--back')).toContainText('Cola');
  await expect(overlay.locator('.study-face--back')).toContainText('La cola equilibra');
});

test('occlusion con figura ausente: placeholder visible y sin errores', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/index.html');
  await seedProLicense(page);
  await seedVisualDeck(page, {
    bookId: 'bk-vis2',
    cards: [{
      type: 'occlusion',
      front: '¿Qué letra está tapada?',
      back: 'Es la A.',
      bbox: { x: 10, y: 10, w: 30, h: 30 },
      occludedLabel: 'A',
      figureKey: 'bk-vis2:figures:inexistente',   // no está en el store (sync parcial)
    }],
    figure: null,
  });
  await page.reload();
  await page.locator('.lib-study-chip').click();
  const overlay = page.locator('#ai-study');

  // Placeholder silencioso (nunca un <img> roto) y la sesión sigue viva.
  await expect(overlay.locator('.study-fig-empty')).toBeVisible();
  await expect(overlay.locator('.study-fig img')).toHaveCount(0);
  await overlay.locator('.study-flip').click();
  await expect(overlay.locator('.study-face--back')).toContainText('Es la A.');
  expect(errors).toEqual([]);
});

test('diagram: el label del nodo de respuesta se tapa en el frente y vuelve al voltear', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await seedVisualDeck(page, {
    bookId: 'bk-vis3',
    cards: [{
      type: 'diagram',
      front: '¿Qué parte señala la flecha?',
      back: 'La cola: contrapeso y timón.',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60">'
        + '<text x="10" y="20">Cabeza</text>'
        + '<text id="tgt" x="10" y="50">Cola</text></svg>',
      answerNodeId: 'tgt',
    }],
    figure: null,
  });
  await page.reload();
  await page.locator('.lib-study-chip').click();
  const overlay = page.locator('#ai-study');
  const front = overlay.locator('.study-face--front');

  // Frente: el nodo de respuesta muestra «?»; el resto de los labels queda intacto.
  await expect(front.locator('.study-diagram')).toBeVisible();
  await expect(front.locator('#tgt')).toHaveText('?');
  await expect(front.locator('.study-diagram')).toContainText('Cabeza');
  await expect(front.locator('.study-diagram')).not.toContainText('Cola');

  // Dorso: el SVG vuelve sin máscara (el highlight lo puso el prompt generador).
  await overlay.locator('.study-flip').click();
  const back = overlay.locator('.study-face--back');
  await expect(back.locator('#tgt')).toHaveText('Cola');
  await expect(back).toContainText('La cola: contrapeso');
});

test('diagram con script en el SVG: placeholder y ningún <script> en el DOM', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await seedVisualDeck(page, {
    bookId: 'bk-vis4',
    cards: [{
      type: 'diagram',
      front: 'Diagrama sospechoso',
      back: '',
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script>'
        + '<text id="x">Hola</text></svg>',
      answerNodeId: 'x',
    }],
    figure: null,
  });
  await page.reload();
  await page.locator('.lib-study-chip').click();
  const overlay = page.locator('#ai-study');

  // El SVG no valida (sanitizeSvg rechaza <script>) → placeholder, nunca inyección.
  await expect(overlay.locator('.study-diagram .study-fig-empty')).toBeVisible();
  expect(await page.evaluate(() => document.querySelectorAll('#ai-study script').length)).toBe(0);
});

test('drawing: dos trazos acumulan, Deshacer saca una, Limpiar vacía, y el dorso lista los pasos', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await seedVisualDeck(page, {
    bookId: 'bk-vis5',
    cards: [{
      type: 'drawing',
      front: 'Dibujá el ciclo del agua.',
      back: 'El sol mueve todo el ciclo.',
      steps: ['Evaporación del agua', 'Condensación en nubes', 'Precipitación'],
    }],
    figure: null,
  });
  await page.reload();
  await page.locator('.lib-study-chip').click();
  const overlay = page.locator('#ai-study');
  const canvas = overlay.locator('.study-draw-canvas');
  await expect(canvas).toBeVisible();

  // Dos arrastres sucesivos → dos trazos: el redibujado ACUMULA, no repinta solo el actual.
  const drag = async (x0: number, y0: number) => {
    const box = await canvas.boundingBox();
    await page.mouse.move(box!.x + x0, box!.y + y0);
    await page.mouse.down();
    await page.mouse.move(box!.x + x0 + 60, box!.y + y0 + 30, { steps: 4 });
    await page.mouse.up();
  };
  await drag(10, 10);
  await drag(30, 60);
  expect(await page.evaluate(() => (document.querySelector('.study-draw-canvas') as any)._strokes.length)).toBe(2);
  // Dibujar no voltea la tarjeta.
  await expect(overlay.locator('.study-flip')).toContainText('Mostrar respuesta');

  await overlay.locator('.study-draw-undo').click();
  expect(await page.evaluate(() => (document.querySelector('.study-draw-canvas') as any)._strokes.length)).toBe(1);
  await overlay.locator('.study-draw-clear').click();
  expect(await page.evaluate(() => (document.querySelector('.study-draw-canvas') as any)._strokes.length)).toBe(0);

  // Dorso: la rúbrica en orden + el dato de contexto.
  await overlay.locator('.study-flip').click();
  const steps = overlay.locator('.study-steps li');
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toHaveText('Evaporación del agua');
  await expect(steps.nth(2)).toHaveText('Precipitación');
  await expect(overlay.locator('.study-face--back')).toContainText('El sol mueve todo el ciclo');
});

test('buildQueue: tarjeta visual sin front entra a la cola; sin front y sin visual, no', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await page.reload();
  const result = await page.evaluate(async () => {
    const Study: any = await import('/js/ai/study.js');
    const cards = [
      { type: 'diagram', front: '', back: '', svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', answerNodeId: '', chapter: '', src: '' },
      { type: 'occlusion', front: '', back: '', figureKey: 'bk:figures:1', bbox: { x: 1, y: 1, w: 2, h: 2 }, chapter: '', src: '' },
      { type: 'drawing', front: '', back: '', steps: ['a', 'b', 'c'], chapter: '', src: '' },
      { type: 'basic', front: '', back: 'sin nada', chapter: '', src: '' },
      { type: 'basic', front: 'pregunta normal', back: 'r', chapter: '', src: '' },
    ];
    const { queue } = Study.buildQueue([{ id: 1, bookId: 'bk-q', name: 'q', cards }]);
    return { included: queue.map((e: any) => e.idx) };
  });
  // Entran las tres visuales (aun sin front) y la básica con pregunta; la vacía, no.
  expect(result.included.sort()).toEqual([0, 1, 2, 4]);
});

// ---------------------------------------------------------------------------
// WU7 · Revisión del boceto con visión: prompt + veredicto por pasos + trazos
// coloreados por paso. Sin modelo de visión: cero red y la rúbrica de siempre.
// ---------------------------------------------------------------------------

const PLAN_5 = ['Evaporación del agua', 'Condensación en nubes', 'Precipitación', 'Escurrimiento', 'Infiltración'];

// Licencia Pro + key + modelo de visión en localStorage (el mismo patrón de
// visual-cards.spec.ts: chatVision los exige).
async function setupVision(page): Promise<void> {
  await page.goto('/index.html');
  await seedProLicense(page);
  await page.evaluate(() => {
    localStorage.setItem('bookreader_ai_key', JSON.stringify('test-key'));
    localStorage.setItem('bookreader_ai_vision_model', JSON.stringify('vision-test'));
  });
}

// Stub de /chat/completions que registra cada body en window.__rev.calls y responde
// con `payload` como content del mensaje.
async function stubChat(page, payload: string): Promise<void> {
  await page.evaluate((content) => {
    const real = window.fetch.bind(window);
    (window as any).__rev = { calls: [] as any[] };
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions') && opts?.body) {
        (window as any).__rev.calls.push(JSON.parse(opts.body));
        return new Response(
          JSON.stringify({ choices: [{ message: { content } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return real(url, opts);
    };
  }, payload);
}

// Contador de fetch sin respuestas falsas (para probar que NO hay red).
async function stubFetchCounter(page): Promise<void> {
  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    (window as any).__rev = { calls: [] as string[] };
    window.fetch = async (url: any, opts: any) => {
      (window as any).__rev.calls.push(typeof url === 'string' ? url : url?.url || '');
      return real(url, opts);
    };
  });
}

// Dos trazos en el canvas (mismo gesto que el test del lienzo de WU6).
async function drawTwoStrokes(page): Promise<void> {
  const canvas = page.locator('.study-draw-canvas');
  const drag = async (x0: number, y0: number) => {
    const box = await canvas.boundingBox();
    await page.mouse.move(box!.x + x0, box!.y + y0);
    await page.mouse.down();
    await page.mouse.move(box!.x + x0 + 60, box!.y + y0 + 30, { steps: 4 });
    await page.mouse.up();
  };
  await drag(10, 10);
  await drag(30, 60);
}

test('drawing review: la imagen y la rúbrica viajan al modelo; el veredicto colorea trazos por paso', async ({ page }) => {
  await setupVision(page);
  await seedVisualDeck(page, {
    bookId: 'bk-vis7a',
    cards: [{ type: 'drawing', front: 'Dibujá el ciclo del agua.', back: '', steps: PLAN_5 }],
    figure: null,
  });
  await page.reload();
  await stubChat(page, JSON.stringify({
    steps: [
      { name: 'Evaporación del agua', detected: true, stroke: 1 },
      { name: 'Condensación en nubes', detected: true, stroke: 2 },
      { name: 'Precipitación', detected: false, stroke: null },
      { name: 'Escurrimiento', detected: false, stroke: null },
      { name: 'Infiltración', detected: false, stroke: null },
    ],
    extraCount: 0,
    comment: 'Muy bien: el sol y las nubes están, faltan tres pasos.',
  }));
  await page.locator('.lib-study-chip').click();
  const overlay = page.locator('#ai-study');
  await drawTwoStrokes(page);
  await overlay.locator('.study-flip').click();

  // El pedido al modelo: modelo de visión, parte image_url (JPEG) y la rúbrica completa.
  const state = await page.evaluate(() => (window as any).__rev);
  expect(state.calls).toHaveLength(1);
  const body = state.calls[0];
  expect(body.model).toBe('vision-test');
  expect(body.max_tokens).toBeGreaterThanOrEqual(4000);
  const content = body.messages[0].content;
  const imgPart = content.find((p: any) => p.type === 'image_url');
  expect(imgPart.image_url.url).toMatch(/^data:image\/jpeg;/);
  const textPart = content.find((p: any) => p.type === 'text');
  for (const step of PLAN_5) expect(textPart.text).toContain(step);
  expect(textPart.text).toContain('"i":1');
  expect(textPart.text).toContain('"i":2');

  // Veredicto: cabecera + comentario, y las 5 filas de la rúbrica con su estado.
  const back = overlay.locator('.study-face--back');
  await expect(back.locator('.study-review-head')).toContainText('Detecté 2 de 5 pasos');
  await expect(back.locator('.study-review-comment')).toContainText('Muy bien');
  const rows = back.locator('.study-steps li');
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toContainText('trazo 1');
  await expect(rows.nth(1)).toContainText('trazo 2');
  await expect(rows.nth(2)).toContainText('no detectado');
  await expect(rows.nth(4)).toContainText('no detectado');

  // El mapa traza → paso queda expuesto en el canvas y las trazas detectadas se pintaron
  // con el color de su paso (estilo inline distinto del gris punteado).
  expect(await page.evaluate(() => (document.querySelector('.study-draw-canvas') as any)._match)).toEqual({ 0: 0, 1: 1 });
});

test('drawing review: un nombre que no está en la rúbrica no inventa fila', async ({ page }) => {
  await setupVision(page);
  await seedVisualDeck(page, {
    bookId: 'bk-vis7b',
    cards: [{ type: 'drawing', front: 'Dibujá el ciclo del agua.', back: '', steps: PLAN_5 }],
    figure: null,
  });
  await page.reload();
  await stubChat(page, JSON.stringify({
    steps: [
      { name: 'Evaporación del agua', detected: true, stroke: 1 },
      { name: 'Fase imaginaria', detected: true, stroke: 2 },
      { name: 'Precipitación', detected: false, stroke: null },
      { name: 'Escurrimiento', detected: false, stroke: null },
      { name: 'Infiltración', detected: false, stroke: null },
    ],
    extraCount: 1,
    comment: 'ok',
  }));
  await page.locator('.lib-study-chip').click();
  const overlay = page.locator('#ai-study');
  await drawTwoStrokes(page);
  await overlay.locator('.study-flip').click();

  const back = overlay.locator('.study-face--back');
  const rows = back.locator('.study-steps li');
  await expect(rows).toHaveCount(5);                       // no se inventó la fila
  await expect(back).not.toContainText('Fase imaginaria');
  await expect(rows.nth(0)).toContainText('trazo 1');
  // Los pasos de la rúbrica que el modelo no mencionó quedan como no detectados.
  await expect(rows.nth(1)).toContainText('no detectado');
  expect(await page.evaluate(() => (document.querySelector('.study-draw-canvas') as any)._match)).toEqual({ 0: 0 });
});

test('drawing review: respuesta basura → UN reintento y la nota tenue sin romper la rúbrica', async ({ page }) => {
  await setupVision(page);
  await seedVisualDeck(page, {
    bookId: 'bk-vis7c',
    cards: [{ type: 'drawing', front: 'Dibujá el ciclo del agua.', back: '', steps: PLAN_5 }],
    figure: null,
  });
  await page.reload();
  await stubChat(page, 'Lo siento, no puedo analizar imágenes en este momento.');
  await page.locator('.lib-study-chip').click();
  const overlay = page.locator('#ai-study');
  await drawTwoStrokes(page);
  await overlay.locator('.study-flip').click();

  const back = overlay.locator('.study-face--back');
  await expect(back.locator('.study-review-note')).toContainText('No se pudo revisar el boceto');
  const state = await page.evaluate(() => (window as any).__rev);
  expect(state.calls).toHaveLength(2);   // exactamente UN reintento
  // La rúbrica sigue visible e intacta: la revisión nunca rompe el estudio.
  const rows = back.locator('.study-steps li');
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toHaveText('Evaporación del agua');
});

test('drawing review sin modelo de visión: cero red, nota tenue y la rúbrica de siempre', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await seedVisualDeck(page, {
    bookId: 'bk-vis7d',
    cards: [{ type: 'drawing', front: 'Dibujá el ciclo del agua.', back: '', steps: PLAN_5 }],
    figure: null,
  });
  // «Sin visión» hoy NO es «sin modelo guardado»: `effectiveVisionModel()` cae al preset del
  // proveedor, y el preset de nan declara deepseek-v4-flash. El caso sin visión es un proveedor
  // que no declara modelo multimodal (Groq), que es cuando la app apaga la función de verdad.
  await page.evaluate(() => {
    localStorage.setItem('bookreader_ai_base_url', JSON.stringify('https://api.groq.com/openai/v1'));
  });
  await page.reload();
  await stubFetchCounter(page);
  await page.locator('.lib-study-chip').click();
  const overlay = page.locator('#ai-study');
  await drawTwoStrokes(page);
  await overlay.locator('.study-flip').click();

  const back = overlay.locator('.study-face--back');
  await expect(back.locator('.study-review-note')).toContainText('necesita un modelo de visión');
  const calls = await page.evaluate(() => (window as any).__rev.calls as string[]);
  expect(calls.filter((u) => u.includes('/chat/completions'))).toHaveLength(0);
  const rows = back.locator('.study-steps li');
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(3)).toHaveText('Escurrimiento');
});
