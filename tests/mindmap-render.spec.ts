import { test, expect } from '@playwright/test';

// P14 F3/F4 · Geometría y export del mapa mental. No necesita LLM ni libro: el módulo de
// render es puro (árbol → SVG), así que se ejercita importándolo directamente.

const TWO_THIN = {
  title: 'Libro',
  branches: [
    { label: 'Una rama con nombre largo', children: [{ label: 'hoja uno', src: 'a0' }] },
    { label: 'Otra rama con nombre largo', children: [{ label: 'hoja dos', src: 'a1' }] },
  ],
};

test.describe('P14 · render del mapa', () => {
  // El fallo antiguo: solo las hojas tenían anticolisión. Las ramas iban a un radio FIJO
  // (210) en el ángulo medio de sus hojas, así que dos ramas con una hoja cada una salían
  // superpuestas. Ahora el radio del anillo lo fija la cuerda que piden sus vecinos.
  test('dos ramas de una sola hoja no se superponen', async ({ page }) => {
    await page.goto('/');
    const overlap = await page.evaluate(async (tree) => {
      const R: any = await import('/js/ai/mindmap-render.js');
      const lay = R.layout(tree);
      const [a, b] = lay.nodes.filter((n: any) => n.depth === 1);
      const gapX = Math.abs(a.x - b.x) - (a.size.w + b.size.w) / 2;
      const gapY = Math.abs(a.y - b.y) - (a.size.h + b.size.h) / 2;
      return { gapX, gapY, count: lay.nodes.filter((n: any) => n.depth === 1).length };
    }, TWO_THIN);
    expect(overlap.count).toBe(2);
    // Separadas en al menos un eje ⇒ los rectángulos no se cortan.
    expect(Math.max(overlap.gapX, overlap.gapY)).toBeGreaterThan(0);
  });

  // Caso real (mapa de "Los últimos días incas"): con ramas desiguales y etiquetas largas
  // aparecían solapes de dos clases que la anticolisión analítica no ve —entre ANILLOS
  // distintos (una hoja encima de su propia rama) y entre hojas cerca del eje vertical, donde
  // alternar el radio no separa nada porque el choque es horizontal—. Ningún par, del anillo
  // que sea, puede quedar superpuesto.
  test('ningún par de píldoras se superpone en un mapa denso y desigual', async ({ page }) => {
    await page.goto('/');
    const bad = await page.evaluate(async () => {
      const R: any = await import('/js/ai/mindmap-render.js');
      const lay = R.layout({
        title: 'Los últimos días incas',
        branches: [
          { label: 'Eventos de la Conquista', children: [
            { label: 'Conquista del imperio inca', src: 'a0' }, { label: 'Captura de Atahualpa', src: 'a1' },
            { label: 'Ejecución de Atahualpa', src: 'a2' }, { label: 'Sitio de Cuzco', src: 'a3' },
            { label: 'Conflictos entre imperios', src: 'a4' }] },
          { label: 'Cultura y Legado', children: [
            { label: 'Descubrimiento de Machu Picchu', src: 'a5' }, { label: 'Cosmovisión inca', src: 'a6' },
            { label: 'Imperio inca', src: 'a7' }] },
          { label: 'Resistencia Inca', children: [
            { label: 'Resistencia de Manco Inca', src: 'a8' }, { label: 'Vilcabamba como capital inca', src: 'a9' },
            { label: 'Última resistencia inca', src: 'a10' }] },
        ],
      });
      const pairs: string[] = [];
      for (let i = 0; i < lay.nodes.length; i++) {
        for (let j = i + 1; j < lay.nodes.length; j++) {
          const a = lay.nodes[i], b = lay.nodes[j];
          const dx = Math.abs(a.x - b.x) - (a.size.w + b.size.w) / 2;
          const dy = Math.abs(a.y - b.y) - (a.size.h + b.size.h) / 2;
          if (dx < 0 && dy < 0) pairs.push(`${a.label} ✕ ${b.label}`);
        }
      }
      return pairs;
    });
    expect(bad).toEqual([]);
  });

  // Antes se medía con `CHARW = 8` fijo, y Inter es proporcional: una etiqueta de íes y otra
  // de emes de la misma longitud daban la misma píldora.
  test('la píldora se mide con el ancho real del texto, no por nº de caracteres', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(async () => {
      const R: any = await import('/js/ai/mindmap-render.js');
      const w = (label: string) => R.layout({ title: 'T', branches: [{ label: 'B', children: [{ label, src: '' }] }] })
        .nodes.find((n: any) => n.depth === 2).size.w;
      return { narrow: w('iiiiiiii'), wide: w('WWWWWWWW') };
    });
    expect(r.wide).toBeGreaterThan(r.narrow + 20);
  });

  // La paleta anterior (tonos 500) no llegaba ni a 2.5:1 con texto blanco. El mínimo AA
  // para texto normal es 4.5:1.
  test('toda la paleta de ramas pasa AA con su tinta', async ({ page }) => {
    await page.goto('/');
    const worst = await page.evaluate(async () => {
      const R: any = await import('/js/ai/mindmap-render.js');
      const lum = (hex: string) => {
        const c = hex.replace('#', '');
        const v = [0, 2, 4].map(i => {
          const u = parseInt(c.slice(i, i + 2), 16) / 255;
          return u <= 0.03928 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
      };
      const ratio = (a: string, b: string) => {
        const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
        return (x + 0.05) / (y + 0.05);
      };
      return Math.min(...R.PALETTE.map((c: string) => ratio(c, R.contrastInk(c))));
    });
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });

  // Plegar no es ocultar píxeles: el nodo pasa a ser hoja del árbol visible y el reparto
  // angular se recalcula sin sus hijos.
  test('plegar quita el subárbol del layout', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(async (tree) => {
      const R: any = await import('/js/ai/mindmap-render.js');
      const open = R.layout(tree).nodes.length;
      const folded = R.layout(tree, { collapsed: new Set(['r.0']) });
      return { open, folded: folded.nodes.length, count: folded.byId.get('r.0').childCount };
    }, TWO_THIN);
    expect(r.open).toBe(5);        // centro + 2 ramas + 2 hojas
    expect(r.folded).toBe(4);
    expect(r.count).toBe(1);       // la píldora anuncia cuántos hijos esconde
  });
});

// F3 · El bug que más costaba: el PNG se rasteriza cargando el SVG como <img>, y ahí no se
// pueden pedir recursos externos — Inter está self-hosted, así que el PNG salía con la
// fuente del sistema y no se parecía a la pantalla. Embebida como data: URI viaja dentro.
test('el CSS de export lleva Inter embebida como data: URI', async ({ page }) => {
  await page.goto('/');
  const css = await page.evaluate(async () => {
    const { interFaceCss } = await import('/js/ui/svg-fonts.js');
    return interFaceCss();
  });
  expect(css).toContain('@font-face');
  expect(css).toContain("font-family:'Inter'");
  expect(css).toContain('data:font/woff2;base64,');
  expect(css).toContain('font-weight:400');
  expect(css).toContain('font-weight:600');
  expect(css.length).toBeGreaterThan(20000);   // son las fuentes de verdad, no un stub
});
