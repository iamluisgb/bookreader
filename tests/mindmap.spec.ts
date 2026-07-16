import { test, expect } from '@playwright/test';
import { seedProLicense } from './pro-license';
import path from 'path';

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
  await page.click('#open-file-btn');
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
  await page.click('#ai-convo-mindmap');
  await page.waitForSelector('#ai-mindmap', { timeout: 5000 });
  await page.click('#mm-generate');

  await page.waitForSelector('.mm-canvas svg', { timeout: 20000 });
  // Nodo central + ramas + hojas.
  await expect(page.locator('.mm-canvas')).toContainText('Comala');
  await expect(page.locator('.mm-canvas')).toContainText('Personajes');
  await expect(page.locator('.mm-canvas')).toContainText('Juan Preciado');
  // Las hojas con src mapeado a anclas reales (a0/a1) son clicables (.mm-cite).
  const cites = page.locator('.mm-canvas .mm-cite');
  expect(await cites.count()).toBeGreaterThanOrEqual(1);
  // Hover: cada nodo lleva <title> nativo con el detalle completo (modelo NotebookLM).
  expect(await page.locator('.mm-canvas svg title').count()).toBeGreaterThan(0);
  await expect(page.locator('#mm-png')).toBeVisible();
});

test('clic en una hoja citada salta al libro y cierra el modal', async ({ page }) => {
  await setup(page);
  await page.click('#ai-convo-mindmap');
  await page.waitForSelector('#ai-mindmap', { timeout: 5000 });
  await page.click('#mm-generate');
  await page.waitForSelector('.mm-canvas .mm-cite', { timeout: 20000 });
  await page.locator('.mm-canvas .mm-cite').first().click();
  await expect(page.locator('#ai-mindmap')).toHaveCount(0);
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
