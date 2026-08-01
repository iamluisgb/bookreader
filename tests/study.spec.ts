import { test, expect } from '@playwright/test';
import { seedProLicense } from './pro-license';
import fs from 'fs';
import path from 'path';

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
  await seedProLicense(page);   // features Pro gateadas (MON2): el test ejercita la feature
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

  // Tarjeta 1: frente visible, respuesta oculta hasta voltear. CUÁL sale primero es
  // aleatorio desde P24 (la cola se baraja), así que el test se guía por lo que hay en
  // pantalla en vez de por el orden del mazo.
  const ANSWERS = { '¿Qué es Raft?': 'Un algoritmo de consenso.', '¿Qué es BM25?': 'Un ranking léxico.' };
  const overlay = page.locator('#ai-study');
  await expect(overlay.locator('.study-left')).toHaveText('2 pendientes');
  const first = (await overlay.locator('.study-q').textContent())!.trim();
  expect(Object.keys(ANSWERS)).toContain(first);
  await expect(overlay.locator('.study-a')).toBeHidden();
  await overlay.locator('.study-flip').click();
  await expect(overlay.locator('.study-a')).toHaveText(ANSWERS[first]);
  await expect(overlay.locator('.study-grade')).toHaveCount(4);
  // Los botones anuncian el intervalo previsto (tarjeta nueva: bien = 1d).
  await expect(overlay.locator('.study-grade.is-good small')).toHaveText('1d');
  await overlay.locator('.study-grade.is-good').click();

  // Tarjeta 2 por teclado: espacio voltea, "1" = otra vez → se re-encola…
  const second = (await overlay.locator('.study-q').textContent())!.trim();
  expect(second).not.toBe(first);
  await page.keyboard.press(' ');
  await expect(overlay.locator('.study-a')).toBeVisible();
  await page.keyboard.press('1');
  // …y vuelve a aparecer; esta vez "bien" (tecla 3).
  await expect(overlay.locator('.study-q')).toHaveText(second);
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
  const byFront = Object.fromEntries(decks[0].cards.map((c: any) => [c.front, c]));
  expect(byFront[first].srs.reps).toBe(1);
  expect(byFront[first].srs.due).toBe(today + 1);
  expect(byFront[second].srs.reps).toBe(1);
  expect(byFront[second].srs.lapses).toBe(1);
  expect(byFront['futura'].srs.due).toBe(today + 5);

  // Sin vencidas → el chip desaparece de la estantería.
  await expect(page.locator('.lib-study-chip')).toHaveCount(0);
});

test('cloze: el frente oculta la respuesta y el volteo la revela resaltada', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);   // features Pro gateadas (MON2): el test ejercita la feature
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
  await seedProLicense(page);   // features Pro gateadas (MON2): el test ejercita la feature
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
  // El fixture se inyecta desde Node (el server sirve app/, no la carpeta tests/).
  const epubBytes = Array.from(fs.readFileSync(path.join(__dirname, 'test.epub')));
  await page.goto('/index.html');
  await seedProLicense(page);   // features Pro gateadas (MON2): el test ejercita la feature
  await page.evaluate(async (bytes) => {
    const DB: any = await import('/js/ai/db.js');
    const Lib: any = await import('/js/library/store.js');
    // Libro REAL en la biblioteca (el deep-link tiene que poder abrirlo de cero).
    const buf = new Uint8Array(bytes).buffer;
    await Lib.putBook({
      id: 'bk-src', title: 'Libro fuente', format: 'epub', fileName: 'test.epub',
      file: buf, size: buf.byteLength, addedAt: Date.now(), lastOpenedAt: Date.now(),
      progress: 0, status: 'unread', shelfIds: [],
    });
    // Ancla de origen y mazo cuya tarjeta la referencia.
    await DB.put('anchors', { bookId: 'bk-src', entries: [['a7', { cfi: null, href: 'cap1.xhtml', chapter: 'I' }]] });
    await DB.addDeck({
      bookId: 'bk-src', name: 'Libro fuente', cardType: 'basic', scope: '',
      // Una sola tarjeta: la cola se baraja (P24), así que un mazo de dos no garantiza
      // cuál sale primero. La tarjeta SIN fuente tiene su propio test más abajo.
      cards: [{ type: 'basic', front: 'con fuente', back: 'r', chapter: 'I', src: 'a7' }],
    });
  }, epubBytes);
  await page.reload();
  await page.locator('.lib-study-chip').click();

  const overlay = page.locator('#ai-study');
  await overlay.locator('.study-flip').click();
  await expect(overlay.locator('.study-src')).toBeVisible();
  await overlay.locator('.study-src').click();

  // El overlay se APARTA (F2: minimizar, no cerrar) y el router abre el libro en modo
  // lectura con la ruta correcta. Antes se cerraba, y con él se perdían la cola y el
  // contador: releer una frase obligaba a reiniciar el repaso entero.
  await expect(overlay).toBeHidden();
  await expect(page.locator('body')).toHaveClass(/reading/, { timeout: 20000 });
  expect(page.url()).toContain('book=bk-src');

  // El chip de vuelta trae la sesión de vuelta donde estaba, con su tarjeta ya volteada.
  const chip = page.locator('.ai-taskchip.is-study');
  await expect(chip).toContainText('Volver al repaso');
  await chip.click();
  await expect(overlay).toBeVisible();
  await expect(overlay.locator('.study-a')).toBeVisible();
  await expect(chip).toHaveCount(0);
  await overlay.locator('.ai-ob-close').click();
});

