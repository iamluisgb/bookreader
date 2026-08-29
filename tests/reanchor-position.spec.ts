// reanchor-position.spec.ts — Un reflujo TARDÍO del contenido no deja la posición atrás.
//
// `reflow-position.spec.ts` cubre los reflujos que vienen de fuera (giro, pantalla completa,
// ajustes): ahí cambia el CONTENEDOR y el pin de `scheduleResize` los ancla. Estos son los que
// vienen de DENTRO del iframe, donde el contenedor no se mueve y por eso no había nada que
// disparar: la fuente de lectura que llega tarde, imágenes que decodifican, CSS del EPUB.
//
// El síntoma medido antes del arreglo: subrayar o marcar, salir, entrar y pulsar la ficha
// dejaba al lector 2 páginas ANTES del pasaje (más cuanto más adentro del capítulo). epub.js
// calcula a qué píxel saltar con la maqueta del momento; cuando Literata entraba después, el
// texto crecía y ese mismo píxel caía en texto anterior.
//
// Dos frentes, un test cada uno:
//   1. Literata se sirve del propio origen y está precacheada → en frío ya no llega tarde.
//   2. Aun llegando tarde, `goTo` re-ancla cuando el contenido asienta.
import { test, expect, type Page } from '@playwright/test';
import path from 'path';

const EPUB_PATH = path.join(__dirname, 'test.epub');

// Distancia en páginas entre la página visible y la que contiene `clave`.
// Negativo = la clave está por delante (nos hemos quedado atrás), que es el bug.
const PAGES_OFF = `async (clave) => {
  const R = await import('/js/epub-reader.js');
  const rend = R.getRendition();
  const norm = s => (s||'').toLowerCase().replace(/\\s+/g,' ').trim();
  const pageText = () => {
    const loc = rend.currentLocation();
    try {
      const c = rend.getContents(); const contents = Array.isArray(c) ? c[0] : c;
      const s = contents.range(loc.start.cfi), e = contents.range(loc.end.cfi);
      const r = contents.document.createRange();
      r.setStart(s.startContainer, s.startOffset); r.setEnd(e.endContainer, e.endOffset);
      return norm(r.toString());
    } catch (err) { return ''; }
  };
  const espera = () => new Promise(r => setTimeout(r, 320));
  if (pageText().includes(clave)) return 0;
  const partida = rend.currentLocation().start.cfi;
  for (let i = 1; i <= 12; i++) { rend.next(); await espera(); if (pageText().includes(clave)) return -i; }
  await rend.display(partida); await espera();
  for (let i = 1; i <= 12; i++) { rend.prev(); await espera(); if (pageText().includes(clave)) return i; }
  return 99;
}`;

async function abrir(page: Page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', EPUB_PATH);
  await expect(page.locator('#epub-container iframe')).toBeAttached({ timeout: 20000 });
  await page.waitForTimeout(3000);
}

// Marca la página actual y devuelve una clave de texto de esa página, para reconocerla luego.
async function marcarAqui(page: Page) {
  const clave = await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    const loc = R.getRendition().currentLocation();
    const c = R.getRendition().getContents();
    const contents = Array.isArray(c) ? c[0] : c;
    const s = contents.range(loc.start.cfi), e = contents.range(loc.end.cfi);
    const r = contents.document.createRange();
    r.setStart(s.startContainer, s.startOffset); r.setEnd(e.endContainer, e.endOffset);
    return r.toString().toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 30);
  });
  // En móvil las barras son overlay y el botón puede quedar fuera del viewport: se pulsa
  // por DOM, que es el mismo manejador.
  await page.$eval('#bookmark-toggle', (e: any) => e.click());
  await page.waitForTimeout(400);
  return clave;
}

async function pulsarMarcador(page: Page) {
  await page.$eval('#sidebar-toggle', (e: any) => e.click());
  await page.waitForTimeout(700);
  await page.click('[data-tab="bookmarks"]').catch(() => {});
  await page.waitForTimeout(300);
  await page.click('.bookmark-item .bookmark-info');
}

