import { test, expect, Page } from '@playwright/test';
import path from 'path';

// Modo scroll + táctil: el resaltado de la selección (capa fixed) debe seguir al texto cuando
// se desplaza el contenedor de epub.js. Antes solo escuchaba el scroll del iframe, que en
// scroll no se mueve, y la selección se quedaba clavada en pantalla.

test.use({ viewport: { width: 390, height: 700 }, hasTouch: true, isMobile: true });
test.describe.configure({ retries: 2 });

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

test('la selección táctil sigue al texto al hacer scroll', async ({ page }) => {
  await abrir(page);
  // Centro en pantalla de la primera palabra larga visible de un párrafo.
  const p = await page.evaluate(() => {
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
          if (y > 120 && y < 450) return { x: fr.left + b.left + b.width / 2, y };
        }
        tn = w.nextNode() as Text | null;
      }
    }
    return null;
  });
  expect(p, 'sin palabra visible').not.toBeNull();
  const cdp = await page.context().newCDPSession(page);
  const pt = [{ x: p!.x, y: p!.y }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt });
  await page.waitForTimeout(700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(500);
  const hi = page.locator('#ts-overlay .ts-hi').first();
  await expect(hi).toBeAttached({ timeout: 5000 });
  const y0 = (await hi.boundingBox())!.y;
  await page.evaluate(() => { (document.querySelector('#epub-container .epub-container') as any).scrollTop += 120; });
  await page.waitForTimeout(500);
  const y1 = (await hi.boundingBox())!.y;
  expect(Math.round(y0 - y1)).toBeGreaterThan(100);   // se fue 120 px arriba junto al texto
});
