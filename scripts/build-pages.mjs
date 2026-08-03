#!/usr/bin/env node
// Prepara dist/ para Cloudflare Pages.
//
// Dos reglas, y las dos vienen de un susto real:
//
//   1. LISTA BLANCA de lo publicable. El repo contiene .env, tests, workers y
//      docs que no deben publicarse. Copiar la raíz entera ya expuso .env una vez.
//
//   2. El origen es el COMMIT, no el disco. Antes se copiaba de `app/` tal cual
//      estuviera, así que un `deploy:pages` con trabajo a medias en el árbol lo
//      mandaba a producción sin que nadie lo pidiera —y con ficheros que ni
//      siquiera estaban en git, imposibles de reproducir después—. Ahora se
//      extrae HEAD con `git archive` y se construye de ahí: lo desplegado es
//      exactamente un commit, y lo que tengas sin commitear no puede colarse.
//
// Para previsualizar trabajo en curso: `npm run build:preview` (--worktree).
import { cp, rm, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { execFileSync, execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

const PUBLIC = ['index.html', 'sw.js', 'app', 'es', 'anki', 'privacy', 'assets'];

const fromWorktree = process.argv.includes('--worktree');
const forDeploy = process.argv.includes('--deploy');

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

// Un deploy de un commit que no está en el remoto pone en producción código que
// no existe en ningún otro sitio: si el portátil se pierde, no hay forma de
// reconstruir lo que están usando los usuarios.
function assertPushed(head) {
  let remote;
  try { remote = git('rev-parse', '--verify', 'origin/main'); } catch { remote = null; }
  const pushed = remote && (() => {
    try { git('merge-base', '--is-ancestor', head, remote); return true; } catch { return false; }
  })();
  if (pushed) return;
  if (process.env.DEPLOY_ALLOW_UNPUSHED === '1') {
    console.warn('⚠️  HEAD no está en origin/main. Sigo porque DEPLOY_ALLOW_UNPUSHED=1.');
    return;
  }
  console.error(
    `\n✖ HEAD (${head.slice(0, 7)}) no está en origin/main.\n` +
    '  Desplegar dejaría en producción código que no existe en el remoto.\n' +
    '  Haz push antes, o fuerza con DEPLOY_ALLOW_UNPUSHED=1.\n');
  process.exit(1);
}

// Avisa de lo que se queda FUERA del build, para que nadie despliegue esperando
// ver un cambio que solo existe en su disco.
function warnDirty() {
  const dirty = git('status', '--porcelain', '--', ...PUBLIC);
  if (!dirty) return;
  console.warn('⚠️  Cambios sin commitear que NO entran en el build (se construye desde HEAD):');
  for (const line of dirty.split('\n')) console.warn('     ' + line.trim());
  console.warn('');
}

let src = root;
let stamp = 'worktree';
let tmp = null;

if (fromWorktree) {
  console.warn('⚠️  Build desde el ÁRBOL DE TRABAJO: incluye cambios sin commitear. Solo para previsualizar.\n');
} else {
  const head = git('rev-parse', 'HEAD');
  if (forDeploy) assertPushed(head);
  warnDirty();
  // `git archive` da el contenido EXACTO de HEAD, sin ficheros sin seguimiento.
  tmp = await mkdtemp(join(tmpdir(), 'bookreader-build-'));
  execSync(`git archive --format=tar HEAD | tar -x -C "${tmp}"`, { cwd: root, stdio: 'inherit' });
  src = tmp;
  stamp = head;
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const entry of PUBLIC) {
  await cp(join(src, entry), join(dist, entry), {
    recursive: true,
    filter: (p) => !p.split('/').pop().startsWith('.'),
  });
}

// Sello del build: responde "¿qué hay desplegado?" sin tener que adivinarlo
// comparando ficheros contra el repo.
await writeFile(join(dist, 'build.json'),
  JSON.stringify({ commit: stamp, builtAt: new Date().toISOString() }, null, 2) + '\n');

if (tmp) await rm(tmp, { recursive: true, force: true });

console.log(`dist/ listo desde ${fromWorktree ? 'el árbol de trabajo' : stamp.slice(0, 7)} con: ${PUBLIC.join(', ')}`);
