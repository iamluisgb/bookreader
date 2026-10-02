import { test, expect } from '@playwright/test';
import path from 'path';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { seedProLicense } from './pro-license';

// P24 F2 · Lo ajeno en el Studio del agente: el resumen de Luis se abre con el mismo visor
// que los tuyos (y sus citas llevan al pasaje: es el mismo fichero), su libreta se lee en
// solo lectura, y su mazo se puede adoptar como mazo propio con calendario nuevo.

const EPUB_PATH = path.join(__dirname, 'test.epub');
const BOOK = createHash('sha256').update(readFileSync(EPUB_PATH)).digest('hex');

async function setup(page) {
  await page.goto('/index.html');
  await seedProLicense(page);   // la plantilla HQ&A es Pro (MON2): el test ejercita lo compartido, no el gate
  await page.evaluate((k) => localStorage.setItem('bookreader_ai_key', JSON.stringify(k)), 'test-key');
  await page.evaluate(async (bookId) => {
    const Shared: any = await import('/js/share/store.js');
    await Shared.replaceDossier('luis|pedro', [{
      bookId, title: 'Pedro Páramo', from: 'Luis', shelfName: 'Rulfo', importedAt: Date.now(),
      highlights: [],
      artifacts: [{ kind: 'summary', result: 'TL;DR: Comala según Luis.\n\n## Ideas principales\nUn pueblo de ánimas [[a0]].', params: {}, segVersion: 6 }],
      notebooks: [{ templateId: 'custom-luis', goal: 'leer a Rulfo', notes: [
        { fieldKey: 'ideas', content: 'Los muertos narran [[a0]]', sourceCfis: [] },
      ] }],
      decks: [{ name: 'Rulfo básico', cardType: 'basic', scope: null, cards: [
        { front: '¿Quién narra?', back: 'Juan Preciado' }, { front: '¿Dónde?', back: 'Comala' },
      ] }],
      templates: [{ id: 'custom-luis', custom: true, name: 'Método de Luis', fields: [{ key: 'ideas', label: 'Ideas', type: 'text' }] }],
    }]);
  }, BOOK);
  await page.reload();
  const fc = page.waitForEvent('filechooser');
  await page.click('.lib-empty .lib-upload');
  await (await fc).setFiles(EPUB_PATH);
  await page.waitForSelector('#ai-toggle:not([disabled])', { timeout: 15000 });
  await page.click('#ai-toggle');
  await page.waitForSelector('.ai-onboarding', { timeout: 5000 });
  await page.click('.ai-ob-tpl[data-tpl="hqa"]');
  await page.fill('#ai-ob-goal', 'entender la novela');
  await page.click('#ai-ob-start');
  await expect(page.locator('#ai-status')).toContainText('Listo', { timeout: 30000 });
  await page.locator('.ai-tab[data-view="studio"]').click();
}

test('Studio: lo de Luis se abre, se lee y su mazo se adopta', async ({ page }) => {
  await setup(page);
  const sec = page.locator('.studio-shared');
  await expect(sec.locator('.studio-group-name')).toHaveText('De Luis');

  // Resumen: el MISMO visor que los tuyos, con la cita convertida en chip.
  await sec.locator('[data-act="shared-open"]').click();
  await expect(page.locator('#ai-summary')).toContainText('Comala según Luis');
  await expect(page.locator('#ai-summary .ai-cite')).toHaveCount(1);
  await page.locator('#ai-summary .ai-ob-close').click();

  // Libreta: solo lectura, con la etiqueta de SU plantilla (viajó incrustada).
  await sec.locator('[data-act="shared-notebook"]').click();
  const nb = page.locator('#shared-notebook');
  await expect(nb.locator('h2')).toHaveText('Método de Luis');
  await expect(nb.locator('.shared-nb-field h3')).toHaveText('Ideas');
  await expect(nb.locator('.shared-nb-note')).toContainText('Los muertos narran');
  await expect(nb.locator('.ai-cite')).toHaveCount(1);
  await expect(nb.locator('textarea, input, [contenteditable]')).toHaveCount(0);
  await nb.locator('.ai-ob-close').click();
  await expect(nb).toHaveCount(0);

  // La plantilla ajena NO entra en tus plantillas (inyectaría texto en tu prompt).
  expect(await page.evaluate(() => localStorage.getItem('bookreader_custom_templates'))).toBeNull();

  // Mazo: adoptarlo lo hace tuyo, sin calendario heredado.
  await sec.locator('[data-act="shared-adopt"]').click();
  await expect(page.locator('.studio-group[data-kind="flashcards"]')).toContainText('Rulfo básico · Luis');
  const decks = await page.evaluate(async (bookId) => (await import('/js/ai/db.js') as any).getDecks(bookId), BOOK);
  expect(decks).toHaveLength(1);
  expect(decks[0].cards.map((c: any) => c.front)).toEqual(['¿Quién narra?', '¿Dónde?']);
  expect(decks[0].cards.every((c: any) => !c.srs)).toBe(true);
});
