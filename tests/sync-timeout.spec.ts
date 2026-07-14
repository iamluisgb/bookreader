import { test, expect } from '@playwright/test';

// Regresión del "Sincronizando… que no acaba": una petición de red estancada (a Drive o al
// Worker de auth) colgaba el ciclo para siempre. fetchWithTimeout aborta pasado el techo y
// lanza code:'timeout', para que el ciclo falle a 'error' en vez de quedarse colgado.
test('fetchWithTimeout aborta una petición estancada', async ({ page }) => {
  await page.goto('/index.html');
  const out = await page.evaluate(async () => {
    const Net: any = await import('/js/sync/net.js');
    const realFetch = window.fetch;
    // fetch que NUNCA resuelve, pero honra el abort (como el fetch real).
    window.fetch = ((_url: string, opts: any) => new Promise((_res, rej) => {
      opts.signal.addEventListener('abort', () => {
        const e: any = new Error('aborted'); e.name = 'AbortError'; rej(e);
      });
    })) as any;
    const t0 = Date.now();
    let code = '', threw = false;
    try {
      await Net.fetchWithTimeout('https://example.test/hang', {}, 100);
    } catch (e: any) { threw = true; code = e.code; }
    window.fetch = realFetch;
    return { threw, code, elapsed: Date.now() - t0 };
  });
  expect(out.threw).toBe(true);
  expect(out.code).toBe('timeout');
  expect(out.elapsed).toBeGreaterThanOrEqual(90);
  expect(out.elapsed).toBeLessThan(3000);   // aborta pronto, no cuelga
});
