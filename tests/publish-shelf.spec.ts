import { test, expect, Page } from '@playwright/test';
import fs from 'fs';

// Perfil público (Ajustes → Perfil público, solo con ?perfil-preview=1). La configuración se
// guarda: qué estanterías, en qué orden y con qué nombre, qué libros de cada una, progreso y
// «leyendo ahora». Lo que entra después en una estantería pública queda oculto hasta marcarlo.
// Descargar deja la foto (formato 2) que convierte scripts/publicar-perfil.mjs; la vista previa la
// deja en localStorage para la página pública con ?draft=1.

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64), D = 'd'.repeat(64);

async function seed(page: Page, url = '/?perfil-preview=1') {
  await page.setViewportSize({ width: 1300, height: 900 });
  await page.goto(url);
  const ids = await page.evaluate(async ({ A, B, C }) => {
    const S: any = await import('/js/library/store.js');
    const ag = await S.addShelf('Técnico/Agentes');
    const hi = await S.addShelf('Historia');
    const c = document.createElement('canvas'); c.width = 300; c.height = 450;
    const x = c.getContext('2d')!; x.fillStyle = '#ffffff'; x.fillRect(0, 0, 300, 450); x.fillStyle = '#c0392b'; x.fillRect(0, 300, 300, 150);
    const cover = c.toDataURL('image/png');
    const now = Date.now();
    await S.putBook({ id: A, title: 'AI Agents: The Definitive Guide', author: 'Nicole Koenigstein', format: 'epub', size: 2_000_000,
      status: 'unread', progress: 0, addedAt: now, cover, shelfIds: [ag.id] });
    await S.putBook({ id: B, title: 'An Illustrated Guide to AI Agents', author: 'Maarten Grootendorst, Jay Alammar', format: 'pdf', size: 9_000_000,
      status: 'reading', progress: 71, addedAt: now - 1, lastOpenedAt: now, shelfIds: [ag.id, hi.id] });
    await S.putBook({ id: C, title: 'SPQR', author: 'Mary Beard', format: 'epub', status: 'finished', progress: 100, addedAt: now - 2, shelfIds: [hi.id] });
    return { ag: ag.id, hi: hi.id };
  }, { A, B, C });
  await page.reload();
  await page.waitForSelector('.lib-rail');
  return ids;
}

async function shelfMenu(page: Page, id: string) {
  await page.locator(`.lib-rail-kebab[data-shelf-menu="${id}"]`).click({ force: true });
}
const config = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('bookreader_public_profile') || 'null'));