test('una tarjeta sin fuente no ofrece el salto al libro', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await seed(page, [{ type: 'basic', front: 'sin fuente', back: 'r', chapter: '' }]);
  await page.reload();
  await page.locator('.lib-study-chip').click();
  const overlay = page.locator('#ai-study');
  await overlay.locator('.study-flip').click();
  await expect(overlay.locator('.study-a')).toBeVisible();
  await expect(overlay.locator('.study-src')).toHaveCount(0);
});

// ---- P20 F3 · El pasaje citado, dentro de la tarjeta ------------------------------

test('al voltear se ve el pasaje del libro que respalda la tarjeta', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    // El pasaje sale del libro SEGMENTADO, no de Retrieval: la cola diaria cruza libros
    // y ninguno tiene por qué estar abierto ni indexado.
    await DB.put('bookText', {
      bookId: 'bk-q', segVersion: 5, blockCount: 2, tokenEstimate: 20,
      annotatedText: '## I\n[[a1]] Vine a Comala porque me dijeron que acá vivía mi padre.\n[[a2]] Otro pasaje.',
    });
    await DB.addDeck({
      bookId: 'bk-q', name: 'Con cita', cardType: 'basic', scope: '',
      cards: [{ type: 'basic', front: '¿Por qué va a Comala?', back: 'Por su padre', chapter: 'I', src: 'a1' }],
    });
  });
  await page.evaluate(async () => (await import('/js/ai/study.js') as any).openToday());
  const overlay = page.locator('#ai-study');
  await overlay.locator('.study-flip').click();
  const quote = overlay.locator('.study-passage');
  await expect(quote).toContainText('Vine a Comala');
  await expect(quote).toContainText('I');            // el capítulo, como cabecera de la cita
  // El salto al libro sigue estando, pero ya como secundario.
  await expect(overlay.locator('.study-src')).toBeVisible();
});

test('sin libro segmentado no se inventa cita ni se rompe el volteo', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    await DB.addDeck({
      bookId: 'bk-sin', name: 'Sin texto', cardType: 'basic', scope: '',
      cards: [{ type: 'basic', front: 'p', back: 'r', src: 'a9' }],
    });
  });
  await page.evaluate(async () => (await import('/js/ai/study.js') as any).openToday());
  const overlay = page.locator('#ai-study');
  await overlay.locator('.study-flip').click();
  await expect(overlay.locator('.study-a')).toContainText('r');
  await expect(overlay.locator('.study-passage')).toHaveCount(0);
});

// ---- P24 F2/F3 · Deshacer y arreglar la tarjeta sin salir de la sesión -----------

