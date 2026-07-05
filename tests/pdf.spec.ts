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

// Índice y marcadores del PDF (paridad con EPUB).
test('PDF-TOC: el índice se rellena para PDF (aquí, sin outline → estado vacío)', async ({ page }) => {
  await openPdf(page);
  // La fixture no trae outline: debe mostrarse el estado propio de PDF, no el placeholder inicial.
  await expect(page.locator('#toc-list')).toContainText('Este PDF no tiene índice');
});

test('PDF-bookmarks: marcar/desmarcar la página y verla en la lista', async ({ page }) => {
  await openPdf(page);
  const btn = page.locator('#bookmark-toggle');
  await expect(btn).toBeEnabled();

  await btn.click();
  await expect(btn).toHaveClass(/is-active/);
  await expect(page.locator('#bookmarks-list .bookmark-item')).toHaveCount(1);
  await expect(page.locator('#bookmarks-list')).toContainText('Página 1');

  // Persistido con id sintético de página.
  const ids = await page.evaluate(async () => {
    const B = await import('/js/bookmarks.js');
    return B.getAll().map((b: any) => ({ cfi: b.cfi, page: b.page }));
  });
  expect(ids.length).toBe(1);
  expect(ids[0].cfi).toBe('page:1');
  expect(ids[0].page).toBe(1);

  // Desmarcar.
  await btn.click();
  await expect(btn).not.toHaveClass(/is-active/);
  await expect(page.locator('#bookmarks-list .bookmark-item')).toHaveCount(0);
});

// VISIÓN · "Explicar lo que veo": captura la página actual y la manda al MODELO DE VISIÓN
// (multimodal, independiente del de texto). Stub de fetch para verificar que el turno lleva
// la imagen (content con image_url) y usa el modelo de visión configurado.
test('VISIÓN: "Ver" envía la imagen de la página al modelo de visión', async ({ page }) => {
  await page.goto('/index.html');
  await page.evaluate((k) => localStorage.setItem('bookreader_ai_key', JSON.stringify(k)), 'test-key');
  await page.evaluate((m) => localStorage.setItem('bookreader_ai_vision_model', JSON.stringify(m)), 'vision-model');
  await page.reload();

  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    (window as any).__vis = { imageSent: false, model: null };
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions') && opts?.body) {
        const body = JSON.parse(opts.body);
        const msgs = body.messages || [];
        const hasImg = msgs.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'image_url'));
        if (hasImg) { (window as any).__vis.imageSent = true; (window as any).__vis.model = body.model; }
        if (body.stream) {
          const chunks = [
            'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n',
          ];
          const s = new ReadableStream({ start(c) { const e = new TextEncoder(); chunks.forEach(x => c.enqueue(e.encode(x))); c.close(); } });
          return new Response(s, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: hasImg ? 'La figura muestra un grafo.' : 'LISTO' } }] }), { status: 200 });
      }
      return real(url, opts);
    };
  });

  const fc = page.waitForEvent('filechooser');
  await page.click('#open-file-btn');
  await (await fc).setFiles(PDF_PATH);
  await page.waitForSelector('#pdf-container canvas', { timeout: 15000 });

  await page.waitForSelector('#ai-toggle:not([disabled])', { timeout: 15000 });
  await page.click('#ai-toggle');
  await page.waitForSelector('.ai-onboarding', { timeout: 5000 });
  await page.click('.ai-ob-tpl[data-tpl="t3-juicio"]');
  await page.fill('#ai-ob-goal', 'entender las figuras');
  await page.click('#ai-ob-start');
  await expect(page.locator('#ai-tabs')).toBeVisible({ timeout: 5000 });

  // El botón "Ver" es visible en PDF.
  await expect(page.locator('#ai-see')).toBeVisible();

  // "Ver" ADJUNTA la captura (no envía): aparece el chip de imagen y el usuario personaliza.
  await page.fill('#ai-input', 'explica la figura');
  await page.click('#ai-see');
  await expect(page.locator('#ai-imgref')).toBeVisible();
  const visBefore = await page.evaluate(() => (window as any).__vis.imageSent);
  expect(visBefore).toBe(false);   // aún no se ha enviado nada

  // Al Enviar, el turno va con imagen al modelo de visión.
  await page.click('#ai-send');
  await expect(page.locator('.ai-msg-assistant .ai-bubble-text').last())
    .toContainText('grafo', { timeout: 15000 });
  await expect(page.locator('#ai-imgref')).toBeHidden();   // el chip se limpia tras enviar

  const vis = await page.evaluate(() => (window as any).__vis);
  expect(vis.imageSent).toBe(true);
  expect(vis.model).toBe('vision-model');
});

