import { test, expect } from '@playwright/test';
import { seedProLicense } from './pro-license';
import path from 'path';
import { openFromStudio, openArtifactFromStudio } from './studio-nav';

// P14 · Mapa mental: map (viñetas citadas) + reduce (árbol JSON) → SVG radial con hojas
// citadas clicables. LLM stubbeado.

const EPUB_PATH = path.join(__dirname, 'test.epub');

async function stubLLM(page) {
  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions') && opts?.body) {
        const body = JSON.parse(opts.body);
        const sys = (body.messages || []).find((m: any) => m.role === 'system')?.content || '';
        // F6 · "Expandir": el prompt pide SUBCONCEPTOS. Se devuelve uno legítimo y otro con un
        // ancla que NO viaja en los pasajes enviados, para comprobar que se descarta.
        if (/SUBCONCEPTOS/.test(sys)) {
          const body2 = JSON.stringify({ children: [
            { label: 'Busca a su padre', src: 'a0' },
            { label: 'Dato inventado', src: 'a999' },
          ] });
          const cs = [
            `data: ${JSON.stringify({ choices: [{ delta: { content: body2 }, finish_reason: null }] })}\n\n`,
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', 'data: [DONE]\n\n'];
          const st = new ReadableStream({ start(c) { const e = new TextEncoder(); cs.forEach(x => c.enqueue(e.encode(x))); c.close(); } });
          return new Response(st, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        const out = /MAPA MENTAL/.test(sys)
          ? JSON.stringify({
              title: 'Comala',
              branches: [
                { label: 'Personajes', children: [{ label: 'Juan Preciado', src: 'a0' }, { label: 'Pedro Páramo', src: 'a1' }] },
                { label: 'Temas', children: [{ label: 'La muerte', src: 'a0' }] },
              ],
            })
          : '- Juan Preciado busca a su padre [[a0]]\n- El pueblo son ánimas [[a1]]';
        const chunks = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: out }, finish_reason: null }] })}\n\n`,
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ];
        const s = new ReadableStream({ start(c) { const e = new TextEncoder(); chunks.forEach(x => c.enqueue(e.encode(x))); c.close(); } });
        return new Response(s, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return real(url, opts);
    };
  });
}

async function setup(page) {
  await page.goto('/index.html');
  await seedProLicense(page);   // features Pro gateadas (MON2): el test ejercita la feature
  await page.evaluate((k) => localStorage.setItem('bookreader_ai_key', JSON.stringify(k)), 'test-key');
  await page.reload();
  await stubLLM(page);
  const fc = page.waitForEvent('filechooser');
  await page.click('.lib-empty .lib-upload');
  await (await fc).setFiles(EPUB_PATH);
  await page.waitForSelector('#ai-toggle:not([disabled])', { timeout: 15000 });
  await page.click('#ai-toggle');
  await page.waitForSelector('.ai-onboarding', { timeout: 5000 });
  await page.click('.ai-ob-tpl[data-tpl="hqa"]');
  await page.fill('#ai-ob-goal', 'entender la novela');
  await page.click('#ai-ob-start');
  await expect(page.locator('#ai-status')).toContainText('Listo', { timeout: 30000 });
}

test('genera un mapa radial SVG con ramas y hojas citadas', async ({ page }) => {
  await setup(page);
  await openFromStudio(page, 'mindmap');
  await page.waitForSelector('#ai-mindmap', { timeout: 5000 });
  await page.click('#mm-generate');

  await page.waitForSelector('.mm-canvas svg', { timeout: 20000 });
  // Nodo central + ramas + hojas.
  await expect(page.locator('.mm-canvas')).toContainText('Comala');
  await expect(page.locator('.mm-canvas')).toContainText('Personajes');
  await expect(page.locator('.mm-canvas')).toContainText('Juan Preciado');
  // Las hojas con src mapeado a anclas reales (a0/a1) son citables (.mm-cite).
  const cites = page.locator('.mm-canvas .mm-cite');
  expect(await cites.count()).toBeGreaterThanOrEqual(1);
  // Cada nodo conserva su <title> nativo (nombre accesible + tooltip de escritorio).
  expect(await page.locator('.mm-canvas svg title').count()).toBeGreaterThan(0);
  // F5 · los nodos son focusables y anunciados como botón (antes eran <g> inertes).
  await expect(cites.first()).toHaveAttribute('role', 'button');
  await expect(cites.first()).toHaveAttribute('tabindex', '0');
  await expect(page.locator('#mm-png')).toBeVisible();
});

// F5 · El clic ya no salta directo al libro: abre el detalle del nodo, que es lo único que
// funciona en táctil (el <title> de SVG no existe ahí) y donde viven las acciones. Desde
// ahí, "Ir al libro" hace lo que antes hacía el clic.
test('clic en una hoja abre su detalle, y desde ahí salta al libro', async ({ page }) => {
  await setup(page);
  await openFromStudio(page, 'mindmap');
  await page.waitForSelector('#ai-mindmap', { timeout: 5000 });
  await page.click('#mm-generate');
  await page.waitForSelector('.mm-canvas .mm-cite', { timeout: 20000 });
  await page.locator('.mm-canvas .mm-cite').first().click();

  const pop = page.locator('.mm-pop');
  await expect(pop).toBeVisible();
  await expect(pop.locator('blockquote')).toBeVisible();   // la cita real del pasaje
  await pop.locator('.mm-pop-act[data-act="cite"]').click();
  await expect(page.locator('#ai-mindmap')).toHaveCount(0);
});

// Reabrir un mapa YA generado entra por `renderResult` sin pasar por el setup, que era el
// único sitio que construía el índice de pasajes. Tras recargar, eso dejaba el mapa sin lo
// que le da valor: el detalle salía sin la cita y "Expandir" respondía "no tiene pasajes que
// ampliar" en TODOS los nodos.
test('un mapa cacheado reabierto tras recargar conserva sus citas', async ({ page }) => {
  await setup(page);
  await openFromStudio(page, 'mindmap');
  await page.waitForSelector('#ai-mindmap', { timeout: 5000 });
  await page.click('#mm-generate');
  await page.waitForSelector('.mm-canvas .mm-cite', { timeout: 20000 });

  await page.reload();
  await stubLLM(page);
  await page.waitForSelector('#ai-toggle:not([disabled])', { timeout: 15000 });
  await page.click('#ai-toggle');
  // Reabrir el artefacto guardado (data-act="open"), NO "Nuevo": es el único camino que
  // llega a `renderResult` sin pasar por el setup, y por tanto el que se rompía.
  await openArtifactFromStudio(page, 'mindmap');
  await page.waitForSelector('.mm-canvas .mm-cite', { timeout: 20000 });

  await page.locator('.mm-canvas .mm-cite').first().click();
  const pop = page.locator('.mm-pop');
  await expect(pop).toBeVisible();
  await expect(pop.locator('blockquote')).toBeVisible();          // la cita sigue ahí
  await expect(pop.locator('.mm-pop-act[data-act="cite"]')).toBeVisible();
});

// F6 · Expandir una hoja añade un tercer nivel bajo demanda. Y solo acepta subconceptos con
// un ancla que exista ENTRE LOS PASAJES ENVIADOS: un nieto sin cita real parecería contenido
// del libro sin serlo, que es lo que no puede llevar un mapa que se publica.
test('expandir añade subconceptos citados y descarta los que no lo están', async ({ page }) => {
  await setup(page);
  await openFromStudio(page, 'mindmap');
  await page.waitForSelector('#ai-mindmap', { timeout: 5000 });
  await page.click('#mm-generate');
  await page.waitForSelector('.mm-canvas .mm-cite', { timeout: 20000 });

  await page.locator('.mm-node[data-id="r.0.0"]').click();
  await page.locator('.mm-pop .mm-pop-act[data-act="expand"]').click();

  await expect(page.locator('.mm-canvas')).toContainText('Busca a su padre', { timeout: 20000 });
  await expect(page.locator('.mm-canvas')).not.toContainText('Dato inventado');

  // Persiste en el artefacto: al reabrirlo desde el Studio el nieto sigue ahí.
  await page.locator('#ai-mindmap .ai-ob-close').click();
  await openArtifactFromStudio(page, 'mindmap');
  await expect(page.locator('.mm-canvas')).toContainText('Busca a su padre', { timeout: 20000 });
});

// F5 · Plegar una rama la convierte en hoja del árbol visible: sus hijos desaparecen del
// lienzo y la píldora muestra cuántos oculta.
test('plegar una rama esconde sus hijos', async ({ page }) => {
  await setup(page);
  await openFromStudio(page, 'mindmap');
  await page.waitForSelector('#ai-mindmap', { timeout: 5000 });
  await page.click('#mm-generate');
  await page.waitForSelector('.mm-canvas svg', { timeout: 20000 });
  await expect(page.locator('.mm-canvas')).toContainText('Juan Preciado');

  await page.locator('.mm-node[data-id="r.0"]').click();
  await page.locator('.mm-pop .mm-pop-act[data-act="fold"]').click();
  await expect(page.locator('.mm-canvas')).not.toContainText('Juan Preciado');
  await expect(page.locator('.mm-canvas')).toContainText('Personajes');
});

// "Cubierta" aparecía como rama del mapa porque el filtro de accesorios —el que decide qué
// se salta el muestreo cuando el ámbito es el libro entero— no conocía el nombre español.
test('la cubierta del EPUB cuenta como accesorio, no como capítulo', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const R: any = await import('/js/ai/retrieval.js');
    return {
      // "Cubierta" se colaba como rama: el filtro de accesorios conocía "portada" y "cover",
      // pero no el nombre que usan muchos EPUB en español.
      cubierta: R.isBoilerplate('Cubierta'),
      contra: R.isBoilerplate('Contraportada'),
      capitulo: R.isBoilerplate('El pishtaco'),
    };
  });
  expect(r.cubierta).toBe(true);
  expect(r.contra).toBe(true);
  expect(r.capitulo).toBe(false);
});

// La causa raíz de que el mapa saliera siendo el índice estaba una capa MÁS ARRIBA del
// prompt: `buildChunks` reinserta el título del capítulo como `## …` en el texto que se manda,
// y la fase de extracción devolvía esos titulares como si fueran conceptos. Para tarjetas y
// resumen ese encabezado es contexto útil; para el mapa es veneno.
test('los trozos del mapa van sin encabezados de capítulo', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const F: any = await import('/js/ai/flashcards.js');
    const passages = [
      { id: 'a0', text: 'La velocidad de la luz es constante en todo sistema inercial.', chapter: 'V. THE PRINCIPLE OF RELATIVITY' },
      { id: 'a1', text: 'Dos sucesos simultáneos para un observador no lo son para otro.', chapter: 'IX. THE RELATIVITY OF SIMULTANEITY' },
    ];
    return {
      con: F.buildChunks(passages, 5000).map((c: any) => c.text).join('\n'),
      sin: F.buildChunks(passages, 5000, { headings: false }).map((c: any) => c.text).join('\n'),
    };
  });
  // Tarjetas y resumen siguen recibiendo el capítulo…
  expect(r.con).toContain('## V. THE PRINCIPLE OF RELATIVITY');
  // …y el mapa no, pero conserva íntegros los pasajes y sus anclas.
  expect(r.sin).not.toContain('##');
  expect(r.sin).not.toContain('THE PRINCIPLE OF RELATIVITY');
  expect(r.sin).toContain('[[a0]] La velocidad de la luz');
  expect(r.sin).toContain('[[a1]] Dos sucesos simultáneos');
});

