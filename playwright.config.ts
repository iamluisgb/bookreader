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
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:8888',
    headless: true,
    // i18n (P15): la app arranca en el idioma de navigator.language (default EN). Los
    // tests históricos asertan texto español, así que el navegador de test es es-ES;
    // tests/i18n.spec.ts fuerza en-US en sus propios contextos para cubrir el inglés.
    locale: 'es-ES',
  },
  webServer: {
    // La app vive en app/; se sirve como raíz para que los tests sigan usando
    // rutas absolutas (/index.html, /js/…) sin cambios tras la reorganización.
    command: 'python3 -m http.server 8888 --directory app',
    port: 8888,
    reuseExistingServer: true,
  },
});
