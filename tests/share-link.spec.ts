import { test, expect, Page, BrowserContext } from '@playwright/test';

// P24 F4 · Compartir una estantería por ENLACE. El dossier se cifra en el navegador del
// emisor y se sube cifrado; la clave va en el fragmento (#d=<id>.<clave>), que no sale del
// navegador. Aquí el Worker (workers/share) es un doble en memoria compartido por los dos
// navegadores, que además deja ver lo que le llegó: bytes que no son el ZIP.
test.describe.configure({ retries: 1 });

type Store = Map<string, Buffer>;

async function stubShare(ctx: BrowserContext, store: Store, seen: { uploads: Buffer[] }) {
  await ctx.route('**/v1/share**', async (route) => {
    const req = route.request();
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (req.method() === 'POST') {
      const body = req.postDataBuffer()!;
      seen.uploads.push(body);
      const id = 'A'.repeat(21) + String(store.size);
      store.set(id, body);
      return route.fulfill({ status: 201, headers: { 'Content-Type': 'application/json', ...cors },
        body: JSON.stringify({ id, expiresAt: Date.now() + 7 * 864e5, deleteToken: 'tok' }) });
    }
    const id = req.url().split('/').pop()!;
    if (req.method() === 'DELETE') {
      store.delete(id);
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json', ...cors }, body: '{"ok":true}' });
    }
    const b = store.get(id);
    if (!b) return route.fulfill({ status: 410, headers: cors, body: '{"error":"expired"}' });
    return route.fulfill({ status: 200, headers: { 'Content-Type': 'application/octet-stream', ...cors }, body: b });
  });
}

async function seed(page: Page) {
  return page.evaluate(async () => {
    const Store: any = await import('/js/library/store.js');
    const DB: any = await import('/js/ai/db.js');
    const Storage: any = await import('/js/storage.js');
    const kg = await Store.addShelf('Knowledge graphs');
    const bytes = new Uint8Array(4096);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) % 251;
    const A = await DB.hashBuffer(bytes.buffer.slice(0));
    const now = Date.now();
    const c = document.createElement('canvas'); c.width = 60; c.height = 90;
    const ctx = c.getContext('2d')!; ctx.fillStyle = '#c0392b'; ctx.fillRect(0, 0, 60, 90);
    await Store.putBook({ id: A, title: 'Knowledge Graphs (survey)', author: 'Hogan et al.', format: 'pdf',
      fileName: 'kg.pdf', size: bytes.length, status: 'reading', addedAt: now, shelfIds: [kg.id],
      cover: c.toDataURL('image/jpeg', 0.8), file: new Blob([bytes], { type: 'application/pdf' }) });
    Storage.set('highlights_' + A, [{ uid: 'u1', id: 'p1', page: 3, rects: [{ x: 0.1, y: 0.2, w: 0.5, h: 0.02 }],
      text: 'A knowledge graph is…', color: '#ffeb3b', timestamp: now, updatedAt: now }]);
    return { A };
  });
}

