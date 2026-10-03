import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// Reglas del set de iconos (DESIGN.md · Iconos). Como css-vars.spec.ts: el sistema se
// cumple porque falla un test, no porque alguien se acuerde.
//   1. Todo icono que la app pide existe. icon() devolvía '' en silencio con un nombre
//      desconocido: `info` no existía y la nota del Resumen salía sin icono sin que nadie
//      lo notara.
//   2. El tamaño es un paso de la escala ('sm'…'hero'), nunca un número: había 12
//      tamaños distintos (de 11 a 56 px).
//   3. La escala de icons.js es el espejo de los tokens --icon-* de themes.css.
//   4. Sin emoji en la interfaz: cambian de dibujo en cada sistema y no heredan el color
//      del tema. La excepción es la tarjeta para compartir (share-card.js): es una imagen
//      para redes y ahí el emoji es lenguaje social.

const ROOT = process.cwd();
const APP = join(ROOT, 'app');

function files(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (f === 'vendor' || f === '_proto' || f.startsWith('.')) continue;
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(js|html|css)$/.test(f)) out.push(p);
  }
  return out;
}
const ALL = files(APP);
const rel = (p: string) => p.slice(ROOT.length + 1);
const iconsSrc = readFileSync(join(APP, 'js/ui/icons.js'), 'utf8');
const ICONS_BLOCK = iconsSrc.slice(iconsSrc.indexOf('const ICONS = {'), iconsSrc.indexOf('\n};', iconsSrc.indexOf('const ICONS = {')));
const NAMES = new Set([...ICONS_BLOCK.matchAll(/^\s+'?([a-z][a-z-]*)'?:\s*'</gm)].map(m => m[1]));

test('todo icono que pide la app existe en el set', () => {
  expect(NAMES.size).toBeGreaterThan(40);
  const missing: string[] = [];
  const pat = /icon\(\s*['"]([a-z-]+)['"]|data-icon=["']([a-z-]+)["']|\bico:\s*['"]([a-z-]+)['"]|act\(\s*['"]([a-z-]+)['"]|row\(\s*'[a-z]+',\s*'([a-z-]+)'/g;
  for (const f of ALL) {
    if (f.endsWith('icons.js')) continue;
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(pat)) {
      const name = m.slice(1).find(Boolean)!;
      if (!NAMES.has(name)) missing.push(`${rel(f)}: ${name}`);
    }
    // Ternarios: icon(cond ? 'a' : 'b', …)
    for (const m of src.matchAll(/icon\([^,()]*\?\s*'([a-z-]+)'\s*:\s*'([a-z-]+)'/g)) {
      for (const n of [m[1], m[2]]) if (!NAMES.has(n)) missing.push(`${rel(f)}: ${n}`);
    }
  }
  expect(missing, `Iconos que no existen en js/ui/icons.js:\n${missing.join('\n')}`).toEqual([]);
});

test('tamaños de icono: un paso de la escala, nunca un número', () => {
  const bad: string[] = [];
  for (const f of ALL) {
    const src = readFileSync(f, 'utf8');
    src.split('\n').forEach((l, i) => {
      if (/icon\((?:[^()]|\([^()]*\))*?\{\s*size:\s*\d/.test(l) || /data-icon-size="\d/.test(l)) bad.push(`${rel(f)}:${i + 1}`);
    });
  }
  expect(bad, `Usa size: 'sm' | 'md' | 'lg' | 'xl' | 'display' | 'hero':\n${bad.join('\n')}`).toEqual([]);
});

test('la escala de icons.js es la de los tokens --icon-* de themes.css', () => {
  const js = Object.fromEntries([...iconsSrc.match(/ICON_SIZES = \{([^}]*)\}/)![1].matchAll(/(\w+):\s*(\d+)/g)].map(m => [m[1], Number(m[2])]));
  const css = Object.fromEntries([...readFileSync(join(APP, 'css/themes.css'), 'utf8').matchAll(/--icon-([a-z]+):\s*(\d+)px/g)].map(m => [m[1], Number(m[2])]));
  expect(js).toEqual(css);
});

test('sin emoji en la interfaz (salvo la tarjeta para compartir)', () => {
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B50}]/u;
  const PERMITIDOS = new Set(['app/js/share-card.js']);
  const bad: string[] = [];
  for (const f of ALL) {
    if (PERMITIDOS.has(rel(f))) continue;
    readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
      const s = l.trim();
      if (/^(\/\/|\/?\*|<!--)/.test(s)) return;            // comentarios
      const code = s.replace(/\/\*.*?\*\//g, '').replace(/\s\/\/\s.*$/, '');
      if (EMOJI.test(code)) bad.push(`${rel(f)}:${i + 1}  ${s.slice(0, 90)}`);
    });
  }
  expect(bad, `Usa un icono del set (js/ui/icons.js):\n${bad.join('\n')}`).toEqual([]);
});

test('el set se pinta: cada icono da un SVG y un nombre desconocido avisa', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', m => { if (m.type() === 'warning') warnings.push(m.text()); });
  await page.goto('/patterns.html');
  const r = await page.evaluate(async () => {
    const I: any = await import('/js/ui/icons.js');
    const empty = I.ICON_NAMES.filter((n: string) => !I.icon(n, { size: 'md' }).includes('<svg'));
    const md = I.icon('books', { size: 'md' });
    return { empty, md, nope: I.icon('no-existe') };
  });
  expect(r.empty).toEqual([]);
  expect(r.md).toContain('width="16"');
  expect(r.md).toContain('stroke-width="1.8"');
  expect(r.nope).toBe('');
  await expect.poll(() => warnings.some(w => w.includes('no-existe'))).toBe(true);
});
