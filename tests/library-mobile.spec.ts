import { test, expect, Page } from '@playwright/test';
import path from 'path';

// Auditoría móvil de la biblioteca (docs/AUDITORIA_MOVIL_BIBLIOTECA.md). En móvil el rail de
// escritorio, puesto en horizontal, era una tira de 2.200 px con Ajustes al final, sin marca
// de la estantería elegida y con el ⋯ dentro de cada chip. Lo que se fija aquí:
//   - tira CORTA (Libros · Sin estantería · fijadas/elegida/recientes · «Estanterías ▾»);
//   - «Más» en la cabecera → Ajustes, Análisis, Mazos… a dos toques;
//   - la elegida, en tinta y a la vista; su ⋯ junto al título; pulsación larga en el chip;
//   - la hoja «Estanterías» con el árbol y el cruce por casillas;
//   - el escritorio, como estaba;
//   - con un libro abierto, «Más» en la cabecera del lector.
test.describe.configure({ retries: 2 });

const EPUB_PATH = path.join(__dirname, 'test.epub');
const MOBILE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

async function seed(page: Page) {
  await page.goto('/');
  const ids = await page.evaluate(async () => {
    const S: any = await import('/js/library/store.js');
    const names = ['Literatura contemporánea', 'Técnico', 'Técnico/LLM', 'Técnico/Sistemas distribuidos', 'Ensayo', 'Club de lectura', 'Clásicos'];
    const sh: any = {};
    for (const n of names) sh[n] = await S.addShelf(n);
    await S.addShelf('Sin empezar', { rule: { status: 'unread' } });
    for (let i = 0; i < 14; i++) {
      await S.putBook({ id: 'b' + i, title: 'Libro ' + i, format: 'epub', status: 'unread', addedAt: Date.now() - i, shelfIds: [sh[names[i % names.length]].id] });
    }
    return { llm: sh['Técnico/LLM'].id, club: sh['Club de lectura'].id };
  });
  await page.reload();
  await page.waitForSelector('.lib-strip', { state: 'attached' });
  return ids;
}

test.describe('móvil', () => {
  test.use(MOBILE);

  test('la tira es corta y «Más» lleva a Ajustes generales en dos toques', async ({ page }) => {
    await seed(page);
    await expect(page.locator('.lib-rail')).toBeHidden();
    // Libros · Sin estantería · «Estanterías ▾»: nada de las 8 estanterías hasta usarlas.
    await expect(page.locator('.lib-strip > .lib-schip')).toHaveCount(3);
    await expect(page.locator('.lib-schip--more')).toContainText('Estanterías');
    await page.locator('.lib-more').click();
    const sheet = page.locator('.lib-sheet');
    await expect(sheet.locator('.lib-sheet-row')).toHaveText(['Ajustes generales', 'Análisis', 'Mazos', 'Nueva estantería', 'Guía rápida']);
    await sheet.locator('[data-act="settings"]').click();
    await expect(page.locator('#app-settings')).toBeVisible();
  });

  test('elegir en la hoja: la estantería queda en tinta, a la vista, con su ⋯ junto al título', async ({ page }) => {
    await seed(page);
    await page.locator('.lib-schip--more').click();
    await page.locator('.lib-sheet-pick', { hasText: 'LLM' }).click();
    await expect(page.locator('.lib-sheet')).toHaveCount(0);
    await expect(page.locator('.lib-h1')).toHaveText('LLM');
    const chip = page.locator('.lib-strip .lib-schip.active');
    await expect(chip).toContainText('LLM');
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    // En tinta: fondo del color del texto y el nombre legible encima.
    const colors = await chip.evaluate((el) => {
      const cs = getComputedStyle(el);
      const name = getComputedStyle(el.querySelector('.lib-schip-name')!);
      return { bg: cs.backgroundColor, ink: getComputedStyle(document.body).color, name: name.color };
    });
    expect(colors.bg).toBe(colors.ink);
    expect(colors.name).not.toBe(colors.bg);
    // A la vista dentro de la tira.
    const inView = await chip.evaluate((el) => {
      const a = el.getBoundingClientRect(), b = el.parentElement!.getBoundingClientRect();
      return a.left >= b.left - 1 && a.right <= b.right + 1;
    });
    expect(inView).toBe(true);
    await expect(page.locator('.lib-head-kebab')).toBeVisible();
  });

  test('la hoja cruza estanterías con las casillas y ofrece Y/O con dos', async ({ page }) => {
    await seed(page);
    await page.locator('.lib-schip--more').click();
    await page.locator('.lib-sheet-shelf', { hasText: 'Clásicos' }).locator('.lib-sheet-check').check();
    await page.locator('.lib-sheet-shelf', { hasText: 'Ensayo' }).locator('.lib-sheet-check').check();
    await expect(page.locator('.lib-sheet-mode')).toBeVisible();         // la hoja sigue abierta
    await page.locator('.lib-sheet-x').click();
    await expect(page.locator('.lib-strip .lib-schip.active')).toHaveCount(2);
  });

  test('pulsación larga en el chip: sus opciones, con «Fijar en la tira» (sin Subir/Bajar)', async ({ page }) => {
    const { club } = await seed(page);
    // La estantería entra en la tira al usarla (recientes).
    await page.locator('.lib-schip--more').click();
    await page.locator('.lib-sheet-pick', { hasText: 'Club de lectura' }).click();
    const chip = page.locator(`.lib-schip[data-shelf-id="${club}"]`);
    await expect(chip).toBeVisible();
    const box = (await chip.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    const menu = page.locator('.lib-menu');
    await expect(menu).toBeVisible();
    await expect(menu.locator('[data-act="up"], [data-act="down"]')).toHaveCount(0);
    await menu.locator('[data-act="pin"]').click();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lib_pinned_shelves') || '[]'))).toContain(club);
    // Fijada: sigue en la tira aunque vuelvas a «Libros».
    await page.locator('.lib-strip .lib-schip[data-shelf="all"]').click();
    await expect(page.locator(`.lib-schip[data-shelf-id="${club}"]`)).toBeVisible();
  });
});

test('escritorio, como estaba: el rail entero y ni tira ni «Más»', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 820 });
  await seed(page);
  await expect(page.locator('.lib-rail')).toBeVisible();
  await expect(page.locator('.lib-strip')).toBeHidden();
  await expect(page.locator('.lib-more')).toBeHidden();
  await expect(page.locator('.lib-rail .lib-rail-settings')).toBeVisible();
});

test('con un libro abierto, «Más» en la cabecera lleva a Ajustes generales y a la biblioteca', async ({ page }) => {
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', EPUB_PATH);
  await page.waitForSelector('#epub-container iframe', { timeout: 30000 });
  await expect(page.locator('#library-btn')).toBeVisible();                 // «‹ Biblioteca» = volver
  await expect(page.locator('#library-btn')).toHaveAccessibleName('Volver a la biblioteca');
  await page.locator('#reader-more').click();
  const menu = page.locator('.reader-more-menu');
  await expect(menu.locator('.lib-menu-item')).toHaveText(['Ajustes generales', 'Biblioteca']);
  await menu.locator('[data-act="general"]').click();
  await expect(page.locator('#app-settings')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('#reader-more').click();
  await page.locator('.reader-more-menu [data-act="library"]').click();
  await expect(page.locator('#library')).toBeVisible();
});
