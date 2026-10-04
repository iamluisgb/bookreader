import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';

// La analítica (Umami, un tercero) no puede recibir el fragmento de la URL: ahí van la clave
// de un enlace compartido (#d=<id>.<clave>, ADR-053), el token de la demo y el libro que se lee.
test('el tracker de la app se carga con data-exclude-hash', () => {
  const src = readFileSync(join(process.cwd(), 'app/js/analytics.js'), 'utf8');
  expect(src).toMatch(/setAttribute\('data-exclude-hash',\s*'true'\)/);
});

test('el tracker respeta exclude-hash: la URL que envía va sin fragmento', async ({ page }) => {
  const sent: string[] = [];
  await page.route('https://cloud.umami.is/**', async (route) => {
    sent.push(JSON.parse(route.request().postData() || '{}')?.payload?.url || '');
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  // El servidor de tests sirve app/; el tracker vive en la raíz del repo (u/s.js).
  await page.route('**/u/s.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript',
    body: readFileSync(join(process.cwd(), 'u/s.js'), 'utf8') }));
  await page.goto('/index.html#d=' + 'A'.repeat(22) + '.' + 'k'.repeat(43));
  await page.evaluate(() => {
    const u = document.createElement('script');
    u.src = '/u/s.js';
    u.setAttribute('data-website-id', 'test');
    u.setAttribute('data-host-url', 'https://cloud.umami.is');
    u.setAttribute('data-exclude-hash', 'true');
    document.head.appendChild(u);
  });
  await expect.poll(() => sent.length, { timeout: 10000 }).toBeGreaterThan(0);
  for (const url of sent) expect(url).not.toContain('#');
});
