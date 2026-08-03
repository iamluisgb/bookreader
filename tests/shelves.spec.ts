import { test, expect } from '@playwright/test';

// Organización de la biblioteca (library/shelves.js): reglas de estantería
// inteligente, árbol por nombre y reordenación. Unidad pura: no toca IndexedDB
// ni el DOM, solo las funciones que deciden qué libro está en qué estantería.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

const DAY = 24 * 60 * 60 * 1000;

test('regla: cada condición filtra y varias se combinan con Y', async ({ page }) => {
  const out = await page.evaluate(async ({ DAY }) => {
    const S = await import('/js/library/shelves.js');
    const now = 1_000 * DAY;
    const books = [
      { id: 'a', title: 'Cálculo', author: 'Spivak', format: 'pdf', status: 'unread', addedAt: now - 2 * DAY, shelfIds: ['sh1'] },
      { id: 'b', title: 'Física', author: 'Feynman', format: 'epub', status: 'reading', addedAt: now - 200 * DAY, shelfIds: ['sh1'] },
      { id: 'c', title: 'Cálculo avanzado', author: 'spivak', format: 'epub', status: 'unread', addedAt: now - 400 * DAY, shelfIds: [] },
      { id: 'z', title: 'Borrado', author: 'Spivak', format: 'epub', status: 'unread', addedAt: now, shelfIds: ['sh1'], deleted: true },
    ];
    const ids = (rule: any) => books.filter(b => S.matchesRule(b, rule, now)).map(b => b.id);
    return {
      estado: ids({ status: 'unread' }),
      formato: ids({ format: 'epub' }),
      // El autor se compara sin acentos ni mayúsculas, como el buscador.
      autor: ids({ author: 'SPIVAK' }),
      titulo: ids({ title: 'calculo' }),
      recientes: ids({ addedWithinDays: 30 }),
      enEstanteria: ids({ shelfIds: ['sh1'] }),
      // Dos condiciones = intersección, no unión.
      combinada: ids({ status: 'unread', format: 'epub' }),
      // Una regla vacía no es una regla.
      vacia: S.hasRule({}),
    };
  }, { DAY });

  expect(out.estado).toEqual(['a', 'c']);
  expect(out.formato).toEqual(['b', 'c']);
  expect(out.autor).toEqual(['a', 'c']);
  expect(out.titulo).toEqual(['a', 'c']);
  expect(out.recientes).toEqual(['a']);
  expect(out.enEstanteria).toEqual(['a', 'b']);
  expect(out.combinada).toEqual(['c']);
  expect(out.vacia).toBe(false);
  // Un tombstone nunca entra en una estantería inteligente: sigue en la base
  // hasta que se purga, pero ya no es un libro de la biblioteca.
  expect(out.estado).not.toContain('z');
});

test('booksIn: la manual lee shelfIds y la inteligente calcula; una regla no puede apoyarse en sí misma', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const S = await import('/js/library/shelves.js');
    const books = [
      { id: 'a', status: 'unread', shelfIds: ['man'] },
      { id: 'b', status: 'finished', shelfIds: ['man'] },
      { id: 'c', status: 'unread', shelfIds: [] },
    ];
    const manual = { id: 'man', name: 'A mano' };
    const smart = { id: 'sm', name: 'Pendientes', rule: { status: 'unread' } };
    // Una regla que se cita a sí misma se ignora en vez de recursar: es la
    // garantía de que no hay ciclos posibles entre estanterías.
    const selfRef = { id: 'sm2', name: 'Bucle', rule: { status: 'unread', shelfIds: ['sm2'] } };
    return {
      manual: S.booksIn(books, manual).map((b: any) => b.id),
      smart: S.booksIn(books, smart).map((b: any) => b.id),
      selfRef: S.booksIn(books, selfRef).map((b: any) => b.id),
      esSmart: [S.isSmart(manual), S.isSmart(smart)],
    };
  });

  expect(out.manual).toEqual(['a', 'b']);
  expect(out.smart).toEqual(['a', 'c']);
  expect(out.selfRef).toEqual(['a', 'c']);
  expect(out.esSmart).toEqual([false, true]);
});

test('árbol por nombre: "Técnico/ML" cuelga de "Técnico", y el tramo que falta sale como grupo', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const S = await import('/js/library/shelves.js');
    const shelves = [
      { id: 's1', name: 'Técnico/ML', createdAt: 1 },
      { id: 's2', name: 'Técnico/Sistemas', createdAt: 2 },
      { id: 's3', name: 'Novela', createdAt: 3 },
      { id: 's4', name: 'Novela/Negra', createdAt: 4 },
    ];
    return S.shelfRows(shelves).map((r: any) => ({
      label: r.label, depth: r.depth, kind: r.kind, id: r.shelf && r.shelf.id, ids: r.shelfIds,
    }));
  });

  // "Técnico" no existe como estantería: se materializa como GRUPO que arrastra
  // a sus dos hijas, así que pulsarlo filtra por ambas.
  expect(out[0]).toMatchObject({ label: 'Técnico', depth: 0, kind: 'group', id: null });
  expect(out[0].ids.sort()).toEqual(['s1', 's2']);
  expect(out[1]).toMatchObject({ label: 'ML', depth: 1, kind: 'shelf', id: 's1' });
  expect(out[2]).toMatchObject({ label: 'Sistemas', depth: 1, kind: 'shelf', id: 's2' });
  // "Novela" sí existe: es una estantería normal, y arrastra a "Negra".
  expect(out[3]).toMatchObject({ label: 'Novela', depth: 0, kind: 'shelf', id: 's3' });
  expect(out[3].ids.sort()).toEqual(['s3', 's4']);
  expect(out[4]).toMatchObject({ label: 'Negra', depth: 1, kind: 'shelf', id: 's4' });
});

test('reorder: mueve entre hermanas del mismo nivel y numera la secuencia entera', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const S = await import('/js/library/shelves.js');
    const shelves = [
      { id: 'a', name: 'Técnico/A', createdAt: 1 },
      { id: 'b', name: 'Técnico/B', createdAt: 2 },
      { id: 'c', name: 'Técnico/C', createdAt: 3 },
      { id: 'x', name: 'Otra', createdAt: 4 },
    ];
    const apply = (patches: any[]) => {
      const next = shelves.map(s => ({ ...s }));
      for (const p of patches) Object.assign(next.find(s => s.id === p.id)!, p);
      return S.shelfRows(next).filter((r: any) => r.depth === 1).map((r: any) => r.shelf.id);
    };
    return {
      bajaA: apply(S.reorder(shelves, 'a', 1)),
      subeC: apply(S.reorder(shelves, 'c', -1)),
      // En el borde no hay nada que mover: no se emite ningún parche.
      topeArriba: S.reorder(shelves, 'a', -1),
      // "Otra" está en la raíz: no es hermana de las de "Técnico".
      otraSola: S.reorder(shelves, 'x', 1),
    };
  });

  expect(out.bajaA).toEqual(['b', 'a', 'c']);
  expect(out.subeC).toEqual(['a', 'c', 'b']);
  expect(out.topeArriba).toEqual([]);
  expect(out.otraSola).toEqual([]);
});

test('cleanRule tira los campos vacíos: la regla que viaja en el sync no lleva ruido', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const S = await import('/js/library/shelves.js');
    return S.cleanRule({
      status: 'unread', format: '', author: '   ', title: 'algo',
      addedWithinDays: 0, shelfIds: [], loQueSea: 'fuera',
    });
  });
  expect(out).toEqual({ status: 'unread', title: 'algo' });
});
