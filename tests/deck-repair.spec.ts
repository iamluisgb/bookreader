import { test, expect } from '@playwright/test';
import { seedProLicense } from './pro-license';

// WU1 · Reparación de identidad de mazos (feature "gestor de mazos").
//
// El problema: un mazo guarda el bookId con el que se creó y nunca lo
// actualizaba. La biblioteca migra identidades (hash de fichero, alias
// canónico tras re-descargar el libro) y reconcile() solo remapeaba
// subrayados y marcadores → mazos huérfanos: sus vencidas contaban en el
// total de repaso pero ninguna fila los alcanzaba. Síntoma real: borrar un
// libro y volver a descargarlo dejaba sus tarjetas sin dueño visible.

const HASH_A = 'a'.repeat(64);   // id canónico realista (64 hex, como producción)
const HASH_B = 'b'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HASH_E = 'e'.repeat(64);

async function seedBook(page: any, id: string, title: string) {
  await page.evaluate(async ({ id, title }) => {
    const Lib: any = await import('/js/library/store.js');
    await Lib.putBook({ id, title, format: 'pdf', shelfIds: [], addedAt: Date.now() });
  }, { id, title });
}

async function seedDeck(page: any, bookId: string, name: string) {
  return page.evaluate(async ({ bookId, name }) => {
    const DB: any = await import('/js/ai/db.js');
    return DB.addDeck({
      bookId, name, cardType: 'basic', scope: '',
      cards: [{ front: 'q', back: 'a', type: 'basic', chapter: 'c1' }],
    });
  }, { bookId, name });
}

async function decksOf(page: any) {
  return page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    return (await DB.getAllDecks()).map((d: any) => ({ id: d.id, bookId: d.bookId, name: d.name, updatedAt: d.updatedAt }));
  });
}

test.describe('Reparación de identidad de mazos', () => {
  test('matchDecksByTitle: huérfano con título único se propone; ambiguo, sin libro y con libro no', async ({ page }) => {
    await page.goto('/index.html');
    await seedProLicense(page);
    const res = await page.evaluate(async ({ HASH_A, HASH_B, HASH_D, HASH_E }) => {
      const DR: any = await import('/js/ai/deck-repair.js');
      const S: any = await import('/js/storage.js');
      const decks = [
        { id: 1, uid: 'u1', bookId: 'clean-code.epub', name: 'Clean Code', scope: '' },      // huérfano, título único
        { id: 2, uid: 'u2', bookId: 'ghost.epub', name: 'Pragmatic Programmer', scope: '' }, // huérfano sin libro
        { id: 3, uid: 'u3', bookId: 'dup.epub', name: 'Título Duplicado', scope: '' },       // ambiguo: no se adivina
        { id: 4, uid: 'u4', bookId: HASH_B, name: 'Clean Code', scope: '' },                 // su libro existe por id
        { id: 5, uid: 'u5', bookId: 'alias.epub', name: 'Clean Code', scope: '' },           // su libro existe por alias
        { id: 6, uid: 'u6', bookId: 'otro.epub', name: 'CLEAN CÖDE (z-lib.org)', scope: '' },// tildes/mayúsculas/mirror
        null, {}, { name: 'sin id' },                    // malformados: se ignoran, nunca lanza
      ];
      const books = [
        { id: HASH_A, title: 'Clean Code' },
        { id: HASH_D, title: 'Título Duplicado' },
        { id: HASH_E, title: 'Título Duplicado' },       // mismo título que HASH_D → ambiguo
        { id: HASH_B, title: 'Otro libro' },
      ];
      S.set('book_aliases', { 'alias.epub': HASH_B });   // deck 5: existe por la cadena de alias
      let proposals;
      try {
        proposals = DR.matchDecksByTitle(decks, books);
      } finally {
        S.remove('book_aliases');
      }
      return proposals;
    }, { HASH_A, HASH_B, HASH_D, HASH_E });
    // Solo los huérfanos con UN único candidato: 1 (título único) y 6 (normalización).
    expect(res).toEqual([
      { deckId: 1, uid: 'u1', bookId: HASH_A, from: 'clean-code.epub', name: 'Clean Code' },
      { deckId: 6, uid: 'u6', bookId: HASH_A, from: 'otro.epub', name: 'CLEAN CÖDE (z-lib.org)' },
    ]);
  });

  test('repairOrphanDecks reasigna el huérfano y es idempotente (no re-sella updatedAt)', async ({ page }) => {
    await page.goto('/index.html');
    await seedProLicense(page);
    await seedBook(page, HASH_A, 'Clean Code');
    await seedDeck(page, 'clean-code.epub', 'Clean Code');

    const first = await page.evaluate(async () => {
      const DR: any = await import('/js/ai/deck-repair.js');
      return DR.repairOrphanDecks();
    });
    expect(first.repaired).toHaveLength(1);
    expect(first.repaired[0]).toMatchObject({ name: 'Clean Code', bookId: HASH_A });
    expect(first.skipped).toBe(0);
    expect(first.orphans).toBe(1);

    let decks = await decksOf(page);
    expect(decks).toHaveLength(1);
    expect(decks[0].bookId).toBe(HASH_A);
    const stampedAt = decks[0].updatedAt;

    // Segunda pasada: ya no hay huérfanos y no se toca nada.
    const second = await page.evaluate(async () => {
      const DR: any = await import('/js/ai/deck-repair.js');
      return DR.repairOrphanDecks();
    });
    expect(second).toEqual({ repaired: [], skipped: 0, orphans: 0 });
    decks = await decksOf(page);
    expect(decks[0].updatedAt).toBe(stampedAt);
  });

  test('título ambiguo: el mazo NO se mueve y cuenta como skipped', async ({ page }) => {
    await page.goto('/index.html');
    await seedProLicense(page);
    await seedBook(page, HASH_A, 'Clean Code');
    await seedBook(page, HASH_B, 'Clean Code');   // dos libros, mismo título
    await seedDeck(page, 'clean-code.epub', 'Clean Code');

    const res = await page.evaluate(async () => {
      const DR: any = await import('/js/ai/deck-repair.js');
      return DR.repairOrphanDecks();
    });
    expect(res.repaired).toEqual([]);
    expect(res.skipped).toBe(1);
    expect(res.orphans).toBe(1);
    const decks = await decksOf(page);
    expect(decks[0].bookId).toBe('clean-code.epub');   // intacto: decidirlo es del usuario
  });

  test('reconcile: el mazo guardado bajo el id que se vuelve alias pasa al canónico', async ({ page }) => {
    await page.goto('/index.html');
    await seedProLicense(page);
    await seedDeck(page, HASH_B, 'Mismo Título');   // A < B: B será el alias de A

    await page.evaluate(async ({ HASH_A, HASH_B }) => {
      const AL: any = await import('/js/sync/aliases.js');
      AL.reconcile({ [HASH_A]: 'Mismo Título', [HASH_B]: 'Mismo Título' });
    }, { HASH_A, HASH_B });

    // El remapeo de mazos es asíncrono (IndexedDB): se espera a que aterrice.
    await expect.poll(async () => (await decksOf(page)).map((d: any) => d.bookId).join(',')).toBe(HASH_A);
  });

  test('arranque: un mazo huérfano se repara solo al recargar la app', async ({ page }) => {
    await page.goto('/index.html');
    await seedProLicense(page);
    await seedBook(page, HASH_A, 'Clean Code');
    await seedDeck(page, 'clean-code.epub', 'Clean Code');

    await page.reload();   // el arranque llama repairOrphanDecks() una vez

    await expect.poll(async () => (await decksOf(page))[0]?.bookId).toBe(HASH_A);
  });
});
