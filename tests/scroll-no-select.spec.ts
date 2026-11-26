import { test, expect, Page } from '@playwright/test';
import path from 'path';

// «Leyendo un ePub en modo scroll, al hacer scroll se selecciona texto sin querer.»
// En scroll el iframe del capítulo viaja con el dedo: las coordenadas del toque (espacio del
// iframe) apenas cambian mientras se arrastra, y la pulsación larga de touch-select.js
// saltaba en mitad del scroll en cuanto el «slop» del navegador era menor que su umbral
// (Android 8 dp, iOS ~10 pt). Aquí: el scroll no deja selección, y el gesto deliberado
// (pulsación larga quieta en táctil, arrastre con ratón en escritorio) sigue subrayando.

async function abrir(page: Page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', path.join(__dirname, 'test.epub'));
  await page.waitForSelector('#epub-container iframe', { state: 'attached', timeout: 30000 });
  await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    R.setReadingMode('scroll');
    await new Promise(r => setTimeout(r, 1500));
    const sc: any = document.querySelector('#epub-container .epub-container');
    for (let i = 0; i < 40 && sc.scrollHeight < sc.clientHeight * 3; i++) {
      R.next(); await new Promise(r => setTimeout(r, 700));
    }
  });
}

const seleccion = (page: Page) => page.evaluate(async () => {
  const T: any = await import('/js/touch-select.js');
  const r = T.selectedRange();
  const native = (document.querySelector('#epub-container iframe') as HTMLIFrameElement)
    .contentWindow!.getSelection()!.toString();
  return (r ? r.toString() : '') + native;
});

// Centro en pantalla de una palabra larga visible (para el gesto deliberado).
const palabra = (page: Page) => page.evaluate(() => {
  const ifr = document.querySelector('#epub-container iframe') as HTMLIFrameElement;
  const doc = ifr.contentDocument!;
  const fr = ifr.getBoundingClientRect();
  for (const el of Array.from(doc.querySelectorAll('p'))) {
    const w = doc.createTreeWalker(el, 4); let tn = w.nextNode() as Text | null;
    while (tn) {
      const m = /[A-Za-zÁÉÍÓÚáéíóúñ]{6,}/.exec(tn.data);
      if (m) {
        const r = doc.createRange(); r.setStart(tn, m.index); r.setEnd(tn, m.index + m[0].length);
        const b = r.getBoundingClientRect();
        const y = fr.top + b.top + b.height / 2;
        if (y > 150 && y < 450) return { x: fr.left + b.left + b.width / 2, y, word: m[0] };
      }
      tn = w.nextNode() as Text | null;
    }
  }
  return null;
});

