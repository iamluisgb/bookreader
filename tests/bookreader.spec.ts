import { test, expect } from '@playwright/test';
import path from 'path';

const EPUB_PATH = path.join(__dirname, 'test.epub');

test.describe('BookReader - Landing', () => {
  test('shows landing page with title and open button', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('BookReader');
    await expect(page.getByRole('button', { name: 'Abrir archivo' })).toBeVisible();
  });

  test('sidebar opens and closes', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Abrir sidebar' }).click();
    await expect(page.locator('#sidebar')).toHaveClass(/open/);
    await page.getByRole('button', { name: 'Cerrar sidebar' }).click();
    await expect(page.locator('#sidebar')).not.toHaveClass(/open/);
  });
});

test.describe('BookReader - EPUB Loading', () => {
  test('loads an epub file and shows title', async ({ page }) => {
    await page.goto('/');

    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: 'Abrir archivo' }).click(),
    ]);
    await fileChooser.setFiles(EPUB_PATH);

    await expect(page.locator('#reader-title')).toHaveText('Pedro Páramo', { timeout: 10000 });
    await expect(page.locator('#reader-footer')).toBeVisible();
    await expect(page.locator('#epub-container')).toBeVisible();
    await expect(page.locator('#landing')).not.toBeVisible();
  });

  test('navigation buttons work', async ({ page }) => {
    await page.goto('/');

    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: 'Abrir archivo' }).click(),
    ]);
    await fileChooser.setFiles(EPUB_PATH);
    await page.waitForTimeout(2000);

    // Go past cover pages
    for (let i = 0; i < 5; i++) {
      await page.getByRole('button', { name: 'Página siguiente' }).click();
      await page.waitForTimeout(300);
    }

    // Verify content is displayed in the iframe
    const iframe = page.locator('#epub-container iframe');
    await expect(iframe).toBeVisible();

    // Check prev button works
    await page.getByRole('button', { name: 'Página anterior' }).click();
    await page.waitForTimeout(500);
  });

  test('keyboard navigation works', async ({ page }) => {
    await page.goto('/');

    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: 'Abrir archivo' }).click(),
    ]);
    await fileChooser.setFiles(EPUB_PATH);
    await page.waitForTimeout(2000);

    // Navigate with keyboard
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(300);
  });
});

test.describe('BookReader - Sidebar Tabs', () => {
  async function loadEpub(page) {
    await page.goto('/');
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: 'Abrir archivo' }).click(),
    ]);
    await fileChooser.setFiles(EPUB_PATH);
    await page.waitForTimeout(3000);
  }

  test('TOC is populated after loading epub', async ({ page }) => {
    await loadEpub(page);

    await page.getByRole('button', { name: 'Abrir sidebar' }).click();
    const tocLinks = page.locator('#toc-list a');
    await expect(tocLinks.first()).toBeVisible({ timeout: 5000 });
    const count = await tocLinks.count();
    expect(count).toBeGreaterThan(0);
  });

  test('bookmark button toggles', async ({ page }) => {
    await loadEpub(page);

    // Navigate to content
    for (let i = 0; i < 5; i++) {
      await page.getByRole('button', { name: 'Página siguiente' }).click();
      await page.waitForTimeout(300);
    }

    const btn = page.getByRole('button', { name: /Marcar página/ });
    await expect(btn).toBeEnabled();

    // Toggle bookmark
    await btn.click();
    await page.waitForTimeout(200);

    // Open sidebar, go to bookmarks tab
    await page.getByRole('button', { name: 'Abrir sidebar' }).click();
    await page.getByRole('button', { name: 'Marcadores' }).click();
    await page.waitForTimeout(200);

    const bookmarkItem = page.locator('.bookmark-item');
    await expect(bookmarkItem.first()).toBeVisible({ timeout: 3000 });
  });

  test('settings tabs switch correctly', async ({ page }) => {
    await loadEpub(page);

    await page.getByRole('button', { name: 'Abrir sidebar' }).click();

    // Check all tabs are present
    await page.getByRole('button', { name: 'Contenido' }).click();
    await expect(page.locator('#tab-contents')).toBeVisible();

    await page.getByRole('button', { name: 'Marcadores' }).click();
    await expect(page.locator('#tab-bookmarks')).toBeVisible();

    await page.getByRole('button', { name: 'Subrayados' }).click();
    await expect(page.locator('#tab-highlights')).toBeVisible();

    await page.getByRole('button', { name: 'Ajustes', exact: true }).click();
    await expect(page.locator('#tab-settings')).toBeVisible();
  });
});

