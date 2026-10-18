import { test, expect } from '@playwright/test';
import { seedProLicense } from './pro-license';

// P45 — Análisis navegable: periodos de calendario con flechas, año y «todo», comparación con
// el periodo anterior, filtro por estantería y la historia de un libro. Reloj fijo en el
// domingo 18-oct-2026 para que las semanas y los meses no dependan del día en que se corre.

const NOW = new Date('2026-10-18T12:00:00');

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
});

// Lectura sembrada por el mismo camino que la app: `days` = días hacia atrás, `steps` = vueltas
// de página (96 s cada una: 25 pasos son 40 min).
async function seedReading(page: any, books: { id: string; title: string; days: [number, number][]; shelf?: string }[]) {
  await page.evaluate(async (books: any[]) => {
    const RL: any = await import('/js/reading-log.js');
    const Store: any = await import('/js/library/store.js');
    const DAY = 86400000;
    const now = Date.now();
    for (const b of books) {
      await Store.putBook({ id: b.id, title: b.title, author: 'A', format: 'epub', file: null, size: 10,
        addedAt: now, progress: 40, status: 'reading', shelfIds: b.shelf ? [b.shelf] : [] });
      for (const [ago, steps] of b.days) {
        const t0 = now - ago * DAY - 3600000;
        await RL.startBook(b.id, { unitWords: 205, maxStep: 4 });
        let t = t0;
        for (let k = 0; k < steps; k++) { RL.position(100 + k, t); t += 96000; }
        await RL.endBook(t);
      }
    }
  }, books);
}

test('period: semana de lunes a domingo, mes y año de calendario, y «todo» desde el primer dato', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async () => {
    const A: any = await import('/js/analysis.js');
    const now = Date.now();
    const f = (p: any) => ({ from: new Date(p.from).toDateString(), to: new Date(p.to).toDateString(), days: p.days.length, current: p.current });
    return {
      week: f(A.period('week', 0, now)), lastWeek: f(A.period('week', -1, now)),
      month: f(A.period('month', -1, now)), year: f(A.period('year', 0, now)),
      day: f(A.period('day', -2, now)),
      all: f(A.period('all', 0, now, new Date('2026-10-01T10:00:00').getTime())),
    };
  });
  expect(r.week).toEqual({ from: 'Mon Oct 12 2026', to: 'Mon Oct 19 2026', days: 7, current: true });
  expect(r.lastWeek).toEqual({ from: 'Mon Oct 05 2026', to: 'Mon Oct 12 2026', days: 7, current: false });
  expect(r.month).toEqual({ from: 'Tue Sep 01 2026', to: 'Thu Oct 01 2026', days: 30, current: false });
  expect(r.year.days).toBe(291);                               // 1-ene a 18-oct: el futuro no cuenta
  expect(r.day).toEqual({ from: 'Fri Oct 16 2026', to: 'Sat Oct 17 2026', days: 1, current: false });
  expect(r.all).toEqual({ from: 'Thu Oct 01 2026', to: 'Mon Oct 19 2026', days: 18, current: true });
});

test('flechas: la semana pasada, comparación con la anterior y vuelta a ahora', async ({ page }) => {
  await page.goto('/index.html');
  // Esta semana: 40 min el viernes (hace 2 días). La pasada: 40 + 40 min. La anterior: 40 min.
  await seedReading(page, [{ id: 'bk-a', title: 'Libro A', days: [[2, 25], [8, 25], [9, 25], [15, 25]] }]);
  await page.click('[data-act="analysis"]');
  const a = page.locator('#analysis');
  await expect(a.locator('.anal-nav-l')).toHaveText('Esta semana');
  await expect(a.locator('.anal-hero-n')).toHaveText('40 min');
  // A estas alturas (domingo) la semana pasada iba ya entera: 80 min → −40 min.
  await expect(a.locator('.anal-delta')).toHaveText('−40 min que la semana pasada a estas alturas');
  await expect(a.locator('[data-act="next"]')).toBeDisabled();

  await a.locator('[data-act="prev"]').click();
  await expect(a.locator('.anal-nav-l')).toHaveText('La semana pasada');
  await expect(a.locator('.anal-hero-n')).toHaveText('1 h 20 min');
  await expect(a.locator('.anal-delta')).toHaveText('+40 min que la semana anterior');
  await a.locator('[data-act="prev"]').click();
  await expect(a.locator('.anal-nav-l')).toContainText('28 sept');
  // Más atrás no hay datos: la flecha se apaga.
  await expect(a.locator('[data-act="prev"]')).toBeDisabled();
  await a.locator('[data-act="now"]').click();
  await expect(a.locator('.anal-nav-l')).toHaveText('Esta semana');
});