test('deshacer devuelve la tarjeta a la cola y su estado SRS anterior', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await seed(page, [{ type: 'basic', front: 'única', back: 'r', chapter: '' }]);
  await page.reload();
  await page.locator('.lib-study-chip').click();

  const overlay = page.locator('#ai-study');
  // Nada que deshacer todavía: el botón no está.
  await expect(overlay.locator('.study-tools [data-act="undo"]')).toHaveCount(0);
  await overlay.locator('.study-flip').click();
  await overlay.locator('.study-grade.is-easy').click();          // "fácil" por error: se va a meses
  await expect(overlay.locator('.study-end h2')).toBeVisible();

  await overlay.locator('.study-tools [data-act="undo"]').click();
  // Vuelve a estar en la cola y VUELVE A SER NUEVA (el srs se borra, no se "des-agenda").
  await expect(overlay.locator('.study-q')).toHaveText('única');
  await expect(overlay.locator('.study-left')).toHaveText('1 pendiente');
  const card = await page.evaluate(async () => {
    const decks = await (await import('/js/ai/db.js') as any).getAllDecks();
    return decks[0].cards[0];
  });
  expect(card.srs).toBeUndefined();

  // Y ahora la nota correcta, que sí se persiste.
  await overlay.locator('.study-flip').click();
  await overlay.locator('.study-grade.is-again').click();
  const after = await page.evaluate(async () => {
    const decks = await (await import('/js/ai/db.js') as any).getAllDecks();
    return decks[0].cards[0].srs;
  });
  expect(after.lapses).toBe(1);
});

test('editar, suspender y borrar la tarjeta durante el repaso', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await seed(page, [
    { type: 'basic', front: 'mala', back: 'r', chapter: '' },
    { type: 'basic', front: 'peor', back: 'r', chapter: '' },
    { type: 'basic', front: 'tercera', back: 'r', chapter: '' },
  ]);
  await page.reload();
  await page.locator('.lib-study-chip').click();
  const overlay = page.locator('#ai-study');

  // 1) Editar: se corrige el frente sin salir y la tarjeta sigue en la cola.
  const primera = (await overlay.locator('.study-q').textContent())!.trim();
  await overlay.locator('.study-tools [data-act="edit"]').click();
  await overlay.locator('.study-edit-f').fill('corregida');
  await overlay.locator('.study-edit-save').click();
  await expect(overlay.locator('.study-q')).toHaveText('corregida');
  await expect(overlay.locator('.study-left')).toHaveText('3 pendientes');

  // 2) Suspender: sale de la cola en el acto (quedan 2).
  await overlay.locator('.study-tools [data-act="suspend"]').click();
  await expect(overlay.locator('.study-left')).toHaveText('2 pendientes');
  await expect(overlay.locator('.study-q')).not.toHaveText('corregida');

  // 3) Borrar: pide confirmación y deja la cola en 1.
  const segunda = (await overlay.locator('.study-q').textContent())!.trim();
  await overlay.locator('.study-tools [data-act="delete"]').click();
  await page.locator('.dlg-ok').click();
  await expect(overlay.locator('.study-left')).toHaveText('1 pendiente');

  // Persistencia: la editada guarda su texto y su suspensión; la borrada es tombstone.
  const cards = await page.evaluate(async () => {
    const decks = await (await import('/js/ai/db.js') as any).getAllDecks();
    return decks[0].cards;
  });
  const editada = cards.find((c: any) => c.front === 'corregida');
  expect(editada.suspended).toBe(true);
  expect(cards.find((c: any) => c.front === primera)).toBeUndefined();   // ya no existe con el viejo
  expect(cards.find((c: any) => c.front === segunda)).toBeUndefined();   // borrada
  expect(cards.filter((c: any) => c.deleted).length).toBe(1);

  // La suspendida se puede reactivar desde la revisión del mazo (no es un viaje de ida).
  await overlay.locator('.ai-ob-close').click();
  await page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    const Fc: any = await import('/js/ai/flashcards.js');
    Fc.open({ bookId: 'bk-study', bookTitle: 'Libro de prueba', goal: '', tocLabels: [], ensureIndex: () => {} });
    await new Promise(r => setTimeout(r, 50));
    const deck = (await DB.getDecks('bk-study'))[0];
    return deck.id;
  });
  await page.locator('.fc-deck [data-act="review"]').click();
  await expect(page.locator('.fc-item.is-suspended')).toHaveCount(1);
  await page.locator('.fc-item.is-suspended .fc-susp').click();
  await expect(page.locator('.fc-item.is-suspended')).toHaveCount(0);
});
