import { test, expect } from '@playwright/test';

// P10 · Modo Estudiar — E2E determinista (sin LLM): siembra un mazo en IndexedDB y un
// libro en la biblioteca, y recorre el bucle completo: chip "Repasar hoy" en la
// estantería → sesión (voltear, evaluar, re-encolado de "otra vez") → persistencia del
// estado SRS tras cada tarjeta → el chip desaparece al no quedar vencidas.

// Siembra: un libro en la estantería (para que el arranque muestre la biblioteca) y un
// mazo con `cards`. Se hace vía los módulos reales (mismo camino que producción).
async function seed(page, cards, extraDeck?: any) {
  await page.evaluate(async ({ cards, extraDeck }) => {
    const DB: any = await import('/js/ai/db.js');
    const Lib: any = await import('/js/library/store.js');
    await Lib.putBook({ id: 'bk-study', title: 'Libro de prueba', addedAt: Date.now(), lastOpenedAt: Date.now() });
    await DB.addDeck({ bookId: 'bk-study', name: 'Libro de prueba', cardType: 'basic', scope: 'Capítulo 1', cards });
    if (extraDeck) await DB.addDeck(extraDeck);
  }, { cards, extraDeck });
}

test('estantería → chip Repasar hoy → sesión completa con persistencia SRS', async ({ page }) => {
  await page.goto('/index.html');
  const today = await page.evaluate(async () => (await import('/js/ai/srs.js') as any).dayOf(Date.now()));
  await seed(page, [
    { type: 'basic', front: '¿Qué es Raft?', back: 'Un algoritmo de consenso.', chapter: '' },
    { type: 'basic', front: '¿Qué es BM25?', back: 'Un ranking léxico.', chapter: '' },
    // Una tarjeta ya agendada a futuro: NO debe entrar en la cola de hoy.
    { type: 'basic', front: 'futura', back: 'no toca', chapter: '', srs: { reps: 3, lapses: 0, ease: 2.5, interval: 10, due: today + 5, lastReview: Date.now() } },
  ]);
  await page.reload();

  // El chip cuenta solo las vencidas (2 de 3).
  const chip = page.locator('.lib-study-chip');
  await expect(chip).toContainText('Repasar hoy · 2');
  await chip.click();

  // Tarjeta 1: frente visible, respuesta oculta hasta voltear.
  const overlay = page.locator('#ai-study');
  await expect(overlay.locator('.study-left')).toHaveText('2 pendientes');
  await expect(overlay.locator('.study-q')).toHaveText('¿Qué es Raft?');
  await expect(overlay.locator('.study-a')).toBeHidden();
  await overlay.locator('.study-flip').click();
  await expect(overlay.locator('.study-a')).toHaveText('Un algoritmo de consenso.');
  await expect(overlay.locator('.study-grade')).toHaveCount(4);
  // Los botones anuncian el intervalo previsto (tarjeta nueva: bien = 1d).
  await expect(overlay.locator('.study-grade.is-good small')).toHaveText('1d');
  await overlay.locator('.study-grade.is-good').click();

  // Tarjeta 2 por teclado: espacio voltea, "1" = otra vez → se re-encola…
  await expect(overlay.locator('.study-q')).toHaveText('¿Qué es BM25?');
  await page.keyboard.press(' ');
  await expect(overlay.locator('.study-a')).toBeVisible();
  await page.keyboard.press('1');
  // …y vuelve a aparecer; esta vez "bien" (tecla 3).
  await expect(overlay.locator('.study-q')).toHaveText('¿Qué es BM25?');
  await page.keyboard.press(' ');
  await page.keyboard.press('3');

  // Fin de sesión: 2 superadas (el "otra vez" no cuenta doble) y la racha arranca (F3).
  await expect(overlay.locator('.study-end h2')).toHaveText('¡Repaso completado!');
  await expect(overlay.locator('.study-end p')).toContainText('2');
  await expect(overlay.locator('.study-streak')).toContainText('Racha de 1 día');
  await overlay.locator('.study-flip').click();
  await expect(overlay).toHaveCount(0);

  // Persistencia: el SRS quedó guardado en IndexedDB (reps ≥ 1, due a futuro; el lapse
  // de "otra vez" quedó registrado) y la futura sigue intacta.
  const decks = await page.evaluate(async () => (await import('/js/ai/db.js') as any).getAllDecks());
  const cards = decks[0].cards;
  expect(cards[0].srs.reps).toBe(1);
  expect(cards[0].srs.due).toBe(today + 1);
  expect(cards[1].srs.reps).toBe(1);
  expect(cards[1].srs.lapses).toBe(1);
  expect(cards[2].srs.due).toBe(today + 5);

  // Sin vencidas → el chip desaparece de la estantería.
  await expect(page.locator('.lib-study-chip')).toHaveCount(0);
});

