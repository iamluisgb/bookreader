#!/usr/bin/env node
// Descarga los libros fixture de las baterías de evals (docs/EVALS.md · EV1).
// Los fixtures NO se versionan (ver .gitignore); este script los repone. Fuentes y
// licencias en evals/fixtures/README.md. P4 usa tests/test.epub (ya en el repo).
//
// Uso: node evals/fetch-fixtures.mjs
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

// minBytes: sanity check — si la fuente devuelve una página de error, no la guardamos.
const FIXTURES = [
  {
    file: 'p1-relativity.epub',
    url: 'https://www.gutenberg.org/cache/epub/30155/pg30155-images.epub',
    minBytes: 500_000,
    note: 'Einstein — Relativity (Gutenberg #30155, dominio público)',
  },
  {
    file: 'p2-progit.epub',
    url: 'https://github.com/progit/progit2/releases/latest/download/progit.epub',
    minBytes: 5_000_000,
    note: 'Chacon & Straub — Pro Git 2 (CC BY-NC-SA 3.0)',
  },
  {
    file: 'p3-constitucion.pdf',
    url: 'https://www.boe.es/buscar/pdf/1978/BOE-A-1978-31229-consolidado.pdf',
    minBytes: 100_000,
    note: 'Constitución Española consolidada (BOE, texto legal público)',
  },
];

await mkdir(DIR, { recursive: true });
let failed = 0;
for (const f of FIXTURES) {
  const dest = join(DIR, f.file);
  const existing = await stat(dest).catch(() => null);
  if (existing && existing.size >= f.minBytes) {
    console.log(`✓ ${f.file} ya existe (${(existing.size / 1e6).toFixed(1)} MB) — ${f.note}`);
    continue;
  }
  process.stdout.write(`↓ ${f.file} … `);
  try {
    // UA de navegador: algunos CDN (Cloudflare) devuelven 403 a user-agents no-navegador.
    const res = await fetch(f.url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < f.minBytes) throw new Error(`solo ${buf.length} bytes (¿página de error?)`);
    await writeFile(dest, buf);
    console.log(`${(buf.length / 1e6).toFixed(1)} MB — ${f.note}`);
  } catch (e) {
    failed++;
    console.log(`FALLO: ${e.message}\n  URL: ${f.url}`);
  }
}
process.exit(failed ? 1 : 0);
