import { test, expect, Page, CDPSession } from '@playwright/test';
import path from 'path';

// Modo scroll en tablet (reportado en una Galaxy Tab con «Site Reliability Engineering»):
//  - pulsar para seguir leyendo acababa en el INICIO DEL CAPÍTULO SIGUIENTE;
//  - la selección se perdía o se descolocaba al hacer scroll.
// Cadena reproducida aquí: alternar las barras cambiaba el alto del lector (padding en scroll)
// → epub.js vaciaba y repintaba la sección (la selección quedaba en un documento muerto) → el
// re-anclaje usaba la «corrección» de doble página de displayCfi, que en scroll llama a
// rendition.next() y pasa de SECCIÓN. Además el pin del reflujo congelaba la posición mientras
// se hacía scroll, y re-anclar con display() recortaba el desplazamiento con el contenido sin
// medir. El libro de prueba imita la estructura de O'Reilly (nota en caja, código, xrefs).

const BOOK = path.join(__dirname, 'oreilly-like.epub');
test.use({ viewport: { width: 1340, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
test.describe.configure({ retries: 1 });

async function abrir(page: Page) {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('br-test-init')) {
      sessionStorage.setItem('br-test-init', '1');
      localStorage.setItem('bookreader_settings', JSON.stringify({ columnWidth: 1120, fontSize: 22 }));
    }
  });
  await page.goto('/');
  await page.setInputFiles('#file-input', BOOK);
  await page.waitForSelector('#epub-container iframe', { state: 'attached', timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    R.setReadingMode('scroll');
    await new Promise(r => setTimeout(r, 2000));
  });
}

const estado = (page: Page) => page.evaluate(async () => {
  const R: any = await import('/js/epub-reader.js');
  const sc: any = document.querySelector('#epub-container .epub-container');
  const ifr = document.querySelector('#epub-container iframe') as HTMLIFrameElement;
  // Primer párrafo visible bajo la cabecera: lo que el lector está leyendo.
  const top = sc.getBoundingClientRect().top + 60;
  const ps = [...ifr.contentDocument!.querySelectorAll('p, pre, h1, h6')];
  const fr = ifr.getBoundingClientRect();
  const i = ps.findIndex(p => fr.top + p.getBoundingClientRect().bottom > top);
  return { href: R.getRendition().currentLocation()?.start?.href as string, top: sc.scrollTop as number, parrafo: i, cfi: R.getCurrentCfi() as string };
});

async function deslizar(cdp: CDPSession, page: Page, dist: number) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 670, y: 620 }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 670, y: 620 - i * dist / 10 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(900);
}

async function zonas(page: Page) {
  const ifr = (await page.locator('#epub-container iframe').boundingBox())!;
  return { izq: ifr.x + ifr.width * 0.08, centro: ifr.x + ifr.width * 0.5, der: ifr.x + ifr.width * 0.92 };
}

