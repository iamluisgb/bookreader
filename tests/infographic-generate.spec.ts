import { test, expect } from '@playwright/test';
import path from 'path';

// P29 · De punta a punta, con el LLM stubbeado (mismo patrón que studio.spec): el Studio ofrece
// la infografía, se genera desde el libro, el póster se pinta y queda en el historial. No hay
// API ni coste; lo que se prueba es el CABLEADO (openers, Jobs, normalización y render), no la
// calidad del texto — eso lo mide `npm run eval`.

const EPUB_PATH = path.join(__dirname, 'test.epub');

const CANDIDATES = '- Comala es un pueblo de ánimas [[a0]]\n- Los muertos hablan [[a1]]';
const POSTER = JSON.stringify({
  kicker: 'Una novela de muertos',
  thesis: 'Un pueblo de piedra donde los muertos hablan.',
  ideas: [{ head: 'Comala', body: 'Un pueblo de ánimas.', src: 'a0' }],
  panels: [
    { kind: 'flow', title: 'La llegada', items: [{ head: 'Juan', body: 'Llega a Comala' }] },
    { kind: 'cols', title: 'Voces', items: [{ head: 'Pedro', sub: 'el padre', body: 'Un cacique' }] },
    { kind: 'rows', title: 'Claves', items: [{ tag: 'Murmullos', body: 'Todos muertos' }] },
  ],
  aside: [
    { label: 'Recuerda', body: 'No es lineal.' },
    { label: 'Idea final', body: 'Comala es un purgatorio.' },
  ],
  quote: { text: 'Un pueblo de muertos que hablan.', attribution: 'La novela' },
});

