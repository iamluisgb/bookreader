import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

// Ritmo de lectura (Análisis): área apilada por libro con media de 7 días, sobre el MISMO
// registro de lectura que el resto de la pantalla y que `reading_stats` del MCP. Los registros
// se siembran con `importDays`, el camino por el que llegan los de otros dispositivos.

const EPUB_PATH = path.join(__dirname, 'test.epub');
const NOW = '2026-10-18T12:00:00';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
});

// ---- Unidad: la agregación, el suavizado y «Otros» -------------------------------------

test('trailingMean: media de 7 días hacia atrás, con los días previos al rango', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const R: any = await import('/js/reading-rhythm.js');
    return {
      flat: R.trailingMean([7, 0, 0, 0, 0, 0, 0, 0]),
      lead: R.trailingMean([0, 0], 7, [7, 7, 7, 7, 7, 7]),
      nice: [R.niceMax(0), R.niceMax(7), R.niceMax(23), R.niceMax(160), R.niceMax(115)],
    };
  });
  // Un día de 7 min se reparte en siete puntos de 1 y desaparece al octavo.
  expect(r.flat).toEqual([1, 1, 1, 1, 1, 1, 1, 0]);
  // El primer día del rango no arranca de cero: arrastra lo leído justo antes.
  expect(r.lead).toEqual([6, 5]);
  expect(r.nice).toEqual([1, 8, 25, 200, 150]);
});

test('rhythm: suma por libro y día, minutos o páginas, y los sin título van a «Otros»', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const R: any = await import('/js/reading-rhythm.js');
    const M = 60000;
    const records = [
      // Dos dispositivos el mismo día: se suman. `alias-a` es el mismo libro que `a`.
      { day: '2026-10-18', books: { a: { ms: 10 * M, words: 3000 }, b: { ms: 5 * M, words: 600 } } },
      { day: '2026-10-18', books: { 'alias-a': { ms: 20 * M, words: 3000 }, gone: { ms: 4 * M, words: 300 } } },
      { day: '2026-10-17', books: { c: { ms: 8 * M, words: 900 }, a: { ms: 0, words: 0 } } },
      // Fuera del rango de 30 días: no cuenta en «30d», sí en «all».
      { day: '2026-08-01', books: { d: { ms: 60 * M, words: 9000 } } },
      // Futuro (reloj de otro dispositivo adelantado): fuera.
      { day: '2026-10-19', books: { a: { ms: 99 * M, words: 1 } } },
    ];
    const titles: any = { a: 'Libro A', b: 'Libro B', c: 'Libro C', d: 'Libro D' };
    const opts = (o: any) => ({ now: Date.now(), cid: (id: string) => (id === 'alias-a' ? 'a' : id),
      titleOf: (id: string) => titles[id] || null, ...o });
    const min = R.rhythm(records, opts({ range: '30d', unit: 'min' }));
    const pages = R.rhythm(records, opts({ range: '30d', unit: 'pages' }));
    const all = R.rhythm(records, opts({ range: 'all', unit: 'min' }));
    const pick = (x: any) => x.layers.map((l: any) => [l.title, l.other, l.count, Math.round(l.total * 100) / 100]);
    return {
      days: min.days.length, from: min.from, to: min.to,
      layers: pick(min), daily: min.daily.slice(-2), total: min.total, daysRead: min.daysRead,
      pages: pick(pages), pagesTotal: pages.total,
      allDays: all.days.length, allFirst: all.layers[0].title,
    };
  });
  expect(r.days).toBe(30);
  expect(r.to).toBe('2026-10-18');
  expect(r.from).toBe('2026-09-19');
  // Ningún «null» en la leyenda: el libro borrado va a «Otros», y con él la capa existe aunque
  // los libros con título quepan.
  expect(r.layers).toEqual([
    ['Libro A', false, 1, 30],
    ['Libro C', false, 1, 8],
    ['Libro B', false, 1, 5],
    [null, true, 1, 4],
  ]);
  expect(r.daily).toEqual([8, 39]);
  expect(r.total).toBe(47);
  expect(r.daysRead).toBe(2);
  // En páginas el orden es por palabras/300 (A = 6000/300 = 20).
  expect(r.pages).toEqual([
    ['Libro A', false, 1, 20],
    ['Libro C', false, 1, 3],
    ['Libro B', false, 1, 2],
    [null, true, 1, 1],
  ]);
  expect(r.pagesTotal).toBe(26);
  // «Todo» empieza en el primer día con lectura y ahí D (60 min) ya es el primero.
  expect(r.allDays).toBe(79);
  expect(r.allFirst).toBe('Libro D');
});

