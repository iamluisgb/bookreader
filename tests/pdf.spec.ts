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
  await page.click('.lib-empty .lib-upload');
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
  // El guardado es asíncrono tras la carga: se sondea el store real hasta que aparece,
  // en vez de apostar 500 ms (que en una máquina ocupada no bastan).
  await expect.poll(async () => page.evaluate(async () => {
    const Store = await import('/js/library/store.js');
    return ((await Store.getAllBooks()) || []).some((b: any) => b.format === 'pdf');
  }), { message: 'el PDF no llegó a guardarse en la biblioteca', timeout: 15000 }).toBe(true);
  const rec = await page.evaluate(async () => {
    const Store = await import('/js/library/store.js');
    // getAllBooks() ya no devuelve el binario (cargaba en memoria el de TODOS
    // los libros solo para pintar la rejilla): trae `hasLocalFile` y el fichero
    // se pide por id con getRaw.
    const books = await Store.getAllBooks();
    const meta = (books || []).find((b: any) => b.format === 'pdf');
    if (!meta) return null;
    const pdf: any = await Store.getRaw(meta.id);
    const bytes = pdf.file instanceof ArrayBuffer ? pdf.file.byteLength : (pdf.file?.size ?? 0);
    return { format: pdf.format, size: pdf.size, fileBytes: bytes, hasLocalFile: meta.hasLocalFile };
  });
  expect(rec).not.toBeNull();
  expect(rec!.format).toBe('pdf');
  expect(rec!.size).toBeGreaterThan(0);      // antes del fix: 0 o no se guardaba
  expect(rec!.fileBytes).toBeGreaterThan(0); // el contenido real quedó guardado
  expect(rec!.hasLocalFile).toBe(true);      // y el listado lo refleja sin cargarlo
});

