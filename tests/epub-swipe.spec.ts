// Pase de página del EPUB con el dedo. Cubre los tres defectos que motivaron el trabajo,
// todos MEDIDOS antes de tocar nada (ver CHANGELOG):
//
//   · la animación se cortaba a medias y eso era el parpadeo — el margen entre el final real
//     de la transición y la limpieza era de 4 ms, y con la CPU frenada 6× se cortaban 3 de
//     cada 10 transiciones;
//   · encadenar gestos perdía la mitad (5 deslizamientos seguidos daban 2 pases);
//   · en el borde del libro se ejecutaba la coreografía COMPLETA de pase sin pasar página.
//
// El gesto se simula con eventos táctiles reales sobre el documento del iframe, que es donde
// escucha touch-select.js.
import { test, expect, type Page } from '@playwright/test';
import path from 'path';

const EPUB = path.join(__dirname, 'test.epub');

test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
// El EPUB se monta entero y la máquina puede ir cargada: mismo motivo que library-organize.
test.describe.configure({ retries: 2 });

async function abrir(page: Page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', EPUB);
  await page.waitForFunction(() => !!document.querySelector('#epub-container iframe'), null, { timeout: 20000 });
  await page.waitForTimeout(2500);
}

// Espera a que el contenedor quede en reposo (sin transform). Se usa entre gestos que NO
// quieren encadenarse: con un `waitForTimeout` fijo, una máquina cargada hace que el pase dure
// más que la espera y el gesto siguiente interrumpe la animación — que es justo lo que el
// primer test mide, así que la medición se contaminaría a sí misma.
async function enReposo(page: Page) {
  await page.waitForFunction(() => {
    const c = document.getElementById('epub-container');
    return !!c && (c.style.transform || '') === '';
  }, null, { timeout: 15000 });
}

// Un deslizamiento horizontal. `dx` negativo = hacia la página siguiente.
async function deslizar(page: Page, dx: number, x0 = 300) {
  await page.evaluate(async ([dx, x0]) => {
    // El iframe se REEMPLAZA al entrar en una sección nueva: hay que esperarlo.
    let ifr = document.querySelector('#epub-container iframe') as HTMLIFrameElement;
    for (let i = 0; i < 40 && (!ifr?.contentWindow || !ifr.contentDocument?.body); i++) {
      await new Promise((r) => setTimeout(r, 50));
      ifr = document.querySelector('#epub-container iframe') as HTMLIFrameElement;
    }
    if (!ifr?.contentWindow) return;
    const doc = ifr.contentDocument!;
    const toque = (tipo: string, x: number) => {
      const t = new Touch({ identifier: 1, target: doc.body, clientX: x, clientY: 400 });
      doc.dispatchEvent(new TouchEvent(tipo, {
        bubbles: true, cancelable: true,
        touches: tipo === 'touchend' ? [] : [t], changedTouches: [t],
        targetTouches: tipo === 'touchend' ? [] : [t],
      }));
    };
    toque('touchstart', x0);
    for (let k = 1; k <= 8; k++) { toque('touchmove', x0 + (dx * k) / 8); await new Promise((r) => setTimeout(r, 16)); }
    toque('touchend', x0 + dx);
  }, [dx, x0] as any);
}

test('la animación del pase no se corta a medias, ni con la CPU de un móvil', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await abrir(page);
  await page.evaluate(() => {
    const w = window as any;
    const c = document.getElementById('epub-container')!;
    w.__cortadas = 0;
    // transitioncancel = la transición se interrumpió a media animación: el contenedor salta
    // desde donde estuviera y el iframe repinta. Es EXACTAMENTE el parpadeo.
    c.addEventListener('transitioncancel', (e: any) => {
      if (e.target === c && e.propertyName === 'transform') w.__cortadas++;
    });
  });

  // 6× es un móvil de gama media; a 1× el defecto casi no se reproducía.
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  for (let k = 0; k < 6; k++) { await deslizar(page, -150); await enReposo(page); await page.waitForTimeout(150); }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  expect(await page.evaluate(() => (window as any).__cortadas)).toBe(0);
});

