import { test, expect } from '@playwright/test';

// Estantería pública en el móvil: al deslizar con el dedo los libros SIGUEN al dedo (no saltan al
// soltar) y al soltar se asientan en el libro que queda en el centro. Toques reales por CDP
// (Input.dispatchTouchEvent), como un dedo: el navegador decide qué gesto es scroll y cuál no.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

// Una sola sesión CDP por gesto: con una por evento, el «dedo» se pierde entre llamadas.
async function finger(page) {
  const cdp = await page.context().newCDPSession(page);
  return (type: string, x = 0, y = 0) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
}

test('deslizar con el dedo mueve los libros y al soltar elige el del centro', async ({ page }) => {
  await page.goto('http://localhost:8899/@luis/');
  await expect(page.locator('.pf-bk').first()).toBeVisible();
  await page.waitForTimeout(900);
  const box = (await page.locator('#pf-tape-wrap').boundingBox())!;
  const y = box.y + box.height / 2, x0 = box.x + box.width * 0.75;
  const first = page.locator('.pf-bk').first();
  const before = await first.evaluate(el => el.style.transform);

  const touch = await finger(page);
  await touch('touchStart', x0, y);
  for (let k = 1; k <= 8; k++) await touch('touchMove', x0 - k * 20, y);
  // A mitad del gesto: la cinta ya se ha movido, sin animación.
  await expect(page.locator('#pf-tape')).toHaveClass(/is-dragging/);
  expect(await first.evaluate(el => el.style.transform)).not.toBe(before);
  await touch('touchEnd');

  await expect(page.locator('#pf-tape')).not.toHaveClass(/is-dragging/);
  await expect(page.locator('.pf-bk.is-active')).toHaveCount(1);
  await expect(page.locator('#pf-count b')).toBeVisible();   // «03 / 07»: hay libro elegido
});

test('un toque sin arrastrar sigue eligiendo el libro tocado', async ({ page }) => {
  await page.goto('http://localhost:8899/@luis/');
  await expect(page.locator('.pf-bk').first()).toBeVisible();
  await page.waitForTimeout(900);
  await page.locator('.pf-bk').nth(2).tap();
  await expect(page.locator('.pf-bk').nth(2)).toHaveClass(/is-active/);
});

// Como un rollo de verdad: mientras se arrastra, el libro que llega al centro se va girando poco a
// poco (no salta de canto a abierto al soltar). Y un gesto vertical es scroll de la página.
test('a mitad del arrastre hay un libro a medio girar; el gesto vertical no mueve la cinta', async ({ page }) => {
  await page.goto('http://localhost:8899/@luis/');
  await expect(page.locator('.pf-bk').first()).toBeVisible();
  await page.waitForTimeout(900);
  const box = (await page.locator('#pf-tape-wrap').boundingBox())!;
  const y = box.y + box.height / 2, x0 = box.x + box.width * 0.6;
  const angles = () => page.locator('.pf-bk').evaluateAll(els => els.map(el => Math.abs(+(/rotateY\((-?[\d.]+)deg\)/.exec(el.style.transform) || [0, 0])[1])));

  const v = await finger(page);
  await v('touchStart', x0, y);
  for (let k = 1; k <= 6; k++) await v('touchMove', x0 + 2, y - k * 15);
  await v('touchEnd');
  await expect(page.locator('#pf-tape')).not.toHaveClass(/is-dragging/);
  await expect(page.locator('.pf-bk.is-active')).toHaveCount(0);

  const h = await finger(page);
  await h('touchStart', x0, y);
  let partial = false;
  for (let k = 1; k <= 30 && !partial; k++) {
    await h('touchMove', x0 - k * 6, y);
    await page.waitForTimeout(30);
    partial = (await angles()).some(a => a > 8 && a < 72);
  }
  await h('touchEnd');
  expect(partial).toBe(true);
  await expect(page.locator('.pf-bk.is-active')).toHaveCount(1);
});
