import { defineConfig } from '@playwright/test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Carga .env (sin dependencia de dotenv) para que los tests dispongan de NAN_API_KEY.
// Las variables ya presentes en el entorno tienen prioridad.
try {
  const raw = readFileSync(resolve(__dirname, '.env'), 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* sin .env: se usa el entorno tal cual */ }

export default defineConfig({
  testDir: './tests',
  // 60 s, no 30. Un timeout es una RED DE SEGURIDAD contra un cuelgue, no un
  // objetivo de rendimiento, y 30 s daban muy poco margen a los tests que montan
  // un EPUB o un PDF entero: cite-nav tarda ~10 s aislado y se pasaba de 30 en
  // cuanto la máquina tenía algo más entre manos. Subirlo no cuesta nada cuando
  // los tests pasan —solo cambia cuánto se espera antes de rendirse— y elimina el
  // modo de fallo más frágil de la suite.
  //
  // NO se limitan los `workers`: medido en una máquina de 16 GB, pasar de 4 a 2
  // sube el tiempo un 21 % y baja el pico de swap un 3 %. La presión de memoria
  // es del sistema (7 GB de swap ya en uso en reposo), no de la suite.
  timeout: 60000,
  // Las aserciones web-first (toBeVisible, toHaveText, expect.poll…) se rinden a los 5 s
  // por defecto, y ESE era el techo que se tocaba antes que el del test: con la máquina
  // ocupada, un repintado tarda más de 5 s y el test moría a los 10, muy lejos de los 60.
  // Reintentar más tiempo no cuesta nada cuando la aserción acaba pasando.
  expect: { timeout: 15000 },
  use: {
    baseURL: 'http://localhost:8888',
    headless: true,
    // i18n (P15): la app arranca en el idioma de navigator.language (default EN). Los
    // tests históricos asertan texto español, así que el navegador de test es es-ES;
    // tests/i18n.spec.ts fuerza en-US en sus propios contextos para cubrir el inglés.
    locale: 'es-ES',
  },
  webServer: [
    {
      // La app vive en app/; se sirve como raíz para que los tests sigan usando
      // rutas absolutas (/index.html, /js/…) sin cambios tras la reorganización.
      command: 'node scripts/test-server.mjs 8888 app',
      port: 8888,
      reuseExistingServer: true,
    },
    {
      // Raíz del repo (landings /, /es/, /anki/, /privacy/) para landing-lang.spec.ts.
      command: 'node scripts/test-server.mjs 8899 .',
      port: 8899,
      reuseExistingServer: true,
    },
  ],
});
