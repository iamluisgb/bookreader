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

test('chatToolsLoop ejecuta herramientas y cierra al no pedir más', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const L = await import('/js/ai/llm.js');
    L.setKey('test-key');
    let round = 0;
    const realFetch = window.fetch;
    window.fetch = async () => {
      round++;
      const msg = round === 1
        ? { content: null, tool_calls: [{ id: 'c1', function: { name: 'search_book', arguments: '{"query":"consensus"}' } }] }
        : { content: 'LISTO' };   // 2ª ronda: sin tool_calls → cierra
      return new Response(JSON.stringify({ choices: [{ message: msg }] }), { status: 200 });
    };
    try {
      const executed: any[] = [];
      const out = await L.chatToolsLoop({
        messages: [{ role: 'user', content: 'q' }],
        tools: [{ type: 'function', function: { name: 'search_book', parameters: {} } }],
        execute: async (name: string, args: any) => { executed.push({ name, args }); return 'pasajes...'; },
        maxRounds: 3,
      });
      return { rounds: out.rounds, content: out.content, executed, callsCount: out.calls.length };
    } finally {
      window.fetch = realFetch;
    }
  });
  expect(r.rounds).toBe(2);
  expect(r.content).toBe('LISTO');
  expect(r.executed).toEqual([{ name: 'search_book', args: { query: 'consensus' } }]);
  expect(r.callsCount).toBe(1);
});

// Routing por tarea (ADR-022): `model` opcional en chatStream/chatTools y resolución
// del modelo lite (ajuste explícito → liteModel del preset → modelo principal).

test('chatStream y chatTools honran el override de modelo', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const L = await import('/js/ai/llm.js');
    L.setKey('test-key');
    L.setModel('modelo-principal');
    const sent: string[] = [];
    const realFetch = window.fetch;
    window.fetch = async (_url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      sent.push(body.model);
      if (body.stream) {
        const s = new ReadableStream({
          start(c) {
            const e = new TextEncoder();
            c.enqueue(e.encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
            c.close();
          },
        });
        return new Response(s, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
    };
    try {
      await L.chatStream({ messages: [{ role: 'user', content: 'q' }] });                          // sin override
      await L.chatStream({ messages: [{ role: 'user', content: 'q' }], model: 'modelo-lite' });    // con override
      await L.chatTools({ messages: [{ role: 'user', content: 'q' }], tools: [] });                // sin override
      await L.chatTools({ messages: [{ role: 'user', content: 'q' }], tools: [], model: 'modelo-lite' });
      return sent;
    } finally {
      window.fetch = realFetch;
    }
  });
  expect(r).toEqual(['modelo-principal', 'modelo-lite', 'modelo-principal', 'modelo-lite']);
});

test('getLiteModel resuelve: explícito → preset del proveedor → modelo principal', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const L = await import('/js/ai/llm.js');
    L.setModel('modelo-principal');
    const out: Record<string, string> = {};
    // Base URL por defecto = preset nan, que declara liteModel.
    out.nanDefault = L.getLiteModel();
    // El ajuste explícito del usuario gana al preset.
    L.setLiteModel('mi-lite');
    out.explicit = L.getLiteModel();
    L.setLiteModel('');
    // Proveedor sin liteModel (OpenAI) y URL personalizada → modelo principal.
    L.setBaseUrl('https://api.openai.com/v1');
    out.openai = L.getLiteModel();
    L.setBaseUrl('https://ejemplo.com/v1');
    out.custom = L.getLiteModel();
    return out;
  });
  expect(r.nanDefault).toBe('qwen3.6');
  expect(r.explicit).toBe('mi-lite');
  expect(r.openai).toBe('modelo-principal');
  expect(r.custom).toBe('modelo-principal');
});
