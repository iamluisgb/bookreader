// pdf-touch-select.spec.ts — Subrayar tres líneas en el PDF con el dedo.
//
// Antes, en móvil, la selección del PDF era 100 % nativa. Las asas nativas no se dejan
// gobernar —su arrastre NO emite eventos táctiles a la página— y sobre una capa de spans en
// absoluto se disparaban en cuanto el dedo pasaba por un hueco: el navegador resolvía el
// cursor por proximidad EN EL DOM y la selección se comía media página.
//
// Ahora la lleva la app (pdf-touch-select.js), con ajuste por LÍNEAS al salir de la línea
// donde empezaste. Efecto colateral que hace posible este fichero: los gestos propios SÍ se
// pueden simular, cosa que con las asas nativas no se podía.
import { test, expect, type Page } from '@playwright/test';
import path from 'path';

const PDF_PATH = path.join(__dirname, 'test-multipage.pdf');

test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });

async function abrir(page: Page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', PDF_PATH);
  await expect(page.locator('#pdf-container .textLayer span').first()).toBeAttached({ timeout: 20000 });
  await page.waitForTimeout(1500);
}

// Las cuatro primeras líneas de un párrafo, con su geometría en pantalla.
async function lineas(page: Page) {
  return page.evaluate(() => {
    const spans = [...document.querySelectorAll('#pdf-container .textLayer span')] as HTMLElement[];
    const i = spans.findIndex((s, k) => k > 4 && s.textContent!.startsWith('Lorem'));
    if (i < 0) throw new Error('no se encontró el párrafo de referencia');
    return spans.slice(i, i + 4).map((s) => {
      const r = s.getBoundingClientRect();
      return { left: r.left, right: r.right, cy: r.top + r.height / 2, texto: s.textContent!.trim() };
    });
  });
}

// Pulsación larga en (x1,y1) y arrastre hasta (x2,y2), con eventos táctiles reales.
async function seleccionar(page: Page, x1: number, y1: number, x2: number, y2: number) {
  await page.evaluate(async ([ax, ay, bx, by]) => {
    const cont = document.getElementById('pdf-container')!;
    const toque = (tipo: string, x: number, y: number) => {
      const t = new Touch({ identifier: 1, target: cont, clientX: x, clientY: y });
      cont.dispatchEvent(new TouchEvent(tipo, {
        bubbles: true, cancelable: true,
        touches: tipo === 'touchend' ? [] : [t],
        changedTouches: [t], targetTouches: tipo === 'touchend' ? [] : [t],
      }));
    };
    toque('touchstart', ax, ay);
    await new Promise((r) => setTimeout(r, 500));          // > LONGPRESS_MS
    for (let k = 1; k <= 6; k++) {                          // arrastre en pasos
      toque('touchmove', ax + ((bx - ax) * k) / 6, ay + ((by - ay) * k) / 6);
      await new Promise((r) => setTimeout(r, 25));
    }
    toque('touchend', bx, by);
  }, [x1, y1, x2, y2]);
  await page.waitForTimeout(400);
}

async function textoBarra(page: Page) {
  return page.evaluate(async () => {
    // La barra guarda lo seleccionado en el editor activo; se lee copiando al portapapeles no,
    // que el navegador de test no lo da: se lee del subrayado que crea el botón de color.
    (document.querySelector('#highlight-tooltip .highlight-color') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 300));
    const H: any = await import('/js/highlights.js');
    const todos = H.getAll ? H.getAll() : [];
    return todos.length ? todos[todos.length - 1].text : '';
  });
}

test('cruzar de línea selecciona LÍNEAS COMPLETAS, no un trozo suelto', async ({ page }) => {
  await abrir(page);
  const L = await lineas(page);

  // Empezar a MEDIA primera línea y soltar a MEDIA tercera. Con precisión de carácter esto
  // daría media línea al principio y media al final; el ajuste por líneas debe dar las tres
  // enteras, que es lo que el usuario quiere y lo que con el dedo no puede apuntar.
  await seleccionar(page, (L[0].left + L[0].right) / 2, L[0].cy, (L[2].left + L[2].right) / 2, L[2].cy);
  await expect(page.locator('#highlight-tooltip')).toBeVisible();

  const texto = await textoBarra(page);
  expect(texto, 'no llegó texto a la barra').toBeTruthy();
  // Las tres líneas enteras y NADA de la cuarta.
  for (const l of L.slice(0, 3)) {
    const trozo = l.texto.slice(0, 25);
    expect(texto, `falta el principio de la línea "${trozo}…"`).toContain(trozo);
  }
  expect(texto, 'se coló la cuarta línea').not.toContain(L[3].texto.slice(0, 25));
});

