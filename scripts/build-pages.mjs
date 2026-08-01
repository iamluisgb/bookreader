#!/usr/bin/env node
// Prepara dist/ para Cloudflare Pages.
//
// Lista blanca a propósito: el repo contiene .env, tests, workers y docs que no
// deben publicarse. Copiar la raíz entera ya expuso .env una vez.
import { cp, rm, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

const PUBLIC = ['index.html', 'sw.js', 'app', 'es', 'anki', 'privacy', 'assets'];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const entry of PUBLIC) {
  await cp(join(root, entry), join(dist, entry), {
    recursive: true,
    filter: (src) => !src.split('/').pop().startsWith('.'),
  });
}

console.log(`dist/ listo con: ${PUBLIC.join(', ')}`);
