import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { seedProLicense } from './pro-license';

// Regresión del reporte del 2026-09-28: mazos que llegan por sync tienen `card.src`, pero
// el libro segmentado (bookText/anchors) NO viaja por sync — así «Ver en el libro» caía en
// un retorno silencioso (ni salto ni pasaje) y «Ver el pasaje del libro» no aparecía.
// El fix segmenta el libro en caliente (local, sin IA) y nunca falla en silencio.

async function seedBookConMazo(page, { bookId, withFile, src = 'a1' }) {
  // El fixture se inyecta desde Node (el server sirve app/, no la carpeta tests/).
  const epubBytes = withFile
    ? Array.from(fs.readFileSync(path.join(__dirname, 'test.epub')))
    : null;
  await page.evaluate(async ({ bookId, epubBytes, src }) => {
    const DB: any = await import('/js/ai/db.js');
    const Lib: any = await import('/js/library/store.js');
    const record: any = {
      id: bookId, title: 'Libro sync', format: 'epub', fileName: 'test.epub',
      addedAt: Date.now(), lastOpenedAt: Date.now(), progress: 0, status: 'unread', shelfIds: [],
    };
    if (epubBytes) {
      const buf = new Uint8Array(epubBytes).buffer;
      record.file = buf; record.size = buf.byteLength;
    } else {
      record.hasLocalFile = false;   // fantasma: llegó por sync, el fichero no está aquí
    }
    await Lib.putBook(record);
    // SIN bookText/anchors: el punto del test es que el estudio los genera a demanda.
    await DB.addDeck({
      bookId, name: 'Libro sync', cardType: 'basic', scope: '',
      cards: [{ type: 'basic', front: 'con fuente', back: 'r', chapter: '', src }],
    });
  }, { bookId, epubBytes, src });
}

test('sin segmentación local, «Ver en el libro» segmenta y abre por deep-link', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await seedBookConMazo(page, { bookId: 'bk-seg', withFile: true });
  await page.reload();
  await page.locator('.lib-study-chip').click();

  const overlay = page.locator('#ai-study');
  await overlay.locator('.study-flip').click();
  await expect(overlay.locator('.study-src')).toBeVisible();
  await overlay.locator('.study-src').click();

  // La sesión se aparta (F2) y el router abre el libro: hash con el libro y, si la ancla
  // generada coincide con card.src, también loc.
  await expect(overlay).toBeHidden();
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/book=bk-seg/);
  // La segmentación quedó persistida: próximos repasos no repiten el trabajo.
  await expect.poll(async () => page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    return !!(await DB.get('bookText', 'bk-seg')) && !!(await DB.get('anchors', 'bk-seg'));
  })).toBe(true);
});

test('al voltear una tarjeta de libro sin segmentar, aparece el pasaje tras generarlo', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await seedBookConMazo(page, { bookId: 'bk-seg2', withFile: true });
  await page.reload();
  await page.locator('.lib-study-chip').click();

  const overlay = page.locator('#ai-study');
  await overlay.locator('.study-flip').click();
  // showPassage no encuentra texto → ensureSegmented → reintento → recorte de página visible.
  await expect(overlay.locator('.study-passage-wrap')).toBeVisible();
});

test('libro fantasma (fichero no está aquí): aviso visible y la sesión sigue', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await seedBookConMazo(page, { bookId: 'bk-ghost', withFile: false });
  await page.reload();
  await page.locator('.lib-study-chip').click();

  const overlay = page.locator('#ai-study');
  await overlay.locator('.study-flip').click();
  await overlay.locator('.study-src').click();
  await expect(page.locator('.ai-toast')).toContainText('no está en este dispositivo');
  // La sesión NO se aparta: no hay a dónde ir sin el fichero.
  await expect(overlay).toBeVisible();
});
