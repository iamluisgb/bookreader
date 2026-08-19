// reflow-position.spec.ts — La posición de lectura sobrevive a TODO reflujo.
//
// `rotate.spec.ts` ya cubre el giro de pantalla, que entra por el listener de `resize` de
// la ventana. Estos casos entran por OTRAS vías, y durante un tiempo esas vías no ponían el
// pin de posición:
//   · pantalla completa / modo inmersivo → `EpubReader.resize()` directo
//   · cuerpo de letra, interlineado, ancho de columna → `settings:changed`
//
// Sin el pin, re-paginar hace que epub.js emita 'relocated' con el inicio de la página
// nueva —que cae ANTES de donde estabas— y ese CFI se adoptaba y se guardaba. Medido antes
// del arreglo: entrar en pantalla completa movía la posición de /80 a /58 y salir de /58 a
// /48. Hacia atrás y ACUMULATIVO: un poco en cada alternancia, hasta perder la página.
//
// Los dos tests fallan sin el arreglo.
import { test, expect, type Page } from '@playwright/test';
import path from 'path';

const EPUB_PATH = path.join(__dirname, 'test.epub');

// Abre el libro y avanza unas páginas: en la primera no se puede derivar hacia atrás, así
// que medir ahí no probaría nada.
async function abrirYAvanzar(page: Page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');
  await page.setInputFiles('#file-input', EPUB_PATH);
  await expect(page.locator('#epub-container iframe')).toBeAttached({ timeout: 20000 });
  await page.waitForTimeout(2000);
  await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    for (let i = 0; i < 14; i++) {
      R.next();
      await new Promise((r) => setTimeout(r, 350));
    }
  });
  await page.waitForTimeout(1500);
}

// CFI actual + el ancho del contenido frente al del iframe. Lo segundo delata el estado en
// el que epub.js se cortocircuita: si el contenido reflúa pero la vista no se re-mide, el
// iframe se queda con el ancho viejo y las páginas de más allá dejan de ser alcanzables.
async function estado(page: Page) {
  return page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    const f = document.querySelector('#epub-container iframe') as HTMLIFrameElement;
    const d = f.contentDocument!;
    return {
      cfi: R.getCurrentCfi(),
      pagina: R.getPageInfo(R.getCurrentCfi())?.page ?? null,
      contenido: d.documentElement.scrollWidth,
      iframe: f.clientWidth,
    };
  });
}

test('alternar pantalla completa no mueve la posición', async ({ page }) => {
  await abrirYAvanzar(page);
  const antes = await estado(page);
  expect(antes.cfi, 'el libro no avanzó: el test no probaría nada').toBeTruthy();

  // Lo que hace el botón ⤢: cambia las clases del body (la cabecera y el pie dejan de
  // ocupar alto) y pide reflujo. Se alterna DOS veces porque la deriva era acumulativa y
  // una sola pasada podía quedarse dentro de la misma página.
  for (let i = 0; i < 2; i++) {
    for (const on of [true, false]) {
      await page.evaluate(async (on) => {
        const R: any = await import('/js/epub-reader.js');
        document.body.classList.toggle('immersive', on);
        document.body.classList.toggle('fs', on);
        R.resize();
      }, on);
      await page.waitForTimeout(1200);
    }
  }

  const despues = await estado(page);
  expect(despues.cfi).toBe(antes.cfi);
  expect(despues.pagina).toBe(antes.pagina);
});

test('cambiar tipografía no mueve la posición ni deja la vista mal medida', async ({ page }) => {
  await abrirYAvanzar(page);
  const antes = await estado(page);
  expect(antes.contenido).toBe(antes.iframe);

  for (const [clave, valor] of [['fontSize', 26], ['lineHeight', 2], ['columnWidth', 480]] as const) {
    await page.evaluate(async ([k, v]) => {
      const S: any = await import('/js/settings.js');
      S.set(k as string, v);
    }, [clave, valor] as any);
    await page.waitForTimeout(1500);

    const ahora = await estado(page);
    expect(ahora.cfi, `la posición se movió al cambiar ${clave}`).toBe(antes.cfi);
    // Con el cuerpo a 26px el contenido pasa de ~90 000 px a ~204 000: si el iframe se
    // quedara en el ancho viejo, la mitad del capítulo sería inalcanzable.
    expect(ahora.contenido, `la vista quedó mal medida tras cambiar ${clave}`).toBe(ahora.iframe);
  }
});