test('a mitad de capítulo: barras, laterales y cambios de tamaño no cambian de capítulo ni pierden el sitio', async ({ page }) => {
  await abrir(page);
  const cdp = await page.context().newCDPSession(page);
  await deslizar(cdp, page, 400); await deslizar(cdp, page, 400); await deslizar(cdp, page, 300);
  const a = await estado(page);
  expect(a.top).toBeGreaterThan(600);
  const z = await zonas(page);
  // Alternar las barras (toque central) ya no redimensiona: ni un píxel de salto.
  for (let k = 0; k < 4; k++) {
    await page.touchscreen.tap(z.centro, 400);
    await page.waitForTimeout(900);
    const s = await estado(page);
    expect(s.href).toBe(a.href);
    expect(Math.abs(s.top - a.top), `toque central ${k}`).toBeLessThan(2);
  }
  // Lateral derecho: desplaza, nunca cambia de capítulo.
  await page.touchscreen.tap(z.der, 400); await page.waitForTimeout(1000);
  const b = await estado(page);
  expect(b.href).toBe(a.href);
  expect(b.top).toBeGreaterThan(a.top + 200);
  // Cambios de tamaño reales (barras del sistema, giro): mismo capítulo y mismo párrafo.
  for (const [w, h] of [[1340, 870], [1340, 800], [800, 1340], [1340, 800]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(2200);
    const s = await estado(page);
    expect(s.href, `${w}x${h}`).toBe(a.href);
    expect(Math.abs(s.parrafo - b.parrafo), `${w}x${h}: párrafo ${s.parrafo} vs ${b.parrafo}`).toBeLessThanOrEqual(1);
  }
});

test('al final del capítulo: un cambio de tamaño no salta al siguiente', async ({ page }) => {
  await abrir(page);
  await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    const c = R.getRendition().getContents()[0];
    const ps = c.document.querySelectorAll('p');
    await R.goTo(c.cfiFromNode(ps[ps.length - 3]));
    await new Promise(r => setTimeout(r, 2000));
  });
  const a = await estado(page);
  for (const [w, h] of [[1340, 870], [1340, 800], [1340, 860], [800, 1340], [1340, 800]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(2200);
    const s = await estado(page);
    expect(s.href, `${w}x${h}`).toBe(a.href);
    expect(Math.abs(s.parrafo - a.parrafo), `${w}x${h}`).toBeLessThanOrEqual(1);
  }
});

test('saltar a un pasaje de un capítulo intermedio se queda en ese capítulo', async ({ page }) => {
  await abrir(page);
  await page.evaluate(async () => { const R: any = await import('/js/epub-reader.js'); R.next(); await new Promise(r => setTimeout(r, 1500)); });
  const ch2 = (await estado(page)).href;
  expect(ch2).toContain('ch02');
  await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    const c = R.getRendition().getContents()[0];
    const ps = c.document.querySelectorAll('p');
    await R.goTo(c.cfiFromNode(ps[1]));
    await new Promise(r => setTimeout(r, 2000));
  });
  expect((await estado(page)).href).toBe(ch2);
});

