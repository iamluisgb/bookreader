import { test, expect } from '@playwright/test';
import path from 'path';

const EPUB_PATH = path.join(__dirname, 'test.epub');
const PDF_PATH = path.join(__dirname, 'test-multipage.pdf');

// P6 · Pulsar un subrayado ya hecho abre la MISMA barra en modo edición (color actual
// marcado, nota, Eliminar). La nota se escribe dentro de la barra y se guarda al cerrarla,
// sin botón Guardar. Borrar es reversible con el aviso "Deshacer".
// Cierra la barra pulsando fuera, que es lo que dispara el guardado de la nota. La espera
// no es decorativa: la barra ignora a propósito los clics de los primeros 100 ms (si no, el
// mismo clic que la abre la cerraría), y Playwright encadena los pasos mucho más rápido que
// una persona.
const clickOutside = async (page) => {
  await page.waitForTimeout(200);
  await page.evaluate(() => document.body.click());
};

test.describe('Subrayado · edición desde el lector', () => {
  async function openEpub(page) {
    await page.goto('/index.html');
    await page.setInputFiles('#file-input', EPUB_PATH);
    await page.waitForSelector('#epub-container iframe', { timeout: 30000 });
    await page.waitForFunction(() => !!document.querySelector('#toc-list a'), null, { timeout: 30000 });
  }

  // Selecciona un párrafo dentro del iframe del EPUB hasta que la app reacciona. epub.js
  // emite `selected` desde su propio listener de `selectionchange` (con debounce), así que
  // el gesto se repite —es idempotente— en vez de apostar a un tiempo fijo.
  async function selectInEpub(page) {
    // La primera página de test.epub es la portadilla (una imagen, sin texto): se avanza
    // hasta una página con prosa que seleccionar.
    await expect.poll(async () => page.evaluate(async () => {
      const doc = (document.querySelector('#epub-container iframe') as HTMLIFrameElement)?.contentDocument;
      if (doc && doc.body.textContent!.trim().length > 60) return true;
      await (await import('/js/epub-reader.js') as any).next();
      return false;
    }, ), { message: 'no se encontró una página con texto en el EPUB', timeout: 30000 }).toBe(true);

    const gesto = () => page.evaluate(() => {
      const doc = (document.querySelector('#epub-container iframe') as HTMLIFrameElement).contentDocument!;
      const p = [...doc.body.querySelectorAll('*')]
        .find(el => el.children.length === 0 && (el.textContent || '').trim().length > 20)!;
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
    }, { message: 'la barra de selección no apareció en el EPUB', timeout: 20000 }).toBe(true);
  }

  test('EPUB: la nota se escribe en la barra y se guarda al cerrarla', async ({ page }) => {
    await openEpub(page);
    await selectInEpub(page);

    await page.locator('#sel-note').click();
    await expect(page.locator('#sel-note-box')).toBeVisible();
    await page.locator('#sel-note-input').fill('mi nota inline');

    // Cerrar la barra ES el gesto de guardar: no hay botón Guardar. Se cierra con un clic
    // fuera, sin depender de dónde caiga en el layout.
    await clickOutside(page);
    await expect(page.locator('#highlight-tooltip')).toBeHidden();

    const saved = await page.evaluate(async () => {
      const H: any = await import('/js/highlights.js');
      return H.getAll().map((h: any) => ({ note: h.note, color: h.color }));
    });
    expect(saved).toHaveLength(1);
    expect(saved[0].note).toBe('mi nota inline');
    expect(saved[0].color).toBe('#ffd54f');   // sin color elegido, el subrayado por defecto
  });

  test('EPUB: pulsar el subrayado reabre la barra con su color y su nota', async ({ page }) => {
    await openEpub(page);
    await selectInEpub(page);
    await page.locator('.highlight-color[data-color="#81c784"]').click();
    await expect(page.locator('#highlight-tooltip')).toBeHidden();

    // Pulsar el resaltado pintado sobre el texto.
    await page.locator('#epub-container svg g.hl').first().click({ force: true });

    await expect(page.locator('#highlight-tooltip')).toBeVisible();
    await expect(page.locator('.highlight-color[data-color="#81c784"]')).toHaveClass(/is-current/);
    await expect(page.locator('#sel-delete')).toBeVisible();

    // Y la nota que se escriba aquí edita ESE subrayado, sin crear otro.
    await page.locator('#sel-note').click();
    await page.locator('#sel-note-input').fill('editada al pulsarla');
    await clickOutside(page);

    const saved = await page.evaluate(async () => {
      const H: any = await import('/js/highlights.js');
      return H.getAll().map((h: any) => ({ note: h.note, color: h.color }));
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual({ note: 'editada al pulsarla', color: '#81c784' });
  });

  test('EPUB: Eliminar quita el subrayado y Deshacer lo devuelve', async ({ page }) => {
    await openEpub(page);
    await selectInEpub(page);
    await page.locator('.highlight-color[data-color="#64b5f6"]').click();

    await page.locator('#epub-container svg g.hl').first().click({ force: true });
    await page.locator('#sel-delete').click();

    await expect(page.locator('#epub-container svg g.hl')).toHaveCount(0);
    expect(await page.evaluate(async () => (await import('/js/highlights.js') as any).getAll().length)).toBe(0);

    await page.locator('.ai-toast-action').click();

    expect(await page.evaluate(async () => (await import('/js/highlights.js') as any).getAll().length)).toBe(1);
    await expect(page.locator('#epub-container svg g.hl')).toHaveCount(1);
  });

  test('PDF: pulsar el subrayado abre la barra en modo edición', async ({ page }) => {
    await page.goto('/index.html');
    await page.setInputFiles('#file-input', PDF_PATH);
    await page.waitForSelector('#pdf-container canvas', { timeout: 30000 });
    await page.waitForSelector('#pdf-container .textLayer span', { timeout: 30000 });

    // Seleccionar texto de la capa del PDF y subrayarlo en rosa.
    await page.evaluate(() => {
      const span = document.querySelector('#pdf-container .textLayer span')!;
      const range = document.createRange();
      range.selectNodeContents(span);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      document.getElementById('pdf-container')!.dispatchEvent(new Event('mouseup', { bubbles: true }));
    });
    await expect(page.locator('#highlight-tooltip')).toBeVisible({ timeout: 15000 });
    await page.locator('.highlight-color[data-color="#f06292"]').click();
    await expect(page.locator('#pdf-container .pdf-hl-group')).toHaveCount(1);

    // Pulsar en el centro del subrayado pintado (la capa no captura eventos: el hit-test
    // va contra los rects guardados, ver pdfHighlightAt).
    const box = (await page.locator('#pdf-container .pdf-hl-group .pdf-hl').first().boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

    await expect(page.locator('#highlight-tooltip')).toBeVisible();
    await expect(page.locator('.highlight-color[data-color="#f06292"]')).toHaveClass(/is-current/);
    await expect(page.locator('#sel-delete')).toBeVisible();

    // Editar la nota no debe duplicar el subrayado (addPdf siempre inserta).
    await page.locator('#sel-note').click();
    await page.locator('#sel-note-input').fill('nota del pdf');
    await clickOutside(page);

    const saved = await page.evaluate(async () => {
      const H: any = await import('/js/highlights.js');
      return H.getAll().map((h: any) => ({ note: h.note, color: h.color }));
    });
    expect(saved).toEqual([{ note: 'nota del pdf', color: '#f06292' }]);
  });
});
