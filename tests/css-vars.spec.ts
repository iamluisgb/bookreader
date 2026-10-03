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

// ---------------------------------------------------------------------------------------
// Gobernanza del sistema de diseño (DESIGN.md §7). Con agentes escribiendo CSS, una regla
// que no se ejecuta no existe: un agente que ve `12px` en tres sitios lo escribe en el
// cuarto. Estos tests convierten las reglas de DESIGN.md en un fallo de `npm test`.
// Los tokens viven en themes.css; fonts.css y temml.css son de terceros/fuentes.
const TOKEN_FREE = ['main.css', 'agent.css', 'modern.css', 'reader.css'];

function cssOf(file: string): string {
  return readFileSync(join(process.cwd(), 'app', 'css', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

function offenders(re: RegExp, allowed: (m: RegExpMatchArray) => boolean): string[] {
  const out: string[] = [];
  for (const f of TOKEN_FREE) {
    for (const m of cssOf(f).matchAll(re)) if (!allowed(m)) out.push(`${f}: ${m[0].trim()}`);
  }
  return out;
}

test('tamaños de letra: solo pasos de la escala (--fs-*)', () => {
  // Excepciones con nombre: cifras de portada y muestras que reproducen otra cosa.
  const EXCEPCIONES = new Set([
    'font-size: 48px', 'font-size: 40px', // .anal-hero-n: cifra de portada de Análisis
    'font-size: 21px',                    // .fs-a--lg: muestra del tamaño de letra del lector
    'font-size: 15.5px',                  // muestra de página (tarjeta compartida)
  ]);
  const bad = offenders(/font-size:\s*[0-9.]+px/g, (m) => EXCEPCIONES.has(m[0]));
  expect(bad, `Usa var(--fs-*) de themes.css:\n${bad.join('\n')}`).toEqual([]);
});

test('radios: solo tokens --r-* (o 0 / 50% para círculos)', () => {
  const bad = offenders(/border(?:-[a-z]+)*-radius:\s*([^;}]+)/g,
    (m) => !/(^|[\s,(])[1-9][0-9.]*px/.test(m[1]));
  expect(bad, `Usa var(--r-*) de themes.css:\n${bad.join('\n')}`).toEqual([]);
});

test('capas: z-index de pantalla solo con tokens --z-* (enteros ≤ 10 dentro de un componente)', () => {
  const bad = offenders(/z-index:\s*(\d+)/g, (m) => Number(m[1]) <= 10);
  expect(bad, `Usa var(--z-*) de themes.css:\n${bad.join('\n')}`).toEqual([]);
});

test('breakpoints: solo los del sistema', () => {
  // 600 móvil estrecho · 767/768 móvil · 1001 doble página (ligado a epub-reader.js) ·
  // 1023/1024 tablet · max-height 480 móvil apaisado.
  const OK = new Set(['600', '767', '768', '1001', '1023', '1024', '480']);
  const bad = offenders(/@media[^{]*?(?:min|max)-(?:width|height):\s*(\d+)px/g, (m) => OK.has(m[1]));
  expect(bad, `Breakpoint fuera del sistema:\n${bad.join('\n')}`).toEqual([]);
});

test('color: el feedback usa --danger/--warning/--success y los hex sueltos no crecen', () => {
  // Rojos/ámbares/verdes que antes se escribían a mano: ahora son tokens semánticos.
  const SEMANTICOS = /#(?:d70015|ff3b30|c81e1e|dc2626|ef4444|e5484d|e53935|b91c1c|b25f00|d97706|f59e0b|f5a524|1f8a3c|16a34a|34c759)\b/gi;
  const sem = offenders(SEMANTICOS, () => false);
  expect(sem, `Usa var(--danger|--warning|--success):\n${sem.join('\n')}`).toEqual([]);

  // Trinquete: lo que queda (blancos/negros de overlays, papeles de muestra) solo puede
  // BAJAR. Si migras uno, baja el techo aquí; si necesitas uno nuevo, crea el token.
  const TECHO: Record<string, number> = { 'main.css': 6, 'agent.css': 11, 'modern.css': 27, 'reader.css': 0 };
  for (const f of TOKEN_FREE) {
    const n = (cssOf(f).match(/#[0-9a-f]{3,8}\b/gi) || []).length;
    expect(n, `${f}: ${n} colores hex sueltos (techo ${TECHO[f]})`).toBeLessThanOrEqual(TECHO[f]);
  }
});
