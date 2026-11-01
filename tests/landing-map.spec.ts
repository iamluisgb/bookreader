import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
// Landing (plan savvia, 30-oct-2026): «Everything in the box» es un diagrama cuyas salidas
// enseñan su mini-demo; la pregunta con opciones explica cada opción; y el
// manifiesto existe en los dos idiomas.
const BASE = 'http://localhost:8899';

test.describe('landing · diagrama, práctica y manifiesto', () => {
  test.use({ locale: 'en-US' });

  test('cada salida del diagrama enseña su demo y solo la suya', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE + '/');
    await page.locator('#bmap').scrollIntoViewIfNeeded();
    await expect(page.locator('.bmap-demo[data-demo="explain"]')).toBeVisible();
    for (const k of ['zone', 'feynman', 'export']) {
      await page.locator(`.bmap-out button[data-demo="${k}"]`).click();
      await expect(page.locator(`.bmap-out button[data-demo="${k}"]`)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator(`.bmap-demo[data-demo="${k}"]`)).toBeVisible();
      await expect(page.locator('.bmap-demo:visible')).toHaveCount(1);
    }
    // las líneas: una por entrada y una por salida
    await expect(page.locator('.bmap-lines path')).toHaveCount(4 + 5);
    expect(errors).toEqual([]);
  });

  test('la pregunta con opciones: al elegir una, todas explican su porqué y sale la cita', async ({ page }) => {
    await page.goto(BASE + '/');
    const quiz = page.locator('#quiz .quiz');
    await quiz.scrollIntoViewIfNeeded();
    await expect(quiz.locator('.quiz-why').first()).toBeHidden();
    await expect(quiz.locator('.quiz-cite')).toBeHidden();
    await quiz.locator('.quiz-opt[data-ok="0"]').first().click();
    await expect(quiz).toHaveClass(/done/);
    await expect(quiz.locator('.quiz-why:visible')).toHaveCount(4);
    await expect(quiz.locator('.quiz-cite')).toBeVisible();
    await expect(quiz.locator('.quiz-opt[aria-pressed="true"]')).toHaveCount(1);
  });

  test('sin movimiento, las barras de memoria se ven llenas', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(BASE + '/es/?lang=es');
    const w = await page.locator('#quiz .mem-bar i').first().evaluate((el) => el.getBoundingClientRect().width);
    expect(w).toBeGreaterThan(20);
    await expect(page.locator('#quiz .quiz-opt')).toHaveCount(4);
  });

  test('el manifiesto existe en inglés y en español, enlazado desde la portada', async ({ page }) => {
    await page.goto(BASE + '/');
    await expect(page.locator('footer a[href="why/"]')).toHaveCount(1);
    await page.goto(BASE + '/why/');
    await expect(page.locator('h1')).toHaveText('What you read should stay with you.');
    await page.goto(BASE + '/es/por-que/');
    await expect(page.locator('h1')).toHaveText('Lo que lees debería quedarse contigo.');
  });
});

test.describe('landing · en el móvil', () => {
  test.use({ locale: 'es-ES', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('la tarjeta de arriba del mazo gira con un toque (una de detrás no se queda el toque)', async ({ page }) => {
    await page.goto(BASE + '/es/?lang=es');
    await page.locator('#deck').scrollIntoViewIfNeeded();
    const top = page.locator('.fcard[aria-hidden="false"]');
    await top.tap();
    await expect(top).toHaveClass(/flip/);
  });
});

// El HTML se sirve sin caché y los JS/CSS de la landing con 4 h: sin versión en la URL, un
// móvil juntaba HTML nuevo con motion.js viejo, que se rompía y dejaba el mazo sin girar.
test('los JS y CSS de la landing llevan ?v= en todas las páginas públicas', () => {
  const bad: string[] = [];
  for (const f of ['index.html', 'es/index.html', 'why/index.html', 'es/por-que/index.html']) {
    const src = readFileSync(join(process.cwd(), f), 'utf8');
    for (const m of src.matchAll(/assets\/landing\/[\w-]+\.(?:js|css)(\?v=\w+)?/g)) if (!m[1]) bad.push(`${f}: ${m[0]}`);
  }
  expect(bad, 'Añade ?v= (y súbelo al cambiar el fichero):\n' + bad.join('\n')).toEqual([]);
});
