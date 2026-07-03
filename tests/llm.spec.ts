import { test, expect } from '@playwright/test';

// IA3 · Reintentos con backoff (ver DECISIONS.md · ADR-008). Se ejercita el módulo real
// en el navegador: helpers puros + un test funcional de que chatStream reintenta ante 503.

test('retry helpers classify status and parse Retry-After', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const L = await import('/js/ai/llm.js');
    return {
      retry429: L.isRetryableStatus(429),
      retry503: L.isRetryableStatus(503),
      no401: L.isRetryableStatus(401),
      no400: L.isRetryableStatus(400),
      raSecs: L.parseRetryAfter('2'),          // 2s → 2000ms
      raBad: L.parseRetryAfter('nonsense'),    // null
      raNull: L.parseRetryAfter(null),         // null
      backoff0: L.backoffDelay(0, () => 0),    // sin jitter → 700
      backoff2: L.backoffDelay(2, () => 0),    // 700*4 = 2800
      backoffCap: L.backoffDelay(20, () => 0), // techo 8000
    };
  });
  expect(r.retry429).toBe(true);
  expect(r.retry503).toBe(true);
  expect(r.no401).toBe(false);
  expect(r.no400).toBe(false);
  expect(r.raSecs).toBe(2000);
  expect(r.raBad).toBeNull();
  expect(r.raNull).toBeNull();
  expect(r.backoff0).toBe(700);
  expect(r.backoff2).toBe(2800);
  expect(r.backoffCap).toBe(8000);
});

test('chatStream retries on 503 then succeeds', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const L = await import('/js/ai/llm.js');
    L.setKey('test-key');            // fetch está stubbeado; la key solo debe existir
    let calls = 0;
    const realFetch = window.fetch;
    window.fetch = async () => {
      calls++;
      if (calls <= 2) return new Response('rate limited', { status: 503 });   // transitorio
      // 3ª llamada: respuesta SSE de éxito con un fragmento y [DONE].
      const body = new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hola"},"finish_reason":null}]}\n\n'));
          c.enqueue(enc.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'));
          c.enqueue(enc.encode('data: [DONE]\n\n'));
          c.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    try {
      let out = '';
      const full = await L.chatStream({ messages: [{ role: 'user', content: 'hi' }], onToken: (t: string) => { out += t; } });
      return { calls, full, out };
    } finally {
      window.fetch = realFetch;
    }
  });
  expect(r.calls).toBe(3);          // 2 fallos + 1 éxito
  expect(r.full).toBe('hola');
  expect(r.out).toBe('hola');
});
