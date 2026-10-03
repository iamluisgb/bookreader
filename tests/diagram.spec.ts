// Diagramas del agente: ```mermaid → SVG (Mermaid vendorizado, carga perezosa). Antes el
// agente tenía prohibido dibujar y, ante «explícamelo con un diagrama», se disculpaba y daba
// una lista. Igual que una tabla es Markdown que la app pinta, un diagrama es Mermaid.
import { test, expect, Page } from '@playwright/test';

async function render(page: Page, md: string, anchors: string[] = []) {
  await page.evaluate(async ({ src, ids }) => {
    const R: any = await import('/js/ai/render.js');
    const map = new Map(ids.map((id: string, i: number) => [id, { page: 10 + i, chapter: 'Cap' }]));
    document.body.insertAdjacentHTML('beforeend', `<div class="probe">${R.renderWithCitations(src, map)}</div>`);
  }, { src: md, ids: anchors });
  await page.waitForFunction(
    () => !document.querySelector('.probe .ai-diagram:not([data-done])'), null, { timeout: 20000 });
}

const SEQ = ['```mermaid', 'sequenceDiagram', '  App->>SO: write() [[a1]]', '  SO->>Red: paquete [[a2]]', '  Red-->>App: ACK', '```'].join('\n');

test('sequenceDiagram, flowchart y timeline se dibujan como SVG, sin bajar ELK', async ({ page }) => {
  const pedidos: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/vendor/mermaid')) pedidos.push(r.url()); });
  await page.goto('/');
  await render(page, [
    SEQ, '',
    '```mermaid', 'flowchart TD', '  A[Petición] --> B{¿Hay capacidad?}', '  B -- sí --> C[Enviar]', '  B -- no --> D[Esperar]', '```', '',
    '```mermaid', 'timeline', '  title TCP', '  1974 : Cerf y Kahn', '  1981 : RFC 793', '```',
  ].join('\n'));
  const r = await page.evaluate(() => [...document.querySelectorAll('.probe .ai-diagram')].map((f) => ({
    done: (f as HTMLElement).dataset.done, svg: !!f.querySelector('svg'), code: !!f.querySelector('pre'), txt: (f.querySelector('svg')?.textContent || '').replace(/\s+/g, ' '),
  })));
  expect(r.map((x) => [x.done, x.svg, x.code])).toEqual([['1', true, false], ['1', true, false], ['1', true, false]]);
  expect(r[0].txt).toContain('write()');
  expect(r[1].txt).toContain('Esperar');
  expect(r[2].txt).toContain('RFC 793');
  // `layout: 'dagre'`: sin él Mermaid 12 baja ELK (1,6 MB) para el flowchart.
  expect(pedidos.some((u) => /elk-/.test(u))).toBe(false);
});

test('las citas salen del diagrama y quedan como chips debajo', async ({ page }) => {
  await page.goto('/');
  await render(page, SEQ, ['a1', 'a2']);
  const r = await page.evaluate(() => ({
    enDiagrama: document.querySelector('.probe .ai-diagram')!.textContent,
    chips: [...document.querySelectorAll('.probe .ai-diagram-cites .ai-cite')].map((b) => (b as HTMLElement).dataset.id),
  }));
  expect(r.enDiagrama).not.toContain('[[');
  expect(r.chips).toEqual(['a1', 'a2']);
});

test('sintaxis rota o tipo no permitido: se queda el código, sin basura en la página', async ({ page }) => {
  await page.goto('/');
  await render(page, [
    '```mermaid', 'sequenceDiagram', '  App->>: (((roto', '```', '',
    '```mermaid', 'classDiagram', '  Animal <|-- Pato', '```',
  ].join('\n'));
  const r = await page.evaluate(() => ({
    estados: [...document.querySelectorAll('.probe .ai-diagram')].map((f) => (f as HTMLElement).dataset.done),
    codigos: [...document.querySelectorAll('.probe .ai-diagram pre')].map((p) => p.textContent),
    // Mermaid deja un nodo «Syntax error» suelto en <body> al fallar.
    sueltos: [...document.body.children].filter((c) => c.id?.startsWith('dai-mmd')).length,
  }));
  expect(r.estados).toEqual(['error', 'skip']);
  expect(r.codigos[0]).toContain('(((roto');
  expect(r.codigos[1]).toContain('classDiagram');
  expect(r.sueltos).toBe(0);
});

// El Mermaid lo escribe un MODELO: es entrada no confiable como cualquier otra.
test('Mermaid hostil no ejecuta nada', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { (window as any).__pwned = false; });
  await render(page, [
    '```mermaid', 'flowchart TD',
    '  A["<img src=x onerror=window.__pwned=true>"] --> B',
    '  click A "javascript:window.__pwned=true"',
    '```',
  ].join('\n'));
  await page.locator('.probe .ai-diagram svg').click({ force: true });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).__pwned)).toBe(false);
  // Ni la <img> (aunque sin onerror pediría una URL de fuera) ni HTML incrustado.
  expect(await page.locator('.probe .ai-diagram img').count()).toBe(0);
  expect(await page.locator('.probe .ai-diagram foreignObject').count()).toBe(0);
});

test('el diagrama toma los colores del tema y se repinta al cambiarlo', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await render(page, SEQ);
  const fill = () => page.evaluate(() => {
    const r = document.querySelector('.probe .ai-diagram svg rect.actor') as SVGElement | null;
    return r ? getComputedStyle(r).fill : '';
  });
  const claro = await fill();
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForFunction((antes) => {
    const r = document.querySelector('.probe .ai-diagram svg rect.actor') as SVGElement | null;
    return !!r && getComputedStyle(r).fill !== antes;
  }, claro, { timeout: 10000 });
  const oscuro = await fill();
  const lum = (c: string) => (c.match(/\d+/g) || []).slice(0, 3).map(Number).reduce((a, b) => a + b, 0);
  expect(lum(oscuro)).toBeLessThan(lum(claro));
});
