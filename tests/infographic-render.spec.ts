import { test, expect } from '@playwright/test';

// P29 · Render de la infografía. Módulo puro (datos → SVG), así que se ejercita importándolo
// directamente, sin LLM ni libro. La geometría es lo único que puede romperse en silencio: un
// bloque que desborda el lienzo no da error, sale recortado en el PNG.

const MIN = { title: 'Un libro cualquiera' };

// Muestra del tamaño que produce el generador en un libro normal: 8 ideas, 3 paneles, cierre
// y cita. Es la que fija el presupuesto de densidad.
const FULL = {
  kicker: 'Un manual de iniciación',
  title: 'Pensar en sistemas',
  author: 'Donella Meadows',
  thesis:
    'Hay problemas que vuelven una y otra vez por mucho que cambien las personas que los gestionan, y la causa está en la estructura en la que están metidos.',
  ideas: Array.from({ length: 8 }, (_, i) => ({
    ico: 'note',
    head: `Idea clave número ${i + 1}`,
    body: 'Una explicación de dos o tres líneas que ocupa el ancho de la columna y obliga a medir el texto de verdad, porque en un póster un bloque desbordado se recorta y nadie se entera.',
  })),
  panels: [
    {
      kind: 'flow',
      title: 'La cadena del argumento',
      steps: [
        { ico: 'columns', head: 'Primer paso', body: 'Lo que ocurre antes que todo lo demás' },
        { ico: 'chart', head: 'Segundo paso', body: 'Lo que se deriva del primero' },
        { ico: 'books', head: 'Tercer paso', body: 'Lo que se acumula sin querer' },
        { ico: 'sparkles', head: 'Cuarto paso', body: 'Lo que decide el desenlace final' },
      ],
    },
    {
      kind: 'cols',
      title: 'Por qué unos se adelantaron',
      cols: [
        {
          ico: 'chart',
          head: 'Qué había cerca',
          sub: 'las especies',
          body: 'El paquete de cereales y ganado disponible en cada sitio no era el mismo.',
        },
        {
          ico: 'target',
          head: 'Cómo se orienta',
          sub: 'latitud',
          body: 'A lo ancho se comparte clima y todo se propaga de vecino a vecino.',
        },
        {
          ico: 'columns',
          head: 'Qué corta el paso',
          sub: 'las barreras',
          body: 'Desiertos y cordilleras deciden si una idea llega al vecino o no.',
        },
        {
          ico: 'books',
          head: 'Cuánta gente conecta',
          sub: 'el tamaño',
          body: 'Más población comunicada significa más inventos y más copias.',
        },
      ],
    },
    {
      kind: 'rows',
      title: 'Dónde tocar, de menos a más potente',
      rows: Array.from({ length: 5 }, (_, i) => ({
        tag: `Nivel ${i + 1}`,
        body: 'Una descripción del nivel con la explicación que da el libro sobre por qué mueve más o menos el resultado.',
      })),
    },
  ],
  aside: [
    {
      ico: 'note',
      label: 'Recuerda',
      body: 'Es un manual de iniciación, no un curso de modelización, y no sustituye al conocimiento de cada campo.',
    },
    {
      ico: 'target',
      label: 'Idea final',
      body: 'Cuando algo falla una y otra vez el problema deja de ser la gente: es la estructura que la rodea.',
    },
  ],
  quote: {
    text: 'Un sistema no se controla: como mucho, se aprende a bailar con él.',
    attribution: 'La tesis de Donella Meadows, resumida',
  },
  footer: 'Creado con BookReader',
};