test.describe('BookReader - Settings', () => {
  async function loadEpub(page) {
    await page.goto('/');
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: 'Abrir archivo' }).click(),
    ]);
    await fileChooser.setFiles(EPUB_PATH);
    await page.waitForTimeout(3000);
  }

  test('theme changes via settings', async ({ page }) => {
    await loadEpub(page);

    await page.getByRole('button', { name: 'Abrir sidebar' }).click();
    await page.getByRole('button', { name: 'Ajustes', exact: true }).click();

    // Por defecto = 'system' (sin atributo data-theme; manda prefers-color-scheme).
    expect(await page.locator('html').getAttribute('data-theme')).toBeNull();

    // Cambiar a oscuro
    await page.locator('.theme-btn[data-theme="dark"]').click();
    await page.waitForTimeout(200);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // Cambiar a sepia
    await page.locator('.theme-btn[data-theme="sepia"]').click();
    await page.waitForTimeout(200);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'sepia');

    // Claro explícito
    await page.locator('.theme-btn[data-theme="light"]').click();
    await page.waitForTimeout(200);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    // Auto (sistema) vuelve a quitar el atributo
    await page.locator('.theme-btn[data-theme="system"]').click();
    await page.waitForTimeout(200);
    expect(await page.locator('html').getAttribute('data-theme')).toBeNull();
  });

  test('font size controls work', async ({ page }) => {
    await loadEpub(page);

    await page.getByRole('button', { name: 'Abrir sidebar' }).click();
    await page.getByRole('button', { name: 'Ajustes', exact: true }).click();

    const fontValue = page.locator('#font-size-value');
    await expect(fontValue).toHaveText('16px');

    // Increase
    await page.getByRole('button', { name: 'A+' }).click();
    await expect(fontValue).toHaveText('17px');

    // Decrease
    await page.getByRole('button', { name: 'A-' }).click();
    await expect(fontValue).toHaveText('16px');
  });

  test('font family select works', async ({ page }) => {
    await loadEpub(page);

    await page.getByRole('button', { name: 'Abrir sidebar' }).click();
    await page.getByRole('button', { name: 'Ajustes', exact: true }).click();

    const select = page.locator('#font-family-select');
    await select.selectOption('sans-serif');
    await expect(select).toHaveValue('sans-serif');

    await select.selectOption('monospace');
    await expect(select).toHaveValue('monospace');
  });

  test('settings persist in localStorage', async ({ page }) => {
    await loadEpub(page);

    await page.getByRole('button', { name: 'Abrir sidebar' }).click();
    await page.getByRole('button', { name: 'Ajustes', exact: true }).click();

    // Change theme
    await page.locator('.theme-btn[data-theme="dark"]').click();
    await page.waitForTimeout(200);

    // Verify in localStorage
    const stored = await page.evaluate(() => {
      return JSON.parse(localStorage.getItem('bookreader_settings'));
    });
    expect(stored.theme).toBe('dark');
  });
});

test.describe('BookReader - Highlights', () => {
  async function loadEpub(page) {
    await page.goto('/');
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: 'Abrir archivo' }).click(),
    ]);
    await fileChooser.setFiles(EPUB_PATH);
    await page.waitForTimeout(3000);
  }

  test('highlights tab shows empty state initially', async ({ page }) => {
    await loadEpub(page);

    await page.getByRole('button', { name: 'Abrir sidebar' }).click();
    await page.getByRole('button', { name: 'Subrayados' }).click();

    await expect(page.locator('#highlights-list .empty-state')).toBeVisible();
    await expect(page.locator('#export-highlights-btn')).toBeDisabled();
  });
});

test.describe('BookReader - Export', () => {
  async function loadEpub(page) {
    await page.goto('/');
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: 'Abrir archivo' }).click(),
    ]);
    await fileChooser.setFiles(EPUB_PATH);
    await page.waitForTimeout(3000);
  }

  test('export button is disabled with no highlights', async ({ page }) => {
    await loadEpub(page);

    await page.getByRole('button', { name: 'Abrir sidebar' }).click();
    await page.getByRole('button', { name: 'Subrayados' }).click();

    await expect(page.locator('#export-highlights-btn')).toBeDisabled();
  });

  test('export button is enabled after adding highlight via JS', async ({ page }) => {
    // The bookId is derived from filename: "test.epub" -> "test"
    const bookId = 'test';

    // Inject highlights for this book
    await page.goto('/');
    await page.evaluate((id) => {
      const highlights = [{
        cfi: 'epubcfi(/6/14!/4/2/1:0)',
        text: 'Test highlight',
        color: '#ffeb3b',
        chapter: 'Test chapter',
        timestamp: Date.now()
      }];
      localStorage.setItem('bookreader_highlights_' + id, JSON.stringify(highlights));
    }, bookId);

    // Load epub
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: 'Abrir archivo' }).click(),
    ]);
    await fileChooser.setFiles(EPUB_PATH);
    await page.waitForTimeout(3000);

    await page.getByRole('button', { name: 'Abrir sidebar' }).click();
    await page.getByRole('button', { name: 'Subrayados' }).click();

    await expect(page.locator('.highlight-item').first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe('BookReader - Drag & Drop', () => {
  test('drag area is visible on landing', async ({ page }) => {
    await page.goto('/');
    const viewport = page.locator('#reader-viewport');
    await expect(viewport).toBeVisible();
  });
});

test.describe('BookReader - No JS errors', () => {
  test('no console errors on load', async ({ page }) => {
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error' && !msg.text().includes('favicon')) {
        errors.push(msg.text());
      }
    });
    // También excepciones no capturadas (no llegan como console.error).
    page.on('pageerror', err => errors.push('pageerror: ' + err.message));

    await page.goto('/');
    await page.waitForTimeout(2000);
    expect(errors).toHaveLength(0);
  });

  test('no console errors after loading epub', async ({ page }) => {
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error' && !msg.text().includes('favicon')) {
        errors.push(msg.text());
      }
    });
    page.on('pageerror', err => errors.push('pageerror: ' + err.message));

    await page.goto('/');
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: 'Abrir archivo' }).click(),
    ]);
    await fileChooser.setFiles(EPUB_PATH);
    await page.waitForTimeout(5000);
    // Navegar para ejercitar el panel de progreso (countBookWords / spine).
    for (let i = 0; i < 3; i++) {
      await page.click('#next-btn');
      await page.waitForTimeout(400);
    }

    expect(errors).toHaveLength(0);
  });
});
