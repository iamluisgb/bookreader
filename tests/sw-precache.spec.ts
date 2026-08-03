import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'path';

// La lista de precache del service worker se mantiene A MANO, y se había
// desincronizado sin que nadie se enterase: tres módulos en uso
// (region-select.js, ai/feynman.js, ui/text.js) llevaban tiempo desplegados sin
// precachear, así que sus funciones no existían sin red en una app cuya premisa
// es funcionar sin red. Nada lo delataba: online todo va bien, y el fallo solo
// aparece en el metro.
//
// Este test es la vigilancia. No corre navegador: compara ficheros.

const root = path.join(__dirname, '..');
const git = (cmd: string) =>
  execSync(cmd, { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);

const assets = () => {
  const sw = readFileSync(path.join(root, 'app/sw.js'), 'utf8');
  const list = sw.slice(sw.indexOf('const ASSETS'), sw.indexOf('];', sw.indexOf('const ASSETS')));
  return [...list.matchAll(/'\.\/([^']+)'/g)].map(m => m[1]);
};

test('todo módulo de la app está en el precache del service worker', () => {
  // Solo los ficheros CON SEGUIMIENTO. Los que no lo tienen son trabajo en curso
  // —y desde el arreglo del build ni siquiera pueden desplegarse, porque dist/
  // sale de HEAD—, así que exigirlos aquí sería ruido. El test salta justo
  // cuando el módulo se commitea, que es el momento en que empieza a importar.
  const modulos = git('git ls-files app/js').map(f => f.replace(/^app\//, ''));
  const enPrecache = new Set(assets());
  const faltan = modulos.filter(m => !enPrecache.has(m));

  expect(faltan, `Módulos sin precachear (añádelos a ASSETS en app/sw.js y sube CACHE_NAME):\n  ${faltan.join('\n  ')}`)
    .toEqual([]);
});

test('el precache no apunta a ficheros que ya no existen', () => {
  // Una entrada obsoleta ya no rompe el precache entero (se cachea uno a uno),
  // pero sigue siendo un recurso que el usuario se queda sin tener offline.
  const muertos = assets().filter(a => !existsSync(path.join(root, 'app', a)));
  expect(muertos, `Entradas de ASSETS que no existen en app/:\n  ${muertos.join('\n  ')}`).toEqual([]);
});

test('subir la versión del cache es lo que fuerza la actualización', () => {
  const sw = readFileSync(path.join(root, 'app/sw.js'), 'utf8');
  // Si CACHE_NAME no cambia, `activate` no purga el cache viejo y los clientes ya
  // instalados siguen sirviendo la versión anterior: un deploy que no llega.
  expect(sw).toMatch(/const CACHE_NAME = 'bookreader-v\d+';/);
});