test('sin la bandera no hay perfil público: ni en el menú ni en Ajustes', async ({ page }) => {
  const ids = await seed(page, '/');
  await shelfMenu(page, ids.ag);
  await expect(page.locator('.lib-menu-item[data-act="share"]')).toBeVisible();
  await expect(page.locator('.lib-menu-item[data-act="publish"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.evaluate(async () => (await import('/js/ui/app-settings.js')).open('public'));
  await expect(page.locator('.appset-nav-item[data-section="public"]')).toHaveCount(0);
});

test('con ?perfil-preview=1, Ajustes enseña la sección aunque no se haya abierto ningún menú', async ({ page }) => {
  await page.goto('/?perfil-preview=1');
  await page.waitForSelector('.lib-rail');
  await page.evaluate(async () => (await import('/js/ui/app-settings.js')).open('public'));
  await expect(page.locator('.appset-nav-item[data-section="public"]')).toBeVisible();
  await expect(page.locator('.pp #pp-enabled')).not.toBeChecked();
  await expect(page.locator('.pp .pp-body')).toBeHidden();
});

test('desde el menú: la estantería pasa a pública con sus libros visibles y queda guardado', async ({ page }) => {
  const ids = await seed(page);
  await shelfMenu(page, ids.ag);
  await page.locator('.lib-menu-item[data-act="publish"]').click();
  const pp = page.locator('.pp');
  await expect(pp).toBeVisible();
  await expect(pp.locator('#pp-enabled')).toBeChecked();
  await expect(pp.locator('.pp-shelf')).toHaveCount(1);
  await expect(pp.locator('.pp-shelf .pp-name')).toHaveValue('Agentes');
  await expect(pp.locator('.pp-shelf .pub-row')).toHaveCount(2);
  const c = await config(page);
  expect(c.enabled).toBe(true);
  expect(c.shelves[0].books.map((b: any) => [b.id, b.show])).toEqual([[A, true], [B, true]]);
});

test('un libro que entra después sale oculto y marcado «Nuevo»; uno que sale, desaparece', async ({ page }) => {
  const ids = await seed(page);
  await shelfMenu(page, ids.ag);
  await page.locator('.lib-menu-item[data-act="publish"]').click();
  await expect(page.locator('.pp-shelf .pub-row')).toHaveCount(2);
  await page.evaluate(async ({ D, A, ag }) => {
    const S: any = await import('/js/library/store.js');
    await S.putBook({ id: D, title: 'Libro nuevo', format: 'epub', status: 'unread', addedAt: Date.now(), shelfIds: [ag] });
    await S.toggleBookShelf(A, ag, false);
  }, { D, A, ag: ids.ag });
  await page.evaluate(async () => (await import('/js/ui/app-settings.js')).open('public'));
  const pp = page.locator('.pp');
  await expect(pp.locator('.pp-toggle .pp-fresh')).toHaveText('1 nuevos sin revisar');
  const rows = pp.locator('.pp-shelf .pub-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText('Libro nuevo');
  await expect(rows.nth(1).locator('input[data-k="show"]')).not.toBeChecked();
  await expect(rows.nth(1).locator('.pp-fresh')).toHaveText('Nuevo');
  // Marcarlo lo publica y deja de ser nuevo.
  await rows.nth(1).locator('input[data-k="show"]').check();
  await expect(pp.locator('.pp-fresh')).toHaveCount(0);
  const c = await config(page);
  expect(c.shelves[0].books.map((b: any) => [b.id, b.show])).toEqual([[B, true], [D, true]]);
  expect(JSON.stringify(c)).not.toContain('fresh');
});

test('descargar: varias estanterías en su orden, cada libro una vez, sin los ocultos', async ({ page }) => {
  const ids = await seed(page);
  await shelfMenu(page, ids.ag);
  await page.locator('.lib-menu-item[data-act="publish"]').click();
  const pp = page.locator('.pp');
  // Segunda estantería, renombrada y subida al primer puesto; un libro oculto; O'Reilly en otro.
  await pp.locator('#pp-add').selectOption(ids.hi);
  await pp.locator('#pp-add-btn').click();
  await expect(pp.locator('.pp-shelf')).toHaveCount(2);
  const hist = pp.locator(`.pp-shelf[data-shelf="${ids.hi}"]`);
  await hist.locator('.pp-name').fill('History');
  await hist.locator('.pp-name').blur();
  await hist.locator('button[data-k="sup"]').click();
  const ag = pp.locator(`.pp-shelf[data-shelf="${ids.ag}"]`);
  await ag.locator('.pub-row', { hasText: 'Definitive' }).locator('input[data-k="show"]').uncheck();
  await pp.locator(`.pp-shelf[data-shelf="${ids.hi}"] .pub-row`, { hasText: 'Illustrated' }).locator('select[data-k="style"]').selectOption('oreilly');
  await pp.locator('#pp-handle').fill('luis'); await pp.locator('#pp-handle').blur();
  await pp.locator('#pp-progress').uncheck();
  await pp.locator('#pp-filters').uncheck();
  // El selector dice qué ha decidido «automático»: SPQR (sin portada) → color de la portada.
  await expect(pp.locator(`.pp-shelf[data-shelf="${ids.hi}"] .pub-row`, { hasText: 'SPQR' }).locator('option[data-auto]')).toHaveText(/automático · color de la portada/);

  const dl = page.waitForEvent('download');
  await pp.locator('button[data-act="download"]').click();
  const snap = JSON.parse(fs.readFileSync((await (await dl).path())!, 'utf8'));
  expect(snap).toMatchObject({ format: 'bookreader-perfil', version: 2, handle: 'luis', showProgress: false, showFilters: false });
  expect(snap.shelves).toEqual([
    { id: 'history', name: 'History', books: [B.slice(0, 12), C.slice(0, 12)] },
    { id: 'agentes', name: 'Agentes', books: [B.slice(0, 12)] },
  ]);
  expect(snap.books.map((b: any) => b.title).sort()).toEqual(['An Illustrated Guide to AI Agents', 'SPQR']);   // sin el oculto, sin repetir
  const ill = snap.books.find((b: any) => b.bookId === B);
  expect(ill.spine).toMatchObject({ style: 'oreilly', author: 'Grootendorst & Alammar' });
  expect(ill.progress).toBeNull();
  expect(snap.now).toBe(B.slice(0, 12));   // automático: el visible a medias abierto más tarde
  for (const b of snap.books) expect(Object.keys(b).filter(k => k !== 'spineAuto').sort()).toEqual(['author', 'bookId', 'coverData', 'id', 'pages', 'pagesEstimated', 'progress', 'spine', 'status', 'title']);
  // `spineAuto` solo en el lomo que eligió la app (SPQR, automático), no en el O'Reilly elegido a mano.
  expect(ill.spineAuto).toBeUndefined();
  expect(snap.books.find((b: any) => b.bookId === C).spineAuto).toBe(true);
  // Portadas a 640 px de ancho (a 320 se veían borrosas en retina).
  const widths = await page.evaluate(async (srcs) => Promise.all(srcs.map(src => new Promise(res => {
    const i = new Image(); i.onload = () => res(i.naturalWidth); i.onerror = () => res(0); i.src = src;
  }))), snap.books.map((b: any) => b.coverData));
  expect(widths).toEqual(snap.books.map(() => 640));

  // Vista previa: la foto en localStorage y la página del handle con ?draft=1.
  const popup = page.waitForEvent('popup');
  await pp.locator('button[data-act="preview"]').click();
  await expect.poll(async () => (await popup).url()).toContain('/@luis/?draft=1');
  const draft = await page.evaluate(() => JSON.parse(localStorage.getItem('bookreader_perfil_draft') || 'null'));
  expect(draft.shelves).toHaveLength(2);
});

test('sync: la configuración del perfil gana la más reciente; el borrador no viaja', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async () => {
    const L: any = await import('/js/sync/layout.js');
    const S: any = await import('/js/storage.js');
    S.set('public_profile', { updatedAt: 100, enabled: false, shelves: [] });
    S.set('perfil_draft', { mucho: 'peso' });
    await L.restoreSnapshot({ settings: { public_profile: { updatedAt: 200, enabled: true, shelves: [] } } }, { mode: 'merge' });
    const a = S.get('public_profile').enabled;
    await L.restoreSnapshot({ settings: { public_profile: { updatedAt: 150, enabled: false, shelves: [] } } }, { mode: 'merge' });
    const b = S.get('public_profile').enabled;
    const snap = await L.buildSnapshot();
    return { a, b, draft: 'perfil_draft' in snap.settings, profile: 'public_profile' in snap.settings };
  });
  expect(r).toEqual({ a: true, b: true, draft: false, profile: true });
});

test('página pública con varias estanterías: pestañas, #enlace y «Show» cambia de estantería', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const cover = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="300" height="450" fill="#123456"/></svg>').toString('base64');
  const book = (id: string, title: string, status: string) => ({ id, title, author: 'Ana Pérez', status, progress: null, pages: 300, pagesEstimated: true,
    spine: { style: 'plain', bg: '#123456', ink: '#ffffff', muted: '#d9d9de', title, author: 'Pérez' }, coverData: cover });
  const snap = { format: 'bookreader-perfil', version: 2, now: 'x3',
    shelves: [{ id: 'agents', name: 'Agents', books: ['x1', 'x2'] }, { id: 'history', name: 'History', books: ['x2', 'x3'] }],
    books: [book('x1', 'Uno', 'unread'), book('x2', 'Dos', 'finished'), book('x3', 'Tres', 'reading')] };
  await page.goto('http://localhost:8899/@luis/');
  await page.evaluate((s) => localStorage.setItem('bookreader_perfil_draft', JSON.stringify(s)), snap);
  await page.goto('http://localhost:8899/@luis/?draft=1#history');
  await expect(page.locator('#pf-filters')).toBeVisible();   // sin `showFilters: false`, se ven
  const tabs = page.locator('#pf-tabs button');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');   // la del #enlace
  await expect(page.locator('#pf-caption')).toContainText('History');
  await expect(page.locator('.pf-bk')).toHaveCount(2);
  await tabs.nth(0).click();
  await expect(page).toHaveURL(/#agents$/);
  await expect(page.locator('#pf-caption')).toContainText('Agents');
  // «Reading now» es Tres, que solo está en History: Show vuelve allí y lo abre.
  await page.locator('#pf-now button').click();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#pf-ob')).toHaveClass(/is-open/, { timeout: 3000 });
  await expect(page.locator('.pf-ob-title')).toHaveText('Tres');
  expect(errors).toEqual([]);
});

test('página pública con el perfil.json de una estantería (formato 1): sin pestañas', async ({ page }) => {
  await page.goto('http://localhost:8899/@luis/');
  await expect(page.locator('.pf-bk').first()).toBeVisible();
  await expect(page.locator('#pf-tabs')).toBeHidden();
  await expect(page.locator('#pf-shelf-title')).toBeVisible();
});

test('lomo automático: detecta O\u2019Reilly por la portada y no confunde un paper ni Packt', async ({ page }) => {
  await page.goto('/');
  const names = ['definitive', 'illustrated', 'albada', 'skills', 'graph', 'harness', 'senior'];
  // Portadas reales del perfil, pasadas como data URL (desde otro puerto el canvas quedaría bloqueado).
  const covers = Object.fromEntries(names.map(n => [n, 'data:image/webp;base64,' + fs.readFileSync(`assets/perfil/luis/${n}.webp`).toString('base64')]));
  const r = await page.evaluate(async (covers) => {
    const P: any = await import('/js/library/publish.js');
    const out: Record<string, boolean> = {};
    for (const [c, src] of Object.entries(covers)) {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src as string; });
      // A 320 (como se calibró) y a 640 (como se usa): tiene que dar lo mismo.
      const at = (w: number) => {
        const cv = document.createElement('canvas'); cv.width = w; cv.height = Math.round(w * img.naturalHeight / img.naturalWidth);
        const ctx = cv.getContext('2d')!; ctx.drawImage(img, 0, 0, cv.width, cv.height);
        return P.looksOReilly(ctx.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height);
      };
      out[c] = at(320) && at(640);
      out[c + '@640'] = at(640) === at(320);
    }
    return out;
  }, covers);
  expect(Object.fromEntries(Object.entries(r).filter(([k]) => !k.endsWith('@640')))).toEqual({ definitive: true, illustrated: true, albada: true, skills: true, graph: false, harness: false, senior: false });
  expect(Object.entries(r).filter(([k, v]) => k.endsWith('@640') && !v)).toEqual([]);
});