test.describe('P29 · render de la infografía', () => {
  test('produce un póster vertical con todos los bloques', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(async (data) => {
      const M: any = await import('/js/ai/infographic-render.js');
      const { svg, width, height } = M.renderSvg(data);
      return { width, height, xml: new XMLSerializer().serializeToString(svg) };
    }, FULL);
    expect(r.width).toBe(1080);
    // 9:16 largo: si sale más bajo, algún bloque no se dibujó.
    expect(r.height).toBeGreaterThan(1700);
    for (const needle of [
      'Pensar en sistemas',
      'IDEAS CLAVE',
      'LA CADENA DEL ARGUMENTO',
      'POR QUÉ UNOS SE ADELANTARON',
      'DÓNDE TOCAR',
      'RECUERDA',
      'IDEA FINAL',
      'bailar con él',
    ]) {
      expect(r.xml).toContain(needle);
    }
  });

  // El artefacto se cachea y se compara: dos renders del mismo dato tienen que dar el mismo
  // SVG. Si no, cualquier re-render (reabrir el artefacto) cambiaría el PNG exportado.
  test('es determinista', async ({ page }) => {
    await page.goto('/');
    const same = await page.evaluate(async (data) => {
      const M: any = await import('/js/ai/infographic-render.js');
      const a = new XMLSerializer().serializeToString(M.renderSvg(data).svg);
      const b = new XMLSerializer().serializeToString(M.renderSvg(data).svg);
      return a === b;
    }, FULL);
    expect(same).toBe(true);
  });

  // Un bloque que desborda no falla: se recorta en el PNG y nadie se entera. Se mide la caja
  // real de cada nodo dibujado contra el lienzo.
  test('ningún nodo se sale del lienzo', async ({ page }) => {
    await page.goto('/');
    const bad = await page.evaluate(async (data) => {
      const M: any = await import('/js/ai/infographic-render.js');
      const { svg, width, height } = M.renderSvg(data);
      document.body.appendChild(svg);
      const out: string[] = [];
      for (const el of Array.from(svg.querySelectorAll('text, rect, image'))) {
        const b = (el as SVGGraphicsElement).getBBox();
        if (b.x < -1 || b.y < -1 || b.x + b.width > width + 1 || b.y + b.height > height + 1) {
          out.push(
            `${el.tagName} [${b.x.toFixed(1)},${b.y.toFixed(1)} ${b.width.toFixed(1)}×${b.height.toFixed(1)}]`,
          );
        }
      }
      return out;
    }, FULL);
    expect(bad).toEqual([]);
  });

  // El PNG se rasteriza cargando el SVG como <img>: un documento aislado que no puede pedir
  // recursos externos. Sin las fuentes embebidas, el póster saldría con la fuente del sistema.
  test('el CSS de export lleva las dos familias embebidas', async ({ page }) => {
    await page.goto('/');
    const css = await page.evaluate(async () => {
      const { posterFaceCss } = await import('/js/ui/svg-fonts.js');
      return posterFaceCss();
    });
    expect(css).toContain("font-family:'Inter'");
    expect(css).toContain("font-family:'Source Serif 4'");
    expect(css).toContain('data:font/woff2;base64,');
    expect(css).toContain('font-weight:600');
    expect(css.length).toBeGreaterThan(60000);
  });

  // La densidad es EL riesgo declarado del artefacto: sin tope, un libro largo produce un
  // póster que nadie lee. Aquí se fija el presupuesto de proporción sobre la muestra realista.
  // IG2: el techo sube de 2,4 a 2,9. El póster largo pasó a ser el formato de LEER con zoom o
  // imprimir (con tipos mayores y diagramas); para redes están el carrusel 4:5 y la story 9:16,
  // de tamaño fijo. La muestra es el peor caso: 8 ideas con el cuerpo al tope.
  test('la densidad se queda dentro del presupuesto', async ({ page }) => {
    await page.goto('/');
    const ratio = await page.evaluate(async (data) => {
      const M: any = await import('/js/ai/infographic-render.js');
      const { width, height } = M.renderSvg(data);
      return height / width;
    }, FULL);
    expect(ratio).toBeGreaterThan(1.6);
    expect(ratio).toBeLessThan(2.9);
  });

  // Un póster mínimo (solo titular) no puede reventar: los bloques son opcionales y la
  // plantilla tiene que aguantar que el modelo devuelva poco.
  test('un dato mínimo sigue produciendo un póster válido', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(async (data) => {
      const M: any = await import('/js/ai/infographic-render.js');
      const { svg, width, height } = M.renderSvg(data);
      return { width, height, xml: new XMLSerializer().serializeToString(svg) };
    }, MIN);
    expect(r.width).toBe(1080);
    expect(r.height).toBeGreaterThan(100);
    expect(r.xml).toContain('aria-label="Un libro cualquiera"');
  });

  // El marco de la portada toma su PROPORCIÓN (`coverAspect`): con un marco fijo 2:3, una tapa
  // 7:9 como la de «Diseño de sistemas» se recortaba por los lados.
  test('el marco de la portada respeta su proporción', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(async () => {
      const M: any = await import('/js/ai/infographic-render.js');
      const one = (coverAspect: number) => {
        const { svg } = M.renderSvg({ title: 'T', cover: 'data:image/jpeg;base64,x', coverAspect });
        const img = svg.querySelector('image')!;
        return { w: Number(img.getAttribute('width')), h: Number(img.getAttribute('height')) };
      };
      return { p23: one(2 / 3), p79: one(7 / 9) };
    });
    expect(r.p23.h).toBe(450);
    expect(r.p79.h).toBe(450);
    expect(r.p23.w / r.p23.h).toBeCloseTo(2 / 3, 2);
    expect(r.p79.w / r.p79.h).toBeCloseTo(7 / 9, 2);
    expect(r.p79.w).toBeGreaterThan(r.p23.w);
  });

  // Acento por libro: sale del color de la cubierta y tiñe números, iconos y rótulos. El tono
  // para la banda oscura se DERIVA (aclarado), así que cualquier acento tiene pareja legible.
  test('el acento del libro tiñe el póster y deriva su tono para la banda', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(async () => {
      const M: any = await import('/js/ai/infographic-render.js');
      const xml = (d: any) => new XMLSerializer().serializeToString(M.renderSvg(d).svg);
      const base = xml({ title: 'T', quote: { text: 'Algo', attribution: 'Alguien' } });
      const indigo = xml({
        title: 'T',
        accent: '#4338ca',
        quote: { text: 'Algo', attribution: 'Alguien' },
      });
      return {
        baseGreen: base.includes('#15803d'),
        baseBand: base.includes('#8ac09e'),
        hasAccent: indigo.includes('#4338ca'),
        hasBand: indigo.includes('#a19ce5'),
      };
    });
    expect(r.baseGreen).toBe(true);
    expect(r.baseBand).toBe(true);
    expect(r.hasAccent).toBe(true);
    expect(r.hasBand).toBe(true);
  });

  // El pie de un artefacto que se comparte lleva de dónde sale: libro · autor ↔ marca · url.
  test('el pie lleva libro, marca y url', async ({ page }) => {
    await page.goto('/');
    const xml = await page.evaluate(async () => {
      const M: any = await import('/js/ai/infographic-render.js');
      return new XMLSerializer().serializeToString(
        M.renderSvg({
          title: 'Un libro',
          author: 'Una autora',
          quote: { text: 'Algo' },
          footer: { mark: 'BookReader', url: 'bookreader.raiatech.com' },
        }).svg,
      );
    });
    expect(xml).toContain('UN LIBRO · UNA AUTORA');
    expect(xml).toContain('BOOKREADER');
    expect(xml).toContain('bookreader.raiatech.com'); // la url se deja en minúsculas: se lee y se teclea mejor
  });

  // Como el mapa mental: si alguien toca la paleta y mete un tono claro, el texto se vuelve
  // ilegible sin que nada avise. El mínimo AA sobre el papel es 4,5:1.
  test('toda la paleta de acentos pasa AA sobre el papel', async ({ page }) => {
    await page.goto('/');
    const worst = await page.evaluate(async () => {
      const M: any = await import('/js/ai/infographic-render.js');
      const lum = (hex: string) => {
        const c = hex.replace('#', '');
        const v = [0, 2, 4].map((i) => {
          const u = parseInt(c.slice(i, i + 2), 16) / 255;
          return u <= 0.03928 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
      };
      const ratio = (a: string, b: string) => {
        const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
        return (x + 0.05) / (y + 0.05);
      };
      return Math.min(...M.ACCENTS.map((c: string) => ratio(c, M.POSTER.bg)));
    });
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });

  // El prototipo es el entregable que se MIRA: si la muestra no pinta las dos veces (pantalla
  // y feed) o alguna portada sintética rompe el SVG, aquí se ve.
  test('el prototipo pinta la muestra completa sin errores', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto('/infographic-proto.html');
    await expect(page.locator('#stage svg')).toBeVisible();
    await expect(page.locator('#feed svg')).toBeVisible();
    expect(await page.locator('#stats').textContent()).toMatch(/^1080 × \d+px$/);
    // La portada sintética viaja como data: URI dentro del SVG del póster.
    expect(await page.locator('#stage svg image').count()).toBe(1);
    const options = await page.locator('#sample option').count();
    expect(options).toBeGreaterThan(1);
    for (let i = 0; i < options; i++) {
      await page.locator('#sample').selectOption({ index: i });
      await expect(page.locator('#stats')).toContainText('1080 ×');
    }
    expect(errors).toEqual([]);
  });

    // IG2 · Carrusel 4:5: diapositivas de 1080×1350, ninguna desborda, la primera es la portada
  // y todas llevan la marca; con cita, la última es la cita.
  test('el carrusel sale en diapositivas 4:5 que no desbordan', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(async (data) => {
      const M: any = await import('/js/ai/infographic-render.js');
      await M.ensureFonts();
      const slides = M.renderSlides({ ...data, footer: { mark: 'BookReader', url: 'bookreader.raiatech.com' } });
      const bad: string[] = [];
      for (const [i, s] of slides.entries()) {
        document.body.appendChild(s.svg);
        for (const el of Array.from(s.svg.querySelectorAll('text, image'))) {
          const b = (el as SVGGraphicsElement).getBBox();
          if (b.x < -1 || b.y < -1 || b.x + b.width > s.width + 1 || b.y + b.height > s.height + 1) bad.push(`${i + 1}: ${el.textContent?.slice(0, 30)}`);
        }
        s.svg.remove();
      }
      const xml = (s: any) => new XMLSerializer().serializeToString(s.svg);
      return {
        n: slides.length,
        sizes: [...new Set(slides.map((s: any) => `${s.width}x${s.height}`))],
        bad,
        firstHasTitle: xml(slides[0]).includes('Pensar en sistemas'),
        lastHasQuote: xml(slides[slides.length - 1]).includes('bailar con él'),
        allBranded: slides.every((s: any) => xml(s).includes('#22c55e')),
      };
    }, FULL);
    expect(r.n).toBeGreaterThanOrEqual(8);
    expect(r.sizes).toEqual(['1080x1350']);
    expect(r.bad).toEqual([]);
    expect(r.firstHasTitle).toBe(true);
    expect(r.lastHasQuote).toBe(true);
    expect(r.allBranded).toBe(true);   // el logo (su marcapáginas verde) en cada diapositiva
  });

  // IG2 · Story 9:16: una imagen de 1080×1920 que no desborda por mucho que traiga el dato.
  test('la story sale en 9:16 y no desborda', async ({ page }) => {
    await page.goto('/');
    const bad = await page.evaluate(async (data) => {
      const M: any = await import('/js/ai/infographic-render.js');
      await M.ensureFonts();
      const s = M.renderStory({ ...data, footer: { mark: 'BookReader', url: 'bookreader.raiatech.com' } });
      if (s.width !== 1080 || s.height !== 1920) return [`tamaño ${s.width}x${s.height}`];
      document.body.appendChild(s.svg);
      const out: string[] = [];
      for (const el of Array.from(s.svg.querySelectorAll('text, image'))) {
        const b = (el as SVGGraphicsElement).getBBox();
        if (b.x < -1 || b.y < -1 || b.x + b.width > 1081 || b.y + b.height > 1921) out.push(el.textContent?.slice(0, 30) || el.tagName);
      }
      return out;
    }, FULL);
    expect(bad).toEqual([]);
  });

  // IG2 · Cada idea con página la enseña («p. 42»): la prueba de que no se inventa nada.
  test('las ideas con página la muestran', async ({ page }) => {
    await page.goto('/');
    const xml = await page.evaluate(async () => {
      const M: any = await import('/js/ai/infographic-render.js');
      return new XMLSerializer().serializeToString(M.renderSvg({ title: 'T', ideas: [{ head: 'Una idea', body: 'Con su cuerpo.', page: 42 }] }).svg);
    });
    expect(xml).toContain('p. 42');
  });

  // IG2 · El PDF del carrusel: cabecera, una página por imagen y la tabla xref bien cerrada.
  test('el PDF del carrusel tiene una página por diapositiva', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(async () => {
      const { imagesToPdf } = await import('/js/ui/pdf-images.js');
      const c = document.createElement('canvas'); c.width = 20; c.height = 25;
      c.getContext('2d')!.fillRect(0, 0, 20, 25);
      const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), 'image/jpeg', 0.9));
      const jpeg = new Uint8Array(await blob.arrayBuffer());
      const pdf = imagesToPdf([{ jpeg, px: 20, py: 25 }, { jpeg, px: 20, py: 25 }, { jpeg, px: 20, py: 25 }], 1080, 1350);
      const text = new TextDecoder('latin1').decode(new Uint8Array(await pdf.arrayBuffer()));
      return { head: text.slice(0, 8), count: (text.match(/\/Type \/Page /g) || []).length, kids: /\/Count 3/.test(text), eof: text.trimEnd().endsWith('%%EOF'), type: pdf.type };
    });
    expect(r.head).toBe('%PDF-1.4');
    expect(r.count).toBe(3);
    expect(r.kids).toBe(true);
    expect(r.eof).toBe(true);
    expect(r.type).toBe('application/pdf');
  });

