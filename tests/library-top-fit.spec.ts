import { test, expect, devices, Page } from '@playwright/test';
import path from 'path';

// La portada de la biblioteca («Continuar leyendo» + «Repaso de hoy») tiene que caber en el
// sitio que tiene. Reportado en un Pixel en horizontal (~915×412): entraba por ancho en el
// diseño de escritorio, con el rail fijo y dos columnas, y la tarjeta se quedaba con 250 px y el
// título de escritorio: una palabra por línea, cortada, y la tarjeta más alta que la pantalla.

const TITULO = 'Site Reliability Engineering 2nd: How Google Runs Production Systems';

async function preparar(page: Page) {
  await page.goto('/');
  await page.setInputFiles('#file-input', path.join(__dirname, 'oreilly-like.epub'));
  await page.waitForSelector('#epub-container iframe', { state: 'attached', timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.evaluate(async () => { const R: any = await import('/js/epub-reader.js'); for (let i = 0; i < 3; i++) { R.next(); await new Promise(r => setTimeout(r, 400)); } });
  await page.waitForTimeout(1000);
  await page.goto('/');
  await page.waitForSelector('.lib-hero-title', { timeout: 20000 });
  // Título largo como el de O'Reilly y una tarjeta de repaso con pendientes (la real depende
  // de los mazos; aquí importa la maqueta).
  await page.evaluate((titulo) => {
    document.querySelector('.lib-steps')?.remove();
    document.querySelector('.lib-hero-title')!.textContent = titulo;
    document.querySelector('.lib-top')!.classList.add('has-today');
    // Marcado como el real: iconos en los botones y la racha en su hueco (en el Pixel real eran
    // lo que hacía bajar «Elegir» a otra línea y abría una fila más con el chip 🔥).
    const ico = '<svg class="icon" width="20" height="20" viewBox="0 0 24 24"></svg>';
    document.querySelector('.lib-today-slot')!.innerHTML = `<section class="lib-today"><div class="lib-today-ring"><svg viewBox="0 0 64 64"></svg><span>146</span></div>
      <div class="lib-today-body"><p class="lib-hero-kicker">Repaso de hoy</p><h2 class="lib-today-title">146 tarjetas</h2><p class="lib-today-meta">~19 min</p>
      <div class="lib-today-actions"><button class="lib-study-chip">${ico}<span>Repasar hoy · 146</span></button><button class="lib-study-pick">Elegir${ico}</button></div></div></section>`;
    // Como hace paintStudyChip: el hueco de la racha, a la línea de minutos de la tarjeta.
    const racha = document.querySelector('.lib-streak-slot') as HTMLElement;
    if (racha) { racha.innerHTML = `<span class="lib-streakchip">${ico}<b>1</b></span>`; document.querySelector('.lib-today-meta')!.appendChild(racha); }
  }, TITULO);
  await page.waitForTimeout(300);
}

const medir = (page: Page) => page.evaluate(() => {
  const r = (s: string) => (document.querySelector(s) as HTMLElement).getBoundingClientRect();
  const t = document.querySelector('.lib-hero-title') as HTMLElement;
  const hero = r('.lib-hero'), today = r('.lib-today'), titulo = r('.lib-hero-title');
  const botones = [...document.querySelectorAll('.lib-today-actions button')].map(b => b.getBoundingClientRect());
  return {
    vh: innerHeight,
    heroAlto: hero.height,
    tituloDesborda: t.scrollWidth > t.clientWidth + 1 || titulo.right > hero.right + 1,
    tituloAncho: titulo.width,
    botonesDentro: botones.every(b => b.right <= today.right + 1 && b.left >= today.left - 1),
    botonesEnUnaFila: botones.length === 2 && Math.abs(botones[0].top - botones[1].top) < 2,
    // La racha, a la vista y dentro de la tarjeta de repaso sin pisar texto ni botones.
    rachaDentro: (() => {
      const c = document.querySelector('.lib-streakchip') as HTMLElement;
      if (!c) return false;
      const b = c.getBoundingClientRect();
      if (!(b.width && b.left >= today.left && b.right <= today.right && b.top >= today.top && b.bottom <= today.bottom)) return false;
      const otros = [...document.querySelectorAll('.lib-today-title, .lib-today-actions button, .lib-today-ring')]
        .map(e => e.getBoundingClientRect()).filter(r => r.width);
      return otros.every(r => b.right <= r.left || b.left >= r.right || b.bottom <= r.top || b.top >= r.bottom);
    })(),
    todayAlto: today.height,
    topAlto: (document.querySelector('.lib-top') as HTMLElement).getBoundingClientRect().height,
  };
});

const casos: [string, any, boolean][] = [
  ['móvil en horizontal', (({ defaultBrowserType, ...d }) => ({ ...d, viewport: { width: 915, height: 412 } }))(devices['Pixel 7 landscape']), true],
  ['móvil en vertical', (({ defaultBrowserType, ...d }) => d)(devices['Pixel 7']), false],
  ['escritorio mediano (rail + dos columnas)', { viewport: { width: 1024, height: 768 } }, false],
  ['escritorio', { viewport: { width: 1440, height: 900 } }, false],
];

for (const [nombre, opts, bajo] of casos) {
  test.describe(nombre, () => {
    test.use(opts);
    test(`${nombre}: «Continuar» y «Repaso» caben sin cortar el título`, async ({ page }) => {
      await preparar(page);
      const m = await medir(page);
      expect(m.tituloDesborda, 'el título se sale de la tarjeta').toBe(false);
      expect(m.tituloAncho, 'el título no puede quedar a palabra por línea').toBeGreaterThan(150);
      expect(m.botonesDentro, 'los botones del repaso se salen de su tarjeta').toBe(true);
      expect(m.rachaDentro, 'la racha tiene que verse en la esquina del repaso sin pisar nada').toBe(true);
      if (bajo) {
        // En una pantalla baja la fila de arriba deja ver la biblioteca.
        expect(m.heroAlto).toBeLessThan(m.vh * 0.4);
        expect(m.botonesEnUnaFila, '«Elegir» bajó a otra línea').toBe(true);
        // Una sola fila de tarjetas iguales, sin una fila extra para la racha, y compacta.
        expect(Math.abs(m.todayAlto - m.heroAlto), 'las dos tarjetas a la misma altura').toBeLessThan(2);
        expect(m.topAlto).toBeLessThanOrEqual(m.heroAlto + 2);
        expect(m.topAlto).toBeLessThan(m.vh * 0.35);
        await expect(page.locator('.lib-layout > .lib-rail')).toBeHidden();
        const portada = await page.locator('.lib-grid .lib-card').first().boundingBox();
        expect(portada!.y, 'la primera portada se ve sin desplazarse').toBeLessThan(m.vh);
      }
    });
  });
}