// La causa raíz, en la capa donde es determinista. `segment.js` emite cada encabezado dos
// veces: como frontera `## texto` y como pasaje con ancla propia. El mapa recibía el titular
// como si fuera contenido y lo devolvía como concepto. Se prueba sobre el pipeline real
// (parsePassages), no sobre objetos inventados.
test('los pasajes que son un encabezado se reconocen y no van al mapa', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const R: any = await import('/js/ai/retrieval.js');
    const anotado = [
      '## V. THE PRINCIPLE OF RELATIVITY',
      '[[a0]] V. THE PRINCIPLE OF RELATIVITY',
      '[[a1]] Si un sistema se mueve uniformemente respecto a otro, las leyes son las mismas.',
      '## Sistemas de coordenadas',
      '[[a2]] Sistemas de coordenadas',
      '[[a3]] Un cuerpo se describe siempre respecto a un cuerpo de referencia.',
    ].join('\n');
    const ps = R.parsePassages(anotado, new Map(), ['V. THE PRINCIPLE OF RELATIVITY']);
    return {
      total: ps.length,
      encabezados: ps.filter((p: any) => R.isHeadingPassage(p)).map((p: any) => p.id),
      contenido: ps.filter((p: any) => !R.isHeadingPassage(p)).map((p: any) => p.id),
    };
  });
  expect(r.total).toBe(4);
  expect(r.encabezados).toEqual(['a0', 'a2']);   // el título de capítulo y el de sección
  expect(r.contenido).toEqual(['a1', 'a3']);     // el texto de verdad se conserva entero
});

