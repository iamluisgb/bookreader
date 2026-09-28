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

test('la ficha del libro muestra la barra de dominio ponderada por estabilidad FSRS', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  // 4 tarjetas: 2 maduras (peso 1 cada una), 1 aprendiendo (intervalo 7 → 7/21), 1 nueva (0).
  // Dominio = (1 + 1 + 1/3 + 0) / 4 = 58%.
  const mk = (interval, reps) => ({ type: 'basic', front: 'q', back: 'a', chapter: '', src: '',
    srs: reps ? { reps, lapses: 0, interval, due: 0, lastReview: 1, stability: interval, difficulty: 5 } : undefined });
  await seedDeck(page, { cards: [mk(30, 5), mk(45, 6), mk(7, 2), { type: 'basic', front: 'q2', back: 'a2', chapter: '', src: '' }] });
  await page.reload();

  const bar = page.locator('.lib-card[data-id="bk-ret"] .lib-mastery');
  await expect(bar).toBeVisible();
  await expect(bar.locator('.lib-mastery-lbl')).toHaveText('58% dominado');
  await expect(bar.locator('.lib-mastery-fill')).toHaveAttribute('style', /width:\s*58%/);
  await expect(bar).toHaveAttribute('title', /2 maduras/);
});

test('meta diaria: anillo con repaso de hoy / meta, ajustable al click', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await seedDeck(page, { cards: [
    { type: 'basic', front: 'q1', back: 'a1', chapter: '', src: '' },
    { type: 'basic', front: 'q2', back: 'a2', chapter: '', src: '' },
  ] });
  await page.reload();
  await page.locator('.lib-study-chip').click();
  const overlay = page.locator('#ai-study');
  const ring = overlay.locator('.study-goal');

  // Default 20; el contador es de TODO el día (empieza en 0 aunque la sesión recién arranque).
  await expect(ring.locator('.study-goal-n')).toHaveText('0/20');

  // Elegir la meta: popover con ±5, persistida.
  await ring.click();
  const pop = overlay.locator('.study-goal-pop');
  await expect(pop).toBeVisible();
  await pop.locator('.study-goal-more').click();
  await expect(pop.locator('.study-goal-v')).toContainText('25');
  await expect(ring.locator('.study-goal-n')).toHaveText('0/25');
  await page.locator('.study-body').click({ position: { x: 10, y: 10 } });
  await expect(pop).toBeHidden();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('bookreader_study_goal')));
  expect(saved).toBe(25);

  // Repasar llena el anillo y sube el contador del día.
  await overlay.locator('.study-flip').click();
  await overlay.locator('.study-grade[data-rate="good"]').click();
  await expect(ring.locator('.study-goal-n')).toHaveText('1/25');
  await expect(ring.locator('.study-goal-fill')).not.toHaveAttribute('style', /stroke-dashoffset:\s*94/);
});

test('hito de racha: se celebra al cruzar 7 y comparte una tarjeta PNG', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  // Racha cruda 6: al repasar hoy pasa a 7 y esta sesión cruza el hito → celebración.
  const yesterday = Math.floor((Date.now() - 86400000) / 86400000);
  await seedStreak(page, { count: 6, lastDay: yesterday });
  await seedDeck(page, { cards: [{ type: 'basic', front: 'q1', back: 'a1', chapter: '', src: '' }] });
  await page.reload();
  await page.locator('.lib-study-chip').click();
  const overlay = page.locator('#ai-study');

  await overlay.locator('.study-flip').click();
  await overlay.locator('.study-grade[data-rate="good"]').click();

  const ms = overlay.locator('.study-milestone');
  await expect(ms).toBeVisible();
  await expect(ms.locator('h3')).toContainText('7 días');
  await expect(ms.locator('.study-share')).toBeVisible();

  // La tarjeta compartible: PNG 1080×1080 no vacío con el hito en él (canvas real, no stub).
  const png = await page.evaluate(async () => {
    const { buildStreakCard } = await import('/js/share-card.js');
    const blob = await buildStreakCard({ streak: 7, bookTitle: 'Libro retención' });
    const bmp = await createImageBitmap(blob);
    return { type: blob.type, size: blob.size, w: bmp.width, h: bmp.height };
  });
  expect(png.type).toBe('image/png');
  expect(png.size).toBeGreaterThan(2000);
  expect(png.w).toBe(1080);
  expect(png.h).toBe(1080);
});

test('heatmap: subrayado por retención a la primera y migración del log legacy', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const seedLog = await page.evaluate(() => {
    const d = new Date();
    const today = Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 86400000); // mismo dayOf que srs.js
    const y = today - 1;
    localStorage.setItem('bookreader_study_log', JSON.stringify({
      [today]: { n: 8, ok: 4 },       // mutará con el repaso de la sesión (→ 9 · 56%)
      [y]: { n: 10, ok: 9 },          // 90% → verde
      [today - 2]: { n: 8, ok: 4 },   // 50% estable → rojo
      [today - 3]: 12,                // legacy: número plano → sin subrayado
    }));
    return { today, y };
  });
  await seedDeck(page);
  await page.reload();
  await page.locator('.lib-study-chip').click();
  const overlay = page.locator('#ai-study');

  // Los repasos de HOY ya cuentan para la meta (8 del log) y siguen contando tras repasar.
  await expect(overlay.locator('.study-goal-n')).toHaveText('8/20');
  await overlay.locator('.study-flip').click();
  await overlay.locator('.study-grade[data-rate="good"]').click();
  await expect(overlay.locator('.study-goal-n')).toHaveText('9/20');

  // Tras repasar la única tarjeta, renderCard pasa a la pantalla final: ahí está el heatmap
  // (el .study-flip del pie AHORA es «Cerrar»: no se vuelve a tocar).
  const heat = overlay.locator('.study-heat');
  await expect(heat.locator('.study-heat-cell.ret-good[title="10 · 90%"]')).toHaveCount(1);
  await expect(heat.locator('.study-heat-cell.ret-low[title="8 · 50%"]')).toHaveCount(1);
  // Hoy: 8 repasos · 4 aciertos + 1 acierto de esta sesión → 5/9 = 56% → rojo.
  await expect(heat.locator('.study-heat-cell.ret-low.is-today[title="9 · 56%"]')).toHaveCount(1);

  // Legacy: 12 repasos, sin datos de acierto → sin subrayado, tooltip plano.
  await expect(heat.locator('.study-heat-cell:not([class*="ret-"])[title="12"]')).toHaveCount(1);
});
