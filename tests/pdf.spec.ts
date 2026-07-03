import { test, expect } from '@playwright/test';
import path from 'path';

const PDF_PATH = path.join(__dirname, 'test.pdf');

// TEC1 · El lector PDF tenía 0 cobertura. Estos tests fijan lo básico y, sobre todo, el
// bug del ArrayBuffer *detached*: pdf.js transfiere el buffer que le pasas, así que si el
// llamador lo reutiliza para guardar el PDF en la biblioteca, petaba y el PDF NO se
// guardaba. El fix clona el buffer en PdfReader.load.

async function openPdf(page) {
  await page.goto('/index.html');
  const fc = page.waitForEvent('filechooser');
  await page.click('#open-file-btn');
  await (await fc).setFiles(PDF_PATH);
  await page.waitForSelector('#pdf-container canvas', { timeout: 15000 });
}

test('un PDF se renderiza (canvas visible con tamaño)', async ({ page }) => {
  await openPdf(page);
  const size = await page.evaluate(() => {
    const c = document.querySelector('#pdf-container canvas') as HTMLCanvasElement;
    return c ? { w: c.width, h: c.height } : null;
  });
  expect(size).not.toBeNull();
  expect(size!.w).toBeGreaterThan(0);
  expect(size!.h).toBeGreaterThan(0);
});

test('un PDF SÍ se guarda en la biblioteca (buffer no detached)', async ({ page }) => {
  await openPdf(page);
  // El guardado ocurre tras cargar; damos un margen y consultamos el store real.
  await page.waitForTimeout(500);
  const rec = await page.evaluate(async () => {
    const Store = await import('/js/library/store.js');
    const books = await Store.getAllBooks();
    const pdf = (books || []).find((b: any) => b.format === 'pdf');
    if (!pdf) return null;
    const bytes = pdf.file instanceof ArrayBuffer ? pdf.file.byteLength : (pdf.file?.size ?? 0);
    return { format: pdf.format, size: pdf.size, fileBytes: bytes };
  });
  expect(rec).not.toBeNull();
  expect(rec!.format).toBe('pdf');
  expect(rec!.size).toBeGreaterThan(0);      // antes del fix: 0 o no se guardaba
  expect(rec!.fileBytes).toBeGreaterThan(0); // el contenido real quedó guardado
});

// PDF2 · Seleccionar texto en el PDF debe ofrecer "Preguntar al agente" y abrir el panel.
// El subrayado real (color/nota) es PDF3, así que en modo PDF esas acciones se ocultan.
test('PDF2: seleccionar texto muestra "Preguntar al agente" y abre el panel', async ({ page }) => {
  await openPdf(page);
  await page.waitForFunction(() => {
    const l = document.querySelector('#pdf-container .textLayer');
    return !!l && l.textContent!.trim().length > 0;
  }, { timeout: 15000 });

  // Seleccionar el texto de la capa y simular el fin de selección (mouseup).
  await page.evaluate(() => {
    const layer = document.querySelector('#pdf-container .textLayer')!;
    const range = document.createRange();
    range.selectNodeContents(layer);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.getElementById('pdf-container')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });

  await expect(page.locator('#highlight-tooltip')).toBeVisible();
  await expect(page.locator('#highlight-tooltip .sel-colors')).toBeVisible();  // subrayar (PDF3)
  await expect(page.locator('#sel-note')).toBeVisible();
  await expect(page.locator('#sel-ask')).toBeVisible();

  await page.locator('#sel-ask').click();
  await expect
    .poll(() => page.evaluate(() => document.body.classList.contains('ai-open')))
    .toBe(true);
});

