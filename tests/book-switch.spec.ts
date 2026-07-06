import { test, expect } from '@playwright/test';
import path from 'path';

// Regresión de un bug CRÍTICO: con un libro abierto, el agente respondía de OTRO.
// Causa: prepareBook() segmenta async y, sin guard, una segmentación tardía del libro
// anterior (a) sobrescribía en RAM el contexto del actual y (b) —en el código viejo—
// guardaba su contenido bajo el bookId equivocado (caché envenenada persistente).
// Aquí abrimos un EPUB grande (segmentación lenta) e, inmediatamente, un PDF (rápido),
// forzando el solape, y verificamos que cada caché conserva SU contenido (no se cruzan).

const EPUB = path.join(__dirname, 'test.epub');
const PDF = path.join(__dirname, 'test.pdf');

test('cambiar de libro durante la segmentación no cruza los contextos', async ({ page }) => {
  await page.goto('/index.html');

  // Abrir EPUB y, sin esperar a que asiente, abrir el PDF (ventana de solape).
  await page.setInputFiles('#file-input', EPUB);
  await page.waitForTimeout(120);
  await page.setInputFiles('#file-input', PDF);
  await page.waitForSelector('#pdf-container canvas', { timeout: 15000 });
  await page.waitForTimeout(1500);   // deja asentar ambas segmentaciones en IndexedDB

  const segs = await page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    const Store: any = await import('/js/library/store.js');
    const books = await Store.getAllBooks();
    const byFormat: Record<string, { len: number; head: string } | null> = {};
    for (const bk of books) {
      const seg = await DB.loadSegmented(bk.id);
      byFormat[bk.format] = seg ? { len: seg.annotatedText.length, head: seg.annotatedText.slice(0, 80) } : null;
    }
    return byFormat;
  });

  // Cada caché debe reflejar SU libro, sin cruces.
  expect(segs.pdf).not.toBeNull();
  expect(segs.epub).not.toBeNull();
  expect(segs.pdf!.head).toContain('Hello PDF');        // el PDF NO debe contener texto del EPUB
  expect(segs.epub!.len).toBeGreaterThan(1000);         // el EPUB conserva su cuerpo largo
  expect(segs.epub!.head).not.toContain('Hello PDF');   // el EPUB NO debe contener texto del PDF
  expect(segs.epub!.len).not.toBe(segs.pdf!.len);       // cachés distintas (si se cruzaran, serían iguales)
});

// La caché que quedó ENVENENADA por el bug (contenido cruzado, guardado con una versión
// anterior) debe ignorarse al subir SEG_VERSION → el libro se re-segmenta y se corrige.
// Esto modela de forma determinista el «sigue el error»: purga de la caché mala.
test('una segmentación cacheada con versión anterior se descarta (purga la caché envenenada)', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async () => {
    const M: any = await import('/js/ai/db.js');
    // Inicializa la BD (crea todos los stores en su versión actual).
    await M.loadSegmented('__init__');
    // Escribe a mano una entrada con una versión ANTERIOR y contenido de OTRO libro.
    await new Promise<void>((res, rej) => {
      // Sin versión: abre en la versión actual del esquema (pinnarla rompería al migrar).
      const req = indexedDB.open('bookreader_ai');
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['bookText', 'anchors'], 'readwrite');
        tx.objectStore('bookText').put({ bookId: 'poison', segVersion: 2, annotatedText: '[[a0]] contenido de OTRO libro', tokenEstimate: 1, blockCount: 1 });
        tx.objectStore('anchors').put({ bookId: 'poison', entries: [['a0', { cfi: 'x', chapter: 'X' }]] });
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      };
      req.onerror = () => rej(req.error);
    });
    const stale = await M.loadSegmented('poison');   // versión vieja → debe ignorarse
    // Una entrada guardada con la versión ACTUAL sí se carga.
    await M.saveSegmented('fresh', 'T', { annotatedText: '[[a0]] ok', anchors: new Map([['a0', { cfi: 'y', chapter: 'C' }]]), tokenEstimate: 1, blockCount: 1 });
    const fresh = await M.loadSegmented('fresh');
    return { staleIsNull: stale === null, freshLoaded: !!fresh && fresh.annotatedText.includes('ok') };
  });
  expect(r.staleIsNull).toBe(true);   // caché envenenada (versión vieja) descartada → se re-segmentará
  expect(r.freshLoaded).toBe(true);   // caché con la versión actual sí carga
});