test('cloze: el frente oculta la respuesta y el volteo la revela resaltada', async ({ page }) => {
  await page.goto('/index.html');
  await seed(page, [
    { type: 'cloze', front: 'Raft elige un {{c1::líder}} por {{c2::mayoría::cómo}}.', back: 'Extra.', chapter: '' },
  ]);
  await page.reload();
  await page.locator('.lib-study-chip').click();

  const overlay = page.locator('#ai-study');
  // Huecos: […] sin pista, [cómo] con pista; la respuesta NO está en el frente.
  await expect(overlay.locator('.study-q')).toHaveText('Raft elige un […] por [cómo].');
  await overlay.locator('.study-flip').click();
  await expect(overlay.locator('.study-a')).toContainText('Raft elige un líder por mayoría.');
  await expect(overlay.locator('.study-a .study-cloze.is-revealed').first()).toHaveText('líder');
  await expect(overlay.locator('.study-extra')).toHaveText('Extra.');
});

test('la cola diaria une mazos y el botón Estudiar del modal muestra el badge de vencidas', async ({ page }) => {
  await page.goto('/index.html');
  await seed(page,
    [{ type: 'basic', front: 'a', back: 'b', chapter: '' }],
    { bookId: 'bk-2', name: 'Otro libro', cardType: 'basic', scope: '', cards: [
      { type: 'basic', front: 'c', back: 'd', chapter: '' },
      { type: 'basic', front: 'e', back: 'f', chapter: '' },
    ] });
  await page.reload();

  // La cola global suma los dos mazos (1 + 2), aunque sean de libros distintos.
  await expect(page.locator('.lib-study-chip')).toContainText('Repasar hoy · 3');
  const due = await page.evaluate(async () => (await import('/js/ai/study.js') as any).dueToday());
  expect(due.cards).toBe(3);
  expect(due.decks.length).toBe(2);
});

// ---- P10 F2 · "Ver en el libro": salto a la fuente vía deep-link del router ----

test('al voltear, "Ver en el libro" abre el libro de origen por deep-link', async ({ page }) => {
  await page.goto('/index.html');
  await page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    const Lib: any = await import('/js/library/store.js');
    // Libro REAL en la biblioteca (el deep-link tiene que poder abrirlo de cero).
    const buf = await (await fetch('/tests/test.epub')).arrayBuffer();
    await Lib.putBook({
      id: 'bk-src', title: 'Libro fuente', format: 'epub', fileName: 'test.epub',
      file: buf, size: buf.byteLength, addedAt: Date.now(), lastOpenedAt: Date.now(),
      progress: 0, status: 'unread', shelfIds: [],
    });
    // Ancla de origen y mazo cuya tarjeta la referencia.
    await DB.put('anchors', { bookId: 'bk-src', entries: [['a7', { cfi: null, href: 'cap1.xhtml', chapter: 'I' }]] });
    await DB.addDeck({
      bookId: 'bk-src', name: 'Libro fuente', cardType: 'basic', scope: '',
      cards: [
        { type: 'basic', front: 'con fuente', back: 'r', chapter: 'I', src: 'a7' },
        { type: 'basic', front: 'sin fuente', back: 'r', chapter: '' },
      ],
    });
  });
  await page.reload();
  await page.locator('.lib-study-chip').click();

  const overlay = page.locator('#ai-study');
  await overlay.locator('.study-flip').click();
  await expect(overlay.locator('.study-src')).toBeVisible();
  await overlay.locator('.study-src').click();

  // El overlay se cierra y el router abre el libro en modo lectura con la ruta correcta.
  await expect(overlay).toHaveCount(0);
  await expect(page.locator('body')).toHaveClass(/reading/, { timeout: 20000 });
  expect(page.url()).toContain('book=bk-src');

  // La tarjeta SIN src no ofrece el salto. (La primera sigue vencida: saltar al libro
  // no la evalúa; se supera con "bien" para llegar a la segunda.)
  await page.evaluate(async () => (await import('/js/ai/study.js') as any).openToday());
  const again = page.locator('#ai-study');
  await expect(again.locator('.study-q')).toHaveText('con fuente');
  await page.keyboard.press(' ');
  await page.keyboard.press('3');
  await expect(again.locator('.study-q')).toHaveText('sin fuente');
  await again.locator('.study-flip').click();
  await expect(again.locator('.study-src')).toHaveCount(0);
});
