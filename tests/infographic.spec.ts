import { test, expect } from '@playwright/test';

// P29 · Generador de la infografía: la parte PURA (parseo y recorte del JSON del modelo). El
// recorte no es cosmético — es el gate `infografia.densidad` del contrato: a un modelo al que
// se le piden «ideas clave» le salen veinte, y veinte ideas convierten el póster en un muro.

const RAW = {
  kicker: 'Un manual de iniciación',
  thesis: 'Una tesis.',
  ideas: [
    { head: 'Uno', body: 'Cuerpo uno.', src: 'a1' },
    { head: 'Dos', body: 'Cuerpo dos.', src: 'a2' },
  ],
  panels: [
    { kind: 'flow', title: 'Cadena', items: [{ head: 'Paso', body: 'Uno' }] },
    { kind: 'cols', title: 'Comparativa', items: [{ head: 'A', sub: 'sub', body: 'B' }] },
    { kind: 'rows', title: 'Niveles', items: [{ tag: 'Nivel', body: 'Texto' }] },
  ],
  aside: [
    { label: 'Recuerda', body: 'Un aviso.' },
    { label: 'Idea final', body: 'Un cierre.' },
  ],
  quote: { text: 'Una cita.', attribution: 'Alguien' },
};

test.describe('P29 · generador de la infografía', () => {
  test('parsea el JSON aunque venga envuelto en markdown o con texto alrededor', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(async () => {
      const M: any = await import('/js/ai/infographic.js');
      return {
        fenced: M.parseJson('Aquí tienes:\n```json\n{"a":1}\n```\nEspero que sirva.'),
        prose: M.parseJson('Claro. {"a":{"b":[1,2]}} Y eso es todo.'),
        junk: M.parseJson('lo siento, no puedo'),
      };
    });
    expect(r.fenced).toEqual({ a: 1 });
    expect(r.prose).toEqual({ a: { b: [1, 2] } });
    expect(r.junk).toBeNull();
  });

  // El gate: más de 8 ideas, más de 3 paneles o más de 4 elementos por panel NO pasan.
  test('recorta los bloques a los techos del esquema', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(async () => {
      const M: any = await import('/js/ai/infographic.js');
      const many = {
        ideas: Array.from({ length: 20 }, (_, i) => ({ head: `Idea ${i}`, body: 'Cuerpo.' })),
        panels: Array.from({ length: 5 }, (_, i) => ({
          kind: 'cols',
          title: `Panel ${i}`,
          items: Array.from({ length: 9 }, (_, j) => ({ head: `H${j}`, body: 'B' })),
        })),
        aside: Array.from({ length: 4 }, (_, i) => ({ label: `L${i}`, body: 'Cuerpo.' })),
      };
      const out = M.normalize(many);
      return {
        ideas: out.ideas.length,
        panels: out.panels.length,
        items: out.panels.map((p: any) => p.items.length),
        aside: out.aside.length,
      };
    });
    expect(r.ideas).toBe(8);
    expect(r.panels).toBe(3);
    expect(r.items).toEqual([4, 4, 4]);
    expect(r.aside).toBe(2);
  });

  test('descarta bloques vacíos y reparte iconos distintos por ranura', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(async () => {
      const M: any = await import('/js/ai/infographic.js');
      const out = M.normalize({
        ideas: [
          { head: 'Válida', body: 'Sí.' },
          { head: '', body: 'Sin rótulo.' },
          { head: 'Solo rótulo', body: '' },
          { head: 'Otra', body: 'Sí.' },
        ],
        panels: [{ kind: 'inventado', title: 'X', items: [{ head: 'a', body: 'b' }] }],
      });
      return { ideas: out.ideas.map((i: any) => i.head), icos: out.ideas.map((i: any) => i.ico), panels: out.panels.length };
    });
    expect(r.ideas).toEqual(['Válida', 'Otra']);
    expect(r.panels).toBe(0); // kind desconocido → fuera
    // Iconos por ranura, no repetidos: era el defecto de la v1 (chart cuatro veces).
    expect(new Set(r.icos).size).toBe(r.icos.length);
  });

  // Cuenta las anclas que no existen en el libro. Es la métrica que el contrato mide aunque el
  // póster no pinte los marcadores: una cita inventada es una afirmación sin respaldo.
  test('cuenta las anclas que no existen en el libro', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(async () => {
      const M: any = await import('/js/ai/infographic.js');
      const anchors = new Map([
        ['a1', 'texto'],
        ['a2', 'texto'],
      ]);
      const out = M.normalize(
        {
          ideas: [
            { head: 'Buena', body: 'Sí.', src: 'a1' },
            { head: 'Mala', body: 'No.', src: 'a99' },
          ],
        },
        anchors,
      );
      return { invalid: out.invalid.count, srcs: out.ideas.map((i: any) => i.src) };
    });
    expect(r.invalid).toBe(1);
    expect(r.srcs).toEqual(['a1', '']); // la inventada queda sin ancla (pero el texto se conserva)
  });

  // Encadena generador → render: la forma que devuelve `normalize` es la que come el póster.
  test('la salida se puede pintar sin tocar nada', async ({ page }) => {
    await page.goto('/');
    const r = await page.evaluate(async (raw) => {
      const G: any = await import('/js/ai/infographic.js');
      const R: any = await import('/js/ai/infographic-render.js');
      const content = G.normalize(raw);
      const { svg, width, height } = R.renderSvg({
        ...content,
        title: 'Un libro',
        author: 'Una autora',
        accent: '#4338ca',
        footer: { mark: 'BookReader', url: 'bookreader.raiatech.com' },
      });
      return { width, height, xml: new XMLSerializer().serializeToString(svg) };
    }, RAW);
    expect(r.width).toBe(1080);
    expect(r.height).toBeGreaterThan(600);
    expect(r.height / r.width).toBeLessThan(2.4); // el presupuesto del póster
    for (const needle of ['UN LIBRO', 'IDEAS CLAVE', 'CADENA', 'COMPARATIVA', 'NIVELES', 'Recuerda', 'Idea final', 'Una cita']) {
      expect(r.xml).toContain(needle);
    }
  });
});
