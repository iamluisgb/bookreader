import { test, expect } from '@playwright/test';
import { seedProLicense } from './pro-license';

// WU2 · Capa de datos del gestor de mazos (feature "gestor de mazos").
//
// Helpers puros que la pantalla "Mazos" (WU3) va a renderizar: agrupación por
// libro canónico (con aliases), resumen por mazo y ciclo de vida de una
// tarjeta creada a mano. Todo es puro: no hay seed de IndexedDB, los mazos y
// libros entran como parámetros.

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function deck(id: number, bookId: string, name: string, createdAt: number, cards: any[] = []) {
  return { id, uid: `u${id}`, bookId, name, scope: '', cardType: 'basic', createdAt, cards };
}

test.describe('Gestor de mazos (WU2)', () => {
  test('groupDecks: agrupa por libro canónico, ordena y separa huérfanos', async ({ page }) => {
    await page.goto('/index.html');
    await seedProLicense(page);
    const res = await page.evaluate(async ({ HASH_A, HASH_B }) => {
      const deck = (id: number, bookId: string, name: string, createdAt: number, cards: any[] = []) =>
        ({ id, uid: `u${id}`, bookId, name, scope: '', cardType: 'basic', createdAt, cards });
      const DM: any = await import('/js/ai/deck-manager.js');
      const S: any = await import('/js/storage.js');
      // d1 y d2 son del mismo libro (HASH_A); d3 nació bajo un id ALIAS del
      // mismo libro → debe caer en el grupo del libro, no en huérfanos.
      const d1 = deck(1, HASH_A, 'A', 100);
      const d2 = deck(2, HASH_A, 'B', 300);
      const d3 = deck(3, 'alias.pdf', 'C', 200);
      // d4 y d5: libros que no están en la biblioteca → huérfanos.
      const d4 = deck(4, 'ghost.epub', 'Mazo sin libro', 400, [{ front: 'q', back: 'a' }, { front: 'q2', back: 'a2' }]);
      const d5 = deck(5, 'legacy.epub', 'AAA', 500, [{ front: 'q' }, { front: 'q2' }, { front: 'q3' }]);
      const books = [
        { id: HASH_A, title: 'Zeta' },
        { id: HASH_B, title: 'Alpha' },
        { id: HASH_B, title: 'Alpha (duplicado)' }, // mismo id canónico: no crea grupo aparte
      ];
      let out: any;
      try {
        S.set('book_aliases', { 'alias.pdf': HASH_A });   // d3 existe por la cadena de alias
        out = DM.groupDecks([d1, d2, d3, d4, d5, null, {}, { name: 'sin id' }], books);
      } finally {
        S.remove('book_aliases');
      }
      return out;
    }, { HASH_A, HASH_B });
    // Un solo grupo (el libro "Zeta"), con d2/d3/d1 por createdAt desc (300/200/100).
    // El mazo nacido bajo el alias (d3) cayó en el grupo, no en huérfanos.
    expect(res.groups).toEqual([
      { bookId: HASH_A, title: 'Zeta', decks: [
        expect.objectContaining({ id: 2 }),
        expect.objectContaining({ id: 3 }),
        expect.objectContaining({ id: 1 }),
      ] },
    ]);
    // Huérfanos: por número de tarjetas desc (d5 tiene 3, d4 tiene 2), con el
    // NOMBRE del mazo como identidad (no un id de libro desconocido).
    expect(res.orphans.map((o: any) => ({ deckId: o.deckId, name: o.name, cards: o.cards }))).toEqual([
      { deckId: 5, name: 'AAA', cards: 3 },
      { deckId: 4, name: 'Mazo sin libro', cards: 2 },
    ]);
    expect(res.orphans.every((o: any) => o.bookId !== HASH_A)).toBe(true);
  });

  test('groupDecks: grupos ordenados por título y entrada malformada no rompe', async ({ page }) => {
    await page.goto('/index.html');
    await seedProLicense(page);
    const res = await page.evaluate(async ({ HASH_A, HASH_B }) => {
      const deck = (id: number, bookId: string, name: string, createdAt: number, cards: any[] = []) =>
        ({ id, uid: `u${id}`, bookId, name, scope: '', cardType: 'basic', createdAt, cards });
      const DM: any = await import('/js/ai/deck-manager.js');
      const books = [
        { id: HASH_A, title: 'Zulu' },
        { id: HASH_B, title: 'Álpha' }, // título con tilde: igual orden alfabético
        { title: 'sin id' },            // libro malformado: se ignora
      ];
      return DM.groupDecks(
        [deck(1, HASH_A, 'z', 1), deck(2, HASH_B, 'a', 1), null, undefined, 'texto', 42],
        books,
      );
    }, { HASH_A, HASH_B });
    expect(res.groups.map((g: any) => g.title)).toEqual(['Álpha', 'Zulu']);
  });

  test('deckSummary: cubos SRS y porTipo; una suspendida no cuenta como vencida', async ({ page }) => {
    await page.goto('/index.html');
    await seedProLicense(page);
    const res = await page.evaluate(async () => {
      const deck = (id: number, bookId: string, name: string, createdAt: number, cards: any[] = []) =>
        ({ id, uid: `u${id}`, bookId, name, scope: '', cardType: 'basic', createdAt, cards });
      const DM: any = await import('/js/ai/deck-manager.js');
      const Srs: any = await import('/js/ai/srs.js');
      const today = Srs.dayOf(Date.now());
      const srs = (reps: number, interval: number, due: number) => ({ reps, interval, due, lapses: 0, ease: 2.5, lastReview: 1 });
      const d = deck(1, 'x', 'mazo', 1, [
        { type: 'basic', front: 'nueva' },                                  // nueva (sin srs)
        { type: 'basic', front: 'vencida', srs: srs(3, 5, today - 1) },     // vencida
        { type: 'basic', front: 'futura', srs: srs(2, 30, today + 10) },    // madura (intervalo ≥ 21)
        { type: 'basic', front: 'aprendiendo', srs: srs(1, 5, today + 2) }, // aprendiendo
        { type: 'basic', front: 'apagada', suspended: true, srs: srs(1, 3, today - 1) }, // suspendida
        { type: 'occlusion', front: 'figura' },                             // visual nueva
        { type: 'diagram', front: 'svg' },                                  // visual nueva
      ]);
      return { sum: DM.deckSummary(d), later: DM.deckSummary(d, Date.now() + 4 * 86400000) };
    });
    // Las NUEVAS siempre cuentan como vencidas (isDue: sin srs → toca hoy); la
    // suspendida (vencida además) NO aparece en due.
    expect(res.sum).toEqual({
      total: 7, due: 4, nuevas: 3, aprendiendo: 2, maduras: 1, suspendidas: 1,
      porTipo: { basic: 5, occlusion: 1, diagram: 1 },
    });
    // Con el tiempo corrido 4 días, la "aprendiendo" programada para hoy+2 pasa a vencer.
    expect(res.later.due).toBe(5);
  });

  test('validateCardInput: los cinco motivos, duplicado sin tildes ni mayúsculas', async ({ page }) => {
    await page.goto('/index.html');
    await seedProLicense(page);
    const res = await page.evaluate(async () => {
      const DM: any = await import('/js/ai/deck-manager.js');
      return {
        empty: DM.validateCardInput({ type: 'basic', front: '   ', back: 'x' }),
        badType: DM.validateCardInput({ type: 'occlusion', front: 'hola', back: 'x' }),
        noHole: DM.validateCardInput({ type: 'cloze', front: 'hola sin hueco', back: '' }),
        dup: DM.validateCardInput(
          { type: 'basic', front: 'HOLA MUNDO', back: 'x' },
          { existingFronts: ['¡Hóla,  mundo!'] },  // normalizeText: misma tarjeta
        ),
        okBasic: DM.validateCardInput({ type: 'basic', front: 'q', back: '' }),   // dorso vacío vale
        okCloze: DM.validateCardInput({ type: 'cloze', front: 'el {{c1::río}} pasa', back: '' }),
      };
    });
    expect(res.empty).toEqual({ ok: false, reason: 'empty-front' });
    expect(res.badType).toEqual({ ok: false, reason: 'bad-type' });
    expect(res.noHole).toEqual({ ok: false, reason: 'cloze-without-hole' });
    expect(res.dup).toEqual({ ok: false, reason: 'duplicate' });
    expect(res.okBasic).toEqual({ ok: true });
    expect(res.okCloze).toEqual({ ok: true });
  });

  test('makeCard: forma exacta con uid no vacío y updatedAt pasado por parámetro', async ({ page }) => {
    await page.goto('/index.html');
    await seedProLicense(page);
    const res = await page.evaluate(async () => {
      const DM: any = await import('/js/ai/deck-manager.js');
      const now = 1700000000000;
      const card = DM.makeCard({ type: 'cloze', front: '  el {{c1::río}}  ', back: '  ' }, now);
      return { card, second: DM.makeCard({ type: 'basic', front: 'a', back: 'b' }, now) };
    });
    // Trim en frente y dorso; chapter/src vacíos; sello exacto.
    expect(res.card).toEqual({
      type: 'cloze', front: 'el {{c1::río}}', back: '',
      chapter: '', src: '', uid: expect.any(String), updatedAt: 1700000000000,
    } as any);
    expect(res.card.uid.length).toBeGreaterThan(0);
    // Dos tarjetas del mismo lote nunca comparten uid.
    expect(res.second.uid).not.toBe(res.card.uid);
  });

  test('mutaciones puras: agregar, quitar, suspender y editar sin tocar el original', async ({ page }) => {
    await page.goto('/index.html');
    await seedProLicense(page);
    const res = await page.evaluate(async () => {
      const deck = (id: number, bookId: string, name: string, createdAt: number, cards: any[] = []) =>
        ({ id, uid: `u${id}`, bookId, name, scope: '', cardType: 'basic', createdAt, cards });
      const DM: any = await import('/js/ai/deck-manager.js');
      const c1 = { type: 'basic', front: 'q1', back: 'a1', uid: 'k1' };
      const c2 = { type: 'basic', front: 'q2', back: 'a2', uid: 'k2', suspended: false };
      const d = deck(1, 'x', 'mazo', 1, [c1, c2]);
      const snapshot = JSON.stringify(d);

      const added = DM.addCard(d, { type: 'basic', front: 'q3', back: 'a3' });
      const removed = DM.removeCard(added, 0);
      const outOfRange = DM.removeCard(d, 99);
      const on = DM.toggleSuspendCard(d, 1);
      const off = DM.toggleSuspendCard(on, 1);
      const edited = DM.updateCardText(d, 0, { front: '  q1 editada  ', back: ' a1 nueva ' });

      return {
        snapshot,
        addedLast: added.cards[added.cards.length - 1],
        originalLen: d.cards.length,
        addedLen: added.cards.length,
        removedFirst: removed.cards[0],
        removedLen: removed.cards.length,
        outOfRangeLen: outOfRange.cards.length,
        outOfRangeSameIds: outOfRange.cards.map((c: any) => c.uid),
        onSuspended: on.cards[1].suspended,
        offSuspended: off.cards[1].suspended,
        origCard2Suspended: d.cards[1].suspended,
        editedFront: edited.cards[0].front,
        editedBack: edited.cards[0].back,
        editedStamp: typeof edited.cards[0].updatedAt === 'number',
        otherUntouched: edited.cards[1] === d.cards[1], // misma referencia: no se tocó
        origCard1Front: d.cards[0].front,
        origCard1Stamp: d.cards[0].updatedAt,
        idKept: [added, removed, on, edited].every((m: any) => m.id === 1 && m.uid === 'u1' && m.name === 'mazo'),
      };
    });
    expect(JSON.parse(res.snapshot).cards).toHaveLength(2);          // el original jamás cambió
    expect(res.addedLast).toMatchObject({ front: 'q3' });
    expect(res.originalLen).toBe(2);
    expect(res.addedLen).toBe(3);
    expect(res.removedFirst).toMatchObject({ uid: 'k2' });          // quitó la primera
    expect(res.removedLen).toBe(2);
    expect(res.outOfRangeLen).toBe(2);                              // índice fuera de rango: copia tal cual
    expect(res.outOfRangeSameIds).toEqual(['k1', 'k2']);
    expect(res.onSuspended).toBe(true);                             // alterna…
    expect(res.offSuspended).toBe(false);                           // …y vuelve
    expect(res.origCard2Suspended).toBe(false);                     // sin mutar la tarjeta original
    expect(res.editedFront).toBe('q1 editada');                     // recorta espacios
    expect(res.editedBack).toBe('a1 nueva');
    expect(res.editedStamp).toBe(true);                             // sella updatedAt
    expect(res.otherUntouched).toBe(true);                          // las demás quedan intactas
    expect(res.origCard1Front).toBe('q1');
    expect(res.origCard1Stamp).toBeUndefined();                     // ni sello en el original
    expect(res.idKept).toBe(true);                                  // identidad del mazo preservada
  });
});
