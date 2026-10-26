import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

// El primero que carga pdf.js no tiene por qué ser el lector: un libro que llega por MCP y
// nunca se abrió lo trocea en segundo plano ai/segment-file.js. Si ese primer uso no fijaba
// workerSrc, pdf.js pedía pdf-3.11.174.worker.min.js (no existe), apagaba los workers y
// memorizaba el fallo, así que al abrir después CUALQUIER PDF salía "Error al cargar el
// archivo PDF" hasta recargar. El worker se fija en vendor-loader.loadPdfJs, para todos.

const PDF = path.join(__dirname, 'test-multipage.pdf');

test('abrir un PDF tras usar pdf.js fuera del lector', async ({ page }) => {
  await page.goto('/index.html');
  const bytes = [...fs.readFileSync(PDF)];
  const pages = await page.evaluate(async (data) => {
    const VL = await import('./js/vendor-loader.js');
    const lib = await VL.loadPdfJs();
    const doc = await lib.getDocument({ data: new Uint8Array(data) }).promise;
    const n = doc.numPages;
    await doc.destroy();
    return n;
  }, bytes);
  expect(pages).toBeGreaterThan(0);

  await page.setInputFiles('#file-input', PDF);
  await page.waitForSelector('#pdf-container .pdf-page canvas', { timeout: 20000 });
});
