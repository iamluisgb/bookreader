import { test, expect } from '@playwright/test';

// Brillo + luz nocturna (tipo Play Books): overlays de pantalla que la web aplica porque
// no puede tocar el brillo/temperatura reales. Brillo → capa negra; luz nocturna → ámbar.

test('brillo y luz nocturna aplican overlays y persisten', async ({ page }) => {
  await page.goto('/index.html');
  await page.waitForTimeout(200);

  // Por defecto: sin efecto (opacidad 0 en ambos). Leemos la opacidad INLINE (valor objetivo,
  // no el animado por la transición CSS).
  const def = await page.evaluate(() => ({
    dim: document.getElementById('screen-dim')!.style.opacity,
    warm: document.getElementById('night-warm')!.style.opacity,
  }));
  expect(parseFloat(def.dim) || 0).toBe(0);
  expect(parseFloat(def.warm) || 0).toBe(0);

  // Ajustar brillo (0.6) y luz nocturna (0.8).
  await page.evaluate(async () => {
    const S: any = await import('/js/settings.js');
    S.set('brightness', 0.6);
    S.set('nightLight', 0.8);
  });
  const on = await page.evaluate(() => ({
    dim: parseFloat(document.getElementById('screen-dim')!.style.opacity),
    warm: parseFloat(document.getElementById('night-warm')!.style.opacity),
    nonBlocking: getComputedStyle(document.getElementById('screen-dim')!).pointerEvents,
    brVal: document.getElementById('brightness-value')!.textContent,
    nlVal: document.getElementById('night-light-value')!.textContent,
  }));
  expect(on.dim).toBeCloseTo(0.4, 2);    // 1 - 0.6
  expect(on.warm).toBeCloseTo(0.6, 2);   // 0.8 * 0.75
  expect(on.nonBlocking).toBe('none');   // los overlays no capturan eventos
  expect(on.brVal).toBe('60%');
  expect(on.nlVal).toBe('80%');

  // Persiste tras recargar.
  await page.reload();
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => ({
    dim: parseFloat(document.getElementById('screen-dim')!.style.opacity),
    warm: parseFloat(document.getElementById('night-warm')!.style.opacity),
    slider: (document.getElementById('brightness') as HTMLInputElement).value,
  }));
  expect(after.dim).toBeCloseTo(0.4, 2);
  expect(after.warm).toBeCloseTo(0.6, 2);
  expect(after.slider).toBe('0.6');
});
