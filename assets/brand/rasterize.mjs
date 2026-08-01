// Rasteriza los SVG de marca a PNG con Chromium (Playwright), sin deps de sistema.
// Uso: node assets/brand/rasterize.mjs
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// [svg fuente, png destino, tamaño px]
const jobs = [
  ['mark-dark.svg', 'png/icon-512.png', 512],
  ['mark-dark.svg', 'png/icon-192.png', 192],
  ['mark-dark.svg', 'png/icon-32.png', 32],
  ['mark-dark.svg', 'png/icon-16.png', 16],
  ['maskable-dark.svg', 'png/maskable-512.png', 512],
  ['maskable-dark.svg', 'png/apple-touch-icon.png', 180],
  ['mark-light.svg', 'png/icon-light-512.png', 512],
  ['mark-light.svg', 'png/icon-light-32.png', 32],
  ['maskable-light.svg', 'png/maskable-light-512.png', 512],
];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [src, out, size] of jobs) {
  const svg = readFileSync(resolve(here, src), 'utf8');
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><html><head><style>*{margin:0;padding:0}html,body{width:${size}px;height:${size}px;overflow:hidden}svg{display:block;width:${size}px;height:${size}px}</style></head><body>${svg}</body></html>`,
    { waitUntil: 'load' }
  );
  const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  writeFileSync(resolve(here, out), buf);
  console.log(`✓ ${out} (${size}px)`);
}
await browser.close();