test('la serif de lectura sale de nuestro origen, no de Google Fonts', async ({ page }) => {
  const terceros: string[] = [];
  const propias: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/fonts\.(googleapis|gstatic)\.com/.test(u)) terceros.push(u);
    if (/\/fonts\/literata-/.test(u)) propias.push(u);
  });

  await abrir(page);
  // Renderizar algo de texto en cursiva y redonda para que se pidan las dos caras.
  await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    for (let i = 0; i < 6; i++) { R.next(); await new Promise((r) => setTimeout(r, 250)); }
  });
  await page.waitForTimeout(1500);

  expect(terceros, `peticiones a Google Fonts desde el lector: ${terceros.join(', ')}`).toEqual([]);
  expect(propias.length, 'no se pidió ninguna Literata local').toBeGreaterThan(0);

  // Y la fuente está realmente disponible DENTRO del iframe de lectura.
  const disponible = await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    const c = R.getRendition().getContents();
    const contents = Array.isArray(c) ? c[0] : c;
    await contents.document.fonts.ready;
    return contents.document.fonts.check('400 16px Literata');
  });
  expect(disponible, 'Literata no quedó disponible en el documento de lectura').toBe(true);
});

// El service worker se bloquea a propósito: sirve las fuentes cache-first y, con él en medio,
// la segunda apertura ni siquiera saldría a la red — que en producción es justo lo que
// queremos, pero aquí impediría montar el escenario del reflujo tardío.
test.describe(() => {
  test.use({ serviceWorkers: 'block' });

test('un reflujo tardío no deja el marcador unas páginas atrás', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });

  // La fuente de lectura, retenida a voluntad: reproduce la apertura en frío con red lenta.
  // `no-store` en la respuesta para que la segunda apertura vuelva a pedirla de verdad; si se
  // sirviera de la caché del navegador no habría nada que retener y el test no probaría nada.
  let retener = false;
  let retenidas = 0;
  const pendientes: Array<() => void> = [];
  await page.route(/\/fonts\/literata-/, async (route) => {
    if (retener) { retenidas++; await new Promise<void>((r) => pendientes.push(r)); }
    const res = await route.fetch();
    await route.fulfill({ response: res, headers: { ...res.headers(), 'cache-control': 'no-store' } });
  });

  // Marcar bien adentro del capítulo largo: el desvío crece con la distancia al inicio
  // de la sección, y en la primera página no se puede ir hacia atrás.
  await abrir(page);
  await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    for (let i = 0; i < 45; i++) { R.next(); await new Promise((r) => setTimeout(r, 170)); }
  });
  await page.waitForTimeout(1500);
  const clave = await marcarAqui(page);
  expect(clave.length, 'clave de texto demasiado corta para reconocer la página').toBeGreaterThan(15);

  // Dejar la última posición LEJOS del marcador, para que el salto tenga que ocurrir.
  await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    await R.getRendition().display(1);
    await new Promise((r) => setTimeout(r, 1200));
    R.flushLastPosition();
  });
  await page.waitForTimeout(600);

  // === SALIR Y ENTRAR con la fuente aún de camino ===
  retener = true;
  await abrir(page);
  await pulsarMarcador(page);
  await page.waitForTimeout(600);

  // La fuente llega ahora: el capítulo se re-maquetará con el lector ya puesto.
  expect(retenidas, 'la fuente no llegó a retenerse: el escenario no se montó').toBeGreaterThan(0);
  retener = false;
  pendientes.splice(0).forEach((r) => r());
  await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    await R.whenReanchored();
  });
  await page.waitForTimeout(500);

  const desvio = await page.evaluate(new Function('k', `return (${PAGES_OFF})(k)`) as any, clave);
  expect(desvio, `páginas de desvío respecto al marcador (negativo = se quedó atrás)`).toBe(0);
});
});
