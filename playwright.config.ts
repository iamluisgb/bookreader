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
  },
  webServer: {
    command: 'python3 -m http.server 8888',
    port: 8888,
    reuseExistingServer: true,
  },
});
