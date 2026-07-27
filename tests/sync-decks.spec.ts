// Sync de los mazos de flashcards y de su estado de repaso.
//
// El caso real: preparas el libro en el PC y repasas en el móvil esperando el bus. Eso
// obliga a más que "mover el registro": el estado SRS vive DENTRO de cada tarjeta, así
// que un LWW a nivel de mazo tiraría los repasos del otro dispositivo. El merge va
// tarjeta a tarjeta (ver db.js · mergeDecks).
import { test, expect, BrowserContext, Page } from '@playwright/test';
import { installDriveMocks, seedDriveToken, createDriveState, DriveState } from './drive-mock';

const BOOK = 'f'.repeat(64);

async function bootDevice(context: BrowserContext, state: DriveState): Promise<Page> {
  await installDriveMocks(context, state);
  await seedDriveToken(context);
  const page = await context.newPage();
  await page.goto('/');
  return page;
}

async function registerBook(page: Page, id: string, title: string) {
  await page.evaluate(async ({ id, title }) => {
    const Lib = await import('/js/library/store.js');
    await Lib.putBook({ id, title, addedAt: Date.now() });
  }, { id, title });
}

async function addDeck(page: Page, bookId: string, fronts: string[]) {
  return page.evaluate(async ({ bookId, fronts }) => {
    const DB = await import('/js/ai/db.js');
    return DB.addDeck({
      bookId, name: 'Mazo', cardType: 'basic', scope: 'Capítulo 1',
      cards: fronts.map((f, i) => ({ front: f, back: 'r' + i, type: 'basic', chapter: 'c1' })),
    });
  }, { bookId, fronts });
}

// Repasa la primera tarjeta vencida del mazo con la nota dada, como hace study.js:
// califica, escribe el array COMPLETO y persiste.
async function study(page: Page, deckId: number, rating: string, front?: string) {
  await page.evaluate(async ({ deckId, rating, front }) => {
    const DB: any = await import('/js/ai/db.js');
    const Srs: any = await import('/js/ai/srs.js');
    const deck = (await DB.getAllDecks()).find((d: any) => d.id === deckId);
    const idx = deck.cards.findIndex((c: any) => (front ? c.front === front : Srs.isDue(c)));
    deck.cards[idx] = { ...deck.cards[idx], srs: Srs.grade(deck.cards[idx].srs, rating) };
    await DB.updateDeck(deckId, { cards: deck.cards });
  }, { deckId, rating, front });
}

async function decksOf(page: Page) {
  return page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    return (await DB.getAllDecks()).map((d: any) => ({
      id: d.id, name: d.name,
      cards: DB.cardsOf(d).map((c: any) => ({ front: c.front, back: c.back, reps: c.srs?.reps ?? null })),
    }));
  });
}

async function sync(page: Page) {
  await page.evaluate(async () => {
    const Engine = await import('/js/sync/engine.js');
    await Engine.syncNow();
  });
}

