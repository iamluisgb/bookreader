// perf.spec.ts — Arnés de rendimiento del lector (BACKLOG · TEC3).
//
// POR QUÉ EXISTE. Todo lo que se afirma sobre el rendimiento del lector venía de leer el
// código, no de medirlo — y TEC4 propone gastar días en cambiar el motor EPUB. Esto pone
// números antes de decidir, y los deja como VALLA: si una métrica se sale del presupuesto,
// el test falla.
//
// CÓMO SE CORRE. `npm run perf`, y **solo eso**: fuera de `npm test` porque necesita
// fixtures pesadas y porque medir con la suite entera en paralelo no mide nada.
//   npm run eval:fixtures   # una vez: descarga las fixtures (no se versionan)
//   npm run perf
// Sin fixtures, los tests se saltan con instrucciones en vez de fallar.
//
// QUÉ MIDE (y por qué así):
//   · epub.ttfp / pdf.ttfp — desde el `change` del <input type=file> (el instante exacto en
//     que la app recibe el fichero, no cuando Playwright suelta el ratón) hasta que hay
//     página pintada de verdad.
//   · epub.turn.intra vs epub.section.load — SEPARADOS a propósito. Pasar página dentro de
//     un capítulo es un scroll de la multicolumna (barato); entrar en una sección nueva es
//     iframe nuevo + layout + medición de columnas (caro). Promediarlos esconde justo el
//     problema que TEC4 quiere atacar.
//   · epub.locations — el recorrido del libro entero en el hilo principal. Es el objetivo
//     directo de TEC4-F1a (moverlo a un worker).
//   · epub.typography — cambiar el cuerpo de letra rehace la maquetación del iframe.
//   · epub.heap — memoria retenida tras recorrer el libro.
//   · app.coldStart — la cascada de módulos ES sin build step (TEC4-F1c, modulepreload).
//
// LOS PRESUPUESTOS son una valla contra regresiones, NO un objetivo de calidad: salen de la
// primera medición en el portátil de desarrollo, redondeados hacia arriba con margen para
// que no parpadeen. Que una métrica pase NO significa que esté bien; significa que no ha
// empeorado. Los objetivos de verdad los pone TEC4 cuando haya con qué comparar.
import { test, expect, type Page, type CDPSession } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

const FIXTURES = path.join(__dirname, '..', 'evals', 'fixtures');
const EPUB_HEAVY = path.join(FIXTURES, 'p2-progit.epub');   // 14 MB, decenas de secciones
const PDF_HEAVY = path.join(FIXTURES, 'p3-constitucion.pdf');

// Presupuestos en ms (salvo los contadores). Ver cabecera: valla, no objetivo.
const BUDGET = {
  'app.coldStart': 600,          // medido 140-265
  'epub.ttfp': 2000,             // medido ~700-870 (EPUB de 14 MB)
  'epub.turn.intra.p95': 200,    // medido ~66-80
  'epub.section.load.p95': 900,  // medido ~470-490
  'epub.locations': 6000,        // medido ~2200
  'epub.typography': 500,        // medido ~53
  'epub.heap.mb': 30,            // medido ~10.6
  'pdf.ttfp': 1500,              // medido ~410
  'pdf.turn.p95': 250,           // medido ~67
};

// Todas las medidas de la corrida, volcadas a test-results/perf.json para poder comparar
// dos corridas sin releer la salida de Playwright.
const medidas: Record<string, number> = {};

function anota(nombre: string, valor: number) {
  medidas[nombre] = Math.round(valor * 10) / 10;
  console.log(`  ${nombre.padEnd(26)} ${medidas[nombre]}`);
}

// Comprueba el presupuesto además de anotar. Separado de `anota` porque hay métricas que
// solo queremos observar (p50) sin convertirlas en valla.
function anotaYExige(nombre: string, valor: number) {
  anota(nombre, valor);
  const tope = BUDGET[nombre as keyof typeof BUDGET];
  expect(valor, `${nombre} se salió del presupuesto (${tope})`).toBeLessThanOrEqual(tope);
}