test('enlace: se cifra, se abre en otro navegador y la estantería llega con libro y notas', async ({ browser }) => {
  const store: Store = new Map();
  const seen = { uploads: [] as Buffer[] };
  const emisor = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const receptor = await browser.newContext();
  try {
    await stubShare(emisor, store, seen);
    await stubShare(receptor, store, seen);
    const p1 = await emisor.newPage();
    await p1.goto('/');
    const { A } = await seed(p1);
    await p1.reload();

    const row = p1.locator('.lib-rail-row', { has: p1.locator('.lib-rail-name', { hasText: /^Knowledge graphs$/ }) });
    await row.hover();
    await row.locator('.lib-rail-kebab').click();
    await p1.locator('.lib-menu-item[data-act="share"]').click();
    await expect(p1.locator('.dlg-input[data-field="how"]')).toHaveValue('link');
    await p1.locator('.dlg-input[data-field="author"]').fill('Luis');
    await p1.getByRole('button', { name: 'Compartir', exact: true }).click();
    await expect(p1.locator('.dlg-card')).toContainText('Enlace copiado');

    const clip = await p1.evaluate(() => navigator.clipboard.readText());
    const url = clip.match(/https?:\/\/\S+/)![0];
    expect(url).toMatch(/#d=[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    // Al servidor no llega ni la clave ni el ZIP en claro.
    const key = url.split('.').pop()!;
    const up = seen.uploads[0];
    expect(up.subarray(0, 4).toString()).toBe('BRL1');
    expect(up.includes(Buffer.from('PK\x03\x04'))).toBe(false);
    expect(up.includes(Buffer.from('Knowledge'))).toBe(false);
    expect(up.toString('latin1')).not.toContain(key);

    // El receptor abre el enlace: revisión del dossier, importar, y el libro con su nota.
    const p2 = await receptor.newPage();
    await p2.goto(url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/app\//, '/'));
    await expect(p2.locator('.dlg-card')).toContainText('Abrir «Knowledge graphs»', { timeout: 20000 });
    await expect(p2.locator('.dlg-card')).toContainText('De Luis');
    // La clave ya no está en la barra de direcciones.
    expect(await p2.evaluate(() => location.hash)).not.toContain('d=');
    await p2.getByRole('button', { name: 'Importar' }).click();
    await expect(p2.locator('.dlg-card')).toContainText('Listo');
    const got = await p2.evaluate(async (A) => {
      const Store: any = await import('/js/library/store.js');
      const b = await Store.getBook(A);
      return { title: b?.title, hasFile: Store.hasFile(b), cover: /^data:image\/jpeg;base64,/.test(b?.cover || '') };
    }, A);
    // Con su portada desde el primer momento (antes salían las iniciales hasta abrirlo).
    expect(got).toEqual({ title: 'Knowledge Graphs (survey)', hasFile: true, cover: true });
  } finally {
    await emisor.close(); await receptor.close();
  }
});

test('enlace caducado o cortado: lo dice, sin romper la app', async ({ page, context }) => {
  const store: Store = new Map();
  await stubShare(context, store, { uploads: [] });
  await page.goto('/#d=' + 'Z'.repeat(22) + '.' + 'k'.repeat(43));
  await expect(page.locator('.dlg-card')).toContainText('ha caducado');
  await page.locator('.dlg-ok').click();
  await expect(page.locator('.lib-h1')).toBeVisible();
});

test('sin servidor de enlaces: ofrece mandarla como fichero sin empezar de nuevo', async ({ page, context }) => {
  await context.route('**/v1/share**', (route) => route.abort());
  await page.goto('/');
  await seed(page);
  await page.reload();
  const row = page.locator('.lib-rail-row', { has: page.locator('.lib-rail-name', { hasText: /^Knowledge graphs$/ }) });
  await row.hover();
  await row.locator('.lib-rail-kebab').click();
  await page.locator('.lib-menu-item[data-act="share"]').click();
  await page.getByRole('button', { name: 'Compartir', exact: true }).click();
  await expect(page.locator('.dlg-card')).toContainText('No se pudo crear el enlace');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Mandar fichero' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('knowledge-graphs.bookreader');
});

test('retirar el enlace desde el menú de la estantería: quien lo abra después ya no puede', async ({ browser }) => {
  const store: Store = new Map();
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  try {
    await stubShare(ctx, store, { uploads: [] });
    const p = await ctx.newPage();
    await p.goto('/');
    await seed(p);
    await p.reload();
    const row = p.locator('.lib-rail-row', { has: p.locator('.lib-rail-name', { hasText: /^Knowledge graphs$/ }) });
    await row.hover();
    await row.locator('.lib-rail-kebab').click();
    await p.locator('.lib-menu-item[data-act="share"]').click();
    await p.getByRole('button', { name: 'Compartir', exact: true }).click();
    await expect(p.locator('.dlg-card')).toContainText('puedes retirarlo antes');
    const url = (await p.evaluate(() => navigator.clipboard.readText())).match(/https?:\/\/\S+/)![0];
    await p.locator('.dlg-ok').click();
    expect(store.size).toBe(1);

    await row.hover();
    await row.locator('.lib-rail-kebab').click();
    await p.locator('.lib-menu-item[data-act="links"]').click();
    await expect(p.locator('.dlg-card')).toContainText('caduca el');
    await p.getByRole('button', { name: 'Retirar' }).click();
    await expect.poll(() => store.size).toBe(0);

    const other = await browser.newContext();
    await stubShare(other, store, { uploads: [] });
    const q = await other.newPage();
    await q.goto(url.replace(/^https?:\/\/[^/]+/, ''));
    await expect(q.locator('.dlg-card')).toContainText('ha caducado o lo han retirado');
    await other.close();
    // Y el menú ya no ofrece retirarlo.
    await row.hover();
    await row.locator('.lib-rail-kebab').click();
    await expect(p.locator('.lib-menu-item[data-act="links"]')).toHaveCount(0);
  } finally { await ctx.close(); }
});

test('la puerta /s/: vista previa propia y redirige a la app con el fragmento intacto', async ({ page }) => {
  const frag = '#d=' + 'A'.repeat(22) + '.' + 'k'.repeat(43);
  // Servidor de la raíz del repo (landings, /s/ y /app/). La app, ya en /app/, pide al
  // servidor de enlaces ESE id: prueba de que el fragmento sobrevivió a la redirección.
  const pedidos: string[] = [];
  await page.route('**/v1/share/**', (route) => {
    pedidos.push(route.request().url());
    return route.fulfill({ status: 410, headers: { 'Access-Control-Allow-Origin': '*' }, body: '{}' });
  });
  const html = await (await page.request.get('http://localhost:8899/s/')).text();
  expect(html).toContain('og:title" content="Te han compartido una estantería en BookReader"');
  expect(html).toContain('og-estanteria-compartida.png');
  expect(html).not.toContain('/u/s.js');                 // sin analítica: aquí la URL lleva la clave
  await page.goto('http://localhost:8899/s/' + frag);
  await expect.poll(() => pedidos.length, { timeout: 15000 }).toBeGreaterThan(0);
  expect(pedidos[0]).toMatch(new RegExp('/v1/share/' + 'A'.repeat(22) + '$'));
  expect(new URL(page.url()).pathname).toBe('/app/');
  expect(page.url()).not.toContain('d=');                // y la clave ya no está en la barra
});
