#!/usr/bin/env node
// Construye la ayuda de BookReader (MkDocs Material) y la deja en su sitio:
//   docs-help/  → fuentes (Markdown, tema, overrides)   [no se publica]
//   help/       → sitio EN generado                     → /help/
//   es/ayuda/   → sitio ES generado                     → /es/ayuda/
//
// Las dos lenguas son dos builds del MISMO árbol de páginas, para que las URLs no
// aniden prefijos y el selector de idioma apunte a la página equivalente. El CSS
// vive una sola vez (docs-help/theme/ayuda.css) y se publica en /help/assets/.
//
// mkdocs NO es dependencia de Node: se usa el del venv .venv-docs si existe (lo crea
// `python3 -m venv .venv-docs && .venv-docs/bin/pip install mkdocs-material`), o el
// que haya en PATH. El HTML generado SÍ se commitea: el deploy sale de HEAD y no
// instala Python.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'docs-help');
const siteEn = join(src, 'site-en');
const siteEs = join(src, 'site-es');
const outEn = join(root, 'help');
const outEs = join(root, 'es', 'ayuda');

const EN_BASE = 'https://bookreader.raiatech.com/help/';
const ES_BASE = 'https://bookreader.raiatech.com/es/ayuda/';

const mkdocs = existsSync(join(root, '.venv-docs', 'bin', 'mkdocs'))
  ? join(root, '.venv-docs', 'bin', 'mkdocs')
  : 'mkdocs';

function build(config) {
  try {
    execFileSync(mkdocs, ['build', '-f', join(src, config)], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, NO_MKDOCS_2_WARNING: '1' },
    });
  } catch {
    console.error(
      `\n✖ No se pudo construir ${config} con «${mkdocs}».\n` +
        '  Si falta MkDocs: python3 -m venv .venv-docs && .venv-docs/bin/pip install mkdocs-material\n',
    );
    process.exit(1);
  }
}

async function urlsFrom(sitemap, base) {
  const xml = await readFile(sitemap, 'utf8');
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => m[1])
    .filter((u) => u.startsWith(base))
    .map((u) => u.slice(base.length));
}

// Material publica los .map de su bundle: en producción no sirven a nadie y pesan
// más que toda la ayuda junta (1 MB por lengua). Se copian y se retiran.
async function stripSourceMaps(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) await stripSourceMaps(p);
    else if (entry.name.endsWith('.map')) await rm(p, { force: true });
  }
}

// El sitemap global es uno solo (sitemap.xml de la raíz). La ayuda aporta su bloque,
// regenerado entero en cada build, con los pares EN/ES y x-default → EN.
async function updateSitemap() {
  const paths = await urlsFrom(join(siteEn, 'sitemap.xml'), EN_BASE);
  const lines = paths.map((p) => {
    const en = EN_BASE + p;
    const es = ES_BASE + p;
    return [
      '  <url>',
      `    <loc>${en}</loc>`,
      `    <xhtml:link rel="alternate" hreflang="en" href="${en}"/>`,
      `    <xhtml:link rel="alternate" hreflang="es" href="${es}"/>`,
      `    <xhtml:link rel="alternate" hreflang="x-default" href="${en}"/>`,
      '  </url>',
    ].join('\n');
  });
  const block =
    '  <!-- help:start · generado por scripts/build-help.mjs, no editar a mano -->\n' +
    lines.join('\n') +
    '\n  <!-- help:end -->\n';

  const file = join(root, 'sitemap.xml');
  let xml = await readFile(file, 'utf8');
  const re = /  <!-- help:start[^]*?<!-- help:end -->\n/;
  if (re.test(xml)) xml = xml.replace(re, block);
  else xml = xml.replace('</urlset>', block + '</urlset>');
  await writeFile(file, xml);
}

async function main() {
  build('mkdocs.en.yml');
  build('mkdocs.es.yml');

  await rm(outEn, { recursive: true, force: true });
  await rm(outEs, { recursive: true, force: true });
  await mkdir(outEn, { recursive: true });
  await mkdir(outEs, { recursive: true });

  await cp(siteEn, outEn, { recursive: true });
  await cp(siteEs, outEs, { recursive: true });

  // Los sitemaps por idioma se quedan: Material los pide para el prefetch de
  // enlaces (navigation.instant) y cada uno es correcto para su subárbol. El
  // global de la raíz sigue siendo el que se anuncia en robots.txt.

  // Un solo CSS para las dos lenguas (ambas lo piden a /help/assets/ayuda.css).
  await mkdir(join(outEn, 'assets'), { recursive: true });
  await cp(join(src, 'theme', 'ayuda.css'), join(outEn, 'assets', 'ayuda.css'));

  await stripSourceMaps(outEn);
  await stripSourceMaps(outEs);

  await updateSitemap();

  // Guarda del inventario F5: la guía rápida de la app (feature-guide.js) enlaza a
  // páginas concretas de la ayuda. Si una página cambia de sitio o desaparece, el
  // build rompe aquí — no en la pantalla de un lector.
  await checkGuideLinks();

  await rm(siteEn, { recursive: true, force: true });
  await rm(siteEs, { recursive: true, force: true });

  console.log(`\n✔ Ayuda construida: ${outEn} y ${outEs}`);
  console.log('  Para publicarla: `npm run deploy:pages` (help ya está en la lista blanca).');
}

async function checkGuideLinks() {
  const src = await readFile(join(root, 'app', 'js', 'ui', 'feature-guide.js'), 'utf8');
  const paths = [...src.matchAll(/help: '([^']+)'/g)].map((m) => m[1]);
  if (paths.length < 3) {
    console.error(
      '\n✖ La guía rápida ha perdido enlaces a la ayuda (esperaba 3 grupos, hay ' +
        paths.length +
        ').',
    );
    process.exit(1);
  }
  const en = new Set(await urlsFrom(join(siteEn, 'sitemap.xml'), EN_BASE));
  const es = new Set(await urlsFrom(join(siteEs, 'sitemap.xml'), ES_BASE));
  const missing = paths.filter((p) => !en.has(p) || !es.has(p));
  if (missing.length) {
    console.error(
      `\n✖ La guía rápida enlaza páginas de ayuda que no existen: ${missing.join(', ')}`,
    );
    console.error('  Revisa los `help:` de app/js/ui/feature-guide.js contra docs-help/.');
    process.exit(1);
  }
  console.log(`\n✔ Guía rápida: ${paths.length} enlaces a la ayuda verificados en EN y ES`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
