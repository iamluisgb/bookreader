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

    // Espera a que la posición SE ASIENTE: goTo hace un segundo `display` que corrige el
    // salto, así que leer demasiado pronto mide la página intermedia. Se espera a que el
    // cfi de inicio no cambie entre dos lecturas, con tope.
    //
    // Deliberadamente NO se espera "hasta que el texto coincida": eso convertiría el
    // test en una profecía autocumplida, y lo que mide es justo cuántas citas caen mal.
    const settle = async () => {
      let prev = null;
      for (let i = 0; i < 40; i++) {                 // tope 2 s
        await new Promise((r) => setTimeout(r, 50));
        const cfi = rendition.currentLocation()?.start?.cfi ?? null;
        if (cfi && cfi === prev) return;
        prev = cfi;
      }
    };

    let ok = 0;
    const misses: string[] = [];
    for (const { id, key } of sample) {
      await rendition.display(0);            // salta lejos para forzar la navegación
      await Epub.goTo(seg.anchors.get(id).cfi);  // camino REAL de la app (con el fix)
      await settle();
      if (pageText().includes(key)) ok++; else misses.push(id);
    }
    return { n: sample.length, ok, misses };
  });

  // Antes del fix: ~10/16. Con el fix: 15/16 (queda alguna arista de epub.js). Exigimos ≥14/16.
  expect(res.ok, `citas que cayeron en la página correcta (fallos: ${res.misses.join(', ')})`).toBeGreaterThanOrEqual(14);
  expect(res.n).toBeGreaterThanOrEqual(14);
});

// Regresión del RESALTADO de la cita (no solo del salto): el CFI del ancla debe cubrir el
// bloque entero. `selectNodeContents` daba offsets de HIJO que `cfiFromRange` emitía como
// offsets de CARÁCTER (`,/1:0,/1:3`), así que el resaltado marcaba 1-7 caracteres — o nada,
// ancho 0, cuando el primer hijo era un elemento. Se mide el ancho pintado, que es lo que
// el usuario ve: un CFI "válido" pero degenerado pasaba cualquier aserción sobre el string.
test('la cita resalta el pasaje, no un puñado de caracteres', async ({ page }) => {
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', path.join(__dirname, 'test.epub'));
  await page.waitForSelector('#epub-container iframe', { timeout: 15000 });

  const res = await page.evaluate(async () => {
    const Epub: any = await import('/js/epub-reader.js');
    const Seg: any = await import('/js/ai/segment.js');
    const rendition = Epub.getRendition();
    const seg = await Seg.segmentBook(Epub.getBook());

    const lineOf = new Map<string, string>();
    for (const line of seg.annotatedText.split('\n')) {
      const m = line.match(/^\[\[(a\d+)\]\]\s+(.*)$/);
      if (m) lineOf.set(m[1], m[2]);
    }
    const ids = [...seg.anchors.keys()]
      .filter((id) => seg.anchors.get(id).cfi && (lineOf.get(id) || '').length >= 120);

    // Ancho pintado del resaltado, sondeado hasta que marks-pane lo coloca (no un sleep
    // fijo: bajo carga tarda más, y este fichero ya es de los lentos de la suite).
    const paintedWidth = async () => {
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const rects = [...document.querySelectorAll('g.ai-cite-hl rect')] as any[];
        const w = rects.reduce((a, r) => a + r.getBoundingClientRect().width, 0);
        if (w > 0) return Math.round(w);
      }
      return 0;
    };

    const out: { id: string; width: number }[] = [];
    for (const k of [1, 2, 3]) {
      const id = ids[Math.floor(ids.length * k / 4)];
      if (!id) continue;
      const cfi = seg.anchors.get(id).cfi;
      await rendition.display(0);
      await Epub.goTo(cfi);
      rendition.annotations.highlight(cfi, {}, () => {}, 'ai-cite-hl', { fill: 'red' });
      out.push({ id, width: await paintedWidth() });
      try { rendition.annotations.remove(cfi, 'highlight'); } catch { /* ya retirado */ }
      document.querySelectorAll('g.ai-cite-hl').forEach((n) => n.remove());
    }
    return out;
  });

  expect(res.length).toBe(3);
  // Un pasaje de ≥120 caracteres ocupa cientos de px. El bug daba 0-60 px.
  for (const { id, width } of res) {
    expect(width, `ancho resaltado de ${id}`).toBeGreaterThan(300);
  }
});
