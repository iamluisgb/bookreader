// pdf-axis-lock.spec.ts — ADR-034 · el eje se decide por GESTO, no con un candado.
//
// Con recorte («Ajustar al texto», ADR-033) no hay eje X que descolocar a zoom 1. Pero al
// ampliar vuelve a haberlo por construcción, y ahí leer en vertical se llevaba la columna de
// lado. La cura no es un modo persistente —dejaría la vista descentrada y, en móvil, el
// contenido de fuera del viewport fuera de alcance—: si el arranque del arrastre es
// claramente vertical, la componente X de ESE gesto se ignora y el siguiente panea normal.
//
// El scroll táctil lo lleva el compositor y Playwright no lo simula, así que aquí se emula lo
// que haría: se mueve el scroll a mano (dy grande + dx de deriva) entre touchmove y
// touchmove. Lo que se fija es el contrato del módulo — cuándo repone scrollLeft y cuándo no.
import { test, expect, type Page } from '@playwright/test';
import path from 'path';

const PDF = path.join(__dirname, 'test-multipage.pdf');

test.use({ viewport: { width: 390, height: 780 }, hasTouch: true });

// Abre el PDF y amplía hasta que sobre ancho: sin recorrido horizontal no hay nada que
// bloquear y el módulo se aparta (esa es la mitad del contrato).
async function abrirConEjeX(page: Page) {
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', PDF);
  await page.waitForSelector('#pdf-container .pdf-page canvas', { timeout: 20000 });
  await page.evaluate(async () => {
    const P: any = await import('/js/pdf-reader.js');
    P.setZoom(2.5);
    await new Promise((r) => setTimeout(r, 400));
    const c = document.getElementById('pdf-container')!;
    c.scrollLeft = Math.round((c.scrollWidth - c.clientWidth) / 2);   // sitio para irse a los dos lados
    c.scrollTop = 0;
  });
  const sobra = await page.evaluate(() => {
    const c = document.getElementById('pdf-container')!;
    return c.scrollWidth - c.clientWidth;
  });
  expect(sobra).toBeGreaterThan(50);
}

// Un arrastre de `pasos` tramos. Tras cada touchmove se mueve el scroll como lo movería el
// compositor: el desplazamiento del dedo, con su deriva lateral incluida.
async function arrastrar(page: Page, dx: number, dy: number, pasos = 5) {
  return page.evaluate(async ([DX, DY, N]) => {
    const c = document.getElementById('pdf-container')!;
    const toque = (tipo: string, x: number, y: number) => {
      const t = new Touch({ identifier: 1, target: c, clientX: x, clientY: y });
      const ts = tipo === 'touchend' ? [] : [t];
      c.dispatchEvent(new TouchEvent(tipo, {
        bubbles: true, cancelable: true, touches: ts, targetTouches: ts, changedTouches: [t],
      }));
    };
    const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const x0 = 195, y0 = 600;
    const l0 = c.scrollLeft;

    toque('touchstart', x0, y0);
    await frame();
    for (let k = 1; k <= N; k++) {
      toque('touchmove', x0 + (DX * k) / N, y0 - (DY * k) / N);
      // El dedo arrastra el contenido en sentido contrario: el scroll avanza lo que baja.
      c.scrollLeft -= DX / N;
      c.scrollTop += DY / N;
      await frame();
    }
    const derivaAntesDeSoltar = c.scrollLeft - l0;
    toque('touchend', x0 + DX, y0 - DY);
    await frame();
    return { derivaAntesDeSoltar, avanceY: c.scrollTop, scrollLeft: c.scrollLeft, l0 };
  }, [dx, dy, pasos] as const);
}

test.describe('PDF · eje dominante durante el gesto', () => {
  test('un arrastre vertical con deriva no mueve la columna de lado', async ({ page }) => {
    await abrirConEjeX(page);
    // 40 px de deriva lateral repartidos en un arrastre de 300 px hacia arriba: el desvío
    // típico del pulgar leyendo. Vertical claro → la X se ignora.
    const r = await arrastrar(page, 40, 300);
    expect(Math.abs(r.derivaAntesDeSoltar)).toBeLessThan(2);   // la columna se queda donde estaba
    expect(r.avanceY).toBeGreaterThan(200);                    // y el gesto sigue desplazando
  });

  test('un arrastre lateral panea con normalidad', async ({ page }) => {
    await abrirConEjeX(page);
    // El mismo módulo, el gesto opuesto: 300 px de lado con 40 de desvío vertical. Aquí la X
    // es lo que se pide, y tocarla sería el candado que ADR-034 no quiere.
    const r = await arrastrar(page, 300, 40);
    expect(Math.abs(r.derivaAntesDeSoltar)).toBeGreaterThan(200);
  });

  test('el eje decidido no sobrevive al gesto', async ({ page }) => {
    await abrirConEjeX(page);
    await arrastrar(page, 40, 300);              // deja el eje X bloqueado…
    await page.waitForTimeout(300);              // …hasta que para la inercia (SETTLE_MS)
    const movido = await page.evaluate(async () => {
      const c = document.getElementById('pdf-container')!;
      const l0 = c.scrollLeft;
      c.scrollLeft = l0 + 60;                    // p. ej. scrollIntoView, o el siguiente paneo
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
      return c.scrollLeft - l0;
    });
    expect(movido).toBeGreaterThan(50);
  });

  test('el zoom sigue anclándose al foco (mueve scrollLeft a mano)', async ({ page }) => {
    await abrirConEjeX(page);
    await arrastrar(page, 40, 300);              // eje bloqueado justo antes de ampliar
    const movido = await page.evaluate(async () => {
      const P: any = await import('/js/pdf-reader.js');
      const c = document.getElementById('pdf-container')!;
      const l0 = c.scrollLeft;
      P.setZoom(4, { x: 380, y: 100 });          // foco en el borde derecho → tiene que ir allí
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 60)));
      return c.scrollLeft - l0;
    });
    expect(Math.abs(movido)).toBeGreaterThan(10);
  });
});