test('la selección sobrevive al scroll, a los laterales y a las barras, y sigue pegada al texto', async ({ page }) => {
  await abrir(page);
  const cdp = await page.context().newCDPSession(page);
  // La nota en caja, a la vista.
  await page.evaluate(() => {
    const ifr = document.querySelector('#epub-container iframe') as HTMLIFrameElement;
    const n = ifr.contentDocument!.querySelector('div[data-type=note]')!;
    const sc: any = document.querySelector('#epub-container .epub-container');
    sc.scrollTop += n.getBoundingClientRect().top + ifr.getBoundingClientRect().top - 250;
  });
  await page.waitForTimeout(1200);
  const w = await page.evaluate(() => {
    const ifr = document.querySelector('#epub-container iframe') as HTMLIFrameElement;
    const doc = ifr.contentDocument!; const fr = ifr.getBoundingClientRect();
    const tn = doc.querySelector('div[data-type=note] p')!.firstChild as Text;
    const m = /reliability/.exec(tn.data)!;
    const r = doc.createRange(); r.setStart(tn, m.index); r.setEnd(tn, m.index + m[0].length);
    const b = r.getBoundingClientRect();
    return { x: fr.left + b.left + b.width / 2, y: fr.top + b.top + b.height / 2 };
  });
  // Mantener pulsado y arrastrar: selección de varias líneas.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: w.x, y: w.y }] });
  await page.waitForTimeout(700);
  for (let i = 1; i <= 8; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: w.x + i * 20, y: w.y + i * 15 }] }); await page.waitForTimeout(30); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(600);

  const desfase = () => page.evaluate(async () => {
    const S: any = await import('/js/touch-select.js');
    const r = S.selectedRange();
    if (!r) return null;
    const fr = (document.querySelector('#epub-container iframe') as HTMLIFrameElement).getBoundingClientRect();
    const real = [...r.getClientRects()].filter((x: any) => x.width >= 0.5 && x.height >= 0.5);
    const dib = [...document.querySelectorAll('#ts-overlay .ts-hi')].map(d => d.getBoundingClientRect());
    if (!real.length || real.length !== dib.length) return { n: real.length, d: dib.length, max: 999 };
    let max = 0;
    real.forEach((x: any, i) => { max = Math.max(max, Math.abs(fr.top + x.top - dib[i].top), Math.abs(fr.left + x.left - dib[i].left)); });
    return { n: real.length, d: dib.length, max: Math.round(max) };
  });
  const comprobar = async (cuando: string) => {
    const d = await desfase();
    expect(d, `${cuando}: la selección se perdió`).not.toBeNull();
    expect(d!.n, `${cuando}: varias líneas`).toBeGreaterThan(1);
    expect(d!.max, `${cuando}: resaltado descolocado`).toBeLessThanOrEqual(1);
    await expect(page.locator('#highlight-tooltip')).toBeVisible();
  };
  await comprobar('al seleccionar');
  await deslizar(cdp, page, 250);
  await comprobar('tras deslizar');
  const z = await zonas(page);
  await page.touchscreen.tap(z.der, 450); await page.waitForTimeout(1000);
  await comprobar('tras el lateral derecho');
  await page.touchscreen.tap(z.izq, 450); await page.waitForTimeout(1000);
  await comprobar('tras el lateral izquierdo');
  // Las barras aparecen/desaparecen (p. ej. otro gesto): ya no redimensiona ni repinta.
  await page.evaluate(() => document.body.classList.toggle('immersive')); await page.waitForTimeout(700);
  await comprobar('tras alternar las barras');
  await page.evaluate(() => document.body.classList.toggle('immersive')); await page.waitForTimeout(700);
  await comprobar('tras alternarlas otra vez');
  // Cambio de alto REAL de la ventana (en la tablet: la barra de tareas del sistema aparece o
  // se esconde). epub.js repinta la sección; la selección tiene que seguir ahí y en su sitio.
  const texto0 = await page.evaluate(async () => (await import('/js/touch-select.js') as any).selectedRange()?.toString());
  await page.setViewportSize({ width: 1340, height: 740 }); await page.waitForTimeout(2200);
  await comprobar('tras encoger la ventana');
  await page.setViewportSize({ width: 1340, height: 800 }); await page.waitForTimeout(2200);
  await comprobar('tras volver al alto original');
  const texto1 = await page.evaluate(async () => (await import('/js/touch-select.js') as any).selectedRange()?.toString());
  expect(texto1, 'la selección es la misma').toBe(texto0);
  // Y se puede seguir extendiendo: el tirador final sigue agarrable donde se dibuja.
  const fin = await page.locator('#ts-overlay .ts-end').boundingBox();
  expect(fin).not.toBeNull();
});

test('con una selección abierta, pasar de capítulo la cierra limpia (sin resaltado fantasma)', async ({ page }) => {
  const errores: string[] = [];
  page.on('pageerror', e => errores.push(e.message));
  await abrir(page);
  const cdp = await page.context().newCDPSession(page);
  const w = await page.evaluate(() => {
    const ifr = document.querySelector('#epub-container iframe') as HTMLIFrameElement;
    const doc = ifr.contentDocument!; const fr = ifr.getBoundingClientRect();
    for (const p of Array.from(doc.querySelectorAll('p'))) {
      const b = p.getBoundingClientRect();
      if (fr.top + b.top > 150 && fr.top + b.top < 500) return { x: fr.left + b.left + 60, y: fr.top + b.top + 12 };
    }
    return null;
  });
  expect(w).not.toBeNull();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: w!.x, y: w!.y }] });
  await page.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('#highlight-tooltip')).toBeVisible();
  await page.evaluate(async () => { (await import('/js/epub-reader.js') as any).next(); });
  await page.waitForTimeout(1500);
  expect((await estado(page)).href).toContain('ch02');
  expect(await page.evaluate(async () => (await import('/js/touch-select.js') as any).selectedRange())).toBeNull();
  await expect(page.locator('#highlight-tooltip')).toBeHidden();
  expect(errores).toEqual([]);
});