// PDF2 · Seleccionar texto en el PDF debe ofrecer "Preguntar al agente" y abrir el panel.
// El subrayado real (color/nota) es PDF3, así que en modo PDF esas acciones se ocultan.
test('PDF2: seleccionar texto muestra "Preguntar al agente" y abre el panel', async ({ page }) => {
  await openPdf(page);
  // Mismo gesto que el resto de tests de selección, con el reintento del helper.
  await selectPdfText(page);

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
// Que la capa de texto tenga contenido no significa que la app ya escuche el `mouseup`:
// un gesto lanzado antes de que el manejador esté puesto se pierde en silencio y el fallo
// aparece después, en el `toBeVisible` del tooltip. Se REINTENTA la selección hasta que la
// app reacciona — el gesto es idempotente, así que repetirlo no altera lo que se prueba.
async function selectPdfText(page) {
  await page.waitForFunction(() => {
    const l = document.querySelector('#pdf-container .textLayer');
    return !!l && l.textContent!.trim().length > 0;
  }, { timeout: 15000 });

  const gesto = () => page.evaluate(() => {
    const layer = document.querySelector('#pdf-container .textLayer')!;
    const range = document.createRange();
    range.selectNodeContents(layer);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.getElementById('pdf-container')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });

  await gesto();
  await expect.poll(async () => {
    if (await page.locator('#highlight-tooltip').isVisible()) return true;
    await gesto();
    return false;
  }, { message: 'el tooltip de selección no apareció tras seleccionar texto del PDF', timeout: 15000 })
    .toBe(true);
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

// PDF3-scroll · En modo scroll el subrayado se creaba sobre el placeholder ANTES de que el
// observer perezoso añadiera el .pdf-scaler → el canvas opaco quedaba encima y TAPABA el
// subrayado (se guardaba pero no se veía). La capa de subrayados debe ir por z-index encima.
test('PDF3-scroll: el subrayado en modo scroll queda por encima del canvas (no lo tapa)', async ({ page }) => {
  await openPdf(page);
  await page.evaluate(async () => { const P: any = await import('/js/pdf-reader.js'); await P.setReadingMode('scroll'); await new Promise(r => setTimeout(r, 500)); });
  await selectPdfText(page);
  await page.locator('#highlight-tooltip .highlight-color').first().click();
  await expect(page.locator('#pdf-container .pdf-hl').first()).toBeVisible();
  // Invariante del fix: la capa de subrayados se apila por ENCIMA del scaler (canvas),
  // pase lo que pase con el orden en el DOM.
  const z = await page.evaluate(() => {
    const layer = document.querySelector('#pdf-container .pdf-hl-layer') as HTMLElement;
    return getComputedStyle(layer).zIndex;
  });
  expect(Number(z)).toBeGreaterThanOrEqual(1);
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
  await page.click('.lib-empty .lib-upload');
  await (await fc).setFiles(PDF_PATH);
  await page.waitForSelector('#pdf-container canvas', { timeout: 15000 });

  await page.waitForSelector('#ai-toggle:not([disabled])', { timeout: 15000 });
  await page.click('#ai-toggle');
  await page.waitForSelector('.ai-onboarding', { timeout: 5000 });
  await page.click('.ai-ob-tpl[data-tpl="t3-juicio"]');
  await page.fill('#ai-ob-goal', 'entender las figuras');
  await page.click('#ai-ob-start');
  await expect(page.locator('#ai-tabs')).toBeVisible({ timeout: 5000 });

  // El botón de visión es visible en PDF (uno solo: el alcance se elige en el overlay).
  await expect(page.locator('#ai-see')).toBeVisible();
  await expect(page.locator('#ai-zone')).toHaveCount(0);   // "Zona" ya no es un botón aparte

  // Abre el overlay y se elige "Toda la página": ADJUNTA la captura (no envía), aparece el
  // chip de imagen y el usuario personaliza la pregunta.
  await page.fill('#ai-input', 'explica la figura');
  await page.click('#ai-see');
  await expect(page.locator('.region-overlay .region-whole')).toBeVisible();
  await page.locator('.region-overlay .region-whole').dispatchEvent('pointerdown');
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

  // "Toda la página" se pulsa con el panel CERRADO (pickZone lo aparta para no tapar la
  // página), así que tiene que devolver al chat pase lo que pase. Si la captura falla —la
  // página aún no ha terminado de renderizarse— y el camino de error no reabre el panel, el
  // usuario se queda sin overlay, sin panel y con el aviso dentro de algo que no ve: el botón
  // parece no hacer nada. Se fuerza el fallo quitando el canvas.
  await page.click('#ai-see');
  await expect(page.locator('.region-overlay')).toBeVisible();
  // El panel se aparta para marcar: `body.ai-open` es el estado real (el panel siempre está
  // en el DOM, solo se traslada fuera de pantalla, así que "visible" no distingue nada).
  await expect(page.locator('body')).not.toHaveClass(/ai-open/);
  await page.evaluate(() => document.querySelectorAll('#pdf-container canvas').forEach((c) => c.remove()));
  await page.locator('.region-overlay .region-whole').dispatchEvent('pointerdown');

  await expect(page.locator('.region-overlay')).toHaveCount(0);      // el overlay se retira…
  await expect(page.locator('body')).toHaveClass(/ai-open/);         // …y el panel vuelve
  await expect(page.locator('#ai-view-chat')).toHaveClass(/active/);
  await expect(page.locator('#ai-status')).toContainText('renderiz'); // con el aviso a la vista
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

  // Zoom fluido tipo Adobe: el canvas está OVERSAMPLEADO y ampliar NO re-renderiza (mismo
  // canvas, backing sin cambiar) — solo crece la caja y su scaler. Sin "recarga".
  test('el zoom no re-renderiza el canvas (oversample + escala por CSS)', async ({ page }) => {
    await openPdf(page);
    await page.waitForTimeout(300);
    const before = await page.evaluate(() => {
      const cv = document.querySelector('#pdf-container canvas') as HTMLCanvasElement;
      cv.dataset.mark = 'orig';
      const box = document.querySelector('#pdf-container .pdf-page') as HTMLElement;
      return { backing: cv.width, css: parseFloat(cv.style.width), box: parseFloat(box.style.width) };
    });
    // Oversampleado: el backing es mayor que el tamaño mostrado (la nitidez por encima de
    // OVERSAMPLE× la da el parche de detalle, no un base más gordo).
    expect(before.backing).toBeGreaterThan(before.css * 1.4);

    const after = await page.evaluate(async () => {
      const P: any = await import('/js/pdf-reader.js');
      P.setZoom(2.5, { x: 195, y: 390 });
      await new Promise((r) => setTimeout(r, 300));
      const cv = document.querySelector('#pdf-container canvas') as HTMLCanvasElement;
      const box = document.querySelector('#pdf-container .pdf-page') as HTMLElement;
      const scaler = document.querySelector('#pdf-container .pdf-scaler') as HTMLElement;
      return { sameCanvas: cv.dataset.mark === 'orig', backing: cv.width, css: parseFloat(cv.style.width),
               box: parseFloat(box.style.width), scaler: scaler.style.transform };
    });
    expect(after.sameCanvas).toBe(true);          // el canvas NO se recrea
    expect(after.backing).toBe(before.backing);   // no se re-renderiza (backing intacto)
    expect(after.css).toBe(before.css);           // el canvas se muestra igual; escala el scaler
    expect(after.scaler).toContain('scale(2.5)');
    expect(Math.abs(after.box - before.box * 2.5)).toBeLessThan(2);   // la caja crece a fit·2.5
  });

  // ADR-019bis · Capa de detalle: al PARAR a zoom alto se superpone un parche del trozo
  // visible a la resolución exacta, SIN tocar el canvas base (que nunca se retira → nunca
  // hay hueco en blanco). Es lo que permite que el base sea barato en memoria.
  test('a zoom alto aparece un parche de detalle encima del base, sin tocarlo', async ({ page }) => {
    await openPdf(page);
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const cv = document.querySelector('#pdf-container canvas') as HTMLCanvasElement;
      cv.dataset.mark = 'orig';
    });

    const r = await page.evaluate(async () => {
      const P: any = await import('/js/pdf-reader.js');
      P.setZoom(4, { x: 195, y: 390 });
      await new Promise((res) => setTimeout(res, 900));   // DETAIL_IDLE_MS + render
      const scaler = document.querySelector('#pdf-container .pdf-scaler') as HTMLElement;
      const base = scaler.querySelector('canvas:not(.pdf-detail)') as HTMLCanvasElement;
      const det = scaler.querySelector('canvas.pdf-detail') as HTMLCanvasElement;
      const kids = Array.from(scaler.children).map((el) => el.className || el.tagName.toLowerCase());
      return {
        hasDetail: !!det,
        baseIntact: base?.dataset.mark === 'orig' && base.width > 0,
        // Densidad = px de backing por px CSS mostrado (antes del scale del scaler).
        baseDensity: base ? base.width / parseFloat(base.style.width) : 0,
        detDensity: det ? det.width / parseFloat(det.style.width) : 0,
        detArea: det ? det.width * det.height : 0,
        order: kids,
      };
    });

    expect(r.hasDetail).toBe(true);
    expect(r.baseIntact).toBe(true);                            // el base sigue ahí, intacto
    expect(r.detDensity).toBeGreaterThan(r.baseDensity * 1.5);  // el parche es más nítido
    expect(r.detArea).toBeLessThanOrEqual(4.5e6);               // memoria acotada (DETAIL_MAX_AREA)
    // base → parche → capa de texto (que debe quedar arriba para seleccionar).
    expect(r.order.indexOf('pdf-detail')).toBeGreaterThan(0);
    expect(r.order.indexOf('pdf-detail')).toBeLessThan(r.order.indexOf('textLayer'));

    // Al volver a zoom bajo el base ya da de sobra → el parche se suelta (memoria).
    const gone = await page.evaluate(async () => {
      const P: any = await import('/js/pdf-reader.js');
      P.setZoom(1);
      await new Promise((res) => setTimeout(res, 900));
      return !document.querySelector('#pdf-container canvas.pdf-detail');
    });
    expect(gone).toBe(true);
  });

  // Modo scroll: el zoom también funciona (leer PDFs técnicos en móvil/tablet).
  test('el zoom funciona en modo scroll continuo', async ({ page }) => {
    await openPdf(page);
    await page.waitForTimeout(300);
    const r = await page.evaluate(async () => {
      const P: any = await import('/js/pdf-reader.js');
      await P.setReadingMode('scroll');
      await new Promise((res) => setTimeout(res, 400));
      const box0 = parseFloat((document.querySelector('#pdf-container .pdf-page') as HTMLElement).style.width);
      const backing0 = (document.querySelector('#pdf-container canvas') as HTMLCanvasElement).width;
      P.setZoom(2, { x: 195, y: 390 });
      await new Promise((res) => setTimeout(res, 300));
      const box1 = parseFloat((document.querySelector('#pdf-container .pdf-page') as HTMLElement).style.width);
      const backing1 = (document.querySelector('#pdf-container canvas') as HTMLCanvasElement).width;
      return { box0, box1, backing0, backing1, hasLayer: !!document.getElementById('pdf-zoom-layer') };
    });
    expect(r.hasLayer).toBe(true);
    expect(Math.abs(r.box1 - r.box0 * 2)).toBeLessThan(2);   // caja ×2 en scroll
    expect(r.backing1).toBe(r.backing0);                     // sin re-render también en scroll
  });

  // Pinch de trackpad en escritorio (llega como ráfaga de wheel con ctrlKey y Δ pequeños):
  // el zoom debe ser PROPORCIONAL al gesto (antes: paso fijo 1.12 por evento → 20 eventos
  // suaves disparaban el zoom a ~6.7×) y durante la ráfaga solo escala el layer (preview
  // GPU, sin reflow); se hornea al acabar la ráfaga.
  test('el pinch de trackpad (wheel+ctrlKey) es proporcional y hornea al acabar la ráfaga', async ({ page }) => {
    await openPdf(page);
    await page.waitForTimeout(300);
    const r = await page.evaluate(async () => {
      const P: any = await import('/js/pdf-reader.js');
      const el = document.getElementById('pdf-container')!;
      const box = () => parseFloat((document.querySelector('#pdf-container .pdf-page') as HTMLElement).style.width);
      const fit = box();
      for (let i = 0; i < 20; i++) {   // ráfaga tipo trackpad: 20 eventos de Δ-10
        el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -10, clientX: 195, clientY: 390 }));
      }
      const layer = document.getElementById('pdf-zoom-layer') as HTMLElement;
      const during = { transform: layer.style.transform, box: box() };
      await new Promise((res) => setTimeout(res, 350));      // > WHEEL_IDLE_MS → hornea
      return { fit, during, boxAfter: box(), layerAfter: layer.style.transform, zoom: P.getZoom() };
    });
    expect(r.during.transform).toContain('scale(');   // durante la ráfaga: preview en el layer...
    expect(r.during.box).toBe(r.fit);                 // ...sin tocar el layout de las páginas
    // 20 eventos de Δ-10 → zoom = e^(200·0.0025) ≈ 1.65: dosificable, no saturado al máximo.
    expect(r.zoom).toBeGreaterThan(1.5);
    expect(r.zoom).toBeLessThan(2);
    expect(r.layerAfter).toBe('');                    // horneado: layer en identidad...
    expect(Math.abs(r.boxAfter - r.fit * r.zoom)).toBeLessThan(2);   // ...y caja a fit·zoom
  });

  // Safari (macOS) no emite wheel+ctrlKey para el pinch de trackpad: usa gesturestart/
  // gesturechange/gestureend con e.scale acumulado. Antes esta ruta no existía → el pinch
  // hacía el zoom nativo de página completa en vez de ampliar el PDF.
  test('el pinch de Safari (gesture events) hace zoom y hornea al soltar', async ({ page }) => {
    await openPdf(page);
    await page.waitForTimeout(300);
    const r = await page.evaluate(async () => {
      const P: any = await import('/js/pdf-reader.js');
      const el = document.getElementById('pdf-container')!;
      const ev = (type: string, scale: number) => {
        const e: any = new Event(type, { bubbles: true, cancelable: true });
        e.scale = scale; e.clientX = 195; e.clientY = 390;
        el.dispatchEvent(e);
      };
      const box = () => parseFloat((document.querySelector('#pdf-container .pdf-page') as HTMLElement).style.width);
      const fit = box();
      ev('gesturestart', 1);
      ev('gesturechange', 1.6);
      ev('gesturechange', 2.2);
      const layer = document.getElementById('pdf-zoom-layer') as HTMLElement;
      const during = layer.style.transform;
      ev('gestureend', 2.2);
      await new Promise((res) => setTimeout(res, 100));
      return { fit, during, boxAfter: box(), zoom: P.getZoom() };
    });
    expect(r.during).toContain('scale(2.2)');         // preview en vivo con e.scale
    expect(r.zoom).toBeCloseTo(2.2, 1);
    expect(Math.abs(r.boxAfter - r.fit * 2.2)).toBeLessThan(2);   // horneado al soltar
  });

  // En MÓVIL, la barra de URL se pliega/despliega al hacer gestos y eso emite `resize`. Cada
  // aviso disparaba un rerender() completo: el contenedor se vaciaba y la vista saltaba al
  // principio de la página ("se recarga y me mueve la vista" al ampliar con dos dedos). El
  // ajuste solo depende del ANCHO, así que un cambio de alto no debe tocar NADA.
  test('un resize que solo cambia el alto no reconstruye ni mueve la vista', async ({ page }) => {
    await openPdf(page);
    await page.waitForTimeout(300);
    await page.evaluate(async () => {
      const P: any = await import('/js/pdf-reader.js');
      P.setZoom(6, { x: 195, y: 390 });          // suficiente para que la página desborde
      const c = document.getElementById('pdf-container')!;
      c.scrollTop = 200;
      (document.querySelector('#pdf-container canvas') as HTMLElement).dataset.mark = 'orig';
    });
    await page.setViewportSize({ width: 390, height: 640 });   // solo el alto (barra de URL)
    await page.waitForTimeout(500);                            // más que el debounce de 200ms

    const r = await page.evaluate(async () => {
      const P: any = await import('/js/pdf-reader.js');
      const cv = document.querySelector('#pdf-container canvas') as HTMLCanvasElement;
      return { sameCanvas: cv.dataset.mark === 'orig', zoom: P.getZoom(),
               scrollTop: document.getElementById('pdf-container')!.scrollTop };
    });
    expect(r.sameCanvas).toBe(true);          // no se reconstruyó el contenedor
    expect(r.zoom).toBeCloseTo(6, 1);         // el zoom sobrevive
    expect(r.scrollTop).toBeGreaterThan(150); // y la posición de lectura, también
  });

  // Cambio de ancho DE VERDAD (rotar, abrir el panel): hay que re-ajustar, pero EN SITIO —
  // sin vaciar el contenedor ni saltar al principio de la página.
  test('un cambio de ancho re-ajusta sin reconstruir y conserva la página', async ({ page }) => {
    await openPdf(page);
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      (document.querySelector('#pdf-container canvas') as HTMLElement).dataset.mark = 'orig';
    });
    const before = await page.evaluate(() => parseFloat(
      (document.querySelector('#pdf-container .pdf-page') as HTMLElement).style.width));

    await page.setViewportSize({ width: 700, height: 780 });
    await page.waitForTimeout(600);

    const after = await page.evaluate(() => {
      const box = document.querySelector('#pdf-container .pdf-page') as HTMLElement;
      const cv = document.querySelector('#pdf-container canvas') as HTMLCanvasElement;
      return { box: parseFloat(box.style.width), css: parseFloat(cv.style.width),
               liveCanvas: cv.width > 0 };
    });
    expect(after.box).toBeGreaterThan(before);              // se re-ajusta al nuevo ancho
    expect(after.css).toBeCloseTo(after.box, 0);            // el canvas acompaña (sin hueco)
    expect(after.liveCanvas).toBe(true);                    // nunca se queda en blanco
  });
});

