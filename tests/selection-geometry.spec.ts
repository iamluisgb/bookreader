// selection-geometry.spec.ts — La selección táctil se dibuja DONDE ESTÁ EL TEXTO.
//
// El contenido del EPUB va en un iframe dentro de `#reader-viewport`, y ese viewport lleva
// una ESCALA en táctil con las barras a la vista (updateReaderScale encoge el texto para
// que quepa entre cabecera y pie). Medido en un móvil de 390 px: el iframe mide 390×780 px
// CSS por dentro y ocupa 338×676 en pantalla — factor 0,867.
//
// La capa de selección y la barra de acciones se dibujan FUERA del viewport, en pantalla.
// Sumar solo el offset del iframe a un rect medido dentro mezclaba los dos espacios y el
// error crecía con la distancia al origen: ~65 px de desvío vertical a media página. De ahí
// los tres síntomas: el resaltado no cubría lo marcado, la barra salía descolocada y los
// tiradores no se dejaban agarrar (se tocaba el círculo que se ve y el punto de agarre
// estaba en otro sitio).
//
// El test del tirador falla sin el arreglo: reproduce el gesto tal como llega del navegador
// (un toque en pantalla se entrega al iframe convertido por la escala) y sin corregir la
// geometría el punto de agarre queda a ~65 px del círculo que se ve, muy por encima del
// radio de 26. Los dos primeros fijan el contrato de ui/frame-rect.js.
import { test, expect, type Page } from '@playwright/test';
import path from 'path';

const EPUB_PATH = path.join(__dirname, 'test.epub');

test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });

// Abre el libro, avanza a páginas con texto de verdad (la primera sección es la portada) y
// deja las barras A LA VISTA, que es el estado en el que el viewport se escala.
async function abrirConBarras(page: Page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', EPUB_PATH);
  await expect(page.locator('#epub-container iframe')).toBeAttached({ timeout: 20000 });
  await page.waitForTimeout(2500);
  await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    for (let i = 0; i < 8; i++) { R.next(); await new Promise((r) => setTimeout(r, 300)); }
    document.body.classList.remove('immersive');
    R.updateReaderScale();
  });
  await page.waitForTimeout(800);
}

// El factor de escala real del iframe: caja en pantalla ÷ caja CSS.
async function escala(page: Page) {
  return page.evaluate(() => {
    const f = document.querySelector('#epub-container iframe') as HTMLIFrameElement;
    const r = f.getBoundingClientRect();
    return { x: r.left, y: r.top, sx: r.width / f.clientWidth, sy: r.height / f.clientHeight };
  });
}

// Selecciona por gestos táctiles reales (pulsación larga + arrastre) sobre el primer
// párrafo con texto de la página visible. Devuelve el rango elegido en coords del iframe.
// Los gestos se dispatchan DENTRO del iframe pero desde el contexto de la página padre:
// el iframe es same-origin, así que se llega por `contentDocument`, y así no dependemos de
// un contexto de ejecución de frame que epub.js destruye al reciclar la vista.
async function seleccionarConGesto(page: Page) {
  return page.evaluate(async () => {
    const f = document.querySelector('#epub-container iframe') as HTMLIFrameElement;
    const doc = f.contentDocument!;
    // Primera línea de texto visible dentro del viewport del iframe.
    const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let n: any, punto: any = null;
    while ((n = w.nextNode())) {
      if (n.textContent.trim().length < 40) continue;
      const r = doc.createRange();
      r.selectNodeContents(n);
      const b = r.getBoundingClientRect();
      if (b.top > 40 && b.bottom < doc.documentElement.clientHeight - 40 &&
          b.left >= 0 && b.right < doc.documentElement.clientWidth) {
        punto = { x: b.left + 20, y: b.top + b.height / 2, ancho: b.width };
        break;
      }
    }
    if (!punto) throw new Error('no se encontró texto visible donde seleccionar');

    (window as any).__toque = (x: number, y: number, tipo: string) => {
      const fr = document.querySelector('#epub-container iframe') as HTMLIFrameElement;
      const d = fr.contentDocument!;
      const t = new Touch({ identifier: 1, target: d.body, clientX: x, clientY: y });
      d.body.dispatchEvent(new TouchEvent(tipo, {
        bubbles: true, cancelable: true,
        touches: tipo === 'touchend' ? [] : [t],
        changedTouches: [t], targetTouches: tipo === 'touchend' ? [] : [t],
      }));
    };
    const toque = (window as any).__toque;

    toque(punto.x, punto.y, 'touchstart');
    await new Promise((r) => setTimeout(r, 500));   // > LONGPRESS_MS
    toque(punto.x + punto.ancho * 0.97, punto.y, 'touchmove');
    await new Promise((r) => setTimeout(r, 60));
    toque(punto.x + punto.ancho * 0.97, punto.y, 'touchend');
    return punto;
  });
}

