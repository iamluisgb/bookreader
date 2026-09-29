import { test, expect, type Page, type Locator } from '@playwright/test';
import { seedProLicense } from './pro-license';

// Interacción de la tarjeta en la sesión de estudio:
//  - el toque es un TOGGLE (frente ↔ dorso), sin re-render (el lienzo conserva trazas)
//  - el swipe con mouse también funciona sobre figuras (sin drag nativo de imagen)
//  - en táctil el gesto horizontal es del swipe (touch-action: pan-y)
//  - el canvas de dibujo nunca voltea ni califica
// El avance sigue siendo SOLO por nota (botones, teclas 1..4 o swipe con la tarjeta girada).

const BOOK_ID = 'bk-inter';

// Siembra: libro + mazo con `cards` y, si viene, la figura referida por figureKey en el
// store de artefactos (mismo camino que producción: db.js + library/store.js).
async function seed(page: Page, cards: any[], figure?: { dataUrl: string; width: number; height: number } | null) {
  await page.evaluate(async ({ BOOK_ID, cards, figure }) => {
    const DB: any = await import('/js/ai/db.js');
    const Lib: any = await import('/js/library/store.js');
    await Lib.putBook({
      id: BOOK_ID, title: 'Libro de interacción', format: 'epub', fileName: 't.epub',
      addedAt: Date.now(), lastOpenedAt: Date.now(), progress: 0, status: 'reading', shelfIds: [],
    });
    let figureKey = '';
    if (figure) {
      figureKey = await DB.putArtifact({
        bookId: BOOK_ID, kind: 'figures', id: 'fig1',
        result: {
          page: 1, rect: { x: 0, y: 0, w: figure.width, h: figure.height },
          dataUrl: figure.dataUrl, labels: [], caption: '', source: '',
          width: figure.width, height: figure.height,
        },
      });
    }
    await DB.addDeck({
      bookId: BOOK_ID, name: 'Mazo de interacción', cardType: 'mixed', scope: '',
      cards: cards.map((c: any) => ({ chapter: '', src: '', ...c, figureKey: c.figureKey ?? figureKey })),
    });
  }, { BOOK_ID, cards, figure: figure ?? null });
}

// dataUrl PNG real de canvas (figura decodificable, no un string inventado).
async function makeFigureDataUrl(page: Page, width: number, height: number): Promise<string> {
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

async function openSession(page: Page, cards: any[], figure?: { dataUrl: string; width: number; height: number } | null) {
  await page.goto('/index.html');
  await seedProLicense(page);
  await seed(page, cards, figure);
  await page.reload();
  await page.locator('.lib-study-chip').click();
  const overlay = page.locator('#ai-study');
  await expect(overlay.locator('.study-card3d')).toBeVisible();
  return overlay;
}

// Frente de la tarjeta actual (visible también con la tarjeta girada: .study-q vive en la
// cara frontal, pero el texto sigue en el DOM).
async function currentFront(page: Page): Promise<string> {
  return (await page.locator('#ai-study .study-q').textContent())!.trim();
}

// Drag con MOUSE de izquierda a derecha sobre el centro de `target` (el swipe califica
// «bien» con |dx| > 90; usamos ~140 px en pasos, como un gesto real).
async function dragMouse(page: Page, target: Locator, dx = 140) {
  const box = await target.boundingBox();
  if (!box) throw new Error('no bounding box for drag target');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 10 });
  await page.mouse.up();
}

test('tap en la tarjeta alterna: frente → dorso → frente', async ({ page }) => {
  const overlay = await openSession(page, [
    { type: 'basic', front: '¿Capital de Australia?', back: 'Canberra.' },
  ]);
  const card3d = overlay.locator('.study-card3d');
  await expect(overlay.locator('.study-q')).toContainText('¿Capital de Australia?');

  // Tap 1: voltea, aparecen los botones de nota.
  await card3d.click();
  await expect(card3d).toHaveClass(/is-flipped/);
  await expect(overlay.locator('.study-a')).toBeVisible();
  await expect(overlay.locator('.study-a')).toContainText('Canberra.');
  await expect(overlay.locator('.study-grade')).toHaveCount(2);

  // Tap 2: vuelve al frente — la respuesta sale del DOM y el pie vuelve a «Mostrar respuesta».
  await card3d.click();
  await expect(card3d).not.toHaveClass(/is-flipped/);
  await expect(overlay).not.toContainText('Canberra');
  await expect(overlay.locator('.study-flip')).toBeVisible();

  // Tap 3: vuelve a voltear (toggle, no un avance).
  await card3d.click();
  await expect(card3d).toHaveClass(/is-flipped/);
  await expect(overlay.locator('.study-a')).toContainText('Canberra.');
});

