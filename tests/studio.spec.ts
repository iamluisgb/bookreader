import { test, expect } from '@playwright/test';
import { seedProLicense } from './pro-license';
import path from 'path';

// Studio: galería per-libro con HISTORIAL. Generar NO sobrescribe: cada resumen/mapa se conserva
// hasta que el usuario lo borra. LLM stubbeado (mismo patrón que jobs.spec).

const EPUB_PATH = path.join(__dirname, 'test.epub');

async function stubLLM(page) {
  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions') && opts?.body) {
        const body = JSON.parse(opts.body);
        const sys = (body.messages || []).find((m: any) => m.role === 'system')?.content || '';
        const out = /PUNTOS CLAVE/.test(sys)
          ? '- Juan Preciado llega a Comala [[a0]]\n- El pueblo está poblado de ánimas [[a1]]'
          : /Ideas principales/.test(sys)
            ? 'TL;DR: Un pueblo de muertos que hablan.\n\n## Ideas principales\nComala es un pueblo de ánimas [[a0]].\n\n## Qué llevarte\n- Los muertos hablan [[a1]]'
            : 'Un pueblo de muertos que hablan.';
        const chunks = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: out }, finish_reason: null }] })}\n\n`,
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ];
        const s = new ReadableStream({ start(c) { const e = new TextEncoder(); chunks.forEach(x => c.enqueue(e.encode(x))); c.close(); } });
        return new Response(s, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return real(url, opts);
    };
  });
}

async function setup(page) {
  await page.goto('/index.html');
  await seedProLicense(page);   // features Pro gateadas (MON2): el test ejercita la feature
  await page.evaluate((k) => localStorage.setItem('bookreader_ai_key', JSON.stringify(k)), 'test-key');
  await page.reload();
  await stubLLM(page);
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
}

async function generateSummary(page) {
  await page.waitForSelector('#ai-summary #sum-generate', { timeout: 5000 });
  await page.click('#sum-generate');
  await expect(page.locator('#ai-summary .sum-doc')).toContainText('pueblo de muertos', { timeout: 15000 });
  await page.locator('#ai-summary .ai-ob-close').click();
  await expect(page.locator('#ai-summary')).toHaveCount(0);
}

test('Studio conserva el historial: generar dos no sobrescribe; borrar uno deja el otro', async ({ page }) => {
  await setup(page);
  const studio = page.locator('#ai-view-studio');
  const summaryCards = studio.locator('.studio-card.studio-generated:has([data-kind="summary"])');

  // Studio con el resumen como invitación vacía.
  await page.click('.ai-tab[data-view="studio"]');
  await expect(studio).toBeVisible();
  await expect(studio.locator('.studio-empty [data-act="gen"][data-kind="summary"]')).toBeVisible();

  // Genera el PRIMER resumen desde Studio.
  await studio.locator('.studio-empty [data-act="gen"][data-kind="summary"]').click();
  await generateSummary(page);

  // Vuelve: 1 artefacto + botón "Nuevo".
  await page.click('.ai-tab[data-view="studio"]');
  await expect(summaryCards).toHaveCount(1);
  await expect(studio.locator('.studio-new[data-kind="summary"]')).toBeVisible();

  // Genera un SEGUNDO resumen con "Nuevo" → NO sobrescribe: ahora hay 2.
  await studio.locator('.studio-new[data-kind="summary"]').click();
  await generateSummary(page);
  await page.click('.ai-tab[data-view="studio"]');
  await expect(summaryCards).toHaveCount(2);

  // Persistidos los dos en IndexedDB.
  const persisted = await page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    return (await DB.getAll('artifacts')).filter((a: any) => a.kind === 'summary').length;
  });
  expect(persisted).toBe(2);

  // Abrir uno → resultado cacheado directo (sin setup).
  await summaryCards.first().locator('[data-act="open"]').click();
  await expect(page.locator('#ai-summary .sum-doc')).toContainText('pueblo de muertos', { timeout: 5000 });
  await expect(page.locator('#ai-summary #sum-generate')).toHaveCount(0);
  await page.locator('#ai-summary .ai-ob-close').click();

  // Borrar UNO → confirmar → queda el otro (no desaparecen todos).
  await page.click('.ai-tab[data-view="studio"]');
  await summaryCards.first().locator('.studio-del').click();
  await page.locator('.dlg-ok').click();
  await expect(summaryCards).toHaveCount(1);

  // Se comprueba con getArtifacts (lo que ve el usuario) y no con getAll (el store crudo):
  // desde que el borrado es un TOMBSTONE —para que se propague por sync en vez de
  // resucitar— la fila sigue existiendo marcada como borrada.
  const { visible, raw } = await page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    const all = await DB.getAll('artifacts');
    const bookId = all[0]?.bookId;
    return {
      visible: (await DB.getArtifacts(bookId)).filter((a: any) => a.kind === 'summary').length,
      raw: all.filter((a: any) => a.kind === 'summary').length,
    };
  });
  expect(visible).toBe(1);
  expect(raw).toBe(2);            // el tombstone sigue ahí hasta que caduque
});

// ---------------------------------------------------------------------------
// Flashcards con mazos: el tile lista los mazos del libro (store `decks`), no
// el historial de jobs. Se siembran dos mazos vía db.js (mismo camino que
// producción) y se recorre: resumen + filas, estudiar un mazo, borrarlo, y el
// caso sin mazos que conserva la invitación vacía.
// ---------------------------------------------------------------------------

// El idioma por defecto del navegador de Playwright es en-US; fijamos español
// ANTES de que la app arranque (addInitScript corre en cada navegación) para
// poder asertar sobre las cadenas de la UI tal cual las escribe el código.
async function setupEs(page: any) {
  await page.addInitScript(() => localStorage.setItem('bookreader_lang', 'es'));
  await setup(page);
}

async function currentBookId(page: any) {
  return page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    return (await DB.getAll('books'))[0].id;
  });
}

async function seedDecks(page: any, bookId: string) {
  const today = await page.evaluate(async () => (await import('/js/ai/srs.js') as any).dayOf(Date.now()));
  await page.evaluate(async ({ bookId, today }: any) => {
    const DB: any = await import('/js/ai/db.js');
    const future = (n: number) => ({ reps: 3, lapses: 0, ease: 2.5, interval: 10, due: today + n, lastReview: Date.now() });
    // Mazo con tarjetas para hoy: una nueva (sin srs) y una vencida hoy; la futura no cuenta.
    await DB.addDeck({
      bookId, name: 'Libro', cardType: 'basic', scope: 'Capítulo 1',
      cards: [
        { type: 'basic', front: 'nueva', back: 'sin agendar', chapter: '' },
        { type: 'basic', front: 'vencida', back: 'para hoy', chapter: '', srs: future(0) },
        { type: 'basic', front: 'futura', back: 'no toca', chapter: '', srs: future(5) },
      ],
    });
    // Mazo sin nada vencido: las dos agendadas a futuro.
    await DB.addDeck({
      bookId, name: 'Libro', cardType: 'basic', scope: 'Capítulo 2',
      cards: [
        { type: 'basic', front: 'a1', back: 'b1', chapter: '', srs: future(3) },
        { type: 'basic', front: 'a2', back: 'b2', chapter: '', srs: future(9) },
      ],
    });
  }, { bookId, today });
}

function flashGroup(page: any) {
  return page.locator('#ai-view-studio .studio-group[data-kind="flashcards"]');
}

test('Studio: el tile de Flashcards lista los mazos del libro con resumen y acciones', async ({ page }) => {
  await setupEs(page);
  await seedDecks(page, await currentBookId(page));

  await page.click('.ai-tab[data-view="studio"]');
  const group = flashGroup(page);
  await expect(group).toBeVisible();

  // Resumen: 2 mazos, 5 tarjetas, 2 para hoy (la nueva y la vencida del mazo 1).
  await expect(group.locator('.studio-deck-summary')).toHaveText('Mazos: 2 · Tarjetas: 5 · Para hoy: 2');

  // Una fila por mazo, con «N tarjetas · M para hoy».
  const rows = group.locator('.studio-card.studio-generated');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'Capítulo 1' })).toContainText('3 tarjetas · 2 para hoy');
  await expect(rows.filter({ hasText: 'Capítulo 2' })).toContainText('2 tarjetas · 0 para hoy');

  // Head con «Nuevo» y acceso al gestor de mazos; SIN invitación vacía.
  await expect(group.locator('.studio-new[data-kind="flashcards"]')).toBeVisible();
  await expect(group.locator('[data-act="manage"]')).toHaveText('Gestionar mazos');
  await expect(group.locator('.studio-empty')).toHaveCount(0);

  // El resto de tipos no cambian: el resumen sigue siendo una invitación vacía.
  await expect(page.locator('#ai-view-studio .studio-empty [data-act="gen"][data-kind="summary"]')).toBeVisible();
});

test('Studio: clic en la fila de un mazo abre el Modo Estudiar con ese mazo', async ({ page }) => {
  await setupEs(page);
  await seedDecks(page, await currentBookId(page));

  await page.click('.ai-tab[data-view="studio"]');
  const row = flashGroup(page).locator('.studio-card.studio-generated').filter({ hasText: 'Capítulo 1' });
  await row.locator('[data-act="study"]').click();

  const study = page.locator('#ai-study');
  await expect(study).toBeVisible();
  await expect(study.locator('.study-title')).toHaveText('Capítulo 1');
  // El mazo estudiado es el del scope: en la cola entran sus 2 para hoy (nueva + vencida).
  await expect(study.locator('.study-left')).toHaveText('2 pendientes');

  // Cerrar vuelve al Studio con los datos frescos (misma fila).
  await study.locator('.ai-ob-close').click();
  await expect(study).toHaveCount(0);
  await expect(flashGroup(page).locator('.studio-card.studio-generated')).toHaveCount(2);
});

test('Studio: la papelera pide confirmación y borra el mazo de IndexedDB', async ({ page }) => {
  await setupEs(page);
  const bookId = await currentBookId(page);
  await seedDecks(page, bookId);

  await page.click('.ai-tab[data-view="studio"]');
  const rows = flashGroup(page).locator('.studio-card.studio-generated');
  await rows.filter({ hasText: 'Capítulo 1' }).locator('.studio-del').click();

  // Confirmación con mensaje propio (mazo + estado de repaso).
  await expect(page.locator('.dlg-card')).toContainText('estado de repaso');
  await page.locator('.dlg-ok').click();

  // La fila desaparece y el mazo ya no está en IndexedDB (getDecks filtra tombstones).
  await expect(rows).toHaveCount(1);
  await expect(rows.filter({ hasText: 'Capítulo 2' })).toBeVisible();
  const remaining = await page.evaluate(async (bookId: any) => {
    const DB: any = await import('/js/ai/db.js');
    return (await DB.getDecks(bookId)).map((d: any) => d.scope);
  }, bookId);
  expect(remaining).toEqual(['Capítulo 2']);
});

test('Studio: sin mazos, el tile de Flashcards sigue siendo la invitación vacía con «Crear»', async ({ page }) => {
  await setupEs(page);

  await page.click('.ai-tab[data-view="studio"]');
  const group = flashGroup(page);
  await expect(group.locator('.studio-empty')).toBeVisible();
  await expect(group.locator('.studio-empty [data-act="gen"][data-kind="flashcards"]')).toHaveText(/Crear/);
  await expect(group.locator('.studio-new[data-kind="flashcards"]')).toHaveCount(0);
  await expect(group.locator('.studio-card.studio-generated')).toHaveCount(0);
});
