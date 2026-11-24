import { test, expect, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// Libros con DRM (24-nov-2026): se reconocen ANTES de abrirlos y la app explica qué pasa, con un
// botón a la ayuda «Consigue libros sin DRM». Antes un EPUB de Adobe acababa en «Error al cargar el
// archivo EPUB: …». La ofuscación de fuentes no es DRM y el libro se sigue abriendo.

// Un EPUB real (tests/test.epub) con ficheros añadidos en META-INF, rehecho con el JSZip de la app.
async function epubWith(page: Page, extra: Record<string, string>) {
  const b64 = fs.readFileSync(path.join(__dirname, 'test.epub')).toString('base64');
  const out = await page.evaluate(async ({ b64, extra }) => {
    const { loadJsZip } = await import('/js/vendor-loader.js');
    const JSZip: any = await loadJsZip();
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const zip = await JSZip.loadAsync(bin);
    for (const [name, text] of Object.entries(extra)) zip.file(name, text);
    // `mimetype` tiene que ir primero y sin comprimir (file-kind.js lo mira en la cabecera).
    const re = new JSZip();
    re.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    for (const n of Object.keys(zip.files)) if (n !== 'mimetype' && !zip.files[n].dir) re.file(n, await zip.file(n).async('uint8array'));
    const u8 = await re.generateAsync({ type: 'uint8array' });
    let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }, { b64, extra });
  return Buffer.from(out, 'base64');
}

async function upload(page: Page, name: string, buffer: Buffer, mimeType = 'application/epub+zip') {
  await page.setInputFiles('#file-input', { name, mimeType, buffer });
}

test.beforeEach(async ({ page }) => { await page.goto('/index.html'); });

test('EPUB con DRM de Adobe: aviso claro, botón a la ayuda y nada en la biblioteca', async ({ page }) => {
  await upload(page, 'libro.epub', await epubWith(page, { 'META-INF/rights.xml': '<adept:rights xmlns:adept="http://ns.adobe.com/adept"/>' }));
  const card = page.locator('.dlg-card');
  await expect(card.locator('.dlg-title')).toHaveText('Este libro tiene DRM');
  await expect(card.locator('.dlg-msg')).toContainText('Adobe Digital Editions');
  const popup = page.waitForEvent('popup');
  await card.locator('.dlg-ok').click();
  expect((await popup).url()).toContain('/es/ayuda/guias/books-without-drm/');
  const n = await page.evaluate(async () => (await (await import('/js/library/store.js')).getAllRecords()).length);
  expect(n).toBe(0);
});

test('EPUB con contenido cifrado en encryption.xml: DRM; solo fuentes ofuscadas: se abre', async ({ page }) => {
  const enc = (algo: string) => `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="${algo}"/><enc:CipherData><enc:CipherReference URI="OEBPS/x"/></enc:CipherData></enc:EncryptedData></encryption>`;
  await upload(page, 'cifrado.epub', await epubWith(page, { 'META-INF/encryption.xml': enc('http://www.w3.org/2001/04/xmlenc#aes128-cbc') }));
  await expect(page.locator('.dlg-card .dlg-title')).toHaveText('Este libro tiene DRM');
  await page.locator('.dlg-card .dlg-cancel').click();

  await upload(page, 'fuentes.epub', await epubWith(page, { 'META-INF/encryption.xml': enc('http://www.idpf.org/2008/embedding') }));
  await expect(page.locator('body')).toHaveClass(/reading/, { timeout: 20000 });
  await expect(page.locator('.dlg-card')).toHaveCount(0);
});

test('PDF de Adobe ADEPT: aviso de DRM; el PDF normal se sigue abriendo', async ({ page }) => {
  const pdf = fs.readFileSync(path.join(__dirname, 'test.pdf'));
  const locked = Buffer.concat([pdf, Buffer.from('\n9 0 obj << /Filter /EBX_HANDLER /V 4 >> endobj\ntrailer << /Encrypt 9 0 R >>\n%%EOF\n')]);
  await upload(page, 'bloqueado.pdf', locked, 'application/pdf');
  await expect(page.locator('.dlg-card .dlg-title')).toHaveText('Este libro tiene DRM');
  await page.locator('.dlg-card .dlg-cancel').click();
  await upload(page, 'normal.pdf', pdf, 'application/pdf');
  await expect(page.locator('#pdf-container .pdf-page canvas').first()).toBeVisible({ timeout: 20000 });
});

test('vale .acsm y libro de Kindle: cada uno con su explicación', async ({ page }) => {
  await upload(page, 'libro.acsm', Buffer.from('<fulfillmentToken xmlns="http://ns.adobe.com/adept"/>'), 'application/vnd.adobe.adept+xml');
  await expect(page.locator('.dlg-card .dlg-title')).toHaveText('Esto no es el libro');
  await page.locator('.dlg-card .dlg-cancel').click();
  await upload(page, 'libro.azw3', Buffer.from('BOOKMOBI'), 'application/octet-stream');
  await expect(page.locator('.dlg-card .dlg-title')).toHaveText('Es un libro de Kindle');
});

test('encryptsContent: solo la ofuscación de fuentes no cuenta como DRM', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const D: any = await import('/js/drm.js');
    return [
      D.encryptsContent('<EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>'),
      D.encryptsContent('<EncryptionMethod Algorithm="http://ns.adobe.com/pdf/enc#RC"/>'),
      D.encryptsContent('<enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>'),
      D.encryptsContent(''),
    ];
  });
  expect(r).toEqual([false, false, true, false]);
});