test('configuración de antes: «color de la portada» por defecto pasa a automático; O\u2019Reilly elegido se queda', async ({ page }) => {
  await page.goto('/');
  const c = await page.evaluate(async () => {
    localStorage.setItem('bookreader_public_profile', JSON.stringify({ updatedAt: 1, enabled: true, shelves: [{ id: 's', name: 'S', books: [
      { id: 'x', show: true, style: 'plain' }, { id: 'y', show: true, style: 'oreilly' }] }] }));
    return (await import('/js/library/publish.js')).getConfig();
  });
  expect(c.shelves[0].books.map((b: any) => b.style)).toEqual(['auto', 'oreilly']);
});

test('página pública con showFilters: false: sin los filtros por estado', async ({ page }) => {
  const cover = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="300" height="450" fill="#123456"/></svg>').toString('base64');
  const snap = { format: 'bookreader-perfil', version: 2, now: null, showFilters: false, shelves: [{ id: 'a', name: 'A', books: ['x1'] }],
    books: [{ id: 'x1', title: 'Uno', author: 'Ana', status: 'reading', progress: 3, pages: 200, pagesEstimated: true,
      spine: { style: 'plain', bg: '#123456', ink: '#ffffff', muted: '#d9d9de', title: 'Uno', author: 'Ana' }, coverData: cover }] };
  await page.goto('http://localhost:8899/@luis/');
  await page.evaluate((s) => localStorage.setItem('bookreader_perfil_draft', JSON.stringify(s)), snap);
  await page.goto('http://localhost:8899/@luis/?draft=1');
  await expect(page.locator('.pf-bk')).toHaveCount(1);
  await expect(page.locator('#pf-filters')).toBeHidden();
});

