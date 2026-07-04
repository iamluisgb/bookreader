// Rasteriza los SVG de icono a PNG usando Chromium (Playwright). Sin dependencias
// de sistema (rsvg/magick). Uso: node scripts/rasterize-icons.mjs
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const icons = resolve(root, 'icons');

// [svg fuente, png destino, tamaño px]
const jobs = [
  ['icon.svg', 'icon-192.png', 192],
  ['icon.svg', 'icon-512.png', 512],
  ['icon-maskable.svg', 'maskable-512.png', 512],
  ['icon-maskable.svg', 'apple-touch-icon.png', 180],
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [src, out, size] of jobs) {
  const svg = readFileSync(resolve(icons, src), 'utf8');
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><html><head><style>*{margin:0;padding:0}html,body{width:${size}px;height:${size}px;overflow:hidden}svg{display:block;width:${size}px;height:${size}px}</style></head><body>${svg}</body></html>`,
    { waitUntil: 'load' }
  );
  const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  writeFileSync(resolve(icons, out), buf);
  console.log(`✓ ${out} (${size}px)`);
}
await browser.close();