test('año: una columna por mes, tocar un mes lleva a ese mes', async ({ page }) => {
  await page.goto('/index.html');
  await seedReading(page, [{ id: 'bk-a', title: 'Libro A', days: [[2, 25], [40, 50]] }]);
  await page.click('[data-act="analysis"]');
  const a = page.locator('#analysis');
  await a.locator('[data-range="year"]').click();
  await expect(a.locator('.anal-nav-l')).toHaveText('2026');
  await expect(a.locator('.anal-cols').first().locator('.anal-col')).toHaveCount(12);
  await expect(a.locator('.anal-chart-h').first()).toHaveText('Tiempo leído por mes');
  await expect(a.locator('.anal-books-line')).toHaveText('1 libro empezado · 0 terminados');
  // Septiembre (hace 40 días) tiene 80 min: tocarlo abre septiembre.
  await a.locator('.anal-cols').first().locator('.anal-col').nth(8).click();
  await expect(a.locator('.anal-tab.active')).toHaveText('Mes');
  await expect(a.locator('.anal-nav-l')).toHaveText('Septiembre');
  await expect(a.locator('.anal-hero-n')).toHaveText('1 h 20 min');
});

test('estantería: el selector filtra la pantalla a sus libros', async ({ page }) => {
  await page.goto('/index.html');
  const shelf = await page.evaluate(async () => (await ((await import('/js/library/store.js')) as any).addShelf('Trabajo')).id);
  await seedReading(page, [
    { id: 'bk-a', title: 'Libro de trabajo', days: [[1, 25]], shelf },
    { id: 'bk-b', title: 'Novela', days: [[1, 50]] },
  ]);
  await page.click('[data-act="analysis"]');
  const a = page.locator('#analysis');
  await expect(a.locator('.anal-hero-n')).toHaveText('2 h');
  await a.locator('[data-act="pick"]').click();
  await a.locator(`.anal-pick-item[data-pick="shelf:${shelf}"]`).click();
  await expect(a.locator('.anal-scope-t')).toHaveText('Trabajo');
  await expect(a.locator('.anal-hero-n')).toHaveText('40 min');
  await expect(a.locator('.anal-book')).toHaveCount(1);
  await a.locator('[data-act="all-books"]').click();
  await expect(a.locator('.anal-hero-n')).toHaveText('2 h');
});

test('un libro de principio a fin: resumen, curva de avance y fecha de terminado', async ({ page }) => {
  await page.goto('/index.html');
  await seedReading(page, [{ id: 'bk-a', title: 'Libro A', days: [[20, 25], [10, 25], [3, 25]] }]);
  // Terminarlo hoy: el store sella la fecha al pasar a «terminado».
  const fin = await page.evaluate(async () => {
    const S: any = await import('/js/library/store.js');
    const r = await S.updateBook('bk-a', { status: 'finished', progress: 100 });
    const back = await S.updateBook('bk-a', { status: 'reading' });
    const again = await S.updateBook('bk-a', { status: 'finished' });
    return { stamped: r.finishedAt === Date.now(), cleared: back.finishedAt === null, again: !!again.finishedAt };
  });
  expect(fin).toEqual({ stamped: true, cleared: true, again: true });

  await page.click('[data-act="analysis"]');
  const a = page.locator('#analysis');
  await a.locator('.anal-book', { hasText: 'Libro A' }).click();
  await expect(a.locator('.anal-tab.active')).toHaveText('Todo');
  await expect(a.locator('.anal-nav-l')).toHaveText('Desde el 28 sept 2026');
  await expect(a.locator('.anal-hero-n')).toHaveText('2 h');
  await expect(a.locator('.anal-hero-l')).toHaveText('leyendo · 3 de 21 días');
  await expect(a.locator('.anal-history')).toContainText('a lo largo de 3 semanas');
  await expect(a.locator('.anal-history')).toContainText('terminado en 21 días');
  await expect(a.locator('.anal-curve polyline')).toHaveCount(1);
  await expect(a.locator('.anal-curve')).toContainText('75 pág.');
});

test('los periodos y el selector están traducidos (EN)', async ({ page }) => {
  await page.goto('/index.html');
  await page.evaluate(() => localStorage.setItem('bookreader_lang', 'en'));
  await page.reload();
  await seedReading(page, [{ id: 'bk-a', title: 'Libro A', days: [[2, 25], [8, 25]] }]);
  await page.click('[data-act="analysis"]');
  const a = page.locator('#analysis');
  await expect(a.locator('.anal-nav-l')).toHaveText('This week');
  // Con el selector abierto, tocar fuera lo cierra y la pestaña responde igual.
  await a.locator('[data-act="pick"]').click();
  await expect(a.locator('.anal-pick-menu')).toContainText('Whole library');
  await a.locator('.appset-h2').click();
  await expect(a.locator('.anal-pick-menu')).toHaveCount(0);
  await a.locator('[data-range="year"]').click();
  const txt = await a.innerText();
  expect(txt).toContain('Whole library');
  expect(txt).not.toMatch(/Esta semana|Toda la biblioteca|empezados|Tiempo leído|que la semana/);
});