// El pinch en modo SCROLL, ya avanzado en el documento: el hueco entre páginas (gap) se
// escala durante el preview pero antes NO al hornear, así que al soltar los dedos la vista
// pegaba un salto proporcional a cuántas páginas llevabas por encima.
test.describe('PDF zoom en scroll continuo (multipágina)', () => {
  test.use({ viewport: { width: 390, height: 780 } });
  test('el pinch mantiene el punto focal aunque haya páginas (y huecos) por encima', async ({ page }) => {
    await page.goto('/index.html');
    const fc = page.waitForEvent('filechooser');
    await page.click('.lib-empty .lib-upload');
    await (await fc).setFiles(path.join(__dirname, '..', 'evals', 'fixtures', 'p3-constitucion.pdf'));
    await page.waitForSelector('#pdf-container canvas', { timeout: 30000 });

    await page.evaluate(async () => {
      const P: any = await import('/js/pdf-reader.js');
      await P.setReadingMode('scroll');
      await new Promise((r) => setTimeout(r, 600));
      P.goTo(6);                                    // bien entrado el documento: varios gaps arriba
    });
    await page.waitForTimeout(600);

    const focal = { x: 195, y: 400 };
    // Qué punto del contenido cae bajo el foco, medido contra la página que hay ahí.
    const probe = (f: {x: number, y: number}) => page.evaluate((f) => {
      const els = Array.from(document.querySelectorAll('#pdf-container .pdf-page')) as HTMLElement[];
      const el = els.find((p) => { const r = p.getBoundingClientRect(); return f.y >= r.top && f.y <= r.bottom; });
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { page: el.dataset.page, fy: (f.y - r.top) / r.height };
    }, f);

    const before = await probe(focal);
    expect(before).not.toBeNull();

    await page.evaluate(async (f) => {
      const P: any = await import('/js/pdf-reader.js');
      P.setZoom(P.getZoom() * 1.8, f);
    }, focal);
    await page.waitForTimeout(300);

    const after = await probe(focal);
    expect(after).not.toBeNull();
    expect(after!.page).toBe(before!.page);                       // sigue la misma página
    expect(Math.abs(after!.fy - before!.fy)).toBeLessThan(0.03);  // y el mismo punto de ella

    // El hueco entre páginas escala con el zoom. Durante el pinch se escala el layer ENTERO
    // (huecos incluidos); si al hornear el hueco volviera a 12px fijos, lo que hay por encima
    // del foco se recolocaría al soltar los dedos — el salto que se veía.
    const g = await page.evaluate(async () => {
      const P: any = await import('/js/pdf-reader.js');
      const els = Array.from(document.querySelectorAll('#pdf-container .pdf-page')) as HTMLElement[];
      const a = els[0].getBoundingClientRect(), b = els[1].getBoundingClientRect();
      return { gap: b.top - a.bottom, zoom: P.getZoom() };
    });
    expect(g.zoom).toBeGreaterThan(1.5);
    expect(g.gap).toBeCloseTo(12 * g.zoom, 0);
  });
});