async function stubLLM(page: any) {
  await page.evaluate(
    ({ candidates, poster }) => {
      const real = window.fetch.bind(window);
      window.fetch = async (url: any, opts: any) => {
        const u = typeof url === 'string' ? url : url?.url || '';
        if (u.includes('/chat/completions') && opts?.body) {
          const body = JSON.parse(opts.body);
          const sys = (body.messages || []).find((m: any) => m.role === 'system')?.content || '';
          const out = /ideas clave candidatas/i.test(sys)
            ? candidates
            : /INFOGRAFÍA en JSON/i.test(sys)
              ? poster
              : 'ok';
          const chunks = [
            `data: ${JSON.stringify({ choices: [{ delta: { content: out }, finish_reason: null }] })}\n\n`,
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n',
          ];
          const s = new ReadableStream({
            start(c) {
              const e = new TextEncoder();
              chunks.forEach((x) => c.enqueue(e.encode(x)));
              c.close();
            },
          });
          return new Response(s, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        return real(url, opts);
      };
    },
    { candidates: CANDIDATES, poster: POSTER },
  );
}

test.describe('P29 · infografía de punta a punta', () => {
  test('se genera desde el Studio, se pinta y queda en el historial', async ({ page }) => {
    test.setTimeout(60000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto('/index.html');
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

    // El Studio ofrece el tipo nuevo junto a resumen y mapa.
    await page.click('.ai-tab[data-view="studio"]');
    await expect(page.locator('.studio-empty [data-act="gen"][data-kind="infographic"]')).toBeVisible();
    await page.click('.studio-empty [data-act="gen"][data-kind="infographic"]');

    // Setup → generar → carrusel (el formato por defecto, IG2) → póster.
    await page.waitForSelector('#ig-generate', { timeout: 5000 });
    await page.click('#ig-generate');
    await expect(page.locator('#ig-slides .ig-slide svg').first()).toBeVisible({ timeout: 30000 });
    expect(await page.locator('#ig-slides .ig-slide svg').count()).toBeGreaterThan(3);
    await expect(page.locator('#ig-png')).toContainText('PDF');
    await page.click('.ig-format button[data-f="poster"]');
    await expect(page.locator('#ig-canvas svg')).toBeVisible({ timeout: 10000 });
    const xml = await page
      .locator('#ig-canvas svg')
      .evaluate((s) => new XMLSerializer().serializeToString(s as SVGSVGElement));
    for (const needle of ['Comala', 'LA LLEGADA', 'VOCES', 'CLAVES', 'RECUERDA', 'IDEA FINAL']) {
      expect(xml).toContain(needle);
    }
    // Sin «p. N» por idea: en una imagen para compartir no se puede pulsar y era ruido.
    expect(xml).not.toMatch(/>p\. \d+</);
    // Un póster, no un muro: la densidad sigue dentro del presupuesto (IG2: 2,9, ver
    // infographic-render.spec — el póster largo es el formato de leer con zoom o imprimir).
    const ratio = await page
      .locator('#ig-canvas svg')
      .evaluate((s) => {
        const svg = s as SVGSVGElement;
        return Number(svg.getAttribute('height')) / Number(svg.getAttribute('width'));
      });
    expect(ratio).toBeLessThan(2.9);
    await expect(page.locator('#ig-png')).toBeVisible();

    // El color lo elige el lector: repinta con ese acento y se guarda en el artefacto.
    const violet = '#6d28d9';
    expect(xml).not.toContain(violet);
    await page.click(`.ig-swatch[data-c="${violet}"]`);
    await expect(page.locator(`.ig-swatch[data-c="${violet}"]`)).toHaveAttribute('aria-pressed', 'true');
    const svgXml = () => page.locator('#ig-canvas svg').evaluate((s) => new XMLSerializer().serializeToString(s as SVGSVGElement));
    expect(await svgXml()).toContain(violet);

    // Al cerrar, el artefacto está en el historial (y se puede reabrir).
    await page.locator('#ai-infographic .ai-ob-close').click();
    const card = page.locator('.studio-card.studio-generated [data-kind="infographic"]');
    await expect(card).toHaveCount(1);
    await card.click();
    // Se recuerda el último formato elegido (póster).
    await expect(page.locator('#ig-canvas svg')).toBeVisible({ timeout: 10000 });
    // …y con el color elegido.
    await expect(page.locator(`.ig-swatch[data-c="${violet}"]`)).toHaveAttribute('aria-pressed', 'true');
    expect(await svgXml()).toContain(violet);

    expect(errors).toEqual([]);
  });
  test('se puede elegir un capítulo: solo sus pasajes llegan al modelo y el póster lo dice', async ({ page }) => {
    test.setTimeout(60000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto('/index.html');
    await page.evaluate((k) => localStorage.setItem('bookreader_ai_key', JSON.stringify(k)), 'test-key');
    await page.reload();
    await stubLLM(page);
    // Además del stub, apunta qué PASAJES recibe el barrido de ideas.
    await page.evaluate(() => {
      (window as any).__mapInputs = [];
      const inner = window.fetch.bind(window);
      window.fetch = async (url: any, opts: any) => {
        const u = typeof url === 'string' ? url : url?.url || '';
        if (u.includes('/chat/completions') && opts?.body) {
          const msgs = JSON.parse(opts.body).messages || [];
          const user = msgs.find((m: any) => m.role === 'user')?.content || '';
          if (user.startsWith('PASAJES:')) (window as any).__mapInputs.push(user);
          if (/INFOGRAFÍA en JSON/i.test(msgs[0]?.content || '')) (window as any).__compose = msgs[0].content;
        }
        return inner(url, opts);
      };
    });

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

    await page.click('.ai-tab[data-view="studio"]');
    await page.click('.studio-empty [data-act="gen"][data-kind="infographic"]');
    await page.waitForSelector('#ig-scope', { timeout: 5000 });

    // Como en el resumen: «Libro entero» por defecto y un capítulo por opción.
    const options = await page.locator('#ig-scope option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(options[0]).toBe('');
    expect(options.length).toBeGreaterThan(2);
    const chapter = options[2];
    await page.selectOption('#ig-scope', chapter);
    await page.click('#ig-generate');
    await expect(page.locator('#ig-slides .ig-slide svg').first()).toBeVisible({ timeout: 30000 });

    const res = await page.evaluate(async (ch) => {
      const R = await import('/js/ai/retrieval.js');
      const own = new Set(R.passagesByChapter(ch).map((p: any) => p.id));
      const sent = ((window as any).__mapInputs as string[]).join('\n').match(/\[\[(a\d+)\]\]/g) || [];
      return { sent: sent.map((x) => x.slice(2, -2)), foreign: sent.map((x) => x.slice(2, -2)).filter((id) => !own.has(id)), compose: (window as any).__compose || '' };
    }, chapter);
    expect(res.sent.length).toBeGreaterThan(0);
    expect(res.foreign).toEqual([]);                       // nada de otros capítulos
    expect(res.compose).toContain(`UN CAPÍTULO, «${chapter}»`);
    await expect(page.locator('#ai-infographic h2')).toContainText(chapter);

    // En el historial queda con el capítulo como ámbito.
    await page.locator('#ai-infographic .ai-ob-close').click();
    await expect(page.locator('.studio-card.studio-generated [data-kind="infographic"]')).toContainText(chapter);
    expect(errors).toEqual([]);
  });
});