// --- El contrato de ui/frame-rect.js ----------------------------------------
// Se prueba sobre un layout sintético de columnas —lo mismo que hace epub.js— en vez de
// sobre el libro: es determinista y rápido. Sobre el libro real no se puede aserta el sitio
// final de la barra, porque `positionTooltip` la ACOTA al viewport y ese recorte iguala los
// dos anclajes en cuanto la selección está cerca de un borde.
test.describe('anclaje de la barra', () => {
  test.use({ viewport: { width: 1400, height: 900 }, hasTouch: false, isMobile: false });

  test('el ancla es la primera línea, no el bounding box, y se ignoran los rects degenerados', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(async () => {
      const FR: any = await import('/js/ui/frame-rect.js');
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:200px;' +
        'column-count:2;column-gap:40px;font:16px/24px serif;';
      host.textContent = 'palabra '.repeat(120);
      document.body.appendChild(host);

      const nodo = host.firstChild as Text;
      const rango = document.createRange();
      rango.setStart(nodo, 0);
      rango.setEnd(nodo, nodo.length);

      const todos = Array.from(rango.getClientRects());
      const usables = FR.usableRects(rango);
      const ancla = FR.anchorRect(rango);
      const b = rango.getBoundingClientRect();
      host.remove();
      return {
        total: todos.length,
        usables: usables.length,
        degenerados: todos.filter((x: any) => x.width < 0.5 || x.height < 0.5).length,
        anclaCentro: ancla.left + ancla.width / 2,
        anclaTop: ancla.top,
        boundingCentro: b.left + b.width / 2,
        boundingTop: b.top,
        boundingAlto: b.height,
        anclaAlto: ancla.height,
      };
    });

    // El texto ocupa las dos columnas: el bounding box abarca ambas y su centro cae en el
    // canalón, donde no hay nada seleccionado. Medido en el libro real, una selección que
    // cruzaba el salto de columna daba un centro de bounding en x = −20: FUERA de pantalla.
    expect(r.usables).toBeGreaterThan(1);
    expect(Math.abs(r.anclaCentro - r.boundingCentro)).toBeGreaterThan(50);
    // Y el ancla es UNA línea, no el bloque entero.
    expect(r.anclaAlto).toBeLessThan(r.boundingAlto / 2);
    // Los rects de ancho o alto cero de los saltos de línea/columna no cuentan: tomarlos
    // como extremo pone el tirador (o la barra) donde no hay texto.
    expect(r.usables).toBe(r.total - r.degenerados);
  });

  test('toScreen aplica la escala del viewport, no solo el desplazamiento', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(async () => {
      const FR: any = await import('/js/ui/frame-rect.js');
      // Un iframe de 400×300 px CSS encogido al 50 %: ocupa 200×150 en pantalla.
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;left:100px;top:50px;width:400px;height:300px;border:0;transform:scale(0.5);transform-origin:0 0;';
      document.body.appendChild(f);
      const tr = FR.frameTransform(f);
      const s = FR.toScreen({ left: 200, top: 100, width: 80, height: 24 }, tr);
      f.remove();
      return { tr, s };
    });
    expect(r.tr.sx).toBeCloseTo(0.5, 2);
    expect(r.tr.sy).toBeCloseTo(0.5, 2);
    // Sin escalar saldría left = 100 + 200 = 300 y width = 80.
    expect(r.s.left).toBeCloseTo(200, 0);
    expect(r.s.top).toBeCloseTo(100, 0);
    expect(r.s.width).toBeCloseTo(40, 0);
    expect(r.s.height).toBeCloseTo(12, 0);
  });
});

test('se puede agarrar el tirador tocando donde se ve el círculo', async ({ page }) => {
  await abrirConBarras(page);
  const t = await escala(page);
  expect(t.sy).toBeLessThan(0.95);

  // Registrar nuestro propio onSelect (sustituye al de highlights-ui) para leer el texto
  // que la selección entrega en cada finalize().
  await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    (window as any).__sel = [];
    R.onSelect((s: any) => (window as any).__sel.push(s.text));
  });

  await seleccionarConGesto(page);
  await page.waitForTimeout(300);
  const antes = await page.evaluate(() => (window as any).__sel.slice(-1)[0] || '');
  expect(antes.length, 'el gesto no produjo selección').toBeGreaterThan(0);

  // Dónde SE VE el círculo del tirador final, en coordenadas de pantalla.
  const circulo = await page.evaluate(() => {
    const he = document.querySelector('#ts-overlay .ts-end') as HTMLElement;
    const cs = getComputedStyle(he, '::after');
    const r = he.getBoundingClientRect();
    // ::after está a left:-8 / top:+16 con 16 px de diámetro → centro en (left, top+24).
    void cs;
    return { x: r.left, y: r.top + 24 };
  });

  // El usuario toca AHÍ. El navegador entrega ese toque al iframe convirtiendo por la
  // escala; se reproduce esa conversión para dispatchar en el mismo sitio que lo haría él.
  await page.evaluate(async ({ c, tr }) => {
    const ix = (c.x - tr.x) / tr.sx, iy = (c.y - tr.y) / tr.sy;
    const toque = (window as any).__toque;
    toque(ix, iy, 'touchstart');
    await new Promise((r) => setTimeout(r, 40));
    toque(ix + 80, iy, 'touchmove');
    await new Promise((r) => setTimeout(r, 40));
    toque(ix + 80, iy, 'touchend');
  }, { c: circulo, tr: t });
  await page.waitForTimeout(300);

  // Si el tirador se agarró, la selección se extendió. Sin el arreglo el punto de agarre
  // quedaba a ~65 px del círculo —muy por encima del radio de 26— y el toque se
  // interpretaba como "tocar fuera": la selección se descartaba en vez de crecer.
  const despues = await page.evaluate(() => (window as any).__sel.slice(-1)[0] || '');
  expect(despues.length, 'el tirador no se agarró: la selección no creció').toBeGreaterThan(antes.length);
});
