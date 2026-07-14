import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// Red de seguridad contra un bug de clase entera: usar una custom property que NO existe
// (p. ej. --bg-primary cuando el tema define --surface-1) resuelve a "sin valor" → fondos
// transparentes y texto invisible, SIN error en consola. Pasó con el menú de repaso y el
// #sync-badge. Este test parsea el CSS y exige que toda `var(--x)` SIN fallback esté definida.

test('ninguna var(--x) del CSS sin fallback queda sin definir', () => {
  const dir = join(process.cwd(), 'app', 'css');
  const css = readdirSync(dir).filter(f => f.endsWith('.css'))
    .map(f => readFileSync(join(dir, f), 'utf8')).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');   // fuera comentarios (evitan casar la declaración siguiente)

  // Propiedades DEFINIDAS: "--nombre:" (una definición siempre lleva ':'; `var(--x)` nunca).
  const defined = new Set<string>();
  for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:/gi)) defined.add(m[1]);

  // Propiedades USADAS: var(--nombre) o var(--nombre, fallback). Con fallback se toleran.
  const missing = new Set<string>();
  for (const m of css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,)?/gi)) {
    const [, name, hasFallback] = m;
    if (!hasFallback && !defined.has(name)) missing.add(name);
  }

  expect([...missing].sort(), `Variables CSS usadas sin definir: ${[...missing].join(', ')}`).toEqual([]);
});
