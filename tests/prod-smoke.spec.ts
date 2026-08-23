import { test, expect } from '@playwright/test';

// Humo contra lo DESPLEGADO. No entra en `npm test`: necesita red y un deploy vivo.
//
//   npm run smoke                      → contra producción
//   SMOKE_URL=https://xxx.pages.dev npm run smoke   → contra un deploy concreto
//   SMOKE_COMMIT=$(git rev-parse HEAD) npm run smoke → exige que sea ESE commit
//
// Por qué existe: la suite normal sirve `app/` como RAÍZ (ver playwright.config),
// mientras que en producción la app cuelga de `/app/`. Ningún test tocaba nunca
// las rutas reales, así que un deploy podía estar roto —o ser de otro commit— sin
// que nada lo dijera. Aquí se comprueba el sitio de verdad, tal y como lo abre un
// usuario.
//
// Deliberadamente corto: esto NO reemplaza a la suite, responde "¿lo que acabo de
// desplegar está vivo y es lo que creo?".

const BASE = (process.env.SMOKE_URL || 'https://bookreader-2h5.pages.dev').replace(/\/$/, '');
const APP = BASE + '/app/';

test.use({ baseURL: undefined });
test.describe.configure({ retries: 2 });   // red real

test('@smoke el deploy sirve el commit que se espera', async ({ request }) => {
  const res = await request.get(`${BASE}/build.json?cb=${Date.now()}`);
  const cuerpo = await res.text();
  // Cloudflare Pages responde 200 con el index.html a las rutas que no existen,
  // así que el status NO distingue "no hay build.json" de "sí lo hay": hay que
  // mirar el cuerpo, o el fallo sale como un SyntaxError sin sentido.
  expect(cuerpo.trimStart().startsWith('{'),
    `${BASE}/build.json no existe (devuelve el fallback HTML): el deploy se hizo con el script viejo, anterior al sello de commit`)
    .toBe(true);
  const build = JSON.parse(cuerpo);
  expect(build.commit).toMatch(/^[0-9a-f]{40}$|^worktree$/);

  // Un build marcado "worktree" en producción significa que alguien desplegó su
  // árbol de trabajo: puede llevar código sin commitear e irreproducible.
  expect(build.commit, 'hay un build del ÁRBOL DE TRABAJO en producción').not.toBe('worktree');

  // Encadenado a `deploy:pages`, esto corre a los pocos segundos de subir los
  // ficheros y Cloudflare todavía puede estar sirviendo el deploy anterior. Se
  // ESPERA a que aparezca el commit en vez de fiarlo a los reintentos, que
  // disparan de inmediato y convierten la propagación en un test flaky.
  if (process.env.SMOKE_COMMIT) {
    await expect.poll(async () => {
      const r = await request.get(`${BASE}/build.json?cb=${Date.now()}`);
      const t = await r.text();
      return t.trimStart().startsWith('{') ? JSON.parse(t).commit : null;
    }, {
      message: 'producción no llegó a servir el commit desplegado (¿deploy a medias?)',
      timeout: 90_000,
      intervals: [1000, 2000, 3000, 5000],
    }).toBe(process.env.SMOKE_COMMIT);
  }
  const final = await (await request.get(`${BASE}/build.json?cb=${Date.now()}`)).json();
  console.log(`  desplegado: ${final.commit.slice(0, 7)} (${final.builtAt})`);
});

test('@smoke la app arranca en /app/ y sus módulos cargan desde ahí', async ({ page }) => {
  const fallos: string[] = [];
  page.on('console', m => { if (m.type() === 'error') fallos.push(m.text()); });
  page.on('pageerror', e => fallos.push(String(e)));
  page.on('response', r => { if (r.status() >= 400) fallos.push(`${r.status()} ${r.url()}`); });

  await page.goto(APP);
  // La biblioteca es la pantalla de inicio: si pinta, el grueso de los módulos
  // (store, view, i18n, icons) se resolvió bien en su ruta real.
  await expect(page.locator('.lib-rail')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.lib-rail-item').first()).toBeVisible();

  expect(fallos, `errores al cargar ${APP}:\n  ${fallos.join('\n  ')}`).toEqual([]);
});

test('@smoke las estanterías nuevas funcionan sobre el despliegue real', async ({ page }) => {
  await page.goto(APP);
  await expect(page.locator('.lib-rail')).toBeVisible({ timeout: 15000 });

  // Se siembra en el IndexedDB de ESTE contexto efímero (cada test de Playwright
  // arranca con almacenamiento limpio y se descarta al terminar): no toca la
  // biblioteca de nadie.
  const rail = await page.evaluate(async () => {
    const Store: any = await import('./js/library/store.js');
    const View: any = await import('./js/library/view.js');
    const sh = await Store.addShelf('Humo/Anidada');
    await Store.addShelf('Regla', { rule: { status: 'reading' } });
    await Store.putBook({ id: 'smoke1', title: 'Libro de humo', format: 'epub',
      status: 'reading', addedAt: Date.now(), shelfIds: [sh.id] });
    await View.render();
    // Nombre + contador por separado, no el textContent de la fila entera: esa
    // caja lleva también la marca de la estantería (su inicial), que es
    // decoración y ensuciaría la comparación.
    return [...document.querySelectorAll('.lib-rail-item')].map(e => {
      const name = e.querySelector('.lib-rail-name')!.textContent!.trim();
      const count = e.querySelector('.lib-rail-count')!.textContent!.trim();
      return `${name} ${count}`;
    });
  });

  // "Humo" es un GRUPO derivado del nombre y "Regla" una inteligente que cuenta
  // por su regla: si ambas salen, el árbol y las reglas viven en producción.
  expect(rail).toContain('Humo 1');
  expect(rail).toContain('Anidada 1');
  expect(rail).toContain('Regla 1');
});
