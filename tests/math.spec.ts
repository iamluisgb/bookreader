// Fórmulas del agente: LaTeX → MathML (Temml vendorizado, carga perezosa). Antes salían
// crudas —`$$\text{GELU}(x) \approx 0.5 \cdot x...`— en un lector cuyo público lee libros
// técnicos, donde la notación no es adorno sino el contenido.
import { test, expect, Page } from '@playwright/test';

// Renderiza markdown en la página y espera a que la hidratación termine.
async function render(page: Page, md: string) {
  await page.evaluate(async (src) => {
    const M: any = await import('/js/ai/markdown.js');
    document.body.insertAdjacentHTML('beforeend', `<div class="probe">${M.mdToHtml(src)}</div>`);
  }, md);
  await page.waitForFunction(
    () => !document.querySelector('.probe .ai-math:not([data-math-done])'), null, { timeout: 10000 });
}

test('$$…$$ y $…$ se convierten en MathML, en bloque e inline', async ({ page }) => {
  await page.goto('/');
  await render(page, [
    '$$\\text{GELU}(x) \\approx 0.5 \\cdot x \\cdot \\left[1 + \\tanh\\left(\\sqrt{\\frac{2}{\\pi}} \\cdot (x + 0.044715 \\cdot x^3)\\right)\\right]$$',
    '',
    'y en línea $x^3$ dentro del párrafo.',
  ].join('\n'));
  const r = await page.evaluate(() => {
    const p = document.querySelector('.probe')!;
    const maths = [...p.querySelectorAll('math')];
    return {
      n: maths.length,
      display: maths.map((m) => m.getAttribute('display')),
      // La fórmula compuesta ocupa varias líneas de alto (radical + fracción): si saliera
      // como texto plano tendría la altura de una línea.
      alto: maths[0].getBoundingClientRect().height,
      raices: p.querySelectorAll('msqrt').length,
      fracciones: p.querySelectorAll('mfrac').length,
    };
  });
  expect(r.n).toBe(2);
  // MathML: `display="block"` para la centrada; la de línea no lleva atributo (inline es el
  // valor por defecto), así que su ausencia ES la aserción.
  expect(r.display).toEqual(['block', null]);
  expect(r.raices).toBeGreaterThan(0);
  expect(r.fracciones).toBeGreaterThan(0);
  expect(r.alto).toBeGreaterThan(30);
});

test('el `$` de código y de prosa NO se toma por una fórmula', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const M: any = await import('/js/ai/markdown.js');
    const md = ['```', 'echo $HOME  # cuesta $5', '```', '', 'En prosa, cuesta $5 y no $7.'].join('\n');
    document.body.insertAdjacentHTML('beforeend', `<div class="probe">${M.mdToHtml(md)}</div>`);
  });
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => {
    const p = document.querySelector('.probe')!;
    return { math: p.querySelectorAll('.ai-math').length, code: p.querySelector('code')!.textContent, txt: p.textContent };
  });
  expect(r.math).toBe(0);                       // ni una fórmula falsa
  expect(r.code).toContain('$HOME');
  expect(r.txt).toContain('cuesta $5 y no $7');
});

test('las fórmulas dentro de una tabla también se renderizan', async ({ page }) => {
  await page.goto('/');
  await render(page, ['| Paso | Resultado |', '|---|---|', '| $x^3$ | $1.0^3 = 1.0$ |'].join('\n'));
  expect(await page.locator('.probe td math').count()).toBe(2);
});

// El TeX lo escribe un MODELO: es entrada no confiable como cualquier otra.
test('LaTeX hostil no inyecta nada', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const M: any = await import('/js/ai/markdown.js');
    (window as any).__pwned = false;
    const md = [
      '$\\text{<img src=x onerror="window.__pwned=true">}$',
      '',
      '$$\\href{javascript:window.__pwned=true}{pincha}$$',
    ].join('\n');
    document.body.insertAdjacentHTML('beforeend', `<div class="probe">${M.mdToHtml(md)}</div>`);
  });
  await page.waitForTimeout(800);
  const r = await page.evaluate(() => {
    const p = document.querySelector('.probe')!;
    return {
      pwned: (window as any).__pwned,
      imgs: p.querySelectorAll('img').length,
      scripts: p.querySelectorAll('script').length,
      links: p.querySelectorAll('a').length,
    };
  });
  expect(r.pwned).toBe(false);
  expect(r.imgs).toBe(0);
  expect(r.scripts).toBe(0);
  expect(r.links).toBe(0);   // \href está fuera con trust:false
});

// Sin la librería (primera visita sin red, o la carga falla) la respuesta no puede quedarse
// en blanco ni mostrar `\cdot`: se ve el TeX ya traducido a Unicode.
test('degradación: TeX legible cuando no hay librería', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const Math2: any = await import('/js/ai/math.js');
    return [
      Math2.readableTex('0.5 \\cdot x^2 \\approx \\pi'),
      Math2.readableTex('\\sqrt{\\frac{2}{\\pi}}'),
      Math2.readableTex('\\text{GELU}(x) \\tanh(y)'),
    ];
  });
  expect(r[0]).toBe('0.5 · x² ≈ π');
  expect(r[1]).toBe('√((2)/(π))');
  expect(r[2]).toBe('GELU(x) tanh(y)');
});

// La librería no debe descargarse si nadie escribe una fórmula: son ~167 KB.
test('Temml solo se descarga cuando aparece una fórmula', async ({ page }) => {
  const pedidos: string[] = [];
  page.on('request', (r) => { if (r.url().includes('temml')) pedidos.push(r.url()); });
  await page.goto('/');
  await page.evaluate(async () => {
    const M: any = await import('/js/ai/markdown.js');
    document.body.insertAdjacentHTML('beforeend', `<div class="probe">${M.mdToHtml('Un párrafo **sin** fórmulas.')}</div>`);
  });
  await page.waitForTimeout(600);
  const jsAntes = pedidos.filter((u) => u.endsWith('.js')).length;

  await render(page, 'Ahora sí: $E = mc^2$');
  const jsDespues = pedidos.filter((u) => u.endsWith('.js')).length;
  expect(jsAntes).toBe(0);
  expect(jsDespues).toBe(1);
});