test.describe('táctil', () => {
  test.use({ viewport: { width: 390, height: 700 }, hasTouch: true, isMobile: true });

  test('scroll con «slop» pequeño (Android/iOS) no selecciona', async ({ page }) => {
    await abrir(page);
    // Reproduce lo que ve el lector en un móvil: el dedo se mueve 8 px, arranca el scroll y
    // desde ahí el contenido (y el iframe) siguen al dedo, así que en coordenadas del iframe
    // el toque se queda a 8 px del inicio durante todo el arrastre.
    await page.evaluate(async () => {
      const ifr = document.querySelector('#epub-container iframe') as HTMLIFrameElement;
      const doc = ifr.contentDocument!, win = doc.defaultView as any;
      const sc = document.querySelector('#epub-container .epub-container') as HTMLElement;
      const touch = (y: number) => new win.Touch({ identifier: 1, target: doc.body, clientX: 200, clientY: y });
      const fire = (type: string, y: number) => {
        const t = touch(y);
        doc.body.dispatchEvent(new win.TouchEvent(type, {
          bubbles: true, cancelable: true,
          touches: type === 'touchend' ? [] : [t], changedTouches: [t],
        }));
      };
      const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
      fire('touchstart', 500);
      await sleep(30);
      fire('touchmove', 492);
      for (let i = 0; i < 20; i++) {     // ~700 ms de arrastre, por encima de la pulsación larga
        sc.scrollTop += 10;
        fire('touchmove', 492);
        await sleep(35);
      }
      fire('touchend', 492);
    });
    await page.waitForTimeout(300);
    expect(await seleccion(page)).toBe('');
    await expect(page.locator('#ts-overlay .ts-hi')).toHaveCount(0);
  });

  test('arrastre real de scroll (CDP) no selecciona', async ({ page }) => {
    await abrir(page);
    const sc = page.locator('#epub-container .epub-container');
    const top0 = await sc.evaluate((e: any) => e.scrollTop);
    const cdp = await page.context().newCDPSession(page);
    let y = 500;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y }] });
    for (let i = 0; i < 30; i++) {
      y -= 8;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y }] });
      await page.waitForTimeout(40);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(400);
    expect(await sc.evaluate((e: any) => e.scrollTop)).toBeGreaterThan(top0 + 100);
    expect(await seleccion(page)).toBe('');
  });

  test('el dedo que frena la inercia no selecciona', async ({ page }) => {
    await abrir(page);
    const p = await palabra(page);
    expect(p, 'sin palabra visible').not.toBeNull();
    const cdp = await page.context().newCDPSession(page);
    // El contenido aún se está desplazando cuando el dedo se posa y se queda quieto.
    await page.evaluate(() => {
      const sc = document.querySelector('#epub-container .epub-container') as HTMLElement;
      let n = 0; const id = setInterval(() => { sc.scrollTop += 1; if (++n > 3) clearInterval(id); }, 16);
    });
    await page.waitForTimeout(30);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p!.x, y: p!.y }] });
    await page.waitForTimeout(700);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(300);
    expect(await seleccion(page)).toBe('');
  });

  test('pulsación larga quieta sí selecciona y el subrayado se guarda', async ({ page }) => {
    await abrir(page);
    await page.waitForTimeout(400);   // sin inercia pendiente de la carga
    const p = await palabra(page);
    expect(p, 'sin palabra visible').not.toBeNull();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p!.x, y: p!.y }] });
    await page.waitForTimeout(700);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.locator('#ts-overlay .ts-hi').first()).toBeAttached({ timeout: 5000 });
    expect(await seleccion(page)).toBe(p!.word);
    await expect(page.locator('#highlight-tooltip')).toBeVisible();
    await page.locator('#sel-mark').tap();
    await expect.poll(() => page.evaluate(async () => {
      const H: any = await import('/js/highlights.js');
      return H.getAll().map((h: any) => h.text);
    })).toEqual([p!.word]);
  });
});

test.describe('escritorio', () => {
  test.use({ viewport: { width: 1200, height: 800 } });

  test('la rueda no selecciona; arrastrar con el ratón sí, y se guarda', async ({ page }) => {
    await abrir(page);
    const sc = page.locator('#epub-container .epub-container');
    const top0 = await sc.evaluate((e: any) => e.scrollTop);
    await page.mouse.move(600, 400);
    for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(60); }
    await page.waitForTimeout(400);
    expect(await sc.evaluate((e: any) => e.scrollTop)).toBeGreaterThan(top0);
    expect(await seleccion(page)).toBe('');

    const p = await palabra(page);
    expect(p, 'sin palabra visible').not.toBeNull();
    await page.mouse.dblclick(p!.x, p!.y);
    await expect(page.locator('#highlight-tooltip')).toBeVisible({ timeout: 5000 });
    expect((await seleccion(page)).trim()).toBe(p!.word);
    await page.locator('#sel-mark').click();
    await expect.poll(() => page.evaluate(async () => {
      const H: any = await import('/js/highlights.js');
      return H.getAll().map((h: any) => h.text);
    })).toEqual([p!.word]);
  });
});
