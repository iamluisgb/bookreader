// pdf-selection.spec.ts — Seleccionar con el ratón en el PDF no se traga lo de al lado.
//
// La capa de texto de pdf.js son <span> posicionados en absoluto cuyo orden en el DOM es el
// del flujo del PDF, no el de la página. Con el puntero en un hueco —el margen, el aire
// entre dos bloques, más allá del final de una línea— el navegador resuelve el cursor por
// proximidad EN EL DOM y aterriza donde le parece.
//
// Medido antes del arreglo, queriendo un párrafo de 223 caracteres:
//   · arrancando en el margen izquierdo → 684 (ancla en la cabecera de la página y arrastra
//     todo lo que hay en medio: es el síntoma reportado);
//   · soltando 120 px a la derecha del final → 592.
// El mecanismo `.endOfContent` del visor de pdf.js no cambia ninguno de los dos.
import { test, expect, type Page } from '@playwright/test';
import path from 'path';

const PDF_PATH = path.join(__dirname, 'test-multipage.pdf');

// Abre el PDF y localiza un párrafo de 4 líneas: sus esquinas y lo que debería salir.
async function abrirYLocalizar(page: Page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', PDF_PATH);
  await expect(page.locator('#pdf-container .textLayer span').first()).toBeAttached({ timeout: 20000 });
  await page.waitForTimeout(2000);
  return page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('#pdf-container .textLayer span')) as HTMLElement[];
    // Un párrafo que NO es el primero de la página: el fallo consistía en anclar arriba del
    // todo, así que medido desde el primer bloque no se notaría.
    const i = spans.findIndex((s, k) => k > 4 && s.textContent!.startsWith('Lorem'));
    if (i < 0) throw new Error('no se encontró el párrafo de referencia');
    const a = spans[i].getBoundingClientRect(), b = spans[i + 3].getBoundingClientRect();
    return {
      ax: a.left + 4, ay: a.top + a.height / 2,
      bx: b.right - 4, by: b.top + b.height / 2,
      esperado: spans.slice(i, i + 4).map((s) => s.textContent).join(' ').replace(/\s+/g, ' ').trim().length,
    };
  });
}

async function arrastrar(page: Page, x1: number, y1: number, x2: number, y2: number) {
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps: 12 });
  await page.mouse.up();
  return page.evaluate(() => (window.getSelection()!.toString() || '').replace(/\s+/g, ' ').trim());
}

// Un carácter de margen: el extremo cae en el borde de un span y el navegador puede resolver
// al hueco entre dos glifos. Lo que se comprueba es que no se cuela OTRO bloque.
const HOLGURA = 3;

test('arrancar el arrastre en el margen izquierdo no ancla en la cabecera', async ({ page }) => {
  const o = await abrirYLocalizar(page);
  const texto = await arrastrar(page, o.ax - 60, o.ay, o.bx, o.by);
  expect(texto.length, `se coló texto de fuera del párrafo: "${texto.slice(0, 60)}…"`)
    .toBeLessThanOrEqual(o.esperado + HOLGURA);
  expect(texto.length).toBeGreaterThanOrEqual(o.esperado - HOLGURA);
  expect(texto.startsWith('Lorem')).toBe(true);
});

test('arrancar fuera de la página tampoco: se repliega a la página más cercana', async ({ page }) => {
  const o = await abrirYLocalizar(page);
  const texto = await arrastrar(page, o.ax - 120, o.ay, o.bx, o.by);
  expect(texto.length).toBeLessThanOrEqual(o.esperado + HOLGURA);
  expect(texto.startsWith('Lorem')).toBe(true);
});

test('soltar más allá del final de la línea no arrastra el párrafo siguiente', async ({ page }) => {
  const o = await abrirYLocalizar(page);
  const texto = await arrastrar(page, o.ax, o.ay, o.bx + 120, o.by);
  expect(texto.length, `se coló texto de más: "…${texto.slice(-60)}"`)
    .toBeLessThanOrEqual(o.esperado + HOLGURA);
});

// El caso del usuario: un hueco grande de aire entre un bloque y el párrafo de abajo. Un PDF
// de prueba corriente tiene los párrafos seguidos y no sabe expresarlo, así que se monta el
// layout a mano —spans en absoluto, como los de pdf.js— y se ejercita la regla directamente.
test('con un hueco grande, el cursor va al bloque más cercano y no al primero del DOM', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const M: any = await import('/js/pdf-text-select.js');
    // El layout se monta DENTRO del #pdf-container de verdad: los selectores del módulo
    // están anclados ahí, y con z-index alto para que sea lo que hay bajo el puntero (si no,
    // caretRangeFromPoint devuelve el texto de la biblioteca que hay debajo).
    const cont = document.getElementById('pdf-container')!;
    const displayPrevio = cont.style.display;
    cont.style.display = 'block';
    const pag = document.createElement('div');
    pag.className = 'pdf-page';
    pag.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:600px;z-index:99999;background:#fff;';
    pag.innerHTML = '<div class="textLayer" style="position:absolute;inset:0;"></div>';
    cont.appendChild(pag);
    const capa = pag.querySelector('.textLayer') as HTMLElement;
    const poner = (txt: string, top: number) => {
      const s = document.createElement('span');
      s.textContent = txt;
      s.style.cssText = `position:absolute;left:100px;top:${top}px;font:16px/20px serif;white-space:pre;`;
      capa.appendChild(s);
      return s;
    };
    const arriba = poner('bloque de arriba', 40);     // primero en el DOM
    const abajo = poner('parrafo de abajo', 400);     // 340 px más abajo, tras un hueco
    // Punto en el hueco, 30 px POR ENCIMA del párrafo de abajo: mucho más cerca de él que
    // del bloque de arriba (330 px). El navegador, por su cuenta, ancla en el de arriba.
    const x = 110, y = 370;
    const nativo = document.caretRangeFromPoint(x, y);
    const nativoHost = nativo && (nativo.startContainer.nodeType === 1
      ? nativo.startContainer as Element : nativo.startContainer.parentElement);
    const pos = M.cursorEnPunto(x, y, pag);
    const host = pos && (pos.node.nodeType === 1 ? pos.node : pos.node.parentElement);
    const salida = {
      nativo: nativoHost ? nativoHost.textContent : null,
      acotado: host ? host.textContent : null,
      esElDeAbajo: host === abajo,
      esElDeArriba: host === arriba,
    };
    pag.remove();
    cont.style.display = displayPrevio;
    return salida;
  });

  expect(r.esElDeAbajo, `el cursor cayó en "${r.acotado}" (el navegador daba "${r.nativo}")`).toBe(true);
  expect(r.esElDeArriba).toBe(false);
});
