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

  // P33 · Árbol a dos lados: las primeras ramas, en su orden, a la derecha de arriba abajo; el
  // resto a la izquierda. El orden del árbol es el del libro y el mapa tiene que respetarlo.
  test('las ramas se reparten a izquierda y derecha, en su orden', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(async () => {
      const R: any = await import('/js/ai/mindmap-render.js');
      const lay = R.layout({ title: 'T', branches: ['A', 'B', 'C', 'D', 'E'].map((l) => ({ label: l, children: [{ label: l + '1', src: '' }] })) });
      const br = lay.nodes.filter((n: any) => n.depth === 1);
      return {
        right: br.filter((n: any) => n.x > 0).map((n: any) => n.label),
        left: br.filter((n: any) => n.x < 0).map((n: any) => n.label),
        rightDown: br.filter((n: any) => n.x > 0).every((n: any, i: number, a: any[]) => !i || n.y > a[i - 1].y),
        leafOutside: lay.nodes.filter((n: any) => n.depth === 2).every((n: any) => Math.sign(n.x) === Math.sign(lay.byId.get(n.parent).x) && Math.abs(n.x) > Math.abs(lay.byId.get(n.parent).x)),
      };
    });
    expect(r.right).toEqual(['A', 'B', 'C']);
    expect(r.left).toEqual(['D', 'E']);
    expect(r.rightDown).toBe(true);
    expect(r.leafOutside).toBe(true);   // cada idea, del lado de su rama y por fuera de ella
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

  // P33 · Los colores de sistema de Apple no aguantan texto (verde o naranja sobre blanco no
  // llegan a 3:1), así que el color va solo en líneas, puntos y aros. Todo texto del mapa,
  // en claro y en oscuro, usa la tinta del tema. Sustituye al test de AA de la paleta vieja,
  // que ponía texto blanco sobre el color de la rama.
  test('ningún texto del mapa va en el color de una rama', async ({ page }) => {
    await page.goto('/');
    const bad = await page.evaluate(async () => {
      const R: any = await import('/js/ai/mindmap-render.js');
      const tree = { title: 'Libro', branches: [
        { label: 'Rama uno', children: [{ label: 'hoja', src: 'a0' }, { label: 'otra', src: 'a1' }] },
        { label: 'Rama dos', children: [{ label: 'hoja dos', src: 'a2' }] },
      ] };
      const dark = { bg: '#1a1f24', ink: '#f2f3f5', muted: '#a8b0b8', leaf: '#232a31', line: '#30363d' };
      const out: string[] = [];
      for (const theme of [R.POSTER, dark]) {
        const lay = R.layout(tree, { collapsed: new Set(['r.0']) });
        const svg = R.renderSvg(lay, { theme, interactive: true, footer: { title: 'Libro', mark: 'BookReader' } }).svg;
        for (const t of svg.querySelectorAll('text')) {
          const f = t.getAttribute('fill');
          if (f !== theme.ink && f !== theme.muted) out.push(`${t.textContent} → ${f}`);
        }
      }
      return out;
    });
    expect(bad).toEqual([]);
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

// P34 · Póster para compartir: horizontal 16:9 y vertical 4:5, con la portada del libro. El
// vertical pone todas las ramas a un lado (a dos lados quedaría demasiado ancho).
test('el póster sale en horizontal y en vertical, con la portada', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const R: any = await import('/js/ai/mindmap-render.js');
    const tree = { title: 'Libro', branches: ['A', 'B', 'C', 'D'].map((l) => ({ label: l, children: [{ label: l + '1', src: 'a0' }] })) };
    const cover = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const out: any = {};
    for (const f of ['landscape', 'portrait']) {
      const lay = R.layout(tree, { sides: R.FORMATS[f].sides });
      const { svg, width, height } = R.renderPoster(lay, { format: f, header: { title: 'Libro', author: 'Autora', cover, coverAspect: 2 / 3 } });
      out[f] = {
        width, height,
        cover: svg.querySelector('image')?.getAttribute('href') === cover,
        leftBranches: lay.nodes.filter((n: any) => n.depth === 1 && n.x < 0).length,
      };
    }
    return out;
  });
  expect([r.landscape.width, r.landscape.height]).toEqual([1920, 1080]);
  expect([r.portrait.width, r.portrait.height]).toEqual([1080, 1350]);
  expect(r.landscape.cover && r.portrait.cover).toBe(true);
  expect(r.landscape.leftBranches).toBe(2);
  expect(r.portrait.leftBranches).toBe(0);
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
