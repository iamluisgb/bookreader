import base from './playwright.config';
import { defineConfig } from '@playwright/test';

// WebKit (Safari) para regresiones de motor: los tests de suite corren en Chromium por
// defecto; bugs de layout/transform reportados desde Safari se verifican aquí:
//   npx playwright test tests/study-overflow.spec.ts --config=playwright.webkit.config.ts
export default defineConfig({
  ...base,
  projects: [{ name: 'webkit', use: { ...base.use, browserName: 'webkit' } }],
});
