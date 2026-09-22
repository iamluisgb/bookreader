import { test, expect } from '@playwright/test';
import path from 'path';

// P30 · Descubrimiento. El hint de la barra de selección aparece UNA vez (one-shot:
// marcado en localStorage al descartarlo, no al mostrarse) y no vuelve tras recargar.
// La guía rápida se abre con '?' y lista las features agrupadas por momento.
// "Primeros pasos" en la estantería se deriva del estado real (libros, clave, objetivo).

const EPUB_PATH = path.join(__dirname, 'test.epub');

async function openEpub(page) {
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', EPUB_PATH);
  await page.waitForSelector('#epub-container iframe', { timeout: 30000 });
  await page.waitForFunction(() => !!document.querySelector('#toc-list a'), null, { timeout: 30000 });
}

async function selectInEpub(page) {
  // Misma técnica que highlight-edit.spec.ts: epub.js emite `selected` desde su
  // listener de `selectionchange` (con debounce), así que el gesto se repite.
  // La primera página de test.epub es la portadilla (imagen, sin texto): se avanza
  // hasta una página con prosa que seleccionar.
  await expect.poll(async () => page.evaluate(async () => {
    const doc = (document.querySelector('#epub-container iframe') as HTMLIFrameElement)?.contentDocument;
    if ((doc?.body?.textContent || '').trim().length > 60) return true;
    await (await import('/js/epub-reader.js') as any).next();
    return false;
  }), { message: 'no se encontró una página con texto en el EPUB', timeout: 30000 }).toBe(true);

  const gesto = () => page.evaluate(() => {
    const doc = (document.querySelector('#epub-container iframe') as HTMLIFrameElement)?.contentDocument;
    const p = doc?.body && [...doc.body.querySelectorAll('*')]
      .find(el => el.children.length === 0 && (el.textContent || '').trim().length > 20);
    if (!p) return;
    const range = doc.createRange();
    range.selectNodeContents(p);
    const sel = doc.defaultView!.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    doc.dispatchEvent(new Event('selectionchange', { bubbles: true }));
    doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await gesto();
  await expect.poll(async () => {
    if (await page.locator('#highlight-tooltip').isVisible()) return true;
    await gesto();
    return false;
  }, { message: 'la barra de selección nunca llegó a abrirse', timeout: 30000 }).toBe(true);
}

test.describe('P30 · hints de descubrimiento', () => {
  test('el hint de selección aparece una vez y no vuelve tras recargar', async ({ page }) => {
    await openEpub(page);
    await selectInEpub(page);

    const hint = page.locator('.hint-pop[data-hint="sel-actions"]');
    await expect(hint).toBeVisible();

    // Descartar → marcado como visto.
    await hint.locator('.hint-pop-close').click();
    await expect(hint).not.toBeVisible();
    const seen = await page.evaluate(() => JSON.parse(localStorage.getItem('bookreader_hints_seen') || '[]'));
    expect(seen).toContain('sel-actions');

    // Recargar y volver a seleccionar: no reaparece.
    await page.reload();
    await page.waitForSelector('#epub-container iframe', { timeout: 30000 });
    await selectInEpub(page);
    await expect(page.locator('.hint-pop[data-hint="sel-actions"]')).not.toBeVisible();
  });

  test("la guía rápida se abre con '?' y agrupa por momento", async ({ page }) => {
    await page.goto('/index.html');
    await page.keyboard.press('?');
    const guide = page.locator('#feature-guide');
    await expect(guide).toBeVisible();
    // Tres grupos = tres momentos: leyendo / con texto seleccionado / con el agente.
    await expect(guide.locator('.fguide-group')).toHaveCount(3);
    await page.keyboard.press('Escape');
    await expect(guide).not.toBeVisible();
  });

  test('"Primeros pasos" en la estantería se marca con el estado real y desaparece al completar', async ({ page }) => {
    // Estado recién estrenado: sin libros → la tarjeta muestra los tres pasos pendientes.
    await page.goto('/index.html');
    // Storage (bookreader_*) guarda JSON: la clave ha de serializarse como tal.
    await page.evaluate(() => localStorage.setItem('bookreader_ai_key', JSON.stringify('sk-test')));
    await page.reload();
    const steps = page.locator('.lib-steps');
    await expect(steps).toBeVisible();
    await expect(steps.locator('.lib-step')).toHaveCount(3);
    await expect(steps.locator('.lib-step.done')).toHaveCount(1); // solo la clave

    // Con un libro importado Y una conversación con objetivo: ya no hay nada que enseñar.
    await page.setInputFiles('#file-input', EPUB_PATH);
    await page.waitForSelector('#epub-container iframe', { timeout: 30000 });
    await page.evaluate(async () => {
      const { createConvo } = await import('/js/ai/db.js');
      const { getAllBooks } = await import('/js/library/store.js');
      const books = await getAllBooks();
      await createConvo(books[0].id, 'hqa', 'Entender el libro a fondo');
    });
    await page.locator('#library-btn').click();
    await page.locator('#library').waitFor({ state: 'visible' });
    await expect(page.locator('.lib-steps')).toHaveCount(0);
  });
});