test('la cola de gestos no se queda con pases pendientes que salten después', async ({ page }) => {
  // Encadenar gestos ya no los descarta: el que llega con un pase en curso se ENCOLA y se
  // aplica con la hoja fuera de pantalla. Lo que este test fija es la corrección de esa cola,
  // no su rendimiento: cuántos de N gestos acaban en pase lo decide algo que está por debajo
  // —epub.js REEMPLAZA el iframe en cada pase y los eventos táctiles quedan atados al
  // documento del touchstart, así que un gesto a caballo del reemplazo se pierde entero, le
  // pase a esta sonda o a un dedo real—, y medirlo aquí solo mediría esa lotería.
  //
  // Lo que sí es nuestro y sí se puede fijar: que la cola quede VACÍA al terminar. La primera
  // versión de la cola solo la vaciaba entre el cambio de página y la animación de entrada;
  // un gesto llegado durante la entrada se quedaba dentro y saltaba de más en el pase
  // siguiente, que es peor que haberlo perdido.
  await abrir(page);
  await page.evaluate(async () => {
    const w = window as any;
    const r = ((await import('/js/epub-reader.js')) as any).getRendition();
    w.__pases = 0;
    const orig = r.next.bind(r);
    r.next = (...a: any[]) => { w.__pases++; return orig(...a); };
  });

  for (let k = 0; k < 5; k++) await deslizar(page, -150);   // ráfaga
  await enReposo(page);
  await page.waitForTimeout(1500);                          // que se drene todo lo pendiente

  const antes = await page.evaluate(() => (window as any).__pases);
  expect(antes).toBeGreaterThan(1);                         // la ráfaga hizo algo

  // Y ahora UN gesto suelto: tiene que producir exactamente UN pase. Si hubiera quedado algo
  // en la cola, aquí se colaría de más.
  await deslizar(page, -150);
  await enReposo(page);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as any).__pases)).toBe(antes + 1);
});