test('tocar «Mostrar respuesta» y el textarea de recuerdo no alterna de más', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  // Con api key hay bloque de recuerdo (textarea) antes de girar.
  await page.evaluate(() => localStorage.setItem('bookreader_ai_key', JSON.stringify('test-key')));
  await seed(page, [{ type: 'basic', front: '¿Quién escribió El Quijote?', back: 'Cervantes.' }]);
  await page.reload();
  await page.locator('.lib-study-chip').click();
  const overlay = page.locator('#ai-study');
  const card3d = overlay.locator('.study-card3d');
  const input = overlay.locator('.study-recall-input');
  await expect(input).toBeVisible();

  // Tocar el textarea es escribir, no girar.
  await input.click();
  await expect(card3d).not.toHaveClass(/is-flipped/);
  await expect(overlay.locator('.study-q')).toContainText('¿Quién escribió El Quijote?');

  // Tocar el botón gira UNA vez: dorso visible, misma tarjeta, sin oscilación.
  await overlay.locator('.study-flip').click();
  await expect(card3d).toHaveClass(/is-flipped/);
  await expect(overlay.locator('.study-a')).toContainText('Cervantes.');
  await expect(overlay.locator('.study-grade')).toHaveCount(2);
});

// El mazo se BARAJa (Fisher-Yates): un mazo con dos tipos distintos no garantiza cuál sale
// primero, y una regresión que solo corre «si la oclusión salió primera» pasa sin que nadie
// la mire (pasó: el chequeo del mecanismo no se ejecutaba). Por eso cada caso usa un mazo de
// UNA sola tarjeta y el camino queda determinista.
test('swipe con mouse sobre la figura de una oclusión: el drag nativo no se come el gesto', async ({ page }) => {
  const dataUrl = await makeFigureDataUrl(page, 200, 100);
  const overlay = await openSession(page, [
    {
      type: 'occlusion',
      front: '¿Qué etiqueta está tapada en la figura?',
      back: 'La cola equilibra al animal.',
      bbox: { x: 50, y: 25, w: 50, h: 25 },
      occludedLabel: 'Cola',
    },
  ], { dataUrl, width: 200, height: 100 });

  await overlay.locator('.study-flip').click();
  const img = overlay.locator('.study-face--back .study-fig-img').first();
  await expect(img).toBeVisible();

  // El bug reportado: el <img> arrancaba el arrastre NATIVO del navegador y la secuencia de
  // punteros moría, así que el swipe no funcionaba SOLO sobre la figura. El arrastre
  // sintético de Playwright no dispara el drag nativo de forma fiable, así que la regresión
  // se afirma sobre el mecanismo: la imagen no es arrastrable y un `dragstart` cancelable
  // llega ya prevenido.
  expect(await img.evaluate((el) => (el as HTMLImageElement).draggable)).toBe(false);
  const prevented = await img.evaluate((el) => {
    const ev = new Event('dragstart', { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(prevented).toBe(true);

  await dragMouse(page, img);
  await expect(overlay.locator('.study-end')).toBeVisible();
});

test('swipe con mouse sobre una tarjeta de texto califica y avanza', async ({ page }) => {
  const overlay = await openSession(page, [
    { type: 'basic', front: '¿Cuál es la unidad de la herencia?', back: 'El gen.' },
  ]);
  await overlay.locator('.study-flip').click();
  await dragMouse(page, overlay.locator('.study-face--back'));
  await expect(overlay.locator('.study-end')).toBeVisible();
});

test.describe('touch', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test('swipe táctil sobre el dorso califica y touch-action es pan-y', async ({ page }) => {
    const overlay = await openSession(page, [
      { type: 'basic', front: '¿Qué mide el pH?', back: 'La acidez.' },
    ]);
    // El gesto horizontal es del swipe; el vertical queda para el scroll del overlay.
    await expect(overlay.locator('.study-card3d')).toHaveCSS('touch-action', 'pan-y');

    await overlay.locator('.study-flip').click();
    const box = await overlay.locator('.study-face--back').boundingBox();
    if (!box) throw new Error('no bounding box for card back');
    const y = box.y + box.height / 2;
    const x0 = box.x + box.width / 2 - 20;

    // Drag táctil REAL vía CDP: touchStart → touchMove ×N → touchEnd.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
    for (let k = 1; k <= 6; k++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + k * 25, y }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    // Avanzó: única tarjeta de la cola → fin de sesión.
    await expect(overlay.locator('.study-end')).toBeVisible();
  });
});

test('arrastrar sobre el lienzo de dibujo no voltea ni califica', async ({ page }) => {
  const overlay = await openSession(page, [
    { type: 'drawing', front: 'Dibujá el ciclo del agua.', back: '', steps: ['Evaporación', 'Condensación', 'Precipitación'] },
  ]);
  const card3d = overlay.locator('.study-card3d');
  const canvas = overlay.locator('.study-draw-canvas');
  await expect(canvas).toBeVisible();

  // Un trazo (drag sobre el canvas) NO es un swipe ni un toque de volteo: sigue la misma
  // tarjeta, sin girar.
  await dragMouse(page, canvas, 160);
  await expect(card3d).not.toHaveClass(/is-flipped/);
  await expect(overlay.locator('.study-q')).toContainText('Dibujá el ciclo del agua');
  await expect(overlay.locator('.study-flip')).toBeVisible();
});
