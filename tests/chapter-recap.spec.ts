import { test, expect, Page } from '@playwright/test';
import path from 'path';

// Repaso del capítulo (HQ&A) con el agente CERRADO. Antes salía solo el aviso «el agente te
// pregunta…» —antes incluso de saber si habría pregunta— y la pregunta se quedaba en el panel
// cerrado. Ahora el aviso llega con la pregunta y «Responder» abre el agente para contestar.
const EPUB_PATH = path.join(__dirname, 'test.epub');

async function openWithHqa(page: Page) {
  await page.route('**/chat/completions', (route) => {
    const body = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Repaso — ¿Qué promete Juan Preciado a su madre? [[a1]]' }, finish_reason: null }] }) + '\n\ndata: [DONE]\n\n';
    return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body });
  });
  await page.goto('/index.html');
  await page.evaluate(() => {
    localStorage.setItem('bookreader_ai_key', JSON.stringify('sk-test'));
    localStorage.setItem('bookreader_license', JSON.stringify({ key: 'BKRD-TEST-PRO', activationId: 'mock-test', validatedAt: Date.now(), revoked: false }));
  });
  await page.reload();
  await page.setInputFiles('#file-input', EPUB_PATH);
  await page.waitForSelector('#epub-container iframe', { state: 'attached', timeout: 30000 });
  await page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    const Store: any = await import('/js/library/store.js');
    let books: any[] = [];
    for (let i = 0; i < 100 && !books.length; i++) { books = await Store.getAllBooks(); if (!books.length) await new Promise(r => setTimeout(r, 100)); }
    await DB.createConvo(books[0].id, 'hqa', 'Entender Comala');
  });
  await page.reload();
  const cover = page.locator('.lib-cover').first();
  const reader = page.locator('#epub-container iframe');
  await expect(cover.or(reader)).toBeVisible({ timeout: 30000 });
  if (await cover.isVisible()) await cover.click();
  await page.waitForFunction(() => !!document.querySelector('#toc-list a'), null, { timeout: 30000 });
  // Conversación activa y libro segmentado (sin abrir el panel).
  await page.waitForFunction(() => { const tabs = document.getElementById('ai-tabs'); return !!tabs && getComputedStyle(tabs).display !== 'none'; }, null, { timeout: 30000 });
  await expect(page.locator('#ai-status')).toContainText('Listo', { timeout: 30000 });
  await page.evaluate(async () => { (await import('/js/ai/panel.js') as any).setOpen(false); });
}

test('con el agente cerrado, el repaso llega con su pregunta y «Responder» abre el agente', async ({ page }) => {
  await openWithHqa(page);
  const labels = await page.locator('#toc-list .toc-label').allTextContents();
  // Pasar del capítulo 2 al 3: se repasa el 2.
  await page.evaluate((ls) => {
    for (const l of ls) window.dispatchEvent(new CustomEvent('reader:chapter-changed', { detail: { label: l } }));
  }, [labels[1], labels[2]]);
  const pop = page.locator('.recap-pop');
  await expect(pop).toBeVisible({ timeout: 20000 });
  await expect(pop.locator('.recap-pop-q')).toHaveText('¿Qué promete Juan Preciado a su madre?');
  await expect(pop).toContainText('Repaso del capítulo');
  await pop.locator('.recap-pop-go').click();
  await expect(page.locator('body')).toHaveClass(/ai-open/);
  await expect(page.locator('#ai-messages')).toContainText('¿Qué promete Juan Preciado');
  await expect(page.locator('#ai-input')).toBeFocused();
  await expect(page.locator('.recap-pop')).toHaveCount(0);
});
