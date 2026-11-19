import { test, expect, Page } from '@playwright/test';

// P58 F3 · Estado en el rail: anillo con la fracción terminada y punto si hay repaso hoy, y
// los dos dichos con palabras en la etiqueta (que es también la del tooltip de la franja).

async function seed(page: Page) {
  await page.setViewportSize({ width: 1300, height: 900 });
  await page.goto('/');
  await page.evaluate(async () => {
    const S: any = await import('/js/library/store.js');
    const DB: any = await import('/js/ai/db.js');
    const Srs: any = await import('/js/ai/srs.js');
    const now = Date.now(), today = Srs.dayOf(now);
    const ag = await S.addShelf('Técnico/Agentes');
    const nov = await S.addShelf('Novela');
    await S.addShelf('Terminados', { rule: { status: 'finished' } });
    const books: [string, string, string][] = [['a1', 'finished', ag.id], ['a2', 'unread', ag.id], ['a3', 'unread', ag.id], ['a4', 'reading', ag.id], ['n1', 'unread', nov.id]];
    for (const [id, status, sh] of books) await S.putBook({ id, title: id, format: 'epub', status, addedAt: now, shelfIds: [sh] });
    await DB.addDeck({ bookId: 'a2', name: 'x', cards: [{ front: 'q', back: 'a', srs: { due: today - 1, interval: 3, stability: 3, lastReview: now - 5 * 86400000, reps: 2 } }] });
  });
  await page.reload();
  await page.waitForSelector('.lib-rail');
}
const item = (page: Page, label: string) => page.locator(`.lib-rail-item[data-row-label="${label}"]`);

test('anillo = terminados / libros; sin nada terminado, sin anillo; las automáticas nunca', async ({ page }) => {
  await seed(page);
  const fill = item(page, 'Agentes').locator('.lib-rail-ring-fill');
  await expect(fill).toHaveAttribute('stroke-dasharray', '25 100');
  // El grupo suma lo de sus hijas.
  await expect(item(page, 'Técnico').locator('.lib-rail-ring-fill')).toHaveAttribute('stroke-dasharray', '25 100');
  await expect(item(page, 'Novela').locator('.lib-rail-ring')).toHaveCount(0);
  await expect(item(page, 'Terminados').locator('.lib-rail-ring')).toHaveCount(0);
  await expect(item(page, 'Agentes')).toHaveAttribute('aria-label', /1 de 4 terminados/);
});

test('punto de repaso: en la estantería con vencidas y en su grupo, no en las demás', async ({ page }) => {
  await seed(page);
  await expect(item(page, 'Agentes').locator('.lib-rail-dot')).toBeVisible();
  await expect(item(page, 'Técnico').locator('.lib-rail-dot')).toBeVisible();
  await expect(item(page, 'Novela').locator('.lib-rail-dot')).toBeHidden();
  await expect(item(page, 'Agentes')).toHaveAttribute('aria-label', /1 tarjeta para hoy/);
  await expect(item(page, 'Novela')).not.toHaveAttribute('aria-label', /para hoy/);
});