test('rhythm: con más de cinco libros, cuatro con color y el resto en «Otros (N libros)»', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const R: any = await import('/js/reading-rhythm.js');
    const books: any = {};
    for (let i = 1; i <= 7; i++) books['b' + i] = { ms: i * 60000, words: i * 100 };
    const five: any = {};
    for (let i = 1; i <= 5; i++) five['b' + i] = { ms: i * 60000, words: i * 100 };
    const titleOf = (id: string) => 'T' + id;
    const many = R.rhythm([{ day: '2026-10-18', books }], { now: Date.now(), titleOf });
    const exact = R.rhythm([{ day: '2026-10-18', books: five }], { now: Date.now(), titleOf });
    const layerSum = many.layers.reduce((n: number, l: any) => n + l.total, 0);
    return {
      many: many.layers.map((l: any) => [l.title, l.color, l.count, l.total]),
      exact: exact.layers.map((l: any) => [l.title, l.color]),
      layerSum, total: many.total,
    };
  });
  expect(r.many).toEqual([
    ['Tb7', 1, 1, 7], ['Tb6', 2, 1, 6], ['Tb5', 3, 1, 5], ['Tb4', 4, 1, 4],
    [null, 'other', 3, 6],
  ]);
  // Exactamente cinco con título: caben todos, sin «Otros».
  expect(r.exact).toEqual([['Tb5', 1], ['Tb4', 2], ['Tb3', 3], ['Tb2', 4], ['Tb1', 5]]);
  expect(r.layerSum).toBe(r.total);
});

// ---- Pantalla ---------------------------------------------------------------------------

async function seedRecords(page: any, extra: Record<string, any> = {}) {
  await page.evaluate(async (extra: any) => {
    const RL: any = await import('/js/reading-log.js');
    const Store: any = await import('/js/library/store.js');
    const DAY = 86400000;
    const M = 60000;
    const now = Date.now();
    const titles: any = {
      'bk-1': 'Designing Data-Intensive Applications', 'bk-2': 'El pez en el agua',
      'bk-3': 'Site Reliability Engineering', 'bk-4': 'La ciudad y los perros', 'bk-5': 'Rayuela',
      'bk-6': 'Pedro Páramo',
    };
    for (const [id, title] of Object.entries(titles)) {
      await Store.putBook({ id, title, author: 'Autor', format: 'epub', file: null, size: 10,
        addedAt: now, progress: 10, status: 'reading', shelfIds: [] });
    }
    const list: any[] = [];
    for (let i = 0; i < 40; i++) {
      const day = RL.dayKey(now - i * DAY);
      const books: any = {};
      if (i % 2 === 0) books['bk-1'] = { ms: 30 * M, words: 6000, units: 20 };
      if (i % 3 === 0) books['bk-2'] = { ms: 20 * M, words: 5000, units: 15 };
      if (i < 10) books['bk-3'] = { ms: 10 * M, words: 2500, units: 8 };
      if (i === 4) books['bk-4'] = { ms: 6 * M, words: 1200, units: 4 };
      if (i === 5) books['bk-5'] = { ms: 5 * M, words: 1000, units: 3 };
      if (i === 6) books['bk-6'] = { ms: 4 * M, words: 900, units: 3 };
      if (i === 7) books['sha-borrado'] = { ms: 3 * M, words: 600, units: 2 };
      Object.assign(books, extra[i] || {});
      if (Object.keys(books).length) list.push({ key: `${day}|otro`, day, deviceId: 'otro', updatedAt: 1, books });
    }
    await RL.importDays(list);
  }, extra);
}

