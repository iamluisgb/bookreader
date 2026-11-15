import { test, expect, Page } from '@playwright/test';
import { gzipSync } from 'node:zlib';

// Mudanza desde el origen viejo (`#migrar=…`).
//
// La PWA vivió en luisgonzalezbernal.com/bookreader hasta el 15-nov-2026. Como el
// almacenamiento va por origen, la página de retirada (rama `gh-pages`) es la única
// que puede leer esos datos: los empaqueta en el fragmento del enlace y la app los
// restaura al abrir. Lo que se fija aquí: el paquete entra por el mismo
// `importBackup` de Ajustes → Datos, sale de la URL antes de usarse (es el backup
// entero), el resto del hash sobrevive, y un paquete roto avisa sin dejar la app
// a medias. Codificación heredada del traspaso de Areté: base64url de
// [marca][cuerpo], con la marca = 1 si el cuerpo va comprimido con gzip.

const B64URL = (b: Buffer) =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function paquete(obj: unknown, gzip = true) {
  const cuerpo = Buffer.from(JSON.stringify(obj), 'utf8');
  const conMarca = gzip
    ? Buffer.concat([Buffer.from([1]), gzipSync(cuerpo)])
    : Buffer.concat([Buffer.from([0]), cuerpo]);
  return B64URL(conMarca);
}

const leer = (page: Page, k: string) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem('bookreader_' + key) || 'null'), k);

const backup = {
  format: 'bookreader-backup',
  version: 1,
  exportedAt: new Date().toISOString(),
  localStorage: { lang: 'es', ai_model: 'bookreader-fast' },
  ai: { convos: [{ id: 'migracion-c1', templateId: 'feynman', createdAt: Date.now(), updatedAt: Date.now() }] },
};

test('un enlace de migración restaura el backup que trae el fragmento', async ({ page }) => {
  await page.goto('/#migrar=' + paquete(backup));

  await expect(page.locator('.ai-toast')).toContainText('traspasados');
  expect(await leer(page, 'lang')).toBe('es');
  expect(await leer(page, 'ai_model')).toBe('bookreader-fast');
  const convos = await page.evaluate(async () => {
    const DB = await import('/js/ai/db.js');
    return DB.getAll('convos');
  });
  expect(convos.map((c: { id: string }) => c.id)).toContain('migracion-c1');
  // El fragmento sale de la URL antes de usarse: el backup no se queda en el historial.
  expect(await page.evaluate(() => location.hash)).not.toContain('migrar');
});

test('el resto del hash sobrevive al paquete (un enlace pegado a un libro)', async ({ page }) => {
  await page.goto('/#migrar=' + paquete(backup) + '&book=abc');

  await expect(page.locator('.ai-toast')).toContainText('traspasados');
  expect(await page.evaluate(() => location.hash)).toBe('#book=abc');
});

test('un paquete roto avisa y no deja la app configurada a medias', async ({ page }) => {
  await page.goto('/#migrar=' + B64URL(Buffer.from([7, 1, 2, 3])));

  await expect(page.locator('.ai-toast')).toContainText('No se pudo importar');
  expect(await leer(page, 'lang')).toBe(null);
});

test('el JSON crudo (sin gzip, marca 0) también se acepta', async ({ page }) => {
  await page.goto('/#migrar=' + paquete({ format: 'bookreader-backup', version: 1, exportedAt: new Date().toISOString(), localStorage: { lang: 'en' }, ai: {} }, false));

  await expect(page.locator('.ai-toast')).toContainText('traspasados');
  expect(await leer(page, 'lang')).toBe('en');
});
