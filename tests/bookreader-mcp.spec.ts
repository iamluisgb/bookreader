import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createSyncServer, installSyncServer, seedBookReaderSync, enableSyncPreview, SYNC_URL } from './bookreader-sync-mock';

// MON4 · El MCP remoto desde la app: Ajustes → Datos → Agentes. Se crea un token, un agente lo
// usa contra el Worker de verdad (el mismo servidor que la app) y lee lo que la app sincronizó;
// al revocarlo, deja de poder.

test('Agentes: crear un token, leer con él por MCP lo sincronizado, y revocarlo', async ({ page, context }) => {
  const server = await createSyncServer();
  await installSyncServer(page, server);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await enableSyncPreview(page);
  await seedBookReaderSync(page);
  await page.goto('/');
  const bookId = await page.evaluate(async () => {
    await (await import('/js/sync/bookreader-auth.js')).enable();
    const Store = await import('/js/library/store.js');
    const buf = new Uint8Array(2048).map((_, i) => (i * 7) % 251);
    const id = 'libro-mcp';
    await Store.putBook({
      id, title: 'Rayuela', author: 'Julio Cortázar', format: 'epub', fileName: 'rayuela.epub',
      file: buf.buffer, size: buf.length, addedAt: Date.now(), progress: 0, status: 'reading', shelfIds: [],
    });
    const H = await import('/js/highlights.js');
    H.setBook(id);
    H.add('epubcfi(/6/4!/4/2)', 'lo que lee el agente', '#ffeb3b', 'c1', '');
    await (await import('/js/sync/engine.js')).syncNow();
    return id;
  });

  await page.evaluate(async () => (await import('/js/ui/app-settings.js')).open('data'));
  await expect(page.locator('#appset-br-on')).toBeVisible();
  await page.locator('#appset-br-agent-create').click();
  await page.locator('.dlg-overlay [data-field="name"]').fill('Hermes');
  await page.locator('.dlg-overlay .dlg-ok').click();
  await expect(page.locator('#appset-br-agent-new')).toBeVisible();
  const token = (await page.locator('#appset-br-agent-token').textContent())!.trim();
  expect(token).toMatch(/^br-mcp-/);
  await expect(page.locator('#appset-br-agent-cmd')).toContainText(`claude mcp add --transport http bookreader ${SYNC_URL}/mcp --header "Authorization: Bearer ${token}"`);
  await expect(page.locator('#appset-br-agents .appset-link')).toHaveCount(1);
  await expect(page.locator('#appset-br-agents')).toContainText('Hermes');
  await expect(page.locator('#appset-br-agents')).toContainText('Solo lee');

  // El agente: MCP por HTTP, sin navegador, contra el mismo servidor.
  const mcp = async (method: string, params: any = {}) => {
    const res = await server.worker.fetch(new Request(SYNC_URL + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }), server.env);
    return { status: res.status, body: res.status === 200 ? await res.json() : null };
  };
  const hl = await mcp('tools/call', { name: 'get_highlights', arguments: { book: 'rayuela' } });
  expect(hl.status).toBe(200);
  const out = JSON.parse(hl.body.result.content[0].text);
  expect(out.bookId).toBe(bookId);
  expect(out.highlights.map((h: any) => h.text)).toEqual(['lo que lee el agente']);

  // Revocar desde la app: el agente se queda fuera al momento.
  await page.locator('#appset-br-agents [data-act="revoke"]').click();
  await page.locator('.dlg-overlay .dlg-ok').click();
  await expect(page.locator('#appset-br-agents .appset-link')).toHaveCount(0);
  expect((await mcp('tools/list')).status).toBe(401);
});

