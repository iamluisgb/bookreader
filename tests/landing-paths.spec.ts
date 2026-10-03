import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';

// La landing también se sirve bajo un subdirectorio (luisgonzalezbernal.com/bookreader/):
// una ruta que empieza por «/» apunta a la raíz de ESE dominio y da 404. Así se perdieron
// las portadas del libro en 3D. Las páginas públicas y su JS/CSS solo usan rutas relativas.
const PAGES = ['index.html', 'es/index.html', 'anki/index.html', 'privacy/index.html',
  'assets/landing/motion.js', 'assets/landing/motion.css', 'assets/landing/brand.css'];

test('las páginas públicas no usan rutas absolutas a recursos propios', () => {
  const bad: string[] = [];
  for (const f of PAGES) {
    const src = readFileSync(join(process.cwd(), f), 'utf8');
    for (const m of src.matchAll(/(?:href|src|url\(|"cover":\s*)\s*["']?(\/(?:assets|app|es|anki|privacy|u)\/[^"')\s]*)/g)) {
      bad.push(`${f}: ${m[1]}`);
    }
  }
  expect(bad, `Usa rutas relativas:\n${bad.join('\n')}`).toEqual([]);
});
