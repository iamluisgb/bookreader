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
  await page.locator('.dlg-overlay input').fill('Hermes');
  await page.locator('.dlg-overlay .dlg-ok').click();
  await expect(page.locator('#appset-br-agent-new')).toBeVisible();
  const token = (await page.locator('#appset-br-agent-token').textContent())!.trim();
  expect(token).toMatch(/^br-mcp-/);
  await expect(page.locator('#appset-br-agent-cmd')).toContainText(`claude mcp add --transport http bookreader ${SYNC_URL}/mcp --header "Authorization: Bearer ${token}"`);
  await expect(page.locator('#appset-br-agents .appset-link')).toHaveCount(1);
  await expect(page.locator('#appset-br-agents')).toContainText('Hermes');

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