// Escritura: el agente reescribe una tarjeta mientras este dispositivo, sin sincronizar, la
// repasa. Tras el sync, la tarjeta tiene el texto del agente Y el repaso del dispositivo, aquí
// y en el servidor (mergeCardPair, textAt/srsAt).
test('Agente con escritura: su edición y un repaso hecho sin sincronizar sobreviven los dos', async ({ page }) => {
  const server = await createSyncServer();
  await installSyncServer(page, server);
  await enableSyncPreview(page);
  await seedBookReaderSync(page);
  await page.goto('/');
  const deckUid = await page.evaluate(async () => {
    await (await import('/js/sync/bookreader-auth.js')).enable();
    const Store = await import('/js/library/store.js');
    const buf = new Uint8Array(1024).map((_, i) => i % 251);
    await Store.putBook({ id: 'ddia', title: 'Designing Data-Intensive Applications', author: 'Kleppmann', format: 'epub', fileName: 'ddia.epub', file: buf.buffer, size: buf.length, addedAt: Date.now(), progress: 0, status: 'reading', shelfIds: [] });
    const DB = await import('/js/ai/db.js');
    const id = await DB.addDeck({ bookId: 'ddia', name: 'Transactions', scope: 'Chapter 8', cardType: 'basic', cards: [{ uid: 'c1', type: 'basic', front: 'What two guarantees does read committed give?', back: 'No dirty reads, no dirty writes.' }] });
    await (await import('/js/sync/engine.js')).syncNow();
    return (await DB.getAll('decks')).find((d: any) => d.id === id).uid;
  });

  await page.evaluate(async () => (await import('/js/ui/app-settings.js')).open('data'));
  await page.locator('#appset-br-agent-create').click();
  await page.locator('.dlg-overlay [data-field="name"]').fill('Claude');
  await page.locator('.dlg-overlay [data-check="scopes"][value="write"]').check();
  await page.locator('.dlg-overlay .dlg-ok').click();
  await expect(page.locator('#appset-br-agent-token')).toContainText('br-mcp-');
  const token = (await page.locator('#appset-br-agent-token').textContent())!.trim();
  await expect(page.locator('#appset-br-agents')).toContainText('Lee y escribe');

  // 1) El dispositivo repasa la tarjeta y NO sincroniza.
  await page.evaluate(async () => {
    (await import('/js/sync/engine.js')).setIntentionalOff(true);
    const DB = await import('/js/ai/db.js');
    const d = (await DB.getAll('decks')).find((x: any) => x.bookId === 'ddia');
    await DB.updateDeck(d.id, { cards: d.cards.map((c: any) => ({ ...c, srs: { reps: 1, lastReview: Date.now(), due: 1 } })) });
  });
  // 2) El agente reescribe la tarjeta.
  const res = await server.worker.fetch(new Request(SYNC_URL + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update_cards', arguments: {
      book: 'designing data', deckUid, changes: [{ uid: 'c1', type: 'cloze', front: 'Read committed: no {{c1::dirty reads}}, no {{c2::dirty writes}}.', back: '' }],
    } } }),
  }), server.env);
  const body = await res.json();
  expect(body.result, JSON.stringify(body) + ' ' + res.status).toBeTruthy();
  expect(body.result.isError ?? false, body.result.content?.[0]?.text).toBe(false);
  // 3) Vuelve a sincronizar: baja la edición, la funde con su repaso y sube el resultado.
  const card = await page.evaluate(async () => {
    const E = await import('/js/sync/engine.js');
    E.setIntentionalOff(false);
    await E.syncNow();
    await E.syncNow();
    const DB = await import('/js/ai/db.js');
    const c = (await DB.getAll('decks')).find((x: any) => x.bookId === 'ddia').cards[0];
    return { front: c.front, type: c.type, reps: c.srs?.reps ?? null, editedBy: c.editedBy };
  });
  expect(card).toEqual({ front: 'Read committed: no {{c1::dirty reads}}, no {{c2::dirty writes}}.', type: 'cloze', reps: 1, editedBy: 'agent:Claude' });
  const remote = await server.worker.fetch(new Request(SYNC_URL + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_deck', arguments: { bookId: 'ddia', deckUid } } }),
  }), server.env);
  const deck = JSON.parse((await remote.json()).result.content[0].text);
  expect({ front: deck.cards[0].front, reps: deck.cards[0].srs?.reps }).toEqual({ front: card.front, reps: 1 });
});