// Opción A · leer en pantalla: el control de zoom lleva el SVG a 1080 px (1:1), que es donde
  // el cuerpo de 13 px se lee de verdad. "Ajustar" vuelve a encajarlo en la caja.
  test('el zoom lleva el póster a tamaño real y vuelve', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto('/infographic-proto.html');
    await expect(page.locator('#stage svg')).toBeVisible();
    const w = () =>
      page
        .locator('#stage svg')
        .evaluate((s) => (s as SVGSVGElement).getBoundingClientRect().width);
    const fit = await w();
    await page.locator('[data-zoom="100"]').click();
    expect(Math.round(await w())).toBe(1080);
    expect(fit).toBeLessThan(1080);
    await page.locator('[data-zoom="fit"]').click();
    expect(Math.round(await w())).toBe(Math.round(fit));
  });

  // Opción A · imprimir: el póster cabe en UNA A4 vertical (si no, saldría partido en dos).
  test('el póster cabe en una A4 al imprimir', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto('/infographic-proto.html');
    await expect(page.locator('#stage svg')).toBeVisible();
    await page.emulateMedia({ media: 'print' });
    const mm = await page.locator('#print-area svg').evaluate((s) => {
      const b = (s as SVGSVGElement).getBoundingClientRect();
      return { w: b.width / (96 / 25.4), h: b.height / (96 / 25.4) };
    });
    await page.emulateMedia({ media: 'screen' });
    expect(mm.h).toBeLessThan(273); // 297 mm − márgenes
    expect(mm.w).toBeLessThan(186); // 210 mm − márgenes
  });
});
