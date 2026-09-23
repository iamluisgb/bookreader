#!/usr/bin/env node
// fixtures/generate.mjs — escribe en disco los fixtures versionados a partir del dataset.
//
//   node test/fixtures/generate.mjs
//
// Los tests leen ESTOS ficheros (no los construyen en memoria): así lo que se prueba es el
// parseo de un fichero real con la forma real, no un objeto que ya vive en memoria.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackupFixture } from '../helpers/dataset.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Escribe un JSON con el orden de claves del objeto (sin reordenar) y salto final. */
export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export async function generateFixtures(root = HERE) {
  const written = [];
  const backupPath = join(root, 'backup.json');
  await writeJson(backupPath, buildBackupFixture());
  written.push(backupPath);
  return written;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await generateFixtures();
  for (const f of files) process.stdout.write('escrito: ' + f + '\n');
}