test('perfil: idioma, presentación, foto, nota con enlace y «2026 en libros» llegan a la foto', async ({ page }) => {
  const ids = await seed(page);
  await page.evaluate(async ({ C }) => {
    const S: any = await import('/js/library/store.js');
    await S.updateBook(C, { finishedAt: Date.now() - 86400000 });
  }, { C });
  await shelfMenu(page, ids.hi);
  await page.locator('.lib-menu-item[data-act="publish"]').click();
  const pp = page.locator('.pp');
  await pp.locator('#pp-lang').selectOption('es');
  await pp.locator('#pp-bio').fill('Leo sobre historia.');
  await pp.locator('#pp-bio').blur();
  await pp.locator('#pp-year').check();
  const row = () => pp.locator('.pub-row', { hasText: 'SPQR' });
  await row().locator('button[data-k="note"]').click();
  await row().locator('textarea[data-k="note-text"]').fill('Una nota escrita a mano.');
  await row().locator('textarea[data-k="note-text"]').blur();
  // Un enlace que no es http(s) no se guarda.
  await row().locator('input[data-k="note-link"]').fill('javascript:alert(1)');
  await row().locator('input[data-k="note-link"]').blur();
  expect((await config(page)).shelves[0].books.find((b: any) => b.id === C).link).toBeUndefined();
  await row().locator('input[data-k="note-link"]').fill('https://example.org/spqr');
  await row().locator('input[data-k="note-link"]').blur();
  const dl = page.waitForEvent('download');
  await pp.locator('button[data-act="download"]').click();
  const snap = JSON.parse(fs.readFileSync((await (await dl).path())!, 'utf8'));
  expect(snap.profile).toMatchObject({ lang: 'es', bio: 'Leo sobre historia.' });
  const spqr = snap.books.find((b: any) => b.bookId === C);
  expect(spqr).toMatchObject({ note: 'Una nota escrita a mano.', link: 'https://example.org/spqr' });
  const y = new Date().getFullYear();
  // Solo lo terminado ESTE año y visible: SPQR sí; el Illustrated (a medias) no.
  expect(snap.shelves.at(-1)).toEqual({ id: `year-${y}`, name: `${y} en libros`, books: [C.slice(0, 12)], year: true });
});

