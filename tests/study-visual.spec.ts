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
