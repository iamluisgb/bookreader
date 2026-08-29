import { test, expect, type Page } from '@playwright/test';
import path from 'path';
const BOOK = path.join(__dirname, '..', 'evals', 'fixtures', 'p2-progit.epub');

// AHORA sí: puntero grueso (activa TouchSelect y el camino táctil) + isMobile.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });

async function abrir(page: Page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', BOOK);
  await expect(page.locator('#epub-container iframe')).toBeAttached({ timeout: 30000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('progress-page');
    return el && el.textContent && !el.textContent.includes('—');
  }, null, { timeout: 90000 });
  await page.waitForTimeout(1500);
}
const pie = (page: Page) => page.textContent('#progress-page');

test('táctil: marcador tras salir y entrar', async ({ page }) => {
  await abrir(page);
  console.log('coarse =', await page.evaluate(() => matchMedia('(pointer: coarse)').matches));

  await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    await R.seekToFraction(0.29);
    await new Promise((r) => setTimeout(r, 2500));
    for (let i = 0; i < 6; i++) { R.next(); await new Promise((r) => setTimeout(r, 400)); }
  });
  await page.waitForTimeout(2000);
  const alMarcar = await pie(page);
  await page.$eval('#bookmark-toggle', (e: any) => e.click());
  await page.waitForTimeout(500);
  const bm = await page.evaluate(async () => {
    const B: any = await import('/js/bookmarks.js');
    const b = B.getAll()[0];
    return { cfi: b.cfi as string, page: b.page };
  });
  console.log('AL MARCAR   pie =', alMarcar, '| ficha:', bm.page);

  await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    await R.seekToFraction(0.60);
    await new Promise((r) => setTimeout(r, 2500));
    R.flushLastPosition();
  });
  await page.waitForTimeout(800);

  await abrir(page);
  console.log('AL REABRIR  pie =', await pie(page));

  await page.$eval('#sidebar-toggle', (e: any) => e.click());
  await page.waitForTimeout(800);
  await page.click('[data-tab="bookmarks"]').catch(() => {});
  await page.waitForTimeout(500);
  await page.tap('.bookmark-item .bookmark-info');       // toque REAL

  for (const ms of [800, 2000, 4000, 7000]) {
    await page.waitForTimeout(ms === 800 ? 800 : 1500);
    console.log(`  t≈${ms}ms  pie =`, await pie(page));
  }

  const d = await page.evaluate(async (cfi) => {
    const R: any = await import('/js/epub-reader.js');
    const book = R.getBook();
    const loc = R.getRendition().currentLocation();
    return { objetivo: book.locations.locationFromCfi(cfi), actual: book.locations.locationFromCfi(loc.start.cfi) };
  }, bm.cfi);
  console.log('OBJETIVO', d.objetivo, '| ACTUAL', d.actual, '| DESVÍO', d.actual - d.objetivo);
});
