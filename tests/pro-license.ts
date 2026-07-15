import type { Page } from '@playwright/test';

// MON2 · Siembra una licencia Pro simulada (modo mock de js/license.js) para que los
// tests de features gateadas (flashcards, mapa mental, repaso, plantilla HQ&A, perfiles)
// ejerciten la feature y no el paywall. El gate en sí se testea en license.spec.ts.
export async function seedProLicense(page: Page) {
  await page.evaluate(() => {
    localStorage.setItem(
      'bookreader_license',
      JSON.stringify({
        key: 'BKRD-TEST-PRO',
        activationId: 'mock-test',
        validatedAt: Date.now(),
        revoked: false,
      })
    );
  });
}