function p(valores: number[], q: number) {
  const orden = [...valores].sort((a, b) => a - b);
  // Percentil por rango más cercano: con 20-40 muestras interpolar no aporta y confunde.
  return orden[Math.min(orden.length - 1, Math.ceil(q * orden.length) - 1)];
}

test.describe('Rendimiento del lector @perf', () => {
  // Un worker, en serie: dos medidas a la vez no son dos medidas.
  test.describe.configure({ mode: 'serial' });

  test.skip(
    !existsSync(EPUB_HEAVY) || !existsSync(PDF_HEAVY),
    'Faltan las fixtures pesadas. Ejecuta `npm run eval:fixtures` (no se versionan).',
  );

  // Margen amplio: abrir un EPUB de 14 MB y darle 40 pases no cabe en el timeout normal.
  test.setTimeout(180_000);

  test.afterAll(() => {
    const dir = path.join(__dirname, '..', 'test-results');
    mkdirSync(dir, { recursive: true });
    const salida = { fecha: new Date().toISOString(), presupuestos: BUDGET, medidas };
    writeFileSync(path.join(dir, 'perf.json'), JSON.stringify(salida, null, 2));
  });

  test('arranque en frío de la app', async ({ page }) => {
    // El reloj lo pone el navegador: `performance.now()` cuenta desde el inicio de la
    // navegación, así que la latencia de Playwright no entra en la medida.
    await page.addInitScript(() => {
      (window as any).__cold = null;
      const tick = () => {
        const h1 = document.querySelector('.lib-h1');
        if (h1 && (h1 as HTMLElement).innerText.trim()) {
          (window as any).__cold = performance.now();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => (window as any).__cold)).not.toBeNull();
    anotaYExige('app.coldStart', await page.evaluate(() => (window as any).__cold));
  });

  test('EPUB pesado: apertura, pases, locations, tipografía y memoria', async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.goto('/');
    await expect(page.locator('.lib-h1')).toBeVisible();

    // ---- TTFP -------------------------------------------------------------------
    anotaYExige('epub.ttfp', await abrirYMedir(page, EPUB_HEAVY, 'epub'));

    // ---- Pases de página, separando intra-capítulo de frontera --------------------
    // Antes de medir se deja asentar el arranque (las locations se generan al abrir y
    // compiten por el hilo). Su coste se mide aparte, abajo, que es donde importa.
    await page.waitForTimeout(2000);

    // Y se entra al CUERPO del libro. Midiendo desde la portada, los 40 pases se quedan en
    // el preliminar (cubierta, créditos, índice): secciones diminutas cuyas fronteras son
    // baratas, así que la métrica cara salía barata por estar mirando donde no era.
    await page.evaluate(async () => {
      const R: any = await import('/js/epub-reader.js');
      await R.seekToFraction(0.25);
    });
    await page.waitForTimeout(1500);

    // Pases DENTRO de capítulo. Los pocos que crucen sección se descartan en vez de
    // promediarse: aquí solo se quiere el coste del scroll de la multicolumna.
    const intra = await page.evaluate(async () => {
      const R: any = await import('/js/epub-reader.js');
      const rend = R.getRendition();
      const spine = () => {
        try { return rend.currentLocation()?.start?.index ?? -1; } catch { return -1; }
      };
      const out: number[] = [];
      for (let i = 0; i < 30; i++) {
        const antes = spine();
        const t0 = performance.now();
        // `rendition.next()` resuelve cuando la vista está mostrada; el doble rAF añade el
        // frame de pintado, que es lo que el lector percibe.
        await rend.next();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
        const ms = performance.now() - t0;
        if (spine() === antes) out.push(ms);
      }
      return out;
    });
    expect(intra.length, 'casi todos los pases cruzaron sección: fixture inadecuada').toBeGreaterThan(15);
    anota('epub.turn.intra.p50', p(intra, 0.5));
    anotaYExige('epub.turn.intra.p95', p(intra, 0.95));

    // Coste de FRONTERA, medido a propósito y no por azar. Contarlo sobre pases naturales
    // hacía el test intermitente: en un libro de capítulos grandes (Pro Git son 21 secciones)
    // 30 pases cruzan una frontera o ninguna, según dónde caiga el arranque. Cargar secciones
    // concretas mide el mismo trabajo —iframe nuevo, layout, medición de columnas— con una
    // muestra estable en cada corrida.
    const secciones = await page.evaluate(async () => {
      const R: any = await import('/js/epub-reader.js');
      const rend = R.getRendition();
      const book = R.getBook();
      const hrefs: string[] = [];
      book.spine.each((it: any) => hrefs.push(it.href));
      // Del último tercio: el preliminar (cubierta, créditos, índice) son secciones
      // diminutas y baratas, y medirlas daría un número bonito que no vive nadie.
      const muestra = hrefs.slice(Math.floor(hrefs.length * 0.4));
      const out: number[] = [];
      for (const href of muestra) {
        const t0 = performance.now();
        await rend.display(href);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
        out.push(performance.now() - t0);
      }
      return out;
    });
    expect(secciones.length, 'menos de 5 secciones medibles: fixture inadecuada').toBeGreaterThan(4);
    anota('epub.section.n', secciones.length);
    anota('epub.section.load.p50', p(secciones, 0.5));
    anotaYExige('epub.section.load.p95', p(secciones, 0.95));

    // ---- Memoria tras recorrer el libro ------------------------------------------
    // La valla es el HEAP, que es la magnitud que de verdad tumba una pestaña. `Documents` y
    // `Nodes` se anotan pero NO se exigen: medido con 140 pases, Documents va de 1 a 5 con un
    // solo iframe enganchado y el heap plano — es retraso del GC en soltar documentos
    // desenganchados, no una fuga, y convertirlo en valla solo produciría fallos intermitentes.
    await cdp.send('HeapProfiler.collectGarbage');
    const tras = await metricas(cdp);
    const iframes = await page.evaluate(() => document.querySelectorAll('iframe').length);
    anota('epub.iframes', iframes);
    anota('epub.docs', tras.Documents);
    anota('epub.nodes', tras.Nodes);
    anotaYExige('epub.heap.mb', tras.JSHeapUsedSize / 1e6);

    // ---- Cambio de cuerpo de letra: reflow completo del iframe --------------------
    // La señal de "reflow terminado" NO puede ser `relocated`: el handler de
    // `settings:changed` solo hace resize + re-inyección de tema, y epub.js no reubica —
    // medido, el evento no llega nunca. Lo observable es la MAQUETACIÓN: al cambiar el
    // cuerpo cambia el número de columnas, así que el `scrollWidth` del documento se mueve
    // y luego se queda quieto. Se espera a que se mueva Y se estabilice tres frames.
    anotaYExige('epub.typography', await page.evaluate(async () => {
      const S: any = await import('/js/settings.js');
      const ancho = () => {
        const f = document.querySelector('#epub-container iframe') as HTMLIFrameElement | null;
        return f?.contentDocument?.documentElement.scrollWidth ?? -1;
      };
      const antes = ancho();
      const t0 = performance.now();
      // +6px y no +1: un salto pequeño puede no cambiar el número de columnas, y entonces
      // no habría nada que observar.
      S.set('fontSize', S.get('fontSize') + 6);
      return await new Promise<number>((resolve) => {
        let quieto = 0;
        let ultimo = antes;
        const tick = () => {
          // Tope propio: se devuelve Infinity y que falle el presupuesto con su número, en
          // vez de colgar el test hasta el timeout de Playwright.
          if (performance.now() - t0 > 20000) return resolve(Infinity);
          const w = ancho();
          quieto = w !== antes && w === ultimo ? quieto + 1 : 0;
          ultimo = w;
          if (quieto >= 3) return resolve(performance.now() - t0);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    }));

    // ---- Locations: el recorrido del libro entero en el hilo principal ------------
    // Sin bookId se fuerza la generación (con id se leerían las ya cacheadas en IDB, que es
    // justo lo que aquí NO queremos medir: interesa el coste de la primera apertura).
    anotaYExige('epub.locations', await page.evaluate(async () => {
      const R: any = await import('/js/epub-reader.js');
      const t0 = performance.now();
      await R.generateLocations();
      return performance.now() - t0;
    }));
  });

  test('PDF pesado: apertura y pases', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.lib-h1')).toBeVisible();

    anotaYExige('pdf.ttfp', await abrirYMedir(page, PDF_HEAVY, 'pdf'));
    await page.waitForTimeout(1000);

    const pases = await page.evaluate(async () => {
      const R: any = await import('/js/pdf-reader.js');
      const out: number[] = [];
      for (let i = 0; i < 30; i++) {
        const t0 = performance.now();
        // El render de la página es asíncrono y NO lo espera `next()`, así que la señal es
        // el evento que emite el propio lector al terminar de pintarla.
        const pintada = new Promise((r) => {
          const h = () => { window.removeEventListener('reader:pdf-page-rendered', h); r(null); };
          window.addEventListener('reader:pdf-page-rendered', h);
        });
        await R.next();
        await pintada;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
        out.push(performance.now() - t0);
      }
      return out;
    });

    anota('pdf.turn.p50', p(pases, 0.5));
    anotaYExige('pdf.turn.p95', p(pases, 0.95));
  });
});

// Abre un libro por el <input type=file> real y devuelve los ms desde que la app RECIBE el
// fichero (evento `change`, capturado antes de soltarlo) hasta que hay página pintada. El
// reloj vive entero en el navegador: ni el round-trip de Playwright ni el diálogo de
// ficheros entran en la cifra.
async function abrirYMedir(page: Page, fichero: string, tipo: 'epub' | 'pdf'): Promise<number> {
  await page.evaluate((t) => {
    const w = window as any;
    w.__ttfp = { t0: null, ready: null };
    document.getElementById('file-input')!.addEventListener(
      'change',
      () => {
        w.__ttfp.t0 = performance.now();
        if (t === 'pdf') {
          const h = () => {
            window.removeEventListener('reader:pdf-page-rendered', h);
            w.__ttfp.ready = performance.now();
          };
          window.addEventListener('reader:pdf-page-rendered', h);
          return;
        }
        // EPUB no emite un evento equivalente, así que la señal es el estado observable:
        // iframe con altura real y un documento maquetado dentro. "Visible" no basta —el
        // contenedor lo está desde antes de que haya nada pintado— y exigir TEXTO tampoco
        // vale: la primera página de muchos EPUB es la portada, un SVG sin una letra.
        const tick = () => {
          const f = document.querySelector('#epub-container iframe') as HTMLIFrameElement | null;
          const doc = f?.contentDocument;
          if (
            f && f.clientHeight > 100 &&
            doc?.readyState === 'complete' &&
            doc.body?.children.length &&
            doc.body.getBoundingClientRect().height > 0
          ) {
            w.__ttfp.ready = performance.now();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      { capture: true, once: true },
    );
  }, tipo);

  await page.setInputFiles('#file-input', fichero);
  await expect
    .poll(() => page.evaluate(() => (window as any).__ttfp.ready), { timeout: 60000 })
    .not.toBeNull();
  const { t0, ready } = await page.evaluate(() => (window as any).__ttfp);
  return ready - t0;
}

async function metricas(cdp: CDPSession): Promise<Record<string, number>> {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}