test('en el borde del libro el arrastre resiste y vuelve, sin fingir un pase', async ({ page }) => {
  await abrir(page);
  const traza = async () => page.evaluate(() => {
    const w = window as any;
    const nums = (w.__tr || []).map((t: string) => {
      const m = /translate3d\((-?[\d.]+)px/.exec(t);
      return m ? Math.abs(+m[1]) : 0;
    });
    return { max: nums.length ? Math.max(...nums) : 0, pasoCompleto: nums.some((n: number) => n > 300) };
  });
  const observar = () => page.evaluate(() => {
    const w = window as any;
    w.__tr = [];
    const c = document.getElementById('epub-container')!;
    new MutationObserver(() => w.__tr.push(c.style.transform || '')).observe(
      c, { attributes: true, attributeFilter: ['style'] });
  });
  const posicion = () => page.evaluate(async () => ((await import('/js/epub-reader.js')) as any).getCurrentCfi());

  // PRINCIPIO: hacia atrás en la primera página.
  await observar();
  const iniAntes = await posicion();
  await deslizar(page, 150, 100);
  await page.waitForTimeout(1200);
  const ini = await traza();
  expect(await posicion()).toBe(iniAntes);
  expect(ini.pasoCompleto).toBe(false);        // no se anima un pase que no ocurre
  expect(ini.max).toBeLessThan(80);            // el arrastre de 150px resiste a ~1/3

  // FINAL: hasta la última página de la última sección, y un deslizamiento más.
  await page.evaluate(async () => {
    const E: any = await import('/js/epub-reader.js');
    const r = E.getRendition();
    const b = E.getBook();
    const ultimo = b.spine.spineItems.length - 1;
    await r.display(b.spine.spineItems[ultimo].href);
    await new Promise((res) => setTimeout(res, 600));
    for (let k = 0; k < 400; k++) {
      const f: any = (r.currentLocation() || {}).end || {};
      if (f.index === ultimo && f.displayed && f.displayed.page >= f.displayed.total) break;
      await r.next();
    }
    await new Promise((res) => setTimeout(res, 400));
  });
  await observar();
  const finAntes = await posicion();
  await deslizar(page, -150);
  await page.waitForTimeout(1200);
  const fin = await traza();
  expect(await posicion()).toBe(finAntes);
  expect(fin.pasoCompleto).toBe(false);
  expect(fin.max).toBeLessThan(80);
});

test('el hueco en blanco entre páginas se mantiene corto', async ({ page }) => {
  // El parpadeo que se veía pasando páginas a ritmo normal: entre la hoja que sale y la que
  // entra la pantalla se quedaba en BLANCO. Medido con screencast, 99-172 ms por pase sobre
  // un libro real. Dos causas, ninguna evidente leyendo el código:
  //
  //   · la hoja SALÍA con ease-out, así que recorría casi todo el camino en la primera mitad
  //     de la animación y se quedaba flotando fuera de cuadro el resto, con la pantalla ya
  //     vacía. Ahora sale con ease-in.
  //   · la hoja que ENTRA arrancaba desde el ancho completo, dejando otro tramo vacío.
  //     Ahora entra desde el 55 %.
  //
  // Lo que queda (~66 ms) es el tiempo que epub.js tarda en cambiar de página, con la hoja
  // necesariamente fuera de cuadro: el suelo de esta arquitectura, no un defecto.
  //
  // Un frame del screencast tan pequeño solo puede ser una pantalla de color uniforme: una
  // página con texto no baja de ~15 KB a esta calidad.
  const UMBRAL_BYTES = 8000;
  await abrir(page);
  await page.evaluate(async () => {
    const r = ((await import('/js/epub-reader.js')) as any).getRendition();
    for (let k = 0; k < 6; k++) await r.next();   // salir de la portada, que es una imagen
  });
  await page.waitForTimeout(1200);

  const seccion = () => page.evaluate(async () => {
    const r = ((await import('/js/epub-reader.js')) as any).getRendition();
    return (r.currentLocation() || {}).start?.index ?? -1;
  });

  const cdp = await page.context().newCDPSession(page);
  const ventanas: number[] = [];
  for (let k = 0; k < 6; k++) {
    const secAntes = await seccion();
    const frames: { t: number; n: number }[] = [];
    const t0 = Date.now();
    const onFrame = async (f: any) => {
      frames.push({ t: Date.now() - t0, n: Buffer.from(f.data, 'base64').length });
      try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch { /* cerrado */ }
    };
    cdp.on('Page.screencastFrame', onFrame);
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 });
    await deslizar(page, -150);
    await enReposo(page);
    await page.waitForTimeout(250);
    await cdp.send('Page.stopScreencast');
    cdp.off('Page.screencastFrame', onFrame);

    const blancos = frames.filter((f) => f.n < UMBRAL_BYTES);
    // Solo cuentan los pases DENTRO de una sección: entrar en un capítulo nuevo obliga a
    // epub.js a construir un iframe y maquetar (~200 ms), y eso no lo arregla ninguna curva.
    const mismaSeccion = (await seccion()) === secAntes;
    if (mismaSeccion && blancos.length >= 2) ventanas.push(blancos[blancos.length - 1].t - blancos[0].t);
  }

  expect(ventanas.length).toBeGreaterThanOrEqual(3);
  const mediana = ventanas.sort((a, b) => a - b)[Math.floor(ventanas.length / 2)];
  console.log('  hueco en blanco por pase (ms):', JSON.stringify(ventanas));
  // Con ESTE libro: antes 66-67 ms clavados, ahora 15-20 (un frame). Sobre un libro real de
  // 14 MB la misma medición daba 99-172 antes y 48-86 después. La valla en 40 separa las dos
  // situaciones con holgura por los dos lados; comprobado que el test FALLA con el código
  // anterior, que es lo único que lo hace valer.
  expect(mediana).toBeLessThan(40);
});