// Márgenes: en una pantalla ANCHA (landscape) la página se centra con margen simétrico. Antes
// el contenedor estaba en display:flex, lo que encogía #pdf-zoom-layer a su contenido y lo
// pegaba a la izquierda → toda la franja gris a la derecha ("márgenes raros" del usuario).
test.describe('PDF márgenes centrados', () => {
  test.use({ viewport: { width: 900, height: 420 } });
  test('la página va centrada (margen izq ≈ der) en landscape, sin franja gris', async ({ page }) => {
    await openPdf(page);
    await page.waitForTimeout(400);
    const g = await page.evaluate(() => {
      const c = document.getElementById('pdf-container')!;
      const p = document.querySelector('#pdf-container .pdf-page')!;
      const cb = c.getBoundingClientRect(), pb = p.getBoundingClientRect();
      return { display: c.style.display, left: pb.left - cb.left, right: cb.right - pb.right };
    });
    expect(g.display).toBe('block');                 // NO flex (evita el pegado a la izquierda)
    expect(Math.abs(g.left - g.right)).toBeLessThan(3);   // centrado: márgenes simétricos
  });
});

// Inmersivo en PDF (móvil): el botón ⤢ queda habilitado y tocar el centro alterna las barras
// (estilo Play Books), igual que en EPUB. Antes en PDF no había forma de ocultar los menús.
test.describe('PDF inmersivo (ocultar barras)', () => {
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
  test('el botón ⤢ se habilita y el tap central alterna las barras', async ({ page }) => {
    await openPdf(page);
    await page.waitForTimeout(300);
    expect(await page.locator('#immersive-toggle').isDisabled()).toBe(false);
    const a = await page.evaluate(() => document.body.classList.contains('immersive'));
    await page.touchscreen.tap(195, 390);
    await page.waitForTimeout(200);
    const b = await page.evaluate(() => document.body.classList.contains('immersive'));
    expect(b).toBe(!a);                              // el tap alterna
    await page.touchscreen.tap(195, 390);
    await page.waitForTimeout(200);
    const c = await page.evaluate(() => document.body.classList.contains('immersive'));
    expect(c).toBe(a);                               // y vuelve
  });
});