test('PDF-portada: se guarda la miniatura de la página 1 como portada', async ({ page }) => {
  await openPdf(page);
  await page.waitForTimeout(600);   // persistToLibrary es async tras la carga
  const cover = await page.evaluate(async () => {
    const Store = await import('/js/library/store.js');
    const books = await Store.getAllBooks();
    const pdf = (books || []).find((b: any) => b.format === 'pdf');
    return pdf ? pdf.cover : null;
  });
  expect(cover).toBeTruthy();
  expect(cover.startsWith('data:image/')).toBe(true);   // no la imagen genérica
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

// Zoom/ajuste (móvil): la página debe caber a lo ancho (antes se pintaba a scale
// fijo 1.5 y se salía de pantalla) y el pinch/zoom debe agrandarla para ver detalle.
test.describe('PDF fit-to-width + zoom', () => {
  test.use({ viewport: { width: 390, height: 780 } });
  test('la página se ajusta al ancho en móvil y el zoom la agranda', async ({ page }) => {
    await openPdf(page);
    await page.waitForTimeout(300);
    const fit = await page.evaluate(() => {
      const c = document.querySelector('#pdf-container') as HTMLElement;
      const w = c.querySelector('.pdf-page') as HTMLElement;
      return { container: c.clientWidth, page: parseFloat(w.style.width) };
    });
    // Cabe dentro del contenedor (padding 20px por lado → 40px).
    expect(fit.page).toBeLessThanOrEqual(fit.container - 39);
    expect(fit.page).toBeGreaterThan(0);
    // Zoom 2× agranda la página (para hacer zoom en detalles y panear).
    const zoomed = await page.evaluate(async () => {
      const P: any = await import('/js/pdf-reader.js');
      P.setZoom(2);
      await new Promise((r) => setTimeout(r, 450));
      return parseFloat((document.querySelector('#pdf-container .pdf-page') as HTMLElement).style.width);
    });
    expect(zoomed).toBeGreaterThan(fit.page * 1.5);
  });

  // El pinch debe ANCLARSE al punto entre los dedos: el punto del contenido bajo el foco
  // debe seguir bajo el foco tras el re-render (antes saltaba a otra parte de la página).
  test('el pinch-zoom se ancla al punto focal (no salta)', async ({ page }) => {
    await openPdf(page);
    await page.waitForTimeout(300);

    // Helper: dispara un pinch (dos dedos) sobre el contenedor del PDF.
    const pinch = (a: any) => page.evaluate((a) => {
      const el = document.getElementById('pdf-container')!;
      const mk = (id: number, x: number, y: number) => new Touch({ identifier: id, target: el, clientX: x, clientY: y });
      const ev = (type: string, ts: Touch[]) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: ts, targetTouches: ts, changedTouches: ts } as any));
      ev('touchstart', [mk(1, a.x0, a.y0), mk(2, a.x1, a.y1)]);
      ev('touchmove', [mk(1, a.x0b, a.y0b), mk(2, a.x1b, a.y1b)]);
      ev('touchend', []);
    }, a);

    // 1) Ampliar para desbordar el contenedor (así hay scroll donde "saltar").
    await pinch({ x0: 150, y0: 300, x1: 240, y1: 340, x0b: 40, y0b: 200, x1b: 340, y1b: 440 });
    await page.waitForTimeout(500);

    // 2) Anotar qué fracción del canvas cae bajo un foco concreto.
    const focal = { x: 300, y: 250 };
    const before = await page.evaluate((f) => {
      const c = document.querySelector('#pdf-container canvas')!.getBoundingClientRect();
      return (f.x - c.left) / c.width;
    }, focal);

    // 3) Pinch anclado en ese foco.
    await pinch({ x0: focal.x - 20, y0: focal.y, x1: focal.x + 20, y1: focal.y, x0b: focal.x - 40, y0b: focal.y, x1b: focal.x + 40, y1b: focal.y });
    await page.waitForTimeout(500);

    // 4) La misma fracción del canvas debe seguir bajo el foco (± pequeño margen).
    const after = await page.evaluate((f) => {
      const c = document.querySelector('#pdf-container canvas')!.getBoundingClientRect();
      return (f.x - c.left) / c.width;
    }, focal);

    expect(Math.abs(after - before)).toBeLessThan(0.05);   // el punto focal se mantiene (no salta)
  });
});
