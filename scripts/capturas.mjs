#!/usr/bin/env node
// capturas.mjs — Las capturas de la ayuda, desde la app real.
//
// Receta de las capturas de docs-help/*/assets/capturas: servidor de test en
// local, fixtures de evals (gitignored: nada personal), tema claro, 2× y el
// idioma de la ayuda para la que se captura. Sin esto guardado, la siguiente
// ronda de capturas cuesta una tarde de arqueología.
//
//   node scripts/capturas.mjs <lang> <shot> <salida.png>
//
//   lang:  es | en
//   shot:  agente | sync | biblioteca
//
// En macOS, convertir a webp después:
//   cwebp -q 82 captura.png -o docs-help/es/assets/capturas/NN-nombre.webp

import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const PORT = 8977;
const FIXTURES = resolve(root, 'evals/fixtures');

const lang = process.argv[2] === 'en' ? 'en' : 'es';
const shot = process.argv[3];
const out = process.argv[4] || `/tmp/captura-${shot}-${lang}.png`;
if (!shot) {
  console.error('Uso: node scripts/capturas.mjs <es|en> <agente|sync|biblioteca> <salida.png>');
  process.exit(1);
}

// Servidor de test (el mismo que usan los specs): sirve app/ como raíz.
const server = spawn(
  'node',
  [resolve(root, 'scripts/test-server.mjs'), String(PORT), resolve(root, 'app')],
  {
    stdio: 'ignore',
  },
);
const killServer = () => server.kill();
process.on('exit', killServer);
await new Promise((ok) => setTimeout(ok, 800));

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 2,
});
await page.addInitScript((l) => localStorage.setItem('bookreader_lang', l), lang);
await page.goto(`http://localhost:${PORT}/`);

if (shot === 'agente' || shot === 'sync') {
  const section = shot === 'agente' ? 'agent' : 'data';
  await page.locator('.lib-rail-settings').click();
  await page.waitForSelector('#app-settings');
  await page.locator(`.appset-nav-item[data-section="${section}"]`).click();
  await page.waitForTimeout(600);
  await page.locator('#app-settings .appset-card').screenshot({ path: out });
} else if (shot === 'biblioteca') {
  // Tres libros de evals para que la biblioteca tenga portadas y la tira viva.
  const libros = ['ddia.epub', 'p1-relativity.epub', 'p3-constitucion.pdf'];
  for (const libro of libros) {
    await page.setInputFiles('#file-input', resolve(FIXTURES, libro));
    // state: 'attached' — el iframe puede estar oculto (p. ej. portada única) y
    // lo que importa es que el libro cargó y persistió en biblioteca.
    await page.waitForSelector('#epub-container iframe, #pdf-viewer canvas', {
      timeout: 60000,
      state: 'attached',
    });
    await page.waitForTimeout(1500);
    await page.locator('#library-btn').click();
    await page.waitForTimeout(500);
  }
  await page.waitForSelector('.lib-grid .lib-cover-img, .lib-grid .lib-cover-fallback', {
    timeout: 30000,
  });
  await page.waitForTimeout(800);
  await page.locator('#library').screenshot({ path: out });
} else {
  console.error(`Shot desconocido: ${shot} (agente | sync | biblioteca)`);
  await browser.close();
  process.exit(1);
}

await browser.close();
killServer();
console.log(`captura ${shot}/${lang} → ${out}`);