test('página pública en español, con presentación, nota y enlace seguro', async ({ page }) => {
  const cover = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="300" height="450" fill="#123456"/></svg>').toString('base64');
  const book = (id: string, extra: object) => ({ id, title: 'Libro ' + id, author: 'Ana', status: 'finished', progress: 100, pages: 200, pagesEstimated: true,
    spine: { style: 'plain', bg: '#123456', ink: '#ffffff', muted: '#d9d9de', title: 'Libro ' + id, author: 'Ana' }, coverData: cover, ...extra });
  const snap = { format: 'bookreader-perfil', version: 2, now: null, owner: 'Ana Pérez', profile: { lang: 'es', bio: 'Hola, leo mucho.' },
    shelves: [{ id: 'h', name: 'Historia', books: ['x1', 'x2'] }],
    books: [book('x1', { note: 'Me cambió la forma de pensar.', link: 'https://example.org/x1' }), book('x2', { link: 'javascript:alert(1)' })] };
  await page.goto('http://localhost:8899/@luis/');
  await page.evaluate((s) => localStorage.setItem('bookreader_perfil_draft', JSON.stringify(s)), snap);
  await page.goto('http://localhost:8899/@luis/?draft=1');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.locator('#pf-bio')).toHaveText('Hola, leo mucho.');
  await expect(page.locator('#pf-filters button').first()).toContainText('Todos');
  await expect(page.locator('.pf-keys')).toContainText('recorrer');
  // Pie: la pregunta y la lista de espera en el idioma de la página.
  await expect(page.locator('.pf-foot-h')).toHaveText('¿Quieres una estantería como esta?');
  expect(decodeURIComponent((await page.locator('#pf-want').getAttribute('href'))!)).toContain('subject=Quiero mi propia estantería pública');
  await page.locator('.pf-bk').first().click();
  await page.locator('.pf-bk.is-active').click();
  await expect(page.locator('.pf-ob-note')).toHaveText('Me cambió la forma de pensar.');
  await expect(page.locator('.pf-ob-link')).toHaveAttribute('href', 'https://example.org/x1');
  await expect(page.locator('.pf-ob-link')).toHaveAttribute('rel', /nofollow/);
  await page.locator('[data-close]').click();
  await page.locator('#pf-next').click();
  await page.locator('.pf-bk.is-active').click();
  await expect(page.locator('#pf-ob')).toHaveClass(/is-open/);
  await expect(page.locator('.pf-ob-link')).toHaveCount(0);   // javascript: no se pinta
});

