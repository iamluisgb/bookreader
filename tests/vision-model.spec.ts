import { test, expect } from '@playwright/test';
import { seedProLicense } from './pro-license';

// Resolución del modelo de visión EFECTIVO (effectiveVisionModel). El bug que fija este
// spec: `_chatVision` y `hasVision()` miraban SOLO el ajuste guardado (`ai_vision_model`),
// sin rescates. Dos consecuencias reales:
//  1. Quien nunca abrió Ajustes avanzados tiene el ajuste vacío → la visión quedaba
//     desactivada aunque el preset del proveedor declare un modelo verificado.
//  2. Un alias del gateway (`bookreader-vision`, escrito por una sesión demo) sobrevivía
//     al cambio a la key propia (BYOK) y se mandaba a api.nan.builders → 400
//     `model_not_found`, con un error que no se entendía.
// Convención de los demás specs: módulo importado DENTRO de la página y estado sembrado
// por localStorage (los módulos leen los ajustes al importarse / en cada llamada).

const NAN = 'https://api.nan.builders/v1';
const GATEWAY = 'https://bookreader-gateway.luisgonzalezb93.workers.dev/v1';
const GROQ = 'https://api.groq.com/openai/v1';

// Siembra el estado ANTES de que cargue la app (mismo patrón que demo-settings.spec.ts),
// de modo que `repairGatewayConfig()` —que corre al importar llm.js— ya vea el estado
// final y no reescriba nada por detrás.
async function seed(page: any, ajustes: Record<string, unknown>) {
  await page.addInitScript((a: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(a)) localStorage.setItem('bookreader_' + k, JSON.stringify(v));
  }, ajustes);
}

// Importa el módulo dentro de la página y devuelve el modelo efectivo + hasVision().
async function visionState(page: any) {
  return page.evaluate(async () => {
    const L: any = await import('/js/ai/llm.js');
    return { effective: L.effectiveVisionModel(), hasVision: L.hasVision() };
  });
}

test('ajuste de visión vacío + nan → usa el visionModel del preset', async ({ page }) => {
  await seed(page, { ai_base_url: NAN, ai_key: 'sk-test', ai_model: 'deepseek-v4-flash' });
  await page.goto('/index.html');
  await seedProLicense(page);
  const r = await visionState(page);
  // Rescate 1: vacío → el preset declara deepseek-v4-flash (verificado con imágenes).
  expect(r.effective).toBe('deepseek-v4-flash');
  expect(r.hasVision).toBe(true);
});

test('ajuste vacío + proveedor SIN visión declarada (groq) → sin visión', async ({ page }) => {
  await seed(page, { ai_base_url: GROQ, ai_key: 'sk-test', ai_model: 'llama-3.3-70b-versatile' });
  await page.goto('/index.html');
  await seedProLicense(page);
  const r = await visionState(page);
  // Sin visionModel en el preset no hay rescate posible: la visión sigue desactivada.
  expect(r.effective).toBe('');
  expect(r.hasVision).toBe(false);
});

test('alias del gateway guardado + base URL BYOK → se ignora y cae al preset', async ({ page }) => {
  // Key NO br-: si fuera token de demo, repairGatewayConfig movería la base URL al gateway
  // y este test no probaría lo que dice (el alias quedaría del lado correcto).
  await seed(page, {
    ai_base_url: NAN,
    ai_key: 'sk-test',
    ai_model: 'deepseek-v4-flash',
    ai_vision_model: 'bookreader-vision',
  });
  await page.goto('/index.html');
  await seedProLicense(page);
  const r = await visionState(page);
  // Rescate 2: el alias solo existe en el gateway; fuera de la demo se usa el preset.
  expect(r.effective).toBe('deepseek-v4-flash');
  expect(r.hasVision).toBe(true);
});

test('alias del gateway guardado + base URL del gateway (demo) → el alias se respeta', async ({ page }) => {
  await seed(page, {
    ai_base_url: GATEWAY,
    ai_key: 'br-demo-000000000000',
    ai_model: 'bookreader-fast',
    ai_vision_model: 'bookreader-vision',
  });
  await page.goto('/index.html');
  await seedProLicense(page);
  const r = await visionState(page);
  // En la demo el alias SÍ es válido: el gateway lo enruta a su modelo multimodal.
  expect(r.effective).toBe('bookreader-vision');
});

test('un modelo explícito del usuario se respeta en ambos modos', async ({ page }) => {
  await seed(page, {
    ai_base_url: NAN,
    ai_key: 'sk-test',
    ai_model: 'deepseek-v4-flash',
    ai_vision_model: 'mi-vision-propia',
  });
  await page.goto('/index.html');
  await seedProLicense(page);
  const byok = await visionState(page);
  expect(byok.effective).toBe('mi-vision-propia');
  expect(byok.hasVision).toBe(true);

  // La elección explícita manda también contra el gateway (aunque sea un id raro).
  await page.evaluate((gw: string) => {
    localStorage.setItem('bookreader_ai_base_url', JSON.stringify(gw));
    localStorage.setItem('bookreader_ai_key', JSON.stringify('br-demo-000000000000'));
    localStorage.setItem('bookreader_ai_model', JSON.stringify('bookreader-fast'));
  }, GATEWAY);
  const demo = await page.evaluate(async () => {
    const L: any = await import('/js/ai/llm.js');
    return L.effectiveVisionModel();
  });
  expect(demo).toBe('mi-vision-propia');
});

test('chatVision manda el modelo EFECTIVO en el body y conserva la imagen', async ({ page }) => {
  await seed(page, { ai_base_url: NAN, ai_key: 'sk-test', ai_model: 'deepseek-v4-flash' });
  await page.goto('/index.html');
  await seedProLicense(page);
  // Stub de /chat/completions (mismo estilo que visual-cards.spec.ts): registra el body
  // y responde un content fijo. El ajuste de visión queda VACÍO: el body debe llevar el
  // modelo del preset, no el vacío guardado.
  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    (window as any).__vm = { calls: [] as any[] };
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions') && opts?.body) {
        (window as any).__vm.calls.push(JSON.parse(opts.body));
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'vision ok' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return real(url, opts);
    };
  });
  const IMAGE = 'data:image/png;base64,AAAA';
  const r = await page.evaluate(async (img: string) => {
    const L: any = await import('/js/ai/llm.js');
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: 'explain' },
        { type: 'image_url', image_url: { url: img } },
      ],
    }];
    const answer = await L.chatVision({ messages });
    return { answer, calls: (window as any).__vm.calls };
  }, IMAGE);
  // El modelo del body es el efectivo (rescate del ajuste vacío), no el vacío guardado.
  expect(r.calls).toHaveLength(1);
  expect(r.calls[0].model).toBe('deepseek-v4-flash');
  // El turno llega intacto: la parte de imagen sobrevive a la resolución del modelo.
  expect(r.calls[0].messages[0].content.some((p: any) => p.type === 'image_url' && p.image_url.url === IMAGE)).toBe(true);
  expect(r.answer).toBe('vision ok');
});