test('la pantalla pinta capas, barras, leyenda con «Otros» y cambia unidad y rango', async ({ page }) => {
  await page.goto('/');
  await seedRecords(page);
  await page.click('[data-act="analysis"]');
  const sec = page.locator('.anal-rhythm');
  await expect(sec.locator('.anal-sec-h')).toHaveText('Ritmo de lectura');
  // 30 días: bk-1 15 días × 30 = 450 min, bk-2 10 × 20 = 200, bk-3 10 × 10 = 100, bk-4 6;
  // «Otros» = bk-5 + bk-6 + el libro borrado = 12 min.
  await expect(sec.locator('.anal-rhythm-key')).toHaveCount(5);
  await expect(sec.locator('.anal-rhythm-name').first()).toHaveText('Designing Data-Intensive Applications');
  await expect(sec.locator('.anal-rhythm-v').first()).toHaveText('7 h 30 min');
  await expect(sec.locator('.anal-rhythm-key.is-other')).toContainText('Otros (3 libros)');
  await expect(sec.locator('.anal-rhythm-key.is-other')).toContainText('12 min');
  // Nunca un id ni un «null» en la leyenda.
  await expect(sec).not.toContainText('null');
  await expect(sec).not.toContainText('sha-borrado');
  await expect(sec.locator('.anal-rhythm-sum')).toContainText('23 días leídos');
  await expect(sec.locator('polygon')).toHaveCount(5);
  await expect(sec.locator('polygon[data-open-book]')).toHaveCount(4);
  await expect(sec.locator('.anal-rhythm-bar')).toHaveCount(23);

  // Páginas: estimadas y rotuladas como tales.
  await sec.locator('[data-runit="pages"]').click();
  await expect(sec.locator('[data-runit="pages"]')).toHaveClass(/active/);
  await expect(sec.locator('.anal-rhythm-v').first()).toHaveText('≈300 pág.');
  await expect(sec.locator('.anal-rhythm-note')).toContainText('Páginas estimadas a 300 palabras');

  // 90 días: entran los días 30-39 (bk-1 los pares, bk-2 los múltiplos de 3: siete más).
  await sec.locator('[data-rrange="90d"]').click();
  await expect(sec.locator('.anal-rhythm-bar')).toHaveCount(30);
  await expect(sec.locator('.anal-rhythm-sum')).toContainText('30 días leídos');
  await sec.locator('[data-rrange="all"]').click();
  await expect(sec.locator('[data-rrange="all"]')).toHaveClass(/active/);
  await expect(sec.locator('.anal-rhythm-bar')).toHaveCount(30);
});

test('móvil: sin scroll horizontal y la leyenda cabe', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/');
  await seedRecords(page);
  // En ancho de teléfono Análisis vive en el menú «Más»: se abre por su módulo.
  await page.evaluate(async () => { const A: any = await import('/js/analysis.js'); await A.open(); });
  await expect(page.locator('.anal-rhythm polygon')).toHaveCount(5);
  const over = await page.evaluate(() => {
    const card = document.querySelector('.anal-card') as HTMLElement;
    const sec = document.querySelector('.anal-rhythm') as HTMLElement;
    return {
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      card: card.scrollWidth - card.clientWidth,
      sec: sec.getBoundingClientRect().right - card.getBoundingClientRect().right,
    };
  });
  expect(over.doc).toBeLessThanOrEqual(0);
  expect(over.card).toBeLessThanOrEqual(0);
  expect(over.sec).toBeLessThanOrEqual(0);
});

test('la sección está traducida (EN)', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('bookreader_lang', 'en'));
  await page.goto('/');
  await seedRecords(page);
  await page.click('[data-act="analysis"]');
  const sec = page.locator('.anal-rhythm');
  await expect(sec.locator('.anal-sec-h')).toHaveText('Reading rhythm');
  await expect(sec.locator('.anal-rhythm-key.is-other')).toContainText('Others (3 books)');
  await expect(sec.locator('.anal-rhythm-sum')).toContainText('23 days read');
  await expect(sec.locator('[data-runit="min"]')).toHaveText('Minutes');
});

test('tocar la leyenda abre ese libro en el lector', async ({ page }) => {
  test.setTimeout(60000);
  await page.goto('/');
  // El libro entra en la biblioteca con su fichero, sin pasar por el import: importar y reabrir
  // el mismo libro enseguida es otra carrera (la carga del import, si aún no ha acabado, echa
  // al lector a la biblioteca al terminar) y no es lo que mide este test.
  const b64 = fs.readFileSync(EPUB_PATH).toString('base64');
  await page.evaluate(async (b64: string) => {
    const Store: any = await import('/js/library/store.js');
    const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    await Store.putBook({ id: 'bk-epub', title: 'Pedro Páramo (EPUB)', author: 'Juan Rulfo', format: 'epub',
      fileName: 'test.epub', file: buf.buffer, size: buf.length, addedAt: Date.now(), progress: 0,
      status: 'reading', shelfIds: [] });
  }, b64);
  await seedRecords(page, { 0: { 'bk-epub': { ms: 600 * 60000, words: 90000, units: 50 } } });
  await page.click('[data-act="analysis"]');
  const key = page.locator('.anal-rhythm-key[data-open-book="bk-epub"]');
  await expect(key).toBeVisible();
  await expect(page.locator('body')).not.toHaveClass(/(^|\s)reading(\s|$)/);
  await key.click();
  await expect(page.locator('#analysis')).toBeHidden();
  await page.waitForSelector('#epub-container iframe', { timeout: 30000 });
  await expect.poll(() => page.evaluate(() => document.body.classList.contains('reading')), { timeout: 30000 }).toBe(true);
});