test('al publicar, la portada sale del fichero si está en el dispositivo (no de la miniatura guardada)', async ({ page }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1300, height: 900 });
  await page.goto('/index.html?perfil-preview=1');
  // Un EPUB con portada declarada y un PDF, importados de verdad (fichero en el dispositivo).
  for (const f of ['test.epub', 'test-multipage.pdf']) {
    await page.setInputFiles('#file-input', require('path').join(__dirname, f));
    await expect(page.locator('body')).toHaveClass(/reading/, { timeout: 20000 });
    await expect.poll(() => page.evaluate(async (n) => (await (await import('/js/library/store.js')).getAllRecords())
      .filter((r: any) => !r.deleted && r.cover).length >= n, f === 'test.epub' ? 1 : 2), { timeout: 15000 }).toBe(true);
    await page.goto('/index.html?perfil-preview=1');
  }
  // Su portada guardada pasa a ser un cuadro rojo de 100 px, como una miniatura pobre del sync.
  const shelf = await page.evaluate(async () => {
    const S: any = await import('/js/library/store.js');
    const sh = await S.addShelf('Pruebas');
    const c = document.createElement('canvas'); c.width = 100; c.height = 150;
    const x = c.getContext('2d')!; x.fillStyle = '#ff0000'; x.fillRect(0, 0, 100, 150);
    for (const r of (await S.getAllRecords()).filter((r: any) => !r.deleted)) await S.updateBook(r.id, { cover: c.toDataURL('image/png'), shelfIds: [sh.id] });
    return sh.id;
  });
  await page.reload();
  await page.waitForSelector('.lib-rail');
  await shelfMenu(page, shelf);
  await page.locator('.lib-menu-item[data-act="publish"]').click();
  const dl = page.waitForEvent('download');
  await page.locator('.pp button[data-act="download"]').click();
  const snap = JSON.parse(fs.readFileSync((await (await dl).path())!, 'utf8'));
  expect(snap.books).toHaveLength(2);
  // Ninguna portada publicada es el cuadro rojo: salen del EPUB y del PDF.
  const reds = await page.evaluate(async (srcs) => Promise.all(srcs.map(src => new Promise(res => {
    const i = new Image(); i.onload = () => {
      const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight;
      const x = c.getContext('2d')!; x.drawImage(i, 0, 0);
      const d = x.getImageData(0, 0, c.width, c.height).data; let red = 0;
      for (let k = 0; k < d.length; k += 4) if (d[k] > 200 && d[k + 1] < 40 && d[k + 2] < 40) red++;
      res(red / (d.length / 4));
    }; i.src = src;
  }))), snap.books.map((b: any) => b.coverData));
  for (const r of reds as number[]) expect(r).toBeLessThan(0.5);
});

// «Publicar» desde la app. Dos caminos (workers/sync/src/publish.js y profiles.js):
//   - alojado (MON7): cualquier cuenta del sync publica /@handle/ al momento, servido desde R2;
//   - manual (PUBLISH_PROFILES, hoy /@luis/): la foto va a una GitHub Action que commitea y despliega.
// Sin sync de BookReader, solo «Descargar para publicar».
async function withSync(page: Page, vars: Record<string, string> = {}) {
  const { createSyncServer, installSyncServer, seedBookReaderSync } = await import('./bookreader-sync-mock');
  const server = await createSyncServer({
    ALLOWED_ORIGINS: `http://localhost:${new URL(test.info().project.use.baseURL || 'http://localhost:8888').port}`,
    PROFILE_TEMPLATE_HTML: '<!doctype html><h1>{{NAME}}</h1>', ...vars,
  });
  await installSyncServer(page.context(), server);
  await seedBookReaderSync(page.context());
  const ids = await seed(page);
  await page.evaluate(async () => { const A = await import('/js/sync/bookreader-auth.js'); await A.enable(); await A.getToken(true); });
  return { server, ids };
}