test.describe('Sync de mazos · dos dispositivos', () => {
  test('el mazo generado en el PC se puede estudiar en el móvil, y el repaso vuelve', async ({ browser }) => {
    test.setTimeout(120000);
    const state = createDriveState();
    const pc = await browser.newContext();
    const movil = await browser.newContext();
    const pcPage = await bootDevice(pc, state);
    const movilPage = await bootDevice(movil, state);

    await registerBook(pcPage, BOOK, 'Build a Large Language Model');
    await addDeck(pcPage, BOOK, ['¿Qué es un token?', '¿Qué es la atención?']);
    await sync(pcPage);

    // El móvil recibe el mazo entero, con sus tarjetas.
    await sync(movilPage);
    const enMovil = await decksOf(movilPage);
    expect(enMovil).toHaveLength(1);
    expect(enMovil[0].cards.map(c => c.front)).toEqual(['¿Qué es un token?', '¿Qué es la atención?']);

    // Se estudia EN EL MÓVIL…
    await study(movilPage, enMovil[0].id, 'good', '¿Qué es un token?');
    await sync(movilPage);

    // …y el PC ve el repaso (no vuelve a ofrecer la tarjeta como nueva).
    await sync(pcPage);
    const enPc = await decksOf(pcPage);
    const token = enPc[0].cards.find(c => c.front === '¿Qué es un token?');
    expect(token!.reps).toBe(1);

    await pc.close();
    await movil.close();
  });

  test('repasar en el móvil y editar en el PC: no se pierde ninguno de los dos', async ({ browser }) => {
    // Es el conflicto que hace insuficiente un LWW por mazo: los dos lados tocan el
    // MISMO registro, y el ganador se llevaría por delante el trabajo del otro.
    test.setTimeout(120000);
    const state = createDriveState();
    const pc = await browser.newContext();
    const movil = await browser.newContext();
    const pcPage = await bootDevice(pc, state);
    const movilPage = await bootDevice(movil, state);

    await registerBook(pcPage, BOOK, 'Libro');
    const deckId = await addDeck(pcPage, BOOK, ['A', 'B']);
    await sync(pcPage);
    await sync(movilPage);
    const movilDeckId = (await decksOf(movilPage))[0].id;

    // El móvil repasa "A" (sin sincronizar todavía: va en el bus).
    await study(movilPage, movilDeckId, 'good', 'A');
    // El PC, mientras, corrige el reverso de "B".
    await pcPage.evaluate(async ({ deckId }) => {
      const DB: any = await import('/js/ai/db.js');
      const deck = (await DB.getAllDecks()).find((d: any) => d.id === deckId);
      deck.cards = deck.cards.map((c: any) => (c.front === 'B' ? { ...c, back: 'reverso corregido' } : c));
      await DB.updateDeck(deckId, { cards: deck.cards });
    }, { deckId });

    await sync(pcPage);
    await sync(movilPage);
    await sync(pcPage);

    for (const page of [pcPage, movilPage]) {
      const cards = (await decksOf(page))[0].cards;
      expect(cards.find(c => c.front === 'A')!.reps, 'el repaso del móvil sobrevive').toBe(1);
      expect(cards.find(c => c.front === 'B')!.back, 'la edición del PC sobrevive').toBe('reverso corregido');
    }

    await pc.close();
    await movil.close();
  });

  test('borrar un mazo no lo resucita el otro dispositivo', async ({ browser }) => {
    test.setTimeout(120000);
    const state = createDriveState();
    const pc = await browser.newContext();
    const movil = await browser.newContext();
    const pcPage = await bootDevice(pc, state);
    const movilPage = await bootDevice(movil, state);

    await registerBook(pcPage, BOOK, 'Libro');
    const deckId = await addDeck(pcPage, BOOK, ['A']);
    await sync(pcPage);
    await sync(movilPage);
    expect(await decksOf(movilPage)).toHaveLength(1);

    await pcPage.evaluate(async (id) => {
      const DB: any = await import('/js/ai/db.js');
      await DB.deleteDeck(id);
    }, deckId);
    await sync(pcPage);
    await sync(movilPage);
    expect(await decksOf(movilPage)).toHaveLength(0);

    await sync(pcPage);
    expect(await decksOf(pcPage), 'ni vuelve en el ciclo siguiente').toHaveLength(0);

    await pc.close();
    await movil.close();
  });

  test('quitar una tarjeta del mazo tampoco la resucita', async ({ browser }) => {
    test.setTimeout(120000);
    const state = createDriveState();
    const pc = await browser.newContext();
    const movil = await browser.newContext();
    const pcPage = await bootDevice(pc, state);
    const movilPage = await bootDevice(movil, state);

    await registerBook(pcPage, BOOK, 'Libro');
    const deckId = await addDeck(pcPage, BOOK, ['A', 'B']);
    await sync(pcPage);
    await sync(movilPage);

    // El editor de flashcards quita una fila → updateDeck recibe la lista sin ella.
    await pcPage.evaluate(async ({ deckId }) => {
      const DB: any = await import('/js/ai/db.js');
      const deck = (await DB.getAllDecks()).find((d: any) => d.id === deckId);
      await DB.updateDeck(deckId, { cards: deck.cards.filter((c: any) => c.front !== 'B') });
    }, { deckId });
    await sync(pcPage);
    await sync(movilPage);

    expect((await decksOf(movilPage))[0].cards.map(c => c.front)).toEqual(['A']);
    await sync(pcPage);
    expect((await decksOf(pcPage))[0].cards.map(c => c.front)).toEqual(['A']);

    await pc.close();
    await movil.close();
  });

  test('una vez convergidos, sincronizar no vuelve a escribir nada', async ({ browser }) => {
    // El push ya no depende solo del updatedAt: también de un digest del contenido.
    // El riesgo evidente de eso es el bucle —cada dispositivo "corrigiendo" al otro sin
    // que nada cambie—, y con los mazos hay dos motivos para que pase: el id
    // autoincremental (distinto en cada equipo) y el orden de las tarjetas tras fusionar.
    test.setTimeout(120000);
    const state = createDriveState();
    const pc = await browser.newContext();
    const movil = await browser.newContext();
    const pcPage = await bootDevice(pc, state);
    const movilPage = await bootDevice(movil, state);

    await registerBook(pcPage, BOOK, 'Libro');
    const deckId = await addDeck(pcPage, BOOK, ['A', 'B', 'C']);
    await sync(pcPage);
    await sync(movilPage);
    await study(movilPage, (await decksOf(movilPage))[0].id, 'good', 'B');
    await sync(movilPage);
    await sync(pcPage);
    await study(pcPage, deckId, 'easy', 'C');
    await sync(pcPage);
    await sync(movilPage);
    await sync(pcPage);

    const versiones = () => [...state.store.entries()].map(([n, f]) => `${n}:${f.version}`).sort();
    const antes = versiones();
    for (let i = 0; i < 3; i++) { await sync(pcPage); await sync(movilPage); }
    expect(versiones(), 'seis ciclos más no deben escribir ni un byte').toEqual(antes);

    await pc.close();
    await movil.close();
  });

  test('la racha de estudio avanza aunque se repase en el otro dispositivo', async ({ browser }) => {
    test.setTimeout(120000);
    const state = createDriveState();
    const pc = await browser.newContext();
    const movil = await browser.newContext();
    const pcPage = await bootDevice(pc, state);
    const movilPage = await bootDevice(movil, state);

    await registerBook(pcPage, BOOK, 'Libro');
    await addDeck(pcPage, BOOK, ['A']);
    // El PC tiene una racha vieja; el móvil repasa hoy.
    await pcPage.evaluate(async () => {
      const S: any = await import('/js/storage.js');
      S.set('study_streak', { count: 3, lastDay: 19000 });
    });
    await movilPage.evaluate(async () => {
      const S: any = await import('/js/storage.js');
      const Srs: any = await import('/js/ai/srs.js');
      S.set('study_streak', Srs.bumpStreak({ count: 3, lastDay: Srs.dayOf(Date.now()) - 1 }));
    });
    await sync(movilPage);
    await sync(pcPage);

    const enPc = await pcPage.evaluate(async () => {
      const S: any = await import('/js/storage.js');
      const Srs: any = await import('/js/ai/srs.js');
      return Srs.currentStreak(S.get('study_streak'));
    });
    expect(enPc).toBe(4);

    await pc.close();
    await movil.close();
  });
});

