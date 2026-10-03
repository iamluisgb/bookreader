import { test, expect } from '@playwright/test';

// Contrato de la biblioteca de patrones (app/patterns.html, DESIGN.md §6): cada patrón
// se pinta con SUS tokens en los cuatro temas. Si alguien vuelve a colorear un botón por
// pantalla, o un token deja de existir en un tema, esto falla antes que el ojo.
const TEMAS = ['', 'light', 'dark', 'sepia'];

for (const tema of TEMAS) {
  test(`patrones con sus tokens · tema ${tema || 'sistema'}`, async ({ page }) => {
    // El tema se fija ANTES de cargar: cambiarlo después dispara las transiciones de los
    // botones y se leería un color a medio camino.
    if (tema) await page.addInitScript((t) => document.documentElement.setAttribute('data-theme', t), tema);
    await page.goto('/patterns.html');

    const r = await page.evaluate(() => {
      const css = (el: Element, p: string) => getComputedStyle(el).getPropertyValue(p).trim();
      const probe = document.createElement('div');
      document.body.appendChild(probe);
      const resolve = (name: string, prop = 'background-color') => {
        probe.style.setProperty(prop, `var(${name})`);
        return getComputedStyle(probe).getPropertyValue(prop);
      };
      const sw = (document.querySelector('[data-swatches]') as HTMLElement).dataset.swatches!.split(' ');
      return {
        vacios: sw.filter((n) => css(document.documentElement, n) === ''),
        primary: [css(document.querySelector('.btn--primary')!, 'background-color'), resolve('--btn-bg')],
        secondary: [css(document.querySelector('.btn--secondary')!, 'background-color'), resolve('--fill')],
        seg: [css(document.querySelector('#pl-seg .segmented-btn.active')!, 'background-color'), resolve('--fill-raised')],
      };
    });

    expect(r.vacios, 'tokens sin valor en este tema').toEqual([]);
    expect(r.primary[0]).toBe(r.primary[1]);
    expect(r.secondary[0]).toBe(r.secondary[1]);
    expect(r.seg[0]).toBe(r.seg[1]);
  });
}
