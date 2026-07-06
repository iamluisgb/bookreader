import { test, expect } from '@playwright/test';

// TEC2 · Render de citas del agente. Solo las anclas que EXISTEN en la conversación se
// convierten en chip clicable (no se inventan citas). Fija el contrato de render.js.
test('renderWithCitations solo convierte anclas existentes', async ({ page }) => {
  await page.goto('/');
  const html = await page.evaluate(async () => {
    const R = await import('/js/ai/render.js');
    const anchors = new Map([['a1', { cfi: 'x' }], ['a2', { cfi: 'y' }]]);
    return R.renderWithCitations('Ver [[a1]] y a2, cita mala [[a99]] y modelo a77.', anchors);
  });
  expect(html).toContain('class="ai-cite" data-id="a1"');
  expect(html).toContain('class="ai-cite" data-id="a2"');   // forma suelta `aN` también
  expect(html).not.toContain('data-id="a99"');              // a99 no existe → no es chip
  expect(html).not.toContain('a99');                        // cita [[a99]] inexistente → se elimina
  expect(html).toContain('a77');                            // `aN` suelto en prosa → se respeta
});

// Las tablas GFM del agente deben renderizarse como <table>, no salir como texto crudo
// con pipes y `|---|---|` (era ilegible en el chat). Ver mdToHtml (js/ai/markdown.js).
test('mdToHtml renderiza tablas GFM como <table>', async ({ page }) => {
  await page.goto('/');
  const html = await page.evaluate(async () => {
    const M = await import('/js/ai/markdown.js');
    const md = [
      '| Modelo | Ventaja | Límite |',
      '|---|---|---|',
      '| A | Rápido | No ve estructura |',
      '| B | Preciso | Más lento |',
    ].join('\n');
    return M.mdToHtml(md);
  });
  expect(html).toContain('<table class="ai-md-table">');
  expect(html).toContain('<th>Modelo</th>');
  expect(html).toContain('<td>Rápido</td>');
  expect(html).toContain('<td>Más lento</td>');
  expect(html).not.toContain('|---|');   // la fila separadora no aparece como texto
  expect(html).not.toMatch(/\|\s*Modelo\s*\|/);   // ni la cabecera con pipes crudos
});