// PDF3 · El subrayado del MÓVIL salía descuadrado. Al mantener pulsado, el navegador
// selecciona una PALABRA y ahí llega el `touchend`; después el usuario arrastra las asas para
// extender la selección, pero ese gesto se lo queda el navegador y no emite más eventos
// táctiles. Se guardaba la palabra inicial en vez de lo que se veía marcado (medido: 82px
// guardados frente a 322 visibles). La captura se mantiene viva con `selectionchange`.
test('PDF3: se guarda la selección AMPLIADA con las asas, no la del touchend', async ({ page }) => {
  await openPdf(page);
  await page.waitForSelector('#pdf-container .textLayer span', { timeout: 15000 });
  const out = await page.evaluate(async () => {
    const H: any = await import('/js/highlights.js');
    const spans = [...document.querySelectorAll('#pdf-container .textLayer span')] as HTMLElement[];
    const layer = spans[0].closest('.textLayer')!;
    const sel = window.getSelection()!;

    // 1) Long-press: una palabra + touchend.
    const r1 = document.createRange();
    r1.setStart(spans[0].firstChild!, 0);
    r1.setEnd(spans[0].firstChild!, Math.min(5, spans[0].textContent!.length));
    sel.removeAllRanges(); sel.addRange(r1);
    document.getElementById('pdf-container')!.dispatchEvent(new TouchEvent('touchend', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    const alLevantarElDedo = sel.toString();

    // 2) Asas: se amplía SIN más eventos táctiles.
    const r2 = document.createRange();
    r2.selectNodeContents(layer);
    sel.removeAllRanges(); sel.addRange(r2);
    await new Promise((r) => setTimeout(r, 50));
    const anchoVisible = r2.getBoundingClientRect().width;

    // 3) Se toca el color.
    (document.querySelector('#highlight-tooltip .highlight-color') as HTMLElement).click();
    const saved = H.getByPage(1)[H.getByPage(1).length - 1];
    const wrapper = document.querySelector('.pdf-page') as HTMLElement;
    const anchoGuardado = (saved.rects || []).reduce((m: number, r: any) => Math.max(m, r.width), 0)
      * wrapper.getBoundingClientRect().width;
    return { alLevantarElDedo, textoGuardado: saved.text, anchoVisible, anchoGuardado };
  });
  expect(out.alLevantarElDedo).toBe('Hello');                      // lo que había en el touchend
  expect(out.textoGuardado).toContain('PDF test page');            // lo que se guarda es lo ampliado
  expect(Math.abs(out.anchoGuardado - out.anchoVisible)).toBeLessThan(3);
});

// Y la geometría del repintado, que es lo primero que se sospecha cuando algo "se descuadra":
// los rects fraccionales tienen que caer sobre el texto a cualquier zoom.
test('PDF3: el subrayado se repinta sobre su texto también con zoom', async ({ page }) => {
  await openPdf(page);
  await page.waitForSelector('#pdf-container .textLayer span', { timeout: 15000 });
  const d = await page.evaluate(async () => {
    const HU: any = await import('/js/highlights-ui.js');
    const H: any = await import('/js/highlights.js');
    const P: any = await import('/js/pdf-reader.js');
    const span = document.querySelector('#pdf-container .textLayer span') as HTMLElement;
    const wrapper = span.closest('.pdf-page') as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(span);
    H.addPdf(1, HU.pdfFractionalRects(range, wrapper), span.textContent || '', '#ffd54f', 'p1');

    const deltas: number[] = [];
    for (const z of [1, 1.8]) {
      P.setZoom(z);
      await new Promise((r) => setTimeout(r, 250));
      HU.drawPdfHighlights(1);
      const rr = document.createRange();
      rr.selectNodeContents(span);
      const s = rr.getBoundingClientRect();
      const painted = document.querySelector('.pdf-hl')!.getBoundingClientRect();
      deltas.push(Math.abs(painted.left - s.left), Math.abs(painted.top - s.top), Math.abs(painted.width - s.width));
    }
    return Math.max(...deltas);
  });
  expect(d).toBeLessThan(1);   // sub-píxel a zoom 1 y 1.8
});

// La contrapartida de mantener viva la captura: si la barra se recolocara en CADA cambio de
// selección, perseguiría al dedo mientras se arrastra el asa (llegan decenas de eventos por
// segundo) — empeorando justo la parte incómoda. El dato se refresca siempre; la barra, solo
// cuando la selección se queda quieta.
test('PDF3: la barra no persigue al dedo mientras se ajusta la selección', async ({ page }) => {
  await openPdf(page);
  await page.waitForSelector('#pdf-container .textLayer span', { timeout: 15000 });
  const out = await page.evaluate(async () => {
    const spans = [...document.querySelectorAll('#pdf-container .textLayer span')] as HTMLElement[];
    const layer = spans[0].closest('.textLayer')!;
    const sel = window.getSelection()!;
    const tt = document.getElementById('highlight-tooltip')!;

    const r1 = document.createRange();
    r1.setStart(spans[0].firstChild!, 0);
    r1.setEnd(spans[0].firstChild!, 3);
    sel.removeAllRanges(); sel.addRange(r1);
    document.getElementById('pdf-container')!.dispatchEvent(new TouchEvent('touchend', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    const start = tt.getBoundingClientRect().left;

    const posiciones: number[] = [];
    for (let i = 4; i <= 18; i++) {
      const r = document.createRange();
      r.setStart(spans[0].firstChild!, 0);
      r.setEnd(spans[0].firstChild!, Math.min(i, spans[0].textContent!.length));
      sel.removeAllRanges(); sel.addRange(r);
      await new Promise((res) => setTimeout(res, 20));
      posiciones.push(Math.round(tt.getBoundingClientRect().left));
    }

    const rr = document.createRange();
    rr.selectNodeContents(layer);
    sel.removeAllRanges(); sel.addRange(rr);
    await new Promise((r) => setTimeout(r, 500));
    return { start, distintasDuranteElArrastre: new Set(posiciones).size, alQuedarseQuieta: tt.getBoundingClientRect().left };
  });
  expect(out.distintasDuranteElArrastre).toBe(1);            // quieta mientras se arrastra
  expect(out.alQuedarseQuieta).not.toBeCloseTo(out.start, 0); // y se recoloca al parar
});

// ADR-026 · Papel del PDF: tinte (multiply) para los claros e inversión para «Noche», los
// dos bajo la misma palanca `data-pdf-paper`. Todo el pintado es CSS: el bitmap no se toca,
// no se vuelve a pdf.js y no se re-rasteriza nada.
test.describe('PDF papel (tinte + noche)', () => {
  const setPaper = (page, v: string) => page.evaluate(async (val) => {
    const S: any = await import('/js/settings.js');
    S.set('pdfPaper', val);
    await new Promise((r) => setTimeout(r, 60));
  }, v);

  test('los tintes claros pintan una capa multiply; «Noche» invierte el canvas', async ({ page }) => {
    await openPdf(page);
    await page.waitForTimeout(300);

    // Por defecto (auto sobre tema claro) NO hay capa de tinte: el papel ya es blanco y no
    // se paga un contexto de mezcla por página para nada.
    await setPaper(page, 'white');
    const blanco = await page.evaluate(() => {
      const w = document.querySelector('#pdf-container .pdf-page') as HTMLElement;
      const cv = document.querySelector('#pdf-container .pdf-scaler canvas') as HTMLCanvasElement;
      return { after: getComputedStyle(w, '::after').display, filtro: getComputedStyle(cv).filter };
    });
    expect(blanco.after).toBe('none');
    expect(blanco.filtro === 'none' || blanco.filtro === '').toBe(true);

    await setPaper(page, 'cream');
    const crema = await page.evaluate(() => {
      const w = document.querySelector('#pdf-container .pdf-page') as HTMLElement;
      const cv = document.querySelector('#pdf-container .pdf-scaler canvas') as HTMLCanvasElement;
      const st = getComputedStyle(w, '::after');
      return {
        attr: document.documentElement.getAttribute('data-pdf-paper'),
        after: st.display, blend: st.mixBlendMode, bg: st.backgroundColor,
        filtro: getComputedStyle(cv).filter,
      };
    });
    expect(crema.attr).toBe('cream');
    expect(crema.after).toBe('block');
    expect(crema.blend).toBe('multiply');         // solo oscurece: papel a crema, tinta intacta
    expect(crema.bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(crema.filtro === 'none' || crema.filtro === '').toBe(true);   // el tinte NO invierte

    await setPaper(page, 'night');
    const noche = await page.evaluate(() => {
      const w = document.querySelector('#pdf-container .pdf-page') as HTMLElement;
      const cv = document.querySelector('#pdf-container .pdf-scaler canvas') as HTMLCanvasElement;
      return { after: getComputedStyle(w, '::after').display, filtro: getComputedStyle(cv).filter };
    });
    // Noche NO es un tinte más: multiplicar por negro dejaría la página entera en negro.
    expect(noche.after).toBe('none');
    expect(noche.filtro).toContain('invert');
    expect(noche.filtro).toContain('hue-rotate');
  });

  test('en «Noche» los subrayados cambian a screen (con multiply serían invisibles)', async ({ page }) => {
    await openPdf(page);
    await selectPdfText(page);
    await page.locator('#highlight-tooltip .highlight-color').first().click();
    await expect(page.locator('#pdf-container .pdf-hl').first()).toBeVisible();

    const claro = await page.evaluate(() => getComputedStyle(
      document.querySelector('#pdf-container .pdf-hl-group')!).mixBlendMode);
    expect(claro).toBe('multiply');

    await setPaper(page, 'night');
    const oscuro = await page.evaluate(() => getComputedStyle(
      document.querySelector('#pdf-container .pdf-hl-group')!).mixBlendMode);
    expect(oscuro).toBe('screen');
  });

  test('el papel no toca el bitmap: el agente de visión sigue viendo la página real', async ({ page }) => {
    await openPdf(page);
    await page.waitForTimeout(400);
    const shot = () => page.evaluate(async () => {
      const P: any = await import('/js/pdf-reader.js');
      return P.capturePageImage(256);
    });

    await setPaper(page, 'white');
    const enBlanco = await shot();
    expect(enBlanco).toBeTruthy();

    // Ni el tinte ni la inversión pasan por el canvas, así que lo que se le manda al modelo
    // es byte a byte lo mismo. Si esto se rompe, es que el papel se está rasterizando.
    await setPaper(page, 'sepia');
    expect(await shot()).toBe(enBlanco);
    await setPaper(page, 'night');
    expect(await shot()).toBe(enBlanco);
  });

  test('en «auto» el papel sigue al tema de la app (la incoherencia que arregla)', async ({ page }) => {
    await openPdf(page);
    const paper = async (theme: string) => page.evaluate(async (th) => {
      const S: any = await import('/js/settings.js');
      S.set('theme', th);
      S.set('pdfPaper', 'auto');
      await new Promise((r) => setTimeout(r, 60));
      return document.documentElement.getAttribute('data-pdf-paper');
    }, theme);

    expect(await paper('light')).toBe('white');
    expect(await paper('sepia')).toBe('cream');   // antes: app en sepia, folio blanco deslumbrando
    expect(await paper('dark')).toBe('night');
  });
});