test('publicar alojado: con sync, elige dirección, publica al momento y se puede retirar', async ({ page }) => {
  const { server, ids } = await withSync(page);
  await shelfMenu(page, ids.ag);
  await page.locator('.lib-menu-item[data-act="publish"]').click();
  const pp = page.locator('.pp');
  await expect(pp.locator('button[data-act="publish"]')).toBeVisible();
  await expect(pp.locator('button[data-act="download"]')).toHaveText('Descargar');

  // Una dirección reservada se rechaza con un motivo que se entiende.
  await pp.locator('#pp-handle').fill('app'); await pp.locator('#pp-handle').blur();
  await pp.locator('button[data-act="publish"]').click();
  await expect(page.locator('.dlg-overlay')).toContainText('reservadas');
  await page.locator('.dlg-overlay .dlg-ok').click();

  await pp.locator('#pp-handle').fill('Ana Lee'); await pp.locator('#pp-handle').blur();
  await expect(pp.locator('#pp-handle')).toHaveValue('ana-lee');
  await pp.locator('#pp-name').fill('Ana Lee'); await pp.locator('#pp-name').blur();
  await pp.locator('button[data-act="publish"]').click();
  await expect(pp.locator('.pp-status')).toContainText('bookreader.raiatech.com/@ana-lee/');
  const perfil = JSON.parse(new TextDecoder().decode(server.env.SYNC._m.get('profiles/ana-lee/perfil.json')));
  expect(perfil.owner).toBe('Ana Lee');
  expect(perfil.books.map((b: any) => b.title).sort()).toEqual(['AI Agents: The Definitive Guide', 'An Illustrated Guide to AI Agents']);
  expect(JSON.stringify(perfil)).not.toContain(A);   // el bookId no sale

  await pp.locator('button[data-act="unpublish"]').click();
  await page.locator('.dlg-overlay .dlg-ok').click();
  await expect(pp.locator('button[data-act="unpublish"]')).toHaveCount(0);
  expect([...server.env.SYNC._m.keys()].filter((k: string) => k.startsWith('profiles/'))).toEqual([]);
});

test('publicar con la Action (PUBLISH_PROFILES): manda la foto, avisa a GitHub y enseña el estado', async ({ page }) => {
  test.setTimeout(60_000);
  const dispatches: any[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).startsWith('https://api.github.com/')) { dispatches.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    return realFetch(url, init);
  }) as typeof fetch;
  try {
    const { server, ids } = await withSync(page, { PUBLISH_REPO: 'iamluisgb/bookreader', GITHUB_DISPATCH_TOKEN: 'gh-test', PUBLISH_PULL_TOKEN: 'pull-test' });
    const user = server.env.DB._raw.prepare('SELECT user FROM tokens ORDER BY rowid DESC LIMIT 1').get().user;
    server.env.PUBLISH_PROFILES = JSON.stringify({ [user]: 'luis' });
    await page.evaluate(() => { const c = JSON.parse(localStorage.getItem('bookreader_public_profile') || '{}'); localStorage.setItem('bookreader_public_profile', JSON.stringify({ ...c, handle: 'luis' })); });
    await shelfMenu(page, ids.ag);
    await page.locator('.lib-menu-item[data-act="publish"]').click();
    const pp = page.locator('.pp');
    await pp.locator('#pp-handle').fill('luis'); await pp.locator('#pp-handle').blur();
    await pp.locator('button[data-act="publish"]').click();
    await expect(pp.locator('.pp-status')).toHaveText(/en cola/);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({ event_type: 'publicar-perfil', client_payload: { handle: 'luis' } });
    const snap = JSON.parse(new TextDecoder().decode(server.env.SYNC._m.get('publish/luis.json')));
    expect(snap).toMatchObject({ format: 'bookreader-perfil', version: 2, handle: 'luis' });
    expect(snap.books.map((b: any) => b.bookId).sort()).toEqual([A, B]);

    const res = await server.worker.fetch(new Request('https://x/v1/profile/status/luis', {
      method: 'POST', headers: { Authorization: 'Bearer pull-test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: dispatches[0].client_payload.id, state: 'done', sha: 'f'.repeat(40) }),
    }), server.env);
    expect(res.status).toBe(200);
    await expect(pp.locator('.pp-status')).toHaveText(/Publicado el/, { timeout: 20_000 });
  } finally { globalThis.fetch = realFetch; }
});

test('sin sync de BookReader: solo «Descargar para publicar»', async ({ page }) => {
  const ids = await seed(page);
  await shelfMenu(page, ids.ag);
  await page.locator('.lib-menu-item[data-act="publish"]').click();
  const pp = page.locator('.pp');
  await expect(pp.locator('button[data-act="download"]')).toHaveText('Descargar para publicar');
  await expect(pp.locator('button[data-act="publish"]')).toHaveCount(0);
});