// Texto de los libros: al crear un agente con permiso para leerlo, la app sube el texto ya
// troceado de sus libros (sync/book-text.js) y el agente lo lee y lo busca con sus anclas.
test('Agente con permiso de texto: la app sube el texto troceado y el agente lo lee y lo busca', async ({ page }) => {
  const server = await createSyncServer();
  await installSyncServer(page, server);
  await enableSyncPreview(page);
  await seedBookReaderSync(page);
  await page.goto('/');
  await page.evaluate(async () => {
    await (await import('/js/sync/bookreader-auth.js')).enable();
    const Store = await import('/js/library/store.js');
    const buf = new Uint8Array(1024).map((_, i) => (i * 3) % 251);
    await Store.putBook({ id: 'ddia', title: 'Designing Data-Intensive Applications', author: 'Kleppmann', format: 'epub', fileName: 'ddia.epub', file: buf.buffer, size: buf.length, addedAt: Date.now(), progress: 0, status: 'reading', shelfIds: [] });
    await (await import('/js/sync/engine.js')).syncNow();
    // El libro, troceado como lo deja segment.js.
    const DB = await import('/js/ai/db.js');
    const anchors = new Map();
    const lines: string[] = [];
    let n = 0;
    for (const ch of ['Chapter 7. Replication', 'Chapter 8. Transactions']) {
      lines.push('', '## ' + ch);
      for (let i = 0; i < 40; i++) {
        const id = 'a' + n++;
        anchors.set(id, { cfi: 'epubcfi(/6/2!/4/' + n + ')', chapter: ch, href: 'x.html' });
        lines.push(`[[${id}]] ${ch === 'Chapter 8. Transactions' && i === 7 ? 'Two doctors on call both go off call: that is write skew.' : 'Paragraph ' + i + ' about logs and nodes.'}`);
      }
    }
    await DB.saveSegmented('ddia', 'Designing Data-Intensive Applications', { annotatedText: lines.join('\n'), anchors, tokenEstimate: 1000, blockCount: n });
  });
  // Sin agentes que lo pidan, no se sube: el texto no está en el servidor.
  const textCalls = () => server.calls.filter((c) => c.startsWith('PUT /v1/o/')).length;
  const putsBefore = textCalls();
  await page.evaluate(async () => (await import('/js/sync/book-text.js')).backfill());
  expect(textCalls()).toBe(putsBefore);

  await page.evaluate(async () => (await import('/js/ui/app-settings.js')).open('data'));
  await page.locator('#appset-br-agent-create').click();
  await page.locator('.dlg-overlay [data-field="name"]').fill('Claude');
  await page.locator('.dlg-overlay [data-check="scopes"][value="text"]').check();
  await page.locator('.dlg-overlay .dlg-ok').click();
  await expect(page.locator('#appset-br-agent-token')).toContainText('br-mcp-');
  const token = (await page.locator('#appset-br-agent-token').textContent())!.trim();
  const call = async (name: string, args: any) => {
    const res = await server.worker.fetch(new Request(SYNC_URL + '/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }), server.env);
    return (await res.json()).result;
  };
  const tool = async (name: string, args: any) => {
    const r = await call(name, args);
    expect(r.isError ?? false, r.content[0].text).toBe(false);
    return JSON.parse(r.content[0].text);
  };
  // La subida va sola tras crear el token: se espera a que el índice esté.
  await expect.poll(async () => !(await call('get_toc', { bookId: 'ddia' })).isError, { timeout: 15000 }).toBe(true);
  const toc = await tool('get_toc', { book: 'designing' });
  expect(toc.chapters.map((c: any) => [c.title, c.passages])).toEqual([['Chapter 7. Replication', 40], ['Chapter 8. Transactions', 40]]);
  const ch = await tool('read_chapter', { bookId: 'ddia', chapter: 'transactions' });
  expect(ch.text.split('\n')[0]).toBe('[[a40]] Paragraph 0 about logs and nodes.');
  const found = await tool('search_book', { bookId: 'ddia', query: 'doctors on call', limit: 1 });
  expect(found.results[0]).toMatchObject({ id: 'a47', chapterTitle: 'Chapter 8. Transactions', text: 'Two doctors on call both go off call: that is write skew.' });
});

// IA10 F1 · Todos los libros con texto, no solo los abiertos: la cola trocea en segundo plano
// los que nunca se abrieron, espera si el lector está abierto, y cuenta en Ajustes los que
// faltan y por qué. Qué está subido lo dice el servidor, no el equipo.
test('Texto para agentes: la cola trocea los libros sin abrir y Ajustes cuenta la cobertura', async ({ page }) => {
  const server = await createSyncServer();
  await installSyncServer(page, server);
  await enableSyncPreview(page);
  await seedBookReaderSync(page);
  await page.goto('/');
  const epub = readFileSync(path.join(__dirname, 'test.epub')).toString('base64');
  await page.evaluate(async (b64) => {
    await (await import('/js/sync/bookreader-auth.js')).enable();
    const Store = await import('/js/library/store.js');
    const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const base = { author: 'X', format: 'epub', addedAt: Date.now(), progress: 0, status: 'unread', shelfIds: [] };
    await Store.putBook({ ...base, id: 'sin-abrir', title: 'Nunca abierto', fileName: 'a.epub', file: buf.buffer.slice(0), size: buf.length });
    // Una ficha sin fichero: el libro está en otro equipo.
    await Store.putBook({ ...base, id: 'en-otro', title: 'En el portátil', fileName: 'b.epub', size: 10 });
    await (await import('/js/sync/engine.js')).syncNow();
    document.body.classList.add('reading');   // con el lector abierto, la cola espera
    await (await import('/js/sync/bookreader-auth.js')).createMcpToken('Claude', { scopes: ['text'] });
  }, epub);
  const segmented = () => page.evaluate(async () => !!(await (await import('/js/ai/db.js')).get('bookText', 'sin-abrir')));
  await page.waitForTimeout(1500);
  expect(await segmented()).toBe(false);
  await page.evaluate(() => document.body.classList.remove('reading'));
  await expect.poll(segmented, { timeout: 20000 }).toBe(true);

  const coverage = () => page.evaluate(async () => {
    const BT = await import('/js/sync/book-text.js');
    await BT.backfill();
    return BT.coverage();
  });
  await expect.poll(async () => (await coverage()).ok, { timeout: 15000 }).toBe(1);
  expect((await coverage()).missing).toEqual([{ id: 'en-otro', title: 'En el portátil', why: 'file' }]);

  // Otro equipo (sin memoria local de lo subido) no vuelve a subirlo: manda el servidor.
  const puts = () => server.calls.filter((c) => c.startsWith('PUT /v1/o/')).length;
  const before = puts();
  await page.evaluate(async () => {
    localStorage.removeItem('bookreader_sync_text_state');
    await (await import('/js/sync/book-text.js')).backfill();
  });
  expect(puts()).toBe(before);

  await page.evaluate(async () => (await import('/js/ui/app-settings.js')).open('data'));
  await expect(page.locator('#appset-br-text')).toContainText('Texto para agentes: 1 de 2 libros.');
  await expect(page.locator('#appset-br-text')).toContainText('«En el portátil»');
});

// Un libro que este equipo nunca descargó, pero cuyo fichero está en el sync: la cola lo baja
// solo para trocearlo, sube su texto y NO lo guarda (el equipo no se llena de libros).
test('Texto para agentes: un libro que solo está en el sync se trocea sin quedarse en el equipo', async ({ browser }) => {
  const server = await createSyncServer({ FILES_ENABLED: '1' });
  const epub = readFileSync(path.join(__dirname, 'test.epub')).toString('base64');
  const boot = async (pair = '') => {
    const context = await browser.newContext();
    await installSyncServer(context, server);
    await enableSyncPreview(context);
    await seedBookReaderSync(context);
    const page = await context.newPage();
    await page.goto('/' + pair);
    return { context, page };
  };
  const pc = await boot();
  const { pair, id } = await pc.page.evaluate(async (b64) => {
    const A = await import('/js/sync/bookreader-auth.js');
    await A.enable();
    await A.getToken(true);   // trae `files` del servidor
    const Store = await import('/js/library/store.js');
    const DB = await import('/js/ai/db.js');
    const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const id = await DB.hashBuffer(buf.buffer.slice(0));
    await Store.putBook({ id, title: 'Solo en el sync', author: 'X', format: 'epub', fileName: 'a.epub', file: buf.buffer, size: buf.length, addedAt: Date.now(), progress: 0, status: 'unread', shelfIds: [] });
    await (await import('/js/sync/engine.js')).syncNow();
    await (await import('/js/sync/blobs.js')).flush();
    await (await import('/js/sync/engine.js')).syncNow();
    const link = A.pairingLink();
    return { pair: link.slice(link.indexOf('#')), id };
  }, epub);
  await pc.context.close();   // el PC ya no está: el texto lo tiene que preparar el otro equipo

  const movil = await boot(pair);
  const { page } = movil;
  await expect.poll(() => page.evaluate(() => !!localStorage.getItem('bookreader_sync_key'))).toBe(true);
  const downloads: string[] = [];
  await page.exposeFunction('__blobEvent', (s: string) => downloads.push(s));
  await page.evaluate(async () => {
    window.addEventListener('bookreader:blob-progress', (e: any) => { if (e.detail.dir === 'down') (window as any).__blobEvent(e.detail.state); });
    await (await import('/js/sync/engine.js')).syncNow();
    await (await import('/js/sync/bookreader-auth.js')).createMcpToken('Claude', { scopes: ['text'] });
  });
  const coverage = () => page.evaluate(async () => {
    const BT = await import('/js/sync/book-text.js');
    await BT.backfill();
    return BT.coverage();
  });
  await expect.poll(async () => (await coverage()).ok, { timeout: 30000 }).toBe(1);
  const local = await page.evaluate(async (id) => {
    const Store = await import('/js/library/store.js');
    const DB = await import('/js/ai/db.js');
    return { file: Store.hasFile(await Store.getRaw(id)), text: !!(await DB.get('bookText', id)) };
  }, id);
  expect(local).toEqual({ file: false, text: true });
  expect(downloads).toEqual([]);   // no pasa por la cola de descargas ni sale en la tarjeta
  await movil.context.close();
});

// IA10 F2 · Tras el texto, el índice de la biblioteca: el libro se indexa desde el texto del
// servidor, se puede buscar (núcleo de library-index-build.js sobre lo cifrado) y su pasaje sale
// del almacén por bloques. Al borrar el libro, se van su índice, su almacén y su texto.
test('Índice de la biblioteca: se construye tras el texto, se busca, y borrar el libro lo quita todo', async ({ page }) => {
  const server = await createSyncServer();
  await installSyncServer(page, server);
  await enableSyncPreview(page);
  await seedBookReaderSync(page);
  await page.goto('/');
  const epub = readFileSync(path.join(__dirname, 'test.epub')).toString('base64');
  await page.evaluate(async (b64) => {
    await (await import('/js/sync/bookreader-auth.js')).enable();
    const Store = await import('/js/library/store.js');
    const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await Store.putBook({ id: 'libro', title: 'Libro', author: 'X', format: 'epub', fileName: 'a.epub', file: buf.buffer, size: buf.length, addedAt: Date.now(), progress: 0, status: 'unread', shelfIds: [] });
    await (await import('/js/sync/engine.js')).syncNow();
    await (await import('/js/sync/bookreader-auth.js')).createMcpToken('Claude', { scopes: ['text'] });
  }, epub);
  const coverage = () => page.evaluate(async () => {
    const BT = await import('/js/sync/book-text.js');
    await BT.backfill();
    return BT.coverage();
  });
  await expect.poll(async () => (await coverage()).indexed, { timeout: 30000 }).toBe(1);

  // Buscar con lo que está en el servidor: una palabra de un pasaje real del libro.
  const found = await page.evaluate(async () => {
    const Provider = await import('/js/sync/provider.js');
    const { BASE } = await import('/js/sync/layout.js');
    const X = await import('/js/sync/library-index-build.js');
    const DB = await import('/js/ai/db.js');
    const text = (await DB.get('bookText', 'libro')).annotatedText;
    const line = text.split('\n').find((l: string) => /^\[\[a\d+\]\] .{80,}/.test(l))!;
    const n = Number(/^\[\[a(\d+)\]\]/.exec(line)![1]);
    const word = line.slice(line.indexOf(' ') + 1).split(/\W+/).filter((w: string) => w.length > 7)[0];
    const m = JSON.parse((await Provider.read(X.manifestPath(BASE)))!.content);
    const read = async (p: string) => (await Provider.read(p))?.content ?? null;
    const r = await X.searchIndex(read, BASE, m, [word], { perBook: 50 });
    const meta = m.books.libro;
    const i = X.blockOf(meta.store.starts, n);
    const o = meta.store.offsets;
    // El almacén, abierto como lo abre el MCP (bloque a bloque), da el pasaje tal cual.
    const C = await import('/js/sync/sync-crypto.js');
    const A = await import('/js/sync/bookreader-auth.js');
    const k = await A.keys();
    const pid = await C.pathId(k, X.storePath(BASE, 'libro'));
    const res = await A.api('/v1/o/' + pid);
    const body = new Uint8Array(await res.arrayBuffer());
    const block = new TextDecoder().decode(await C.openBlock(k, pid, body.subarray(o[i], o[i + 1]), i, o.length - 1));
    return {
      hit: r.books[0]?.bookId, hasPassage: r.books[0]?.passages.some((p: any) => p.n === n),
      passage: X.passageIn(block, n), expected: line.slice(line.indexOf(' ') + 1),
    };
  });
  expect(found.hit).toBe('libro');
  expect(found.hasPassage).toBe(true);
  expect(found.passage).toBe(found.expected);

  // Borrar el libro: fuera del índice, sin almacén y sin texto en el servidor.
  const left = await page.evaluate(async () => {
    await (await import('/js/library/store.js')).deleteBook('libro');
    await (await import('/js/sync/book-text.js')).backfill();
    const Provider = await import('/js/sync/provider.js');
    const { BASE } = await import('/js/sync/layout.js');
    const m = JSON.parse((await Provider.read(BASE + 'index/manifest.json'))!.content);
    const files = (await Provider.list(BASE)).map((f: any) => f.path).filter((p: string) => p.includes('/text/') || p.includes('/index/s/'));
    return { books: Object.keys(m.books), files };
  });
  expect(left).toEqual({ books: [], files: [] });
});

// Artefactos de un agente: llegan al dispositivo por el sync, el Studio los ve (getArtifacts
// filtra por SEG_VERSION) y los renderers de la app los pintan.
test('Agente crea un mapa mental y una infografía: llegan al Studio del dispositivo y se pintan', async ({ page }) => {
  const server = await createSyncServer();
  await installSyncServer(page, server);
  await enableSyncPreview(page);
  await seedBookReaderSync(page);
  await page.goto('/');
  await page.evaluate(async () => {
    await (await import('/js/sync/bookreader-auth.js')).enable();
    const Store = await import('/js/library/store.js');
    const buf = new Uint8Array(1024).map((_, i) => (i * 5) % 251);
    await Store.putBook({ id: 'ddia', title: 'Designing Data-Intensive Applications', author: 'Kleppmann', format: 'epub', fileName: 'ddia.epub', file: buf.buffer, size: buf.length, addedAt: Date.now(), progress: 0, status: 'reading', shelfIds: [] });
    await (await import('/js/sync/engine.js')).syncNow();
  });
  await page.evaluate(async () => (await import('/js/ui/app-settings.js')).open('data'));
  await page.locator('#appset-br-agent-create').click();
  await page.locator('.dlg-overlay [data-field="name"]').fill('Claude');
  await page.locator('.dlg-overlay [data-check="scopes"][value="write"]').check();
  await page.locator('.dlg-overlay .dlg-ok').click();
  await expect(page.locator('#appset-br-agent-token')).toContainText('br-mcp-');
  const token = (await page.locator('#appset-br-agent-token').textContent())!.trim();
  const tool = async (name: string, args: any) => {
    const res = await server.worker.fetch(new Request(SYNC_URL + '/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }), server.env);
    const r = (await res.json()).result;
    expect(r.isError ?? false, r.content[0].text).toBe(false);
    return JSON.parse(r.content[0].text);
  };
  await tool('create_mindmap', { book: 'designing', title: 'Transacciones', branches: [
    { label: 'Anomalías', children: [{ label: 'Write skew' }, { label: 'Lost update' }] },
    { label: 'Aislamiento', children: [{ label: 'Snapshot isolation' }] },
  ] });
  await tool('create_infographic', { book: 'designing', thesis: 'Las transacciones son un contrato de seguridad.', ideas: [{ head: 'ACID', body: 'Un conjunto de garantías.' }] });

  const out = await page.evaluate(async () => {
    await (await import('/js/sync/engine.js')).syncNow();
    const DB = await import('/js/ai/db.js');
    const arts = await DB.getArtifacts('ddia');
    const mm = arts.find((a: any) => a.kind === 'mindmap');
    const ig = arts.find((a: any) => a.kind === 'infographic');
    const MR = await import('/js/ai/mindmap-render.js');
    const IR = await import('/js/ai/infographic-render.js');
    const svgMap = MR.renderSvg(MR.layout(mm.result)).svg.outerHTML;
    const svgInfo = new XMLSerializer().serializeToString(IR.renderSvg(ig.result, { title: 'DDIA' }).svg);
    return { kinds: arts.map((a: any) => a.kind).sort(), by: mm.params.by, map: svgMap.includes('Write skew') && svgMap.includes('Transacciones'), info: svgInfo.includes('ACID') };
  });
  expect(out).toEqual({ kinds: ['infographic', 'mindmap'], by: 'agent:Claude', map: true, info: true });
});

// Organizar la biblioteca: el agente crea una estantería con el libro dentro y lo marca
// terminado; el dispositivo, sin haberlo bajado, pasa una página. Tras el sync se conserva lo
// del agente (shelvesAt/statusAt) Y el progreso. Después, «Deshacer» desde Ajustes revierte el
// último cambio del agente aquí y en el servidor.
test('Agente organiza la biblioteca: sobrevive a un pase de página sin sincronizar, y se deshace desde la app', async ({ page }) => {
  const server = await createSyncServer();
  await installSyncServer(page, server);
  await enableSyncPreview(page);
  await seedBookReaderSync(page);
  await page.goto('/');
  await page.evaluate(async () => {
    await (await import('/js/sync/bookreader-auth.js')).enable();
    const Store = await import('/js/library/store.js');
    const buf = new Uint8Array(1024).map((_, i) => (i * 11) % 251);
    await Store.putBook({ id: 'ddia', title: 'Designing Data-Intensive Applications', author: 'Kleppmann', format: 'epub', fileName: 'ddia.epub', file: buf.buffer, size: buf.length, addedAt: Date.now(), progress: 20, status: 'reading', shelfIds: [] });
    await (await import('/js/sync/engine.js')).syncNow();
  });
  await page.evaluate(async () => (await import('/js/ui/app-settings.js')).open('data'));
  await page.locator('#appset-br-agent-create').click();
  await page.locator('.dlg-overlay [data-field="name"]').fill('Claude');
  await page.locator('.dlg-overlay [data-check="scopes"][value="library"]').check();
  await page.locator('.dlg-overlay .dlg-ok').click();
  await expect(page.locator('#appset-br-agent-token')).toContainText('br-mcp-');
  const token = (await page.locator('#appset-br-agent-token').textContent())!.trim();
  await expect(page.locator('#appset-br-agents')).toContainText('organiza la biblioteca');
  const tool = async (name: string, args: any) => {
    const res = await server.worker.fetch(new Request(SYNC_URL + '/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }), server.env);
    const r = (await res.json()).result;
    expect(r.isError ?? false, r.content[0].text).toBe(false);
    return JSON.parse(r.content[0].text);
  };

  // 1) El dispositivo deja de sincronizar; 2) el agente organiza; 3) el dispositivo lee.
  await page.evaluate(async () => (await import('/js/sync/engine.js')).setIntentionalOff(true));
  const shelf = await tool('create_shelf', { name: 'Técnico/Bases de datos', books: ['designing'] });
  await tool('update_books', { changes: [{ bookId: 'ddia', status: 'finished' }] });
  await page.waitForTimeout(20);
  const local = await page.evaluate(async () => {
    const S: any = await import('/js/library/store.js');
    await S.updateBook('ddia', (cur: any) => ({ progress: 25, status: S.statusFor(25, cur.status) }));
    const E = await import('/js/sync/engine.js');
    E.setIntentionalOff(false);
    await E.syncNow(); await E.syncNow();
    const b = await S.getBook('ddia');
    const sh = (await S.getShelves()).map((x: any) => x.name);
    return { shelfIds: b.shelfIds, status: b.status, progress: b.progress, shelves: sh };
  });
  expect(local).toEqual({ shelfIds: [shelf.shelfId], status: 'finished', progress: 25, shelves: ['Técnico/Bases de datos'] });

  // Deshacer el último cambio (el estado) desde Ajustes.
  await page.evaluate(async () => (await import('/js/ui/app-settings.js')).open('data'));
  const rows = page.locator('#appset-br-changes .appset-link');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Claude · 1 libros');
  await rows.first().locator('[data-act="undo"]').click();
  await page.locator('.dlg-overlay .dlg-ok').click();
  await expect(page.locator('#appset-data-msg')).toContainText('Deshecho');
  await expect(rows.first()).toContainText('deshecho');
  const after = await page.evaluate(async () => {
    const E = await import('/js/sync/engine.js');
    await E.syncNow();
    const S: any = await import('/js/library/store.js');
    const b = await S.getBook('ddia');
    return { status: b.status, shelfIds: b.shelfIds, finished: !!b.finishedAt };
  });
  expect(after).toEqual({ status: 'reading', shelfIds: [shelf.shelfId], finished: false });
  const remote = (await tool('list_books', {})).books.find((b: any) => b.id === 'ddia');
  expect(remote.status).toBe('reading');
});