// PDF3 · Subrayar en PDF: crea un ancla {página, rects}, pinta el overlay sobre el canvas,
// lo persiste y lo re-pinta al re-renderizar la página.
async function selectPdfText(page) {
  await page.waitForFunction(() => {
    const l = document.querySelector('#pdf-container .textLayer');
    return !!l && l.textContent!.trim().length > 0;
  }, { timeout: 15000 });
  await page.evaluate(() => {
    const layer = document.querySelector('#pdf-container .textLayer')!;
    const range = document.createRange();
    range.selectNodeContents(layer);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.getElementById('pdf-container')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
}

test('PDF3: subrayar en PDF crea overlay, lo persiste y lo re-pinta', async ({ page }) => {
  await openPdf(page);
  await selectPdfText(page);
  await expect(page.locator('#highlight-tooltip')).toBeVisible();

  // Subrayar en el primer color.
  await page.locator('#highlight-tooltip .highlight-color').first().click();

  // Overlay pintado sobre el canvas.
  await expect(page.locator('#pdf-container .pdf-hl').first()).toBeVisible();

  // Persistido con ancla de página + rects.
  const stored = await page.evaluate(async () => {
    const H = await import('/js/highlights.js');
    const all = H.getAll();
    return all.map((h: any) => ({ page: h.page, rects: (h.rects || []).length, hasId: !!h.id }));
  });
  expect(stored.length).toBeGreaterThan(0);
  expect(stored[0].page).toBe(1);
  expect(stored[0].rects).toBeGreaterThan(0);
  expect(stored[0].hasId).toBe(true);

  // Re-render de la misma página → el overlay se vuelve a pintar (no se pierde).
  await page.evaluate(async () => { const P = await import('/js/pdf-reader.js'); await P.goTo(1); });
  await expect(page.locator('#pdf-container .pdf-hl').first()).toBeVisible();
});

// PDF4 · Modo scroll continuo: alternar monta las páginas apiladas (con data-page), las
// renderiza (lazy) y recuerda el modo; volver a paginado quita la clase.
test('PDF4: alternar a scroll monta y renderiza páginas, y persiste el modo', async ({ page }) => {
  await openPdf(page);

  await page.evaluate(async () => { const P = await import('/js/pdf-reader.js'); await P.setReadingMode('scroll'); });
  await expect(page.locator('#pdf-container.pdf-scroll')).toBeVisible();
  await expect(page.locator('#pdf-container .pdf-page[data-page="1"]')).toBeVisible();

  // El observer perezoso pinta la página visible.
  await expect
    .poll(() => page.evaluate(() => {
      const c = document.querySelector('#pdf-container .pdf-page[data-page="1"] canvas') as HTMLCanvasElement;
      return c ? c.width : 0;
    }))
    .toBeGreaterThan(0);

  const mode = await page.evaluate(async () => { const P = await import('/js/pdf-reader.js'); return P.getReadingMode(); });
  expect(mode).toBe('scroll');

  // Subrayar sigue funcionando en scroll (usa el data-page del wrapper).
  await selectPdfText(page);
  await page.locator('#highlight-tooltip .highlight-color').first().click();
  await expect(page.locator('#pdf-container .pdf-page[data-page="1"] .pdf-hl').first()).toBeVisible();

  // Volver a paginado quita la clase de scroll.
  await page.evaluate(async () => { const P = await import('/js/pdf-reader.js'); await P.setReadingMode('paginated'); });
  await expect(page.locator('#pdf-container.pdf-scroll')).toHaveCount(0);
});

test.describe('PDF HiDPI', () => {
  test.use({ deviceScaleFactor: 2 });
  test('el canvas se pinta a más resolución que su tamaño CSS (nitidez retina)', async ({ page }) => {
    await openPdf(page);
    const r = await page.evaluate(() => {
      const c = document.querySelector('#pdf-container canvas') as HTMLCanvasElement;
      return { backing: c.width, css: parseFloat(c.style.width || '0') };
    });
    expect(r.css).toBeGreaterThan(0);
    expect(r.backing).toBeGreaterThan(r.css * 1.5);   // backing ≈ 2× el tamaño mostrado
  });
});
