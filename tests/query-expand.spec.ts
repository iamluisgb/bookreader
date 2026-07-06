import { test, expect } from '@playwright/test';
import path from 'path';

const EPUB_PATH = path.join(__dirname, 'test.epub');

// IA7 · Reescritura de consulta (HyDE-lite). Dos frentes: (1) las funciones puras de parseo
// —tolerantes a ruido, con fallback— y (2) la integración: en una pregunta conceptual la
// expansión se dispara y el turno responde igual (unión, sin regresión).

// ---- Unitario: parseExpansion / expansionQuery ----
test('parseExpansion es tolerante y expansionQuery combina términos + hipótesis', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async () => {
    const Q: any = await import('/js/ai/query-expand.js');
    const valid = Q.parseExpansion('{"terms":["Raft","consenso"],"hypothetical":"Raft elige un líder."}');
    const fenced = Q.parseExpansion('```json\n{"terms":["Comala"],"hypothetical":"un pueblo de muertos"}\n```');
    const noisy = Q.parseExpansion('Claro, aquí tienes: {"terms":["x"],"hypothetical":"y"} ¡listo!');
    // Modelo reasoning: razonamiento (con llaves) ANTES del JSON real → toma el objeto real.
    const reasoning = Q.parseExpansion('<think>quizá {esto} confunda</think>\n{"terms":["consensus"],"hypothetical":"nodes agree"}');
    return {
      valid, fenced, reasoning,
      garbage: Q.parseExpansion('no hay json aquí'),
      empty: Q.parseExpansion('{"terms":[],"hypothetical":""}'),
      nullish: Q.parseExpansion(''),
      query: Q.expansionQuery(valid),
      queryOfNull: Q.expansionQuery(null),
      noisyOk: !!noisy,
    };
  });
  expect(r.valid).toEqual({ terms: ['Raft', 'consenso'], hypothetical: 'Raft elige un líder.' });
  expect(r.fenced.terms).toEqual(['Comala']);          // quita fences ```json
  expect(r.reasoning.terms).toEqual(['consensus']);    // ignora <think> y toma el JSON real
  expect(r.noisyOk).toBe(true);                         // extrae el objeto entre texto
  expect(r.garbage).toBeNull();                         // sin JSON → null (fallback)
  expect(r.empty).toBeNull();                           // vacío → null
  expect(r.nullish).toBeNull();
  expect(r.query).toBe('Raft consenso Raft elige un líder.');   // términos + hipótesis
  expect(r.queryOfNull).toBe('');
});

// ---- Integración: la expansión se dispara en una pregunta conceptual ----
// Stub que distingue la llamada de EXPANSIÓN (su system prompt pide JSON de búsqueda) de la
// de RESPUESTA. La expansión devuelve JSON; la respuesta, el texto de prueba en streaming.
async function stubLLM(page) {
  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    (window as any).__llm = { expansion: 0, answer: 0 };
    const stream = (payload: string) => {
      const chunks = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: payload }, finish_reason: null }] })}\n\n`,
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ];
      const s = new ReadableStream({ start(c) { const e = new TextEncoder(); chunks.forEach(x => c.enqueue(e.encode(x))); c.close(); } });
      return new Response(s, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions') && opts?.body) {
        const body = JSON.parse(opts.body);
        const sys = (body.messages || []).find((m: any) => m.role === 'system')?.content || '';
        if (body.stream && /BÚSQUEDA por palabras clave/i.test(sys)) {
          (window as any).__llm.expansion++;
          return stream('{"terms":["Comala","Pedro Páramo","muerte"],"hypothetical":"Comala es un pueblo habitado por almas en pena."}');
        }
        if (body.stream) { (window as any).__llm.answer++; return stream('Respuesta de prueba.'); }
        return new Response(JSON.stringify({ choices: [{ message: { content: 'LISTO' } }] }), { status: 200 });
      }
      return real(url, opts);
    };
  });
}

test('una pregunta conceptual dispara la expansión y responde igual (sin regresión)', async ({ page }) => {
  await page.goto('/index.html');
  await page.evaluate((k) => {
    localStorage.setItem('bookreader_ai_key', JSON.stringify(k));
    localStorage.setItem('bookreader_flashcards_hint_seen', 'true');
  }, 'test-key');
  await page.reload();
  await stubLLM(page);

  const fc = page.waitForEvent('filechooser');
  await page.click('#open-file-btn');
  await (await fc).setFiles(EPUB_PATH);
  await page.waitForSelector('#ai-toggle:not([disabled])', { timeout: 15000 });
  await page.click('#ai-toggle');
  await page.waitForSelector('.ai-onboarding', { timeout: 5000 });
  await page.click('.ai-ob-quickchat');
  await expect(page.locator('#ai-status')).toContainText('Listo', { timeout: 30000 });

  await page.evaluate(() => { (window as any).__llm.expansion = 0; (window as any).__llm.answer = 0; });
  await page.fill('#ai-input', '¿qué sensación transmite el pueblo y por qué?');   // conceptual, sin nombrar capítulo
  await page.click('#ai-send');
  await expect(page.locator('.ai-msg-assistant .ai-bubble-text').last()).toContainText('Respuesta de prueba', { timeout: 15000 });

  const counts = await page.evaluate(() => (window as any).__llm);
  expect(counts.expansion).toBeGreaterThanOrEqual(1);   // la expansión se disparó…
  expect(counts.answer).toBeGreaterThanOrEqual(1);      // …y la respuesta se entregó igual
});