test('dentro de una misma línea la selección sigue siendo por caracteres', async ({ page }) => {
  await abrir(page);
  const L = await lineas(page);

  // De un cuarto a tres cuartos de la MISMA línea: no se cruza ninguna, así que no se ajusta.
  const ancho = L[0].right - L[0].left;
  await seleccionar(page, L[0].left + ancho * 0.25, L[0].cy, L[0].left + ancho * 0.75, L[0].cy);
  await expect(page.locator('#highlight-tooltip')).toBeVisible();

  const texto = await textoBarra(page);
  expect(texto.length, 'se ajustó a línea completa cuando no debía').toBeLessThan(L[0].texto.length);
  expect(texto.length, 'no seleccionó casi nada').toBeGreaterThan(5);
});

test('la selección nativa está desactivada en táctil', async ({ page }) => {
  await abrir(page);
  const v = await page.evaluate(() => {
    const s = document.querySelector('#pdf-container .textLayer span') as HTMLElement;
    return getComputedStyle(s).userSelect || (getComputedStyle(s) as any).webkitUserSelect;
  });
  // Si la nativa siguiera viva competiría con la nuestra y saldría el menú del sistema
  // encima de la barra de acciones.
  expect(v).toBe('none');
});

// La capa de selección es `position: fixed` y se dibuja una vez, en coordenadas de PANTALLA.
// El PDF, en cambio, vive en un contenedor con `overflow: auto`. Al desplazarse con la
// selección puesta, el texto se movía y el resaltado se quedaba clavado donde estaba: bandas
// azules a un lado del texto y la barra de acciones flotando lejos de lo marcado.
test('al desplazarse, el resaltado sigue pegado al texto', async ({ page }) => {
  await abrir(page);
  // En modo SCROLL, que es donde el contenedor se desplaza de verdad (en paginado la página
  // cabe entera y `scrollHeight === clientHeight`, así que no probaría nada).
  await page.evaluate(async () => {
    const R: any = await import('/js/pdf-reader.js');
    await R.setReadingMode('scroll');
  });
  await page.waitForTimeout(1200);
  const L = await lineas(page);
  await seleccionar(page, (L[0].left + L[0].right) / 2, L[0].cy, (L[2].left + L[2].right) / 2, L[2].cy);
  await expect(page.locator('#highlight-tooltip')).toBeVisible();

  // Distancia entre el resaltado y el texto que cubre, antes y después de desplazar. Es lo
  // que tiene que NO cambiar; comparar posiciones absolutas no diría nada, porque las dos
  // cosas se mueven.
  const separacion = () => page.evaluate(() => {
    const hi = document.querySelector('#ts-overlay .ts-hi') as HTMLElement;
    const tt = document.getElementById('highlight-tooltip')!;
    const spans = [...document.querySelectorAll('#pdf-container .textLayer span')] as HTMLElement[];
    const i = spans.findIndex((s, k) => k > 4 && s.textContent!.startsWith('Lorem'));
    const a = hi.getBoundingClientRect(), b = spans[i].getBoundingClientRect();
    const t = tt.getBoundingClientRect();
    return { dx: a.left - b.left, dy: a.top - b.top, barra: t.top - b.top };
  });

  const antes = await separacion();
  const movido = await page.evaluate(() => {
    const c = document.getElementById('pdf-container')!;
    const t0 = c.scrollTop;
    c.scrollTop += 30;
    c.dispatchEvent(new Event('scroll'));
    return c.scrollTop - t0;
  });
  expect(movido, 'el contenedor no se desplazó: el test no probaría nada').toBeGreaterThan(20);
  await page.waitForTimeout(300);
  const despues = await separacion();

  expect(Math.abs(despues.dx - antes.dx), 'el resaltado se quedó atrás en horizontal').toBeLessThan(2);
  expect(Math.abs(despues.dy - antes.dy), 'el resaltado se quedó atrás en vertical').toBeLessThan(2);
  // Y la barra de acciones va con ellos: quedarse flotando lejos de lo marcado era la otra
  // mitad del síntoma.
  // Y la barra de acciones va con ellos: quedarse flotando lejos de lo marcado era la otra
  // mitad del síntoma. Se desplaza POCO a propósito — con un salto grande la selección se sale
  // por arriba y la barra se ancla al borde de la pantalla, que es lo correcto pero no es lo
  // que aquí se quiere medir.
  const enPantalla = await page.evaluate(() =>
    document.querySelector('#ts-overlay .ts-hi')!.getBoundingClientRect().top > 0);
  expect(enPantalla, 'la selección se salió de la pantalla: el caso medido sería el del recorte').toBe(true);
  expect(Math.abs(despues.barra - antes.barra), 'la barra se quedó atrás').toBeLessThan(2);
});
