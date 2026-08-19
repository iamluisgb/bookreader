// position-key.spec.ts — La posición de lectura se guarda bajo el id CANÓNICO (TEC5).
//
// Antes vivía bajo la clave interna de epub.js (`epubjs:<v>:<dc:identifier>`) y, en PDF,
// bajo la huella de pdf.js. Eso la metía en un espacio de ids distinto al del resto de la
// app —biblioteca, subrayados, marcadores, sync— con tres efectos medidos:
//   1. viajaba al proveedor como un "libro fantasma" sin título ni fichero;
//   2. la reconciliación de alias no la alcanzaba (mismo libro de otro mirror: cruzaban los
//      subrayados y no la página);
//   3. los EPUB sin `dc:identifier` compartían la clave `epubjs:0.3:` y se pisaban la
//      posición entre libros DISTINTOS.
import { test, expect, type Page } from '@playwright/test';
import path from 'path';

const EPUB_PATH = path.join(__dirname, 'test.epub');
const PDF_PATH = path.join(__dirname, 'test-multipage.pdf');
const CANONICO = /^bookreader_(lastPosition|pdfLastPage)_[0-9a-f]{64}$/;

async function abrir(page: Page, fichero: string) {
  await page.goto('/');
  await page.setInputFiles('#file-input', fichero);
  await page.waitForTimeout(3000);
}

// Claves de posición presentes, sin el prefijo de Storage.
async function clavesDePosicion(page: Page) {
  return page.evaluate(() =>
    Object.keys(localStorage).filter((k) => /^bookreader_(lastPosition|pdfLastPage)_/.test(k)).sort(),
  );
}

test('EPUB: la posición se guarda bajo el hash del fichero, no bajo la clave de epub.js', async ({ page }) => {
  await abrir(page, EPUB_PATH);
  await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    for (let i = 0; i < 4; i++) { R.next(); await new Promise((r) => setTimeout(r, 350)); }
    R.flushLastPosition();
  });
  await page.waitForTimeout(500);

  const claves = await clavesDePosicion(page);
  expect(claves.length).toBeGreaterThan(0);
  for (const k of claves) expect(k, `clave no canónica: ${k}`).toMatch(CANONICO);
  // La clave vieja de epub.js empieza por "epubjs:"; ni una debe quedar.
  expect(claves.filter((k) => k.includes('epubjs:'))).toEqual([]);
});

test('EPUB: una posición guardada con la clave vieja se migra al abrir', async ({ page }) => {
  // Una primera apertura solo para averiguar cuál ERA la clave vieja de este libro.
  await abrir(page, EPUB_PATH);
  const claveVieja = await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    return R.getBook().key();
  });

  // El montaje va DESPUÉS de navegar, no antes: al salir de la página, `pagehide` vacía la
  // posición actual bajo la clave canónica con sello fresco, y entonces el LWW prefiere —con
  // razón— ese valor al que acabamos de sembrar. Sembrando ya en la página nueva, el estado
  // es el real de un usuario que viene de la versión anterior: solo existe la clave vieja.
  await page.goto('/');
  await page.evaluate((vieja) => {
    for (const k of Object.keys(localStorage)) {
      if (/^bookreader_(lastPosition|lastPositionAt)_/.test(k)) localStorage.removeItem(k);
    }
    localStorage.setItem('bookreader_lastPosition_' + vieja, JSON.stringify('epubcfi(/6/16!/4/2[c01]/80/1:0)'));
    localStorage.setItem('bookreader_lastPositionAt_' + vieja, JSON.stringify(Date.now()));
  }, claveVieja);

  await page.setInputFiles('#file-input', EPUB_PATH);   // abrir dispara la migración
  await page.waitForTimeout(3000);

  const claves = await clavesDePosicion(page);
  expect(claves.length).toBe(1);
  expect(claves[0]).toMatch(CANONICO);
  // El valor viajó: se aserta la SECCIÓN, no el CFI exacto. epub.js muestra la página que
  // CONTIENE el CFI migrado y a continuación 'relocated' guarda el INICIO de esa página
  // (aquí /62 para un pin en /80): exigir igualdad byte a byte estaría comprobando el
  // redondeo de la paginación, no la migración. Lo que importa es que abre en la sección
  // guardada (/6/16) y no al principio del libro (/6/2).
  const valor = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)!), claves[0]);
  expect(valor).toContain('/6/16!');
  // ...y la clave vieja desapareció: si se quedara, buildSnapshot volvería a subirla como
  // libro fantasma en el siguiente sync.
  const restos = await page.evaluate(
    (v) => ['lastPosition_', 'lastPositionAt_', 'readingMode_']
      .map((p) => 'bookreader_' + p + v)
      .filter((k) => localStorage.getItem(k) !== null),
    claveVieja,
  );
  expect(restos).toEqual([]);
});

test('PDF: la última página se guarda bajo el hash del fichero, no bajo la huella de pdf.js', async ({ page }) => {
  await abrir(page, PDF_PATH);
  await page.evaluate(async () => {
    const R: any = await import('/js/pdf-reader.js');
    await R.next();
  });
  await page.waitForTimeout(800);

  const claves = await clavesDePosicion(page);
  expect(claves.length).toBeGreaterThan(0);
  for (const k of claves) expect(k, `clave no canónica: ${k}`).toMatch(CANONICO);
});

test('la posición ya no viaja al sync como libro fantasma', async ({ page }) => {
  await abrir(page, EPUB_PATH);
  await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    for (let i = 0; i < 4; i++) { R.next(); await new Promise((r) => setTimeout(r, 350)); }
    R.flushLastPosition();
  });
  await page.waitForTimeout(500);

  const libros = await page.evaluate(async () => {
    const L: any = await import('/js/sync/layout.js');
    const snap = await L.buildSnapshot();
    return Object.keys(snap.books);
  });
  // Antes salían DOS entradas: el libro real (hash) y el fantasma (epubjs:…, sin título).
  expect(libros.length).toBe(1);
  expect(libros[0]).toMatch(/^[0-9a-f]{64}$/);
});
