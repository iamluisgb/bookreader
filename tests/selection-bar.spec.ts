// P38 · Barra de selección compacta: una fila con lo de un toque y el resto en ⋯ (dos líneas:
// qué haces · qué recibes). Lo que se comprueba aquí es la COMPOSICIÓN (qué va en la fila y
// qué en el menú, según lo seleccionado y el ancho) y los gestos nuevos: subrayar de un toque
// con el último color, escribir para preguntar y Escape. Los modos del agente de cada enfoque
// están en numeric-example.spec.ts; la edición de un subrayado, en highlight-edit.spec.ts.
import { test, expect, Page } from '@playwright/test';
import path from 'path';

const EPUB = path.join(__dirname, 'test.epub');
const PDF = path.join(__dirname, 'test-multipage.pdf');

async function openEpub(page: Page) {
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', EPUB);
  await page.waitForFunction(() => !!document.querySelector('#toc-list a'), null, { timeout: 30000 });
}

// Selecciona `chars` caracteres de un párrafo con prosa (o una sola palabra con `word`). El
// gesto se repite hasta que la barra aparece: epub.js emite `selected` con debounce.
async function selectInEpub(page: Page, { word = false } = {}) {
  const gesto = () => page.evaluate(async (soloPalabra) => {
    const doc = (document.querySelector('#epub-container iframe') as HTMLIFrameElement)?.contentDocument;
    const p = doc?.body && [...doc.body.querySelectorAll('p')].find(el => (el.textContent || '').trim().length > 80);
    if (!p) { try { await (await import('/js/epub-reader.js') as any).next(); } catch { /* cargando */ } return; }
    const w = doc.createTreeWalker(p, 4);
    let tn = w.nextNode() as Text | null;
    while (tn && tn.length < 30) tn = w.nextNode() as Text | null;
    if (!tn) return;
    const range = doc.createRange();
    if (soloPalabra) {
      const m = /[A-Za-zÁÉÍÓÚáéíóúñÑ]{5,}/.exec(tn.data)!;
      range.setStart(tn, m.index); range.setEnd(tn, m.index + m[0].length);
    } else {
      range.setStart(tn, 0); range.setEnd(tn, Math.min(tn.length, 70));
    }
    const sel = doc.defaultView!.getSelection()!;
    sel.removeAllRanges(); sel.addRange(range);
    doc.dispatchEvent(new Event('selectionchange', { bubbles: true }));
    doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, word);
  await expect.poll(async () => {
    if (await page.locator('#highlight-tooltip').isVisible()) return true;
    await gesto();
    return false;
  }, { timeout: 30000 }).toBe(true);
  // Que no llegue un `selected` rezagado del gesto repetido a mitad del test.
  await page.waitForTimeout(500);
}

const slotIds = (page: Page) => page.$$eval('#sel-slot > [data-quick]', els => els.map(e => e.id));

test('escritorio: una fila con Explícame y Por qué importa; el resto, en ⋯ con su segunda línea', async ({ page }) => {
  await openEpub(page);
  await selectInEpub(page);

  expect(await slotIds(page)).toEqual(['sel-explain', 'sel-why']);
  // La fila cabe sin envolver y sin recortar.
  const fit = await page.$eval('#sel-row', r => r.scrollWidth <= r.clientWidth + 1);
  expect(fit).toBe(true);
  await expect(page.locator('#sel-menu')).toBeHidden();
  await expect(page.locator('#sel-define')).toBeHidden();

  await page.locator('#sel-more').click();
  await expect(page.locator('#sel-menu')).toBeVisible();
  await expect(page.locator('#sel-more')).toHaveAttribute('aria-expanded', 'true');
  // Entero dentro de la pantalla (si no cabe, hace scroll; nunca se sale).
  const m = await page.$eval('#sel-menu', el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, vh: innerHeight }; });
  expect(m.top).toBeGreaterThanOrEqual(0);
  expect(m.bottom).toBeLessThanOrEqual(m.vh);
  for (const id of ['sel-define', 'sel-related', 'sel-counter', 'sel-card', 'sel-notebook', 'sel-copy', 'sel-share']) {
    await expect(page.locator(`#sel-menu #${id}`)).toBeVisible();
  }
  // Dos líneas: lo que haces y lo que vas a recibir.
  await expect(page.locator('#sel-related .sel-sub')).toHaveText('Otros pasajes del libro sobre esto');
  // Lo que ya está en la fila no se repite en el menú.
  await expect(page.locator('#sel-menu #sel-explain')).toHaveCount(0);

  // Escape cierra primero el menú y después la barra.
  await page.keyboard.press('Escape');
  await expect(page.locator('#sel-menu')).toBeHidden();
  await expect(page.locator('#highlight-tooltip')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#highlight-tooltip')).toBeHidden();
});

test('una palabra suelta: «Qué significa aquí» pasa a la fila', async ({ page }) => {
  await openEpub(page);
  await selectInEpub(page, { word: true });
  expect((await slotIds(page))[0]).toBe('sel-define');
  // En la fila va la etiqueta corta; en el menú, la completa.
  await expect(page.locator('#sel-define .sel-lbl')).toHaveText('Qué significa');
});