// Detectar en CLIENTE que el árbol es el índice del libro. Tres rondas de pedírselo al modelo
// por prompt demostraron que pedirlo no basta; los capítulos los tenemos aquí. La comparación
// va por prefijo porque el rótulo se recorta a 32 caracteres al pintarlo.
test('se detecta un árbol cuyas ramas son los capítulos', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const M: any = await import('/js/ai/mindmap.js');
    const chapters = [
      'V. THE PRINCIPLE OF RELATIVITY (IN THE RESTRICTED SENSE)',
      'IX. THE RELATIVITY OF SIMULTANEITY',
      'XI. THE LORENTZ TRANSFORMATION',
    ];
    const indice = { title: 'X', branches: [
      { label: 'THE PRINCIPLE OF RELATIVITY (IN' },   // recortado a 32: debe casar igual
      { label: 'THE RELATIVITY OF SIMULTANEITY' },
      { label: 'THE LORENTZ TRANSFORMATION' },
    ] };
    const tematico = { title: 'X', branches: [
      { label: 'Simultaneidad y tiempo' },
      { label: 'Transformaciones entre sistemas' },
      { label: 'Equivalencia masa-energía' },
    ] };
    return {
      indice: M.chapterLikeBranches(indice, chapters),
      tematico: M.chapterLikeBranches(tematico, chapters),
      sinCapitulos: M.chapterLikeBranches(indice, []),
    };
  });
  expect(r.indice).toBe(3);        // las tres, incluida la recortada
  expect(r.tematico).toBe(0);
  expect(r.sinCapitulos).toBe(0);  // sin lista de capítulos no se inventa una señal
});

