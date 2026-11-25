import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

// Biblioteca libre (/samples/): `?sample=se:…` y `?sample=tec:…` bajan el libro de su fuente y lo
// abren, sin que este sitio guarde ninguno. Sin red: el catálogo real se sirve desde el disco y las
// fuentes externas se simulan con los EPUB/PDF de prueba.
// La aserción que discrimina es `body.reading`: el libro está ABIERTO, no solo descargado.

const CATALOGO = path.join(__dirname, '..', 'assets', 'muestra', 'catalogo.json');
const EPUB = path.join(__dirname, 'test.epub');
const PDF = path.join(__dirname, 'test.pdf');
const WORKER = 'https://bookreader-libros.luisgonzalezb93.workers.dev';
const CORS = { 'Access-Control-Allow-Origin': '*' };

async function fuentes(page) {
  const pedidas: string[] = [];
  await page.route('**/assets/muestra/catalogo.json', (r) => r.fulfill({ path: CATALOGO }));
  await page.route('https://standardebooks.org/**', (r) => { pedidas.push(r.request().url()); return r.fulfill({ path: EPUB, headers: CORS }); });
  await page.route(`${WORKER}/**`, (r) => { pedidas.push(r.request().url()); return r.fulfill({ path: PDF, headers: CORS }); });
  await page.route('https://media.githubusercontent.com/**', (r) => { pedidas.push(r.request().url()); return r.fulfill({ path: EPUB, headers: CORS }); });
  return pedidas;
}

test('un clásico de Standard Ebooks se baja de su web y se abre', async ({ page }) => {
  const pedidas = await fuentes(page);
  await page.goto('/index.html?sample=' + encodeURIComponent('se:mary-shelley/frankenstein'));
  await expect(page.locator('body')).toHaveClass(/reading/, { timeout: 15000 });
  expect(pedidas).toEqual(['https://standardebooks.org/ebooks/mary-shelley/frankenstein/downloads/mary-shelley_frankenstein.epub?source=download']);
  // La marca se quita: recargar no vuelve a importar.
  expect(new URL(page.url()).searchParams.get('sample')).toBeNull();
});

test('un técnico sin CORS pasa por el Worker y un PDF se abre como PDF', async ({ page }) => {
  const pedidas = await fuentes(page);
  await page.goto('/index.html?sample=tec:think-python-2');
  await expect(page.locator('body')).toHaveClass(/reading/, { timeout: 15000 });
  expect(pedidas).toEqual([`${WORKER}/libro/think-python-2`]);
});

test('un técnico con CORS se baja directo, sin el Worker', async ({ page }) => {
  const pedidas = await fuentes(page);
  await page.goto('/index.html?sample=tec:sicp');
  await expect(page.locator('body')).toHaveClass(/reading/, { timeout: 15000 });
  expect(pedidas).toEqual(['https://media.githubusercontent.com/media/sarabander/sicp-epub/master/sicp.epub']);
});

test('un id fuera del catálogo no baja nada y lo dice', async ({ page }) => {
  const pedidas = await fuentes(page);
  const fuera: string[] = [];
  page.on('request', (r) => { if (!r.url().startsWith('http://localhost')) fuera.push(r.url()); });
  for (const id of ['tec:no-existe', 'se:alguien/inventado', 'https://example.com/x.epub']) {
    await page.goto('/index.html?sample=' + encodeURIComponent(id));
    await expect(page.locator('.dlg-overlay').filter({ hasText: /No se pudo abrir el libro|could not be opened/ }).first()).toBeVisible({ timeout: 10000 });
  }
  expect(pedidas).toEqual([]);
  expect(fuera).toEqual([]);
});

// Gutenberg y Elejandría: el id tiene que estar en la lista blanca del catálogo y la URL la
// construye el Worker a partir del número, así que un id inventado no genera ni una petición.
test('un libro de Gutenberg se pide al Worker por su número', async ({ page }) => {
  const pedidas = await fuentes(page);
  const cat = JSON.parse(fs.readFileSync(CATALOGO, 'utf8'));
  const id = cat.pgIds[0];
  await page.goto('/index.html?sample=' + encodeURIComponent('pg:' + id));
  await expect(page.locator('body')).toHaveClass(/reading/, { timeout: 15000 });
  expect(pedidas).toEqual([`${WORKER}/pg/${id}`]);
});

test('un libro de Elejandría se pide al Worker por su id', async ({ page }) => {
  const pedidas = await fuentes(page);
  const enlaces = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'muestra', 'elejandria-enlaces.json'), 'utf8'));
  const id = Object.keys(enlaces.links)[0];
  await page.goto('/index.html?sample=' + encodeURIComponent('el:' + id));
  await expect(page.locator('body')).toHaveClass(/reading/, { timeout: 15000 });
  expect(pedidas).toEqual([`${WORKER}/el/${id}`]);
});

test('un número de Gutenberg que no está en el catálogo no sale a la red', async ({ page }) => {
  const pedidas = await fuentes(page);
  const cat = JSON.parse(fs.readFileSync(CATALOGO, 'utf8'));
  let fuera = 1;
  while (cat.pgIds.includes(fuera)) fuera++;
  await page.goto('/index.html?sample=' + encodeURIComponent('pg:' + fuera));
  await expect(page.locator('.dlg-overlay').filter({ hasText: /No se pudo abrir el libro|could not be opened/ }).first()).toBeVisible({ timeout: 10000 });
  expect(pedidas).toEqual([]);
});