test('subrayar es un toque con el último color usado', async ({ page }) => {
  await openEpub(page);
  await selectInEpub(page);
  // Primera vez: amarillo. Pasar por encima del subrayador enseña los colores, y elegir
  // verde lo deja como el de un toque.
  await expect(page.locator('#sel-palette')).toBeHidden();
  await page.locator('#sel-mark').hover();
  await expect(page.locator('#sel-palette')).toBeVisible();
  // En escritorio los colores están en la paleta, no repetidos en el menú.
  await expect(page.locator('#sel-colors')).toBeHidden();
  await page.locator('#sel-palette .highlight-color[data-color="#81c784"]').click();
  await expect(page.locator('#highlight-tooltip')).toBeHidden();

  // Otro pasaje (una palabra suelta): uno con el mismo CFI se reutilizaría.
  await selectInEpub(page, { word: true });
  await page.locator('#sel-mark').hover();
  await expect(page.locator('#sel-palette')).toBeVisible();
  await page.locator('#sel-ask').hover();
  await expect(page.locator('#sel-palette')).toBeHidden();
  const dot = await page.$eval('#sel-mark .sel-mark-dot', d => getComputedStyle(d).backgroundColor);
  expect(dot).toBe('rgb(129, 199, 132)');
  await page.locator('#sel-mark').click();
  const colors = await page.evaluate(async () => {
    const H: any = await import('/js/highlights.js');
    return H.getAll().map((h: any) => h.color);
  });
  expect(colors).toEqual(['#81c784', '#81c784']);
});

test('escribir con algo seleccionado abre el chat con el fragmento y lo tecleado', async ({ page }) => {
  test.setTimeout(90000);
  await page.addInitScript(() => {
    localStorage.setItem('bookreader_ai_key', JSON.stringify('sk-test'));
    localStorage.setItem('bookreader_ai_base_url', JSON.stringify('https://stub.invalid/v1'));
  });
  await openEpub(page);
  await page.locator('#ai-toggle').click();
  await page.locator('.ai-ob-quickchat').click().catch(() => { /* ya hay conversación */ });
  await expect(page.locator('#ai-status')).toContainText(/Listo para preguntar/, { timeout: 30000 });

  await selectInEpub(page);
  // El foco está en el texto (donde se seleccionó), no en el composer.
  await page.evaluate(() => (document.querySelector('#epub-container iframe') as HTMLIFrameElement).contentWindow!.focus());
  await page.keyboard.type('por que vuelve');
  await expect(page.locator('#highlight-tooltip')).toBeHidden();
  await expect(page.locator('#ai-ref')).toBeVisible();
  await expect(page.locator('#ai-ref-text')).not.toBeEmpty();
  // Ninguna letra se pierde mientras el panel toma el foco.
  await expect(page.locator('#ai-input')).toHaveValue('por que vuelve');
  await expect(page.locator('#ai-input')).toBeFocused();
});

test.describe('móvil', () => {
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });

  test('la barra va fija abajo, a lo ancho, y su fila cabe', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('#file-input', PDF);
    await expect(page.locator('#pdf-container .textLayer span').first()).toBeAttached({ timeout: 20000 });
    await page.waitForTimeout(1500);
    // Pulsación larga sobre una línea visible en la mitad de arriba (no la taparía la barra).
    const p = await page.evaluate(() => {
      const s = ([...document.querySelectorAll('#pdf-container .textLayer span')] as HTMLElement[])
        .find(e => { const r = e.getBoundingClientRect(); return e.textContent!.length > 20 && r.top > 80 && r.bottom < 400; })!;
      const r = s.getBoundingClientRect();
      return { x: r.left + 20, y: r.top + r.height / 2, x2: r.right - 10 };
    });
    await page.evaluate(async ({ x, y, x2 }) => {
      const cont = document.getElementById('pdf-container')!;
      const toque = (tipo: string, cx: number) => {
        const t = new Touch({ identifier: 1, target: cont, clientX: cx, clientY: y });
        cont.dispatchEvent(new TouchEvent(tipo, { bubbles: true, cancelable: true,
          touches: tipo === 'touchend' ? [] : [t], changedTouches: [t], targetTouches: tipo === 'touchend' ? [] : [t] }));
      };
      toque('touchstart', x);
      await new Promise(r => setTimeout(r, 500));
      for (let k = 1; k <= 4; k++) { toque('touchmove', x + ((x2 - x) * k) / 4); await new Promise(r => setTimeout(r, 25)); }
      toque('touchend', x2);
    }, p);
    const tt = page.locator('#highlight-tooltip');
    await expect(tt).toBeVisible();
    await expect(tt).toHaveClass(/is-docked/);
    const geo = await page.evaluate(() => {
      const r = document.getElementById('highlight-tooltip')!.getBoundingClientRect();
      const row = document.getElementById('sel-row')!;
      return { left: r.left, right: r.right, bottom: r.bottom, vw: innerWidth, vh: innerHeight, fits: row.scrollWidth <= row.clientWidth + 1 };
    });
    expect(geo.bottom).toBeGreaterThan(geo.vh - 30);
    expect(geo.left).toBeLessThan(12);
    expect(geo.right).toBeGreaterThan(geo.vw - 12);
    expect(geo.fits).toBe(true);
    // Cabe al menos Preguntar + una acción del agente.
    expect((await slotIds(page)).length).toBeGreaterThanOrEqual(1);

    // El menú se abre hacia arriba, entero dentro de la pantalla, con los colores al alcance.
    await page.locator('#sel-more').click();
    const m = await page.$eval('#sel-menu', el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, sh: el.scrollHeight, ch: el.clientHeight }; });
    expect(m.top).toBeGreaterThanOrEqual(0);
    expect(m.bottom).toBeLessThanOrEqual(geo.vh);
    expect(m.sh).toBeLessThanOrEqual(m.ch + 1);
    await expect(page.locator('#sel-menu .highlight-color').first()).toBeVisible();
    await expect(page.locator('#sel-palette .highlight-color')).toHaveCount(0);
  });
});
