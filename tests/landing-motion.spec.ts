import { test, expect } from '@playwright/test';
// P32: la landing cambia de libro (selector y ?para=) y, sin movimiento, se pinta entera y quieta.
const BASE = 'http://localhost:8899';

test.describe('landing · un libro por público', () => {
  test.use({ locale: 'en-US' });

  test('el selector cambia el libro en todas las escenas y deja el enlace en la URL', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE + '/');
    await expect(page.locator('.picker button[data-book="ddia"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.picker button[data-book="fa"]').click();
    await expect(page.locator('.picker button[data-book="fa"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/[?&]para=medicine/);
    await expect(page.locator('#bk-ch')).toHaveText('Cardiovascular · Physiology');
    await expect(page.locator('#proof-mark')).toContainText('bradykinin');
    await expect(page.locator('#deck .face-q').first()).toContainText('ACE inhibitors');
    await expect(page.locator('#spine-mine')).toHaveText('First Aid · Step 1');
    expect(errors).toEqual([]);
  });

  test('?para= abre directamente ese libro, también tras la redirección a /es/', async ({ browser }) => {
    const ctx = await browser.newContext({ locale: 'es-ES' });
    const page = await ctx.newPage();
    await page.goto(BASE + '/?para=certificaciones');
    await expect(page).toHaveURL(BASE + '/es/?para=certificaciones');
    await expect(page.locator('.picker button[data-book="aws"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#bk-q')).toContainText('Standard-IA');
    await ctx.close();
  });

  test('con movimiento reducido todo se ve en su estado final', async ({ browser }) => {
    const ctx = await browser.newContext({ locale: 'en-US', reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto(BASE + '/');
    await expect(page.locator('html')).not.toHaveClass(/motion/);
    await expect(page.locator('#bk-a')).toContainText('one copy of the data');
    await expect(page.locator('#proof')).toHaveClass(/marked/);
    const heroHeight = await page.locator('#hero').evaluate((el) => el.getBoundingClientRect().height);
    expect(heroHeight).toBeLessThan(1400); // sin el recorrido de scroll de 230vh
    await ctx.close();
  });
});