test.describe('unidades del merge de mazos', () => {
  const base = {
    uid: 'deck-1', id: 7, bookId: 'b', name: 'Mazo', cardType: 'basic',
    createdAt: 1000, updatedAt: 1000,
    cards: [{ uid: 'c1', front: 'A', back: 'a', updatedAt: 1000 }],
  };

  test('las tarjetas se fusionan aunque el mazo pierda el LWW', async ({ page }) => {
    await page.goto('/');
    const out = await page.evaluate(async (base) => {
      const DB: any = await import('/js/ai/db.js');
      // El local es MÁS NUEVO a nivel de mazo, pero el remoto trae una tarjeta que él
      // no tiene y un repaso más reciente de la que comparten.
      const local = { ...base, updatedAt: 5000, name: 'Renombrado' };
      const remote = {
        ...base, updatedAt: 2000,
        cards: [
          { uid: 'c1', front: 'A', back: 'a', srs: { reps: 2 }, updatedAt: 4000 },
          { uid: 'c2', front: 'B', back: 'b', updatedAt: 2000 },
        ],
      };
      const m = DB.mergeDeckPair(local, remote);
      return { name: m.name, cards: m.cards.map((c: any) => ({ uid: c.uid, reps: c.srs?.reps ?? null })) };
    }, base);
    expect(out.name).toBe('Renombrado');                       // metadatos: gana el local
    expect(out.cards).toEqual([{ uid: 'c1', reps: 2 }, { uid: 'c2', reps: null }]);
  });

  test('el repaso más viejo no pisa al más nuevo', async ({ page }) => {
    await page.goto('/');
    const reps = await page.evaluate(async (base) => {
      const DB: any = await import('/js/ai/db.js');
      const local = { ...base, cards: [{ uid: 'c1', front: 'A', srs: { reps: 5 }, updatedAt: 9000 }] };
      const remote = { ...base, updatedAt: 9999, cards: [{ uid: 'c1', front: 'A', srs: { reps: 1 }, updatedAt: 3000 }] };
      return DB.mergeDeckPair(local, remote)?.cards[0].srs.reps ?? null;
    }, base);
    expect(reps).toBe(5);
  });

  test('el tombstone de tarjeta gana el empate de updatedAt', async ({ page }) => {
    await page.goto('/');
    const deleted = await page.evaluate(async (base) => {
      const DB: any = await import('/js/ai/db.js');
      const remote = { ...base, cards: [{ uid: 'c1', front: '', deleted: true, deletedAt: 1000, updatedAt: 1000 }] };
      return DB.mergeDeckPair(base, remote)?.cards[0].deleted;
    }, base);
    expect(deleted).toBe(true);
  });

  test('un remoto que no aporta nada no genera escritura (no rebota el sync)', async ({ page }) => {
    await page.goto('/');
    const nulo = await page.evaluate(async (base) => {
      const DB: any = await import('/js/ai/db.js');
      return DB.mergeDeckPair(base, JSON.parse(JSON.stringify(base))) === null;
    }, base);
    expect(nulo).toBe(true);
  });

  test('mergeDecks es idempotente y conserva el id local', async ({ page }) => {
    await page.goto('/');
    const out = await page.evaluate(async (base) => {
      const DB: any = await import('/js/ai/db.js');
      const id = await DB.addDeck({ bookId: 'mm', name: 'Local', cardType: 'basic', cards: [{ front: 'A' }] });
      const local = (await DB.getAll('decks')).find((d: any) => d.id === id);
      const remote = { ...local, id: 999, updatedAt: local.updatedAt + 1, name: 'Remoto' };
      await DB.mergeDecks([remote]);
      await DB.mergeDecks([remote]);
      const all = (await DB.getAll('decks')).filter((d: any) => d.bookId === 'mm');
      return { n: all.length, id: all[0].id, name: all[0].name, mismo: all[0].id === id };
    }, base);
    expect(out.n).toBe(1);
    expect(out.mismo).toBe(true);
    expect(out.name).toBe('Remoto');
  });

  test('generar un mazo avisa al SyncEngine (dispara el push)', async ({ page }) => {
    await page.goto('/');
    const fired = await page.evaluate(async () => {
      const DB: any = await import('/js/ai/db.js');
      let n = 0;
      window.addEventListener('bookreader:data-changed', () => { n++; });
      await DB.addDeck({ bookId: 'nn', name: 'X', cardType: 'basic', cards: [{ front: 'A' }] });
      await new Promise((r) => setTimeout(r, 50));
      return n;
    });
    expect(fired).toBeGreaterThan(0);
  });

  test('backfill: los mazos previos reciben uid por tarjeta', async ({ page }) => {
    await page.goto('/');
    const out = await page.evaluate(async () => {
      const DB: any = await import('/js/ai/db.js');
      // Mazo "antiguo": sin uid de tarjeta (como los que ya existen en disco).
      await DB.put('decks', { bookId: 'old', name: 'Viejo', createdAt: 1, cards: [{ front: 'A' }, { front: 'B' }] });
      await DB.backfillSyncFields();
      const d = (await DB.getAll('decks')).find((x: any) => x.bookId === 'old');
      return { deckUid: !!d.uid, uids: d.cards.map((c: any) => !!c.uid), sellos: d.cards.every((c: any) => c.updatedAt > 0) };
    });
    expect(out.deckUid).toBe(true);
    expect(out.uids).toEqual([true, true]);
    expect(out.sellos).toBe(true);
  });

  test('purga: la tarjeta borrada hace 40 días desaparece; la de ayer se queda', async ({ page }) => {
    await page.goto('/');
    const fronts = await page.evaluate(async () => {
      const DB: any = await import('/js/ai/db.js');
      const now = Date.now();
      const dia = 86400000;
      await DB.put('decks', { bookId: 'pp', uid: 'p1', name: 'P', createdAt: 1, updatedAt: now, cards: [
        { uid: 'v', front: 'viva', updatedAt: now },
        { uid: 'x', front: '', deleted: true, deletedAt: now - 40 * dia, updatedAt: now - 40 * dia },
        { uid: 'y', front: '', deleted: true, deletedAt: now - dia, updatedAt: now - dia },
      ] });
      await DB.purgeDeletedDecks(now - 30 * dia);
      const d = (await DB.getAll('decks')).find((x: any) => x.bookId === 'pp');
      return d.cards.map((c: any) => c.uid);
    });
    expect(fronts).toEqual(['v', 'y']);
  });
});
