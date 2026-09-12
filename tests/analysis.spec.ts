import { test, expect } from '@playwright/test';

// P25 F2 — la pantalla de Análisis. Los datos se siembran por el mismo camino que los
// escribe la app (reading-log con reloj inyectado), no escribiendo IndexedDB a mano: así
// el test también cubre que lo sembrado sea lo que el contador habría contado.

async function seed(page: any) {
  await page.evaluate(async () => {
    const RL: any = await import('/js/reading-log.js');
    const Store: any = await import('/js/library/store.js');
    const H: any = await import('/js/highlights.js');
    const DAY = 86400000;
    const now = Date.now();
    const books = [
      // `steps` = vueltas de página de cada día. Cada paso avanza una unidad en 96 s
      // (~128 wpm: lectura de manual), así que 50 pasos son 80 min y 25 son 40.
      { id: 'bk-aa', title: 'El infinito en un junco', steps: [15, 0, 10, 0, 20, 0, 5] },
      { id: 'bk-bb', title: 'Data-Intensive Applications', steps: [0, 0, 0, 25, 0, 0, 0] },
    ];
    for (const b of books) {
      await Store.putBook({ id: b.id, title: b.title, author: 'Autor', format: 'epub', file: null,
        size: 10, addedAt: now, progress: 10, status: 'reading', shelfIds: [] });
      for (let i = 0; i < b.steps.length; i++) {
        if (!b.steps[i]) continue;
        const day = now - (b.steps.length - 1 - i) * DAY;
        await RL.startBook(b.id, { unitWords: 205, maxStep: 4 });
        let t = day;
        for (let k = 0; k < b.steps[i]; k++) { RL.position(100 + k, t); t += 96000; }
        await RL.endBook(t);   // el tramo abierto al cerrar vale por un paso más
      }
    }
    H.setBook('bk-aa');
    H.add('epubcfi(/6/4!/4/1)', 'Un pasaje', 'yellow');
    H.add('epubcfi(/6/4!/4/2)', 'Otro pasaje', 'yellow');
  });
}

test('collect: junta lectura, subrayados y libros del periodo', async ({ page }) => {
  await page.goto('/');
  await seed(page);
  const d: any = await page.evaluate(async () => {
    const A: any = await import('/js/analysis.js');
    const x = await A.collect(7);
    return { ms: x.ms, units: x.units, activeDays: x.activeDays, series: x.series.length,
             highlights: x.highlights, books: x.books.map((b: any) => [b.title, b.ms]) };
  });

  // 80 min en 'bk-aa' (50 pasos) y 40 en 'bk-bb' (25); el desglose va por TIEMPO.
  expect(d.ms).toBe(120 * 60000);
  expect(d.activeDays).toBe(5);
  expect(d.series).toBe(7);               // la serie trae los días a cero también
  expect(d.highlights).toBe(2);
  expect(d.books[0][0]).toBe('El infinito en un junco');
  expect(d.books[0][1]).toBe(80 * 60000);
  expect(d.books[1][1]).toBe(40 * 60000);
});

test('la pantalla enseña la cifra, el desglose y una columna por día', async ({ page }) => {
  await page.goto('/');
  await seed(page);
  await page.click('[data-act="analysis"]');
  await expect(page.locator('.anal-hero-n')).toHaveText('2 h');
  await expect(page.locator('.anal-col')).toHaveCount(7);
  // Los días sin lectura se quedan VACÍOS (no hay barra que los disimule).
  await expect(page.locator('.anal-col-fill')).toHaveCount(5);
  await expect(page.locator('.anal-book')).toHaveCount(2);
  await expect(page.locator('.anal-book').first()).toContainText('El infinito en un junco');

  // El rango cambia la ventana: en "Mes" hay 30 columnas y la cifra no baja.
  await page.click('[data-range="month"]');
  await expect(page.locator('.anal-col')).toHaveCount(30);
  await expect(page.locator('.anal-hero-n')).toHaveText('2 h');
});

test('sin lectura validada no se pinta un cero: se explica qué cuenta', async ({ page }) => {
  await page.goto('/');
  await page.click('[data-act="analysis"]');
  await expect(page.locator('.anal-empty')).toBeVisible();
  await expect(page.locator('.anal-hero-n')).toHaveCount(0);
  await expect(page.locator('.anal-empty-p')).toContainText('ritmo humano');
});

test('rastrear un libro no aparece como lectura en la pantalla', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const RL: any = await import('/js/reading-log.js');
    const now = Date.now();
    await RL.startBook('bk-cc', { unitWords: 205, maxStep: 4 });
    // Diez saltos por el capítulo, unos segundos en cada sitio: buscar, no leer.
    for (let i = 0; i < 10; i++) { RL.markJump(); RL.position(300 + i * 7, now + i * 8000); }
    await RL.endBook(now + 80000);
  });
  await page.click('[data-act="analysis"]');
  await expect(page.locator('.anal-empty')).toBeVisible();
});

test('la pantalla está traducida (EN)', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('bookreader_lang', 'en'));
  await seed(page);
  await page.reload();
  await page.click('[data-act="analysis"]');
  await expect(page.locator('.anal-hero-l')).toContainText('reading');
  await expect(page.locator('.anal-chart-h').first()).toHaveText('Time read per day');
  const txt = await page.locator('#analysis').innerText();
  expect(txt).not.toMatch(/leyendo|pág\.|Subrayados|Semana/);
});
