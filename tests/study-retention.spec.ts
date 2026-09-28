import { test, expect } from '@playwright/test';
import { seedProLicense } from './pro-license';

// Retención visible (feature retencion-visual): lo que hoy es invisible no motiva.
// T1 · chip de racha persistente: se ve en la biblioteca y en el header de la sesión
// (lección Duolingo: la gente que abandona nunca llega a la pantalla final), con estado
// «en riesgo» mientras el día corre sin ningún repaso.

async function seedDeck(page, { bookId = 'bk-ret', cards } = {}) {
  await page.evaluate(async ({ bookId, cards }) => {
    const DB: any = await import('/js/ai/db.js');
    const Lib: any = await import('/js/library/store.js');
    await Lib.putBook({
      id: bookId, title: 'Libro retención', format: 'epub', fileName: 't.epub',
      addedAt: Date.now(), lastOpenedAt: Date.now(), progress: 0, status: 'reading', shelfIds: [],
    });
    await DB.addDeck({
      bookId, name: 'Libro retención', cardType: 'basic', scope: '',
      cards: cards || [{ type: 'basic', front: 'q1', back: 'a1', chapter: '', src: '' }],
    });
  }, { bookId, cards });
}

// Siembra la racha cruda (study.js usa Storage con prefijo bookreader_).
async function seedStreak(page, streak: { count: number; lastDay: number }) {
  await page.evaluate((s) => localStorage.setItem('bookreader_study_streak', JSON.stringify(s)), streak);
}

test('la racha se ve en la biblioteca con estado en riesgo y pasa a encendida al repasar', async ({ page }) => {
  const yesterday = Math.floor((Date.now() - 86400000) / 86400000);
  await page.goto('/index.html');
  await seedProLicense(page);
  await seedStreak(page, { count: 6, lastDay: yesterday });
  await seedDeck(page);
  await page.reload();

  // Biblioteca: chip visible, en riesgo (racha viva, hoy sin repasar).
  const libChip = page.locator('.lib-streakchip');
  await expect(libChip).toBeVisible();
  await expect(libChip).toContainText('6');
  await expect(libChip).toHaveClass(/is-risky/);

  // Sesión: el chip está en el header ANTES de responder nada.
  await page.locator('.lib-study-chip').click();
  const overlay = page.locator('#ai-study');
  const chip = overlay.locator('.study-streakchip');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('6');
  await expect(chip).toHaveClass(/is-risky/);

  // Al repasar la primera tarjeta: racha 7 y el riesgo se apaga.
  await overlay.locator('.study-flip').click();
  await overlay.locator('.study-grade[data-rate="good"]').click();
  await expect(chip).toContainText('7');
  await expect(chip).not.toHaveClass(/is-risky/);
});
