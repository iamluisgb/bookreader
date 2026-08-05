import { test, expect } from '@playwright/test';
import path from 'path';

// Regresión del resaltado de citas en PDF: pinchabas [[aN]], el lector saltaba a la página
// y no se señalaba NADA. El corpus (segment-pdf) une los renglones con un espacio y deshace
// los guiones de corte; la capa de texto de pdf.js concatena sus spans SIN separador. El
// mismo pasaje era "eiusmod tempor" en el corpus y "eiusmodtempor" en el DOM, así que la
// comparación por blancos fallaba en cuanto el pasaje cruzaba un renglón — casi siempre.
//
// El test cruza las dos fuentes REALES (corpus segmentado ↔ capa de texto renderizada) en
// vez de una capa simulada: es justo la frontera donde vivía el bug.
test('las citas de un PDF localizan el pasaje en la página renderizada', async ({ page }) => {
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', path.join(__dirname, 'test-multipage.pdf'));
  await page.waitForSelector('#pdf-container .pdf-page canvas', { timeout: 20000 });

  const res = await page.evaluate(async () => {
    const Pdf: any = await import('/js/pdf-reader.js');
    const Seg: any = await import('/js/ai/segment-pdf.js');
    const Loc: any = await import('/js/pdf-locate.js');

    const seg = await Seg.segmentPdf(Pdf.getDocument());
    // Un pasaje por página (excepto la 1ª, ya visible): la cita navega y luego resalta.
    const targets: any[] = [];
    for (const [id, a] of seg.anchors) {
      if (a.page > 1 && !targets.some(t => t.page === a.page)) {
        const line = seg.annotatedText.split('\n').find((l: string) => l.startsWith(`[[${id}]]`));
        targets.push({ id, page: a.page, text: (line || '').replace(/^\[\[a\d+\]\]\s*/, '') });
      }
    }

    const out: any[] = [];
    for (const t of targets.slice(0, 5)) {
      await Pdf.goTo(t.page);
      const sel = `#pdf-container .pdf-page[data-page="${t.page}"]`;
      const t0 = Date.now();
      let layer: Element | null = null;
      while (Date.now() - t0 < 5000) {
        layer = document.querySelector(sel)?.querySelector('.textLayer') || null;
        if (layer && layer.childElementCount > 0) break;
        await new Promise(r => setTimeout(r, 50));
      }
      const range = layer ? Loc.rangeForText(layer, t.text) : null;
      // Ancho REAL pintado: un rango degenerado (0 rects, o rects vacíos) no resalta nada,
      // aunque el Range exista. Es lo que hay que medir, no si devuelve no-null.
      const rects = range ? [...range.getClientRects()] : [];
      const width = rects.reduce((s, r) => s + r.width, 0);
      out.push({ page: t.page, chars: range?.toString().length ?? 0, width: Math.round(width) });
    }
    return out;
  });

  expect(res.length).toBeGreaterThan(0);
  for (const r of res) {
    expect(r.chars, `página ${r.page} sin pasaje localizado`).toBeGreaterThan(40);
    expect(r.width, `página ${r.page} con resaltado de ancho 0`).toBeGreaterThan(50);
  }
});
