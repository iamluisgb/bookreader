import { test, expect } from '@playwright/test';
import path from 'path';

const EPUB_PATH = path.join(__dirname, 'test.epub');

// P5 · Búsqueda sobre el corpus segmentado (pasajes [[aN]] + anclas). Un solo camino para
// EPUB (ancla→CFI) y PDF (ancla→página).

test('searchPassages: encuentra, ubica (CFI/página) y fragmenta el match', async ({ page }) => {
  await page.goto('/index.html');
  const res = await page.evaluate(async () => {
    const { searchPassages } = await import('/js/search.js');
    const text = [
      '## Capítulo 1',
      '[[a0]] El zorro rápido salta sobre el perro dormido.',
      '[[a1]] Otra frase sin relación alguna.',
      '## Capítulo 2',
      '[[a2]] El PERRO ladra fuerte por la noche.',
    ].join('\n');
    const anchors = new Map<string, any>([
      ['a0', { cfi: 'cfi-0', chapter: 'Capítulo 1' }],
      ['a1', { cfi: 'cfi-1' }],
      ['a2', { page: 5, chapter: 'Capítulo 2' }],
    ]);
    return searchPassages(text, anchors, 'perro');
  });

  expect(res.length).toBe(2);
  // EPUB: locator = CFI, con capítulo.
  expect(res[0].loc).toBe('cfi-0');
  expect(res[0].chapter).toBe('Capítulo 1');
  expect(res[0].match.toLowerCase()).toBe('perro');
  // PDF: locator = página (case-insensitive: "PERRO").
  expect(res[1].loc).toBe(5);
  expect(res[1].page).toBe(5);
  expect(res[1].match).toBe('PERRO');
});

test('searchPassages: es insensible a acentos y a mayúsculas', async ({ page }) => {
  await page.goto('/index.html');
  const res = await page.evaluate(async () => {
    const { searchPassages } = await import('/js/search.js');
    const text = '## C\n[[a0]] La canción sonó en la habitación.';
    return searchPassages(text, new Map([['a0', { cfi: 'x' }]]), 'CANCION');
  });
  expect(res.length).toBe(1);
  expect(res[0].match).toBe('canción');
});

test('búsqueda E2E: escribir en la pestaña Buscar lista y navega a la coincidencia', async ({ page }) => {
  await page.goto('/index.html');
  const fc = page.waitForEvent('filechooser');
  await page.click('#open-file-btn');
  await (await fc).setFiles(EPUB_PATH);
  await page.waitForSelector('#ai-toggle:not([disabled])', { timeout: 20000 });

  // Esperar a que la segmentación (corpus de búsqueda) se guarde en IndexedDB.
  await expect.poll(async () => page.evaluate(async () => {
    const DB = await import('/js/ai/db.js');
    return (await DB.getAll('bookText')).length;
  }), { timeout: 30000 }).toBeGreaterThan(0);

  // Elegir un término real de un pasaje del corpus (robusto al contenido del epub).
  const term = await page.evaluate(async () => {
    const DB = await import('/js/ai/db.js');
    const bt = await DB.getAll('bookText');
    const line = (bt[0].annotatedText || '').split('\n').find((l: string) => l.startsWith('[[') && /[a-záéíóúñ]{5,}/i.test(l.slice(6)));
    return (line || '').match(/[a-záéíóúñ]{5,}/i)?.[0] || 'the';
  });

  // Abrir el sidebar en la pestaña Buscar y teclear.
  await page.evaluate(() => document.getElementById('sidebar')!.classList.add('open'));
  await page.click('.tab-btn[data-tab="search"]');
  await page.fill('#search-input', term);

  await expect(page.locator('.search-hit').first()).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.search-hit mark').first()).toBeVisible();   // el match resaltado

  await page.locator('.search-hit').first().click();
  // Al navegar se cierra el sidebar.
  await expect(page.locator('#sidebar')).not.toHaveClass(/open/);
});
