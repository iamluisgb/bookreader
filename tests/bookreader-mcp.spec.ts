import { test, expect } from '@playwright/test';
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
