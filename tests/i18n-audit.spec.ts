import { test, expect } from '@playwright/test';
import path from 'path';
test.use({ locale: 'en-US' });

const EPUB_PATH = path.join(__dirname, 'test.epub');

// Palabras españolas que NO deben aparecer en la UI inglesa. Se excluye el contenido del
// libro (iframe del EPUB) y los nombres propios (Pedro Páramo en #reader-title).
const SPANISH = /(estanter|libro|biblioteca|aún|pág\.|página|tarjeta|mazo|repas|subray|marcador|ajuste|buscar|abrir|guardar|cancelar|enviar|nueva |nuevo |crear |elegir|objetivo|capítulo|plantilla|perfil|resumen|mapa mental|generando|preparando|leyendo|terminado|sin |ningún|todavía|vacía)/i;

async function dumpUiText(page) {
  return page.evaluate(() => {
    const parts: string[] = [];
    const walk = (root: Element | Document) => {
      for (const el of Array.from(root.querySelectorAll('*'))) {
        if (['SCRIPT', 'STYLE', 'IFRAME'].includes(el.tagName)) continue;
        for (const a of ['title', 'aria-label', 'placeholder', 'data-tip']) {
          const v = el.getAttribute(a);
          if (v) parts.push(`[${a}] ${v}`);
        }
        for (const n of Array.from(el.childNodes)) {
          if (n.nodeType === 3 && n.textContent && n.textContent.trim()) parts.push(n.textContent.trim());
        }
      }
    };
    walk(document);
    return parts;
  });
}

function leaks(parts: string[]) {
  return parts.filter(p => SPANISH.test(p) && !/Pedro Páramo|Juan Rulfo|Página de título/.test(p));
}

test('auditoría EN: lector + sidebar + biblioteca + panel + modales sin español', async ({ page }) => {
  test.setTimeout(60000);
  const found: string[] = [];
  await page.goto('/');

  // 1) landing
  found.push(...leaks(await dumpUiText(page)).map(x => 'landing: ' + x));

  // 2) cargar libro
  const [fc] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Open file' }).click(),
  ]);
  await fc.setFiles(EPUB_PATH);
  await expect(page.locator('#reader-title')).toHaveText('Pedro Páramo', { timeout: 10000 });

  // 3) sidebar: todas las pestañas
  await page.locator('#sidebar-toggle').click();
  for (const tab of ['contents', 'search', 'bookmarks', 'highlights', 'settings']) {
    await page.locator(`.tab-btn[data-tab="${tab}"]`).click();
  }
  found.push(...leaks(await dumpUiText(page)).map(x => 'reader/sidebar: ' + x));
  await page.locator('#sidebar-close').click();

  // 4) panel del agente + onboarding (plantillas) + studio
  await page.locator('#ai-toggle').click();
  await page.waitForTimeout(1500); // segmentación + estado
  found.push(...leaks(await dumpUiText(page)).map(x => 'ai-panel: ' + x));

  // cerrar onboarding/panel antes de navegar
  await page.locator('#ai-onboarding .ai-ob-close').click().catch(() => {});
  await page.locator('#ai-close').click().catch(() => {});

  // 5) biblioteca (crear estantería para poblar el raíl)
  await page.locator('#library-btn').click();
  await expect(page.locator('.lib-h1')).toBeVisible();
  found.push(...leaks(await dumpUiText(page)).map(x => 'library: ' + x));
  // kebab del libro
  await page.locator('.lib-card .lib-kebab').first().click({ force: true });
  found.push(...leaks(await dumpUiText(page)).map(x => 'book-menu: ' + x));
  await page.keyboard.press('Escape');

  const uniq = [...new Set(found)];
  expect(uniq, 'Cadenas españolas en UI inglesa:\n' + uniq.join('\n')).toHaveLength(0);
});
