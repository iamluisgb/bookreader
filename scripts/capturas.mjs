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
// Con salida .webp, la convierte el propio Chromium (calidad 0,82, como `cwebp -q 82`): no hace
// falta cwebp en la máquina.

import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';

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
  // Libros de evals para que la biblioteca tenga portadas y la tira viva. Los que no estén en
  // esta máquina (las fixtures van fuera de git) se saltan.
  const libros = ['p1-relativity.epub', 'p5-onliberty.epub', 'p6-sre2.epub', 'p3-constitucion.pdf']
    .filter((libro) => existsSync(resolve(FIXTURES, libro)));
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
  // Estanterías con su marca (P58): icono y tono, un anillo (un libro terminado) y un punto de
  // repaso (tarjetas vencidas). Nombres en el idioma de la captura, nada personal.
  await page.evaluate(async (lang) => {
    const S = await import('/js/library/store.js');
    const DB = await import('/js/ai/db.js');
    const Srs = await import('/js/ai/srs.js');
    const es = lang === 'es';
    const books = await S.getAllBooks();
    const byFile = (f) => books.find((b) => (b.fileName || '').startsWith(f));
    const shelf = async (name, icon, hue, file) => {
      const sh = await S.addShelf(name);
      await S.updateShelf(sh.id, { icon, hue });
      const b = file && byFile(file);
      if (b) await S.toggleBookShelf(b.id, sh.id, true);
      return sh;
    };
    await shelf(es ? 'Ahora' : 'Now', 'star', 45, 'p5-onliberty');
    await shelf(es ? 'Técnico' : 'Technical', 'chip', 225);
    await shelf(es ? 'Técnico/Operación y fiabilidad' : 'Technical/Operations and reliability', 'shield', 0, 'p6-sre2');
    await shelf(es ? 'Humanidades' : 'Humanities', 'landmark', 25);
    await shelf(es ? 'Humanidades/Ciencia' : 'Humanities/Science', 'flask', 200, 'p1-relativity');
    await shelf(es ? 'Humanidades/Filosofía' : 'Humanities/Philosophy', 'quill', 285, 'p5-onliberty');
    await shelf(es ? 'Derecho' : 'Law', 'briefcase', 200, 'p3-constitucion');
    await shelf(es ? 'Salud y hábitos' : 'Health and habits', 'heart', 0);
    await S.addShelf(es ? 'Terminados' : 'Finished', { rule: { status: 'finished' } });
    const rel = byFile('p1-relativity');
    if (rel) await S.updateBook(rel.id, { status: 'finished', progress: 100 });
    const lib = byFile('p5-onliberty');
    if (lib) {
      const now = Date.now(), today = Srs.dayOf(now);
      await DB.addDeck({ bookId: lib.id, name: 'On Liberty', cards: Array.from({ length: 6 }, (_, k) => ({
        front: 'q' + k, back: 'a' + k,
        srs: { due: today - 1, interval: 3, stability: 3, lastReview: now - 5 * 86400000, reps: 2 } })) });
    }
  }, lang);
  await page.reload();
  await page.waitForSelector('.lib-grid .lib-cover-img, .lib-grid .lib-cover-fallback', {
    timeout: 30000,
  });
  await page.waitForTimeout(1200);
  const png = await page.locator('#library').screenshot({ path: out.endsWith('.webp') ? undefined : out });
  if (out.endsWith('.webp')) {
    const webp = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/webp', 0.82).split(',')[1];
    }, png.toString('base64'));
    writeFileSync(out, Buffer.from(webp, 'base64'));
  }
} else {
  console.error(`Shot desconocido: ${shot} (agente | sync | biblioteca)`);
  await browser.close();
  process.exit(1);
}

await browser.close();
killServer();
console.log(`captura ${shot}/${lang} → ${out}`);
