import { test, expect } from '@playwright/test';
import path from 'path';

// Regresión de la navegación de citas: al pinchar un chip [[aN]] del agente, la app llama a
// EpubReader.goTo(cfi). epub.js mal-paginaba el PRIMER display dentro de una sección larga
// (la posición se calcula antes de que asienten las columnas), y ~37% de las citas caían en
// otra página. goTo hace ahora un segundo display que corrige el salto. Este test ejercita el
// camino REAL y comprueba que el pasaje citado queda en la página visible.
test('las citas del agente navegan a la página del pasaje', async ({ page }) => {
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', path.join(__dirname, 'test.epub'));
  await page.waitForSelector('#epub-container iframe', { timeout: 15000 });

  const res = await page.evaluate(async () => {
    const Epub: any = await import('/js/epub-reader.js');
    const Seg: any = await import('/js/ai/segment.js');
    const book = Epub.getBook();
    const rendition = Epub.getRendition();
    const seg = await Seg.segmentBook(book);

    const lineOf = new Map<string, string>();
    for (const line of seg.annotatedText.split('\n')) {
      const m = line.match(/^\[\[(a\d+)\]\]\s+(.*)$/);
      if (m) lineOf.set(m[1], m[2]);
    }
    const norm = (s: string) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

    // Texto de la página visible: rango entre start y end de currentLocation.
    const pageText = () => {
      const loc = rendition.currentLocation();
      try {
        const c = rendition.getContents();
        const contents = Array.isArray(c) ? c[0] : c;
        const s = contents.range(loc.start.cfi), e = contents.range(loc.end.cfi);
        const range = contents.document.createRange();
        range.setStart(s.startContainer, s.startOffset);
        range.setEnd(e.endContainer, e.endOffset);
        return norm(range.toString());
      } catch { return ''; }
    };

    const ids = [...seg.anchors.keys()].filter((id) => seg.anchors.get(id).cfi);
    // 16 anclas repartidas, con clave de texto suficientemente larga para no dar falsos positivos.
    const sample = Array.from({ length: 16 }, (_, k) => ids[Math.floor(ids.length * (k + 0.5) / 16)])
      .filter(Boolean)
      .map((id) => ({ id, key: norm(lineOf.get(id) || '').slice(0, 22) }))
      .filter((x) => x.key.length >= 12);

    let ok = 0;
    const misses: string[] = [];
    for (const { id, key } of sample) {
      await rendition.display(0);            // salta lejos para forzar la navegación
      await Epub.goTo(seg.anchors.get(id).cfi);  // camino REAL de la app (con el fix)
      await new Promise((r) => setTimeout(r, 120));
      if (pageText().includes(key)) ok++; else misses.push(id);
    }
    return { n: sample.length, ok, misses };
  });

  // Antes del fix: ~10/16. Con el fix: 15/16 (queda alguna arista de epub.js). Exigimos ≥14/16.
  expect(res.ok, `citas que cayeron en la página correcta (fallos: ${res.misses.join(', ')})`).toBeGreaterThanOrEqual(14);
  expect(res.n).toBeGreaterThanOrEqual(14);
});