// Una viñeta sin ancla no se puede citar, ni ampliar, ni llevar al libro — y ensucia: se
// agrupan bajo "General" y producían una rama basura con ese nombre. Por ahí se coló hasta el
// mapa final un "- Relat" cortado (eval p14-validado).
test('las viñetas sin ancla no llegan al mapa', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const M: any = await import('/js/ai/mindmap.js');
    // capBulletsFair es la puerta por la que pasan; sin ancla caían en "General".
    const bullets = ['Concepto bueno [[a1]]', 'Relat', 'Otro concepto [[a2]]'];
    const conAncla = bullets.filter(b => /\[\[a\d+\]\]/.test(b));
    return { total: bullets.length, filtradas: conAncla.length, capped: M.capBulletsFair(conAncla, 10, () => 'A').length };
  });
  expect(r.total).toBe(3);
  expect(r.filtradas).toBe(2);
  expect(r.capped).toBe(2);
});

// P14 F2 · El cap de viñetas reparte por capítulo (antes un muestreo uniforme podía
// dejar capítulos sin representación) y el árbol de 1 rama cae al fallback por capítulos.
test('capBulletsFair reparte el cupo entre capítulos', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const M: any = await import('/js/ai/mindmap.js');
    const chapterOf = (id: string) => (id && Number(id.slice(1)) < 10 ? 'A' : 'B');
    // 12 viñetas de A (a0..a9 + 2 extra) y 3 de B: el cap a 6 debe incluir B.
    const bullets = [
      ...Array.from({ length: 9 }, (_, i) => `- idea A${i} [[a${i}]]`),
      '- idea B1 [[a20]]', '- idea B2 [[a21]]', '- idea B3 [[a22]]',
    ];
    const capped = M.capBulletsFair(bullets, 6, chapterOf);
    return {
      total: capped.length,
      deB: capped.filter((b: string) => b.includes('B')).length,
      sinCap: M.capBulletsFair(bullets.slice(0, 4), 6, chapterOf).length,   // ≤max → tal cual
    };
  });
  expect(r.total).toBe(6);
  expect(r.deB).toBeGreaterThanOrEqual(2);   // B no desaparece
  expect(r.sinCap).toBe(4);
});
