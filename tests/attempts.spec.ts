import { test, expect } from '@playwright/test';
import { seedProLicense } from './pro-license';

// P42 F1 · Registro de intentos del repaso — E2E determinista (sin LLM real).
// Cubre: el comparador local de cloze (casos dorados), el registro que deja cada nota, el
// veredicto que llega después de la nota, «deshacer» que retira el intento, la semántica
// nueva del `ok` del heatmap (primera nota de cada tarjeta en el día), la unión por uid en
// sync/backup y la subida de versión de la BD sin perder datos.

const BOOK = 'bk-att';

async function seed(page, cards) {
  await page.evaluate(
    async ({ BOOK, cards }) => {
      const DB: any = await import('/js/ai/db.js');
      const Lib: any = await import('/js/library/store.js');
      await Lib.putBook({
        id: BOOK,
        title: 'Libro intentos',
        addedAt: Date.now(),
        lastOpenedAt: Date.now(),
      });
      await DB.addDeck({
        bookId: BOOK,
        name: 'Libro intentos',
        cardType: 'basic',
        scope: '',
        cards,
      });
    },
    { BOOK, cards },
  );
}

async function openSession(page) {
  await page.reload();
  await page.locator('.lib-study-chip').click();
  return page.locator('#ai-study');
}

const attempts = (page) =>
  page.evaluate(async () => ((await import('/js/ai/db.js')) as any).getAll('attempts'));
const deckOf = (page) =>
  page.evaluate(async () => (await ((await import('/js/ai/db.js')) as any).getAllDecks())[0]);
const todayLog = (page) =>
  page.evaluate(async () => {
    const day = ((await import('/js/ai/srs.js')) as any).dayOf(Date.now());
    return JSON.parse(localStorage.getItem('bookreader_study_log') || '{}')[day] || null;
  });

// Respuesta falsa del modelo para la corrección del recuerdo. Con `hold`, la respuesta no
// sale hasta que el test llama a window.__release() (el veredicto llega DESPUÉS de la nota).
async function stubVerdict(page, veredicto: string, { hold = false } = {}) {
  await page.evaluate(
    ({ veredicto, hold }) => {
      const real = window.fetch.bind(window);
      window.fetch = async (url: any, opts: any) => {
        const u = typeof url === 'string' ? url : url?.url || '';
        if (u.includes('/chat/completions')) {
          if (hold)
            await new Promise((r) => {
              (window as any).__release = r;
            });
          // checkRecall usa chatStream: la respuesta tiene que ser SSE, como la del proveedor.
          const content = JSON.stringify({ veredicto, comentario: 'comentario de prueba' });
          const chunk = JSON.stringify({
            choices: [{ delta: { content }, finish_reason: 'stop' }],
          });
          return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }
        return real(url, opts);
      };
    },
    { veredicto, hold },
  );
}

// ---- Comparador de cloze ---------------------------------------------------------

test('comparador de cloze: lo que perdona es la forma, nunca el contenido', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async () => {
    const C: any = await import('/js/ai/cloze-check.js');
    const cases: [string, string][] = [
      // Pasan: mayúsculas, acentos, artículo inicial, puntuación que envuelve, guiones, pista.
      ['El protocolo es {{c1::Raft}}.', 'raft'],
      ['{{c1::algoritmo}}', 'Algorítmo'],
      ['{{c1::el Senado}}', 'senado'],
      ['{{c1::Senado}}', '  «El senado.» '],
      ['{{c1::The Raft protocol}}', 'raft protocol'],
      ['{{c1::byte-pair encoding}}', 'Byte pair   encoding'],
      ['{{c1::Raft::un algoritmo}}', 'RAFT'],
      ['{{c1::año}}', 'ano'], // documentado: ñ = n
      ['Capitales: {{c1::Madrid}} y {{c2::París}}', 'madrid, paris'],
      ['Capitales: {{c1::Madrid}} y {{c2::París}}', 'Madrid París'],
      // No pasan: sinónimo, errata, plural, respuesta dentro de más texto, orden cambiado.
      ['{{c1::consenso}}', 'acuerdo'],
      ['{{c1::Raft}}', 'Rfat'],
      ['{{c1::nodo}}', 'nodos'],
      ['{{c1::Raft}}', 'creo que Raft'],
      ['Capitales: {{c1::Madrid}} y {{c2::París}}', 'París, Madrid'],
      // No aplica: sin huecos o sin respuesta.
      ['sin huecos', 'algo'],
      ['{{c1::Raft}}', '   '],
    ];
    return {
      exact: cases.map(([front, answer]) => C.clozeExact(front, answer)),
      loneArticle: C.normalizeAnswer('La'),
      answers: C.clozeAnswers('{{c1::uno}} y {{c2::dos::pista}}'),
    };
  });
  expect(r.exact).toEqual([
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    false,
    false,
    false,
    false,
    false,
    null,
    null,
  ]);
  expect(r.loneArticle).toBe('la'); // un artículo que ES la respuesta no se borra
  expect(r.answers).toEqual(['uno', 'dos']);
});

// ---- Registro y deshacer ---------------------------------------------------------

test('cada nota deja un intento con sus campos, y deshacer lo retira', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await seed(page, [
    { type: 'basic', front: '¿Qué es Raft?', back: 'Un algoritmo de consenso.', chapter: '' },
  ]);
  const overlay = await openSession(page);

  await overlay.locator('.study-flip').click();
  await page.keyboard.press('3'); // «bien»
  await expect(overlay.locator('.study-end h2')).toBeVisible();
  await expect.poll(async () => (await attempts(page)).length).toBe(1);

  const deck = await deckOf(page);
  const [a] = await attempts(page);
  expect(a).toMatchObject({
    cardUid: deck.cards[0].uid,
    deckUid: deck.uid,
    bookId: BOOK,
    mode: 'reveal',
    verdict: null,
    exact: null,
    grade: 'good',
    prevInterval: null, // tarjeta nueva
    arm: null,
    answer: null, // girada sin escribir: no hay texto que guardar
  });
  expect(typeof a.uid).toBe('string');
  expect(a.latencyMs).toBeGreaterThanOrEqual(0);
  expect(Math.abs(a.ts - Date.now())).toBeLessThan(60000);
  expect(a.cardHash).toMatch(/^[0-9a-f]{8}$/); // huella del contenido de la tarjeta (P42)
  expect(Object.keys(a).sort()).toEqual([
    'answer',
    'arm',
    'bookId',
    'cardHash',
    'cardUid',
    'deckUid',
    'exact',
    'grade',
    'latencyMs',
    'mode',
    'prevInterval',
    'ts',
    'uid',
    'verdict',
  ]);

  // Deshacer: la nota se retira y su intento también.
  await overlay.locator('.study-tools [data-act="undo"]').click();
  await expect(overlay.locator('.study-q')).toHaveText('¿Qué es Raft?');
  await expect.poll(async () => (await attempts(page)).length).toBe(0);

  // La nota buena de después sí queda, con un uid nuevo.
  await overlay.locator('.study-flip').click();
  await overlay.locator('.study-grade.is-again').click();
  await expect.poll(async () => (await attempts(page)).map((x) => x.grade)).toEqual(['again']);
  expect((await attempts(page))[0].uid).not.toBe(a.uid);
});

test('respuesta escrita en un cloze: modo written, exact local y veredicto del agente', async ({
  page,
}) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await page.evaluate(() => localStorage.setItem('bookreader_ai_key', JSON.stringify('test-key')));
  await seed(page, [
    { type: 'cloze', front: 'El algoritmo de consenso es {{c1::Raft}}.', back: '', chapter: '' },
  ]);
  const overlay = await openSession(page);
  await stubVerdict(page, 'bien');

  await overlay.locator('.study-recall-input').fill(' raft. ');
  await overlay.locator('.study-flip').click();
  await expect(overlay.locator('.study-feedback.is-good')).toBeVisible();
  await overlay.locator('.study-grade.is-good').click();

  await expect.poll(async () => (await attempts(page)).length).toBe(1);
  const [a] = await attempts(page);
  expect(a).toMatchObject({ mode: 'written', exact: true, verdict: 'good', grade: 'good' });
  expect(a.answer).toBe('raft.'); // el texto tal cual lo escribió (sin los espacios de los extremos)
});

test('el texto escrito se guarda (recortado a 500); el intento solo mirando lo deja en null', async ({
  page,
}) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await page.evaluate(() => localStorage.setItem('bookreader_ai_key', JSON.stringify('test-key')));
  await seed(page, [
    { type: 'basic', front: 'uno', back: 'r1', chapter: '' },
    { type: 'basic', front: 'dos', back: 'r2', chapter: '' },
    { type: 'basic', front: 'tres', back: 'r3', chapter: '' },
  ]);
  const overlay = await openSession(page);
  await stubVerdict(page, 'bien');

  // La cola se baraja: lo que se prueba va por POSICIÓN, no por tarjeta.
  const LONG = 'x'.repeat(480) + 'FIN-DEL-TOPE' + 'y'.repeat(100); // 592 caracteres
  const answers = ['Un algoritmo de consenso', LONG, ''];
  for (const text of answers) {
    if (text) await overlay.locator('.study-recall-input').fill(text);
    await overlay.locator('.study-flip').click();
    await overlay.locator('.study-grade.is-good').click();
  }
  await expect(overlay.locator('.study-end h2')).toBeVisible();

  await expect.poll(async () => (await attempts(page)).length).toBe(3);
  const byMode = (await attempts(page)).map((x) => ({ mode: x.mode, answer: x.answer }));
  // (a) escrito → el texto; (b) solo mirando → null.
  expect(byMode).toContainEqual({ mode: 'written', answer: 'Un algoritmo de consenso' });
  expect(byMode).toContainEqual({ mode: 'reveal', answer: null });
  // (c) más de 500 caracteres → se recorta a los 500 primeros.
  const long = byMode.find((x) => x.answer && x.answer.startsWith('xxx'));
  expect(long!.answer).toHaveLength(500);
  expect(long!.answer).toBe(LONG.slice(0, 500));
});

test('el veredicto que llega DESPUÉS de la nota se guarda en el mismo intento', async ({
  page,
}) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await page.evaluate(() => localStorage.setItem('bookreader_ai_key', JSON.stringify('test-key')));
  await seed(page, [{ type: 'cloze', front: 'Capital: {{c1::Madrid}}', back: '', chapter: '' }]);
  const overlay = await openSession(page);
  await stubVerdict(page, 'a medias', { hold: true });

  await overlay.locator('.study-recall-input').fill('Barcelona');
  await overlay.locator('.study-flip').click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__release)).toBe('function');
  await overlay.locator('.study-grade.is-again').click();

  // Con la corrección aún en vuelo no se escribe nada: un registro inmutable no se completa luego.
  await page.waitForTimeout(300);
  expect(await attempts(page)).toHaveLength(0);

  await page.evaluate(() => (window as any).__release());
  await expect.poll(async () => (await attempts(page)).length).toBe(1);
  const [a] = await attempts(page);
  expect(a).toMatchObject({ mode: 'written', exact: false, verdict: 'partial', grade: 'again' });
});

// ---- Heatmap: el `ok` cuenta la PRIMERA nota de cada tarjeta en el día ------------

test('heatmap: un fallo y luego un acierto en la misma tarjeta cuenta 0 de 1, no 1 de 2', async ({
  page,
}) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await seed(page, [
    { type: 'basic', front: 'uno', back: 'r1', chapter: '' },
    { type: 'basic', front: 'dos', back: 'r2', chapter: '' },
  ]);
  const overlay = await openSession(page);

  // X: «otra vez» → Y: «bien» → X re-encolada: «bien».
  const first = (await overlay.locator('.study-q').textContent())!.trim();
  await overlay.locator('.study-flip').click();
  await page.keyboard.press('1');
  await expect(overlay.locator('.study-q')).not.toHaveText(first);
  await overlay.locator('.study-flip').click();
  await page.keyboard.press('3');
  await expect(overlay.locator('.study-q')).toHaveText(first);
  await overlay.locator('.study-flip').click();
  await page.keyboard.press('3');
  await expect(overlay.locator('.study-end h2')).toBeVisible();

  // 3 notas, 2 tarjetas, 1 acertada a la primera → 50 %. Con la semántica vieja era 2/3.
  expect(await todayLog(page)).toEqual({ n: 3, ok: 1, c: 2 });
  await expect(overlay.locator('.study-heat-cell.is-today.ret-low[title="3 · 50%"]')).toHaveCount(
    1,
  );

  // Deshacer revierte EXACTAMENTE lo que sumó cada nota.
  await overlay.locator('.study-tools [data-act="undo"]').click(); // X «bien» (no era la primera)
  expect(await todayLog(page)).toEqual({ n: 2, ok: 1, c: 2 });
  await overlay.locator('.study-tools [data-act="undo"]').click(); // Y «bien» (primera, acierto)
  expect(await todayLog(page)).toEqual({ n: 1, ok: 0, c: 1 });
  await expect.poll(async () => (await attempts(page)).length).toBe(1);
});

test('heatmap: una tarjeta ya repasada hoy (otra sesión) no vuelve a contar', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const today = await page.evaluate(async () =>
    ((await import('/js/ai/srs.js')) as any).dayOf(Date.now()),
  );
  // Fallada hace un momento en otra sesión: vence hoy (re-aprendiendo), último repaso = hoy.
  await seed(page, [
    {
      type: 'basic',
      front: 'repetida',
      back: 'r',
      chapter: '',
      srs: {
        reps: 0,
        lapses: 1,
        ease: 2.5,
        interval: 0,
        due: today,
        lastReview: Date.now() - 1000,
        stability: 0.5,
        difficulty: 6,
      },
    },
  ]);
  const overlay = await openSession(page);

  await overlay.locator('.study-flip').click();
  await page.keyboard.press('3');
  await expect(overlay.locator('.study-end h2')).toBeVisible();

  expect(await todayLog(page)).toEqual({ n: 1, ok: 0, c: 0 });
  // Sin tarjetas nuevas en el día no hay retención que pintar: el cuadro va sin subrayado.
  await expect(
    overlay.locator('.study-heat-cell.is-today:not([class*="ret-"])[title="1"]'),
  ).toHaveCount(1);
  await expect.poll(async () => (await attempts(page)).map((x) => x.prevInterval)).toEqual([0]);
});

// ---- Sync, backup y subida de versión ----------------------------------------------

test('sync y backup: los intentos se UNEN por uid y nunca se reescriben', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async () => {
    const DB: any = await import('/js/ai/db.js');
    const L: any = await import('/js/sync/layout.js');
    const Backup: any = await import('/js/backup.js');
    const mk = (uid: string, extra = {}) => ({
      uid,
      cardUid: 'c1',
      deckUid: 'd1',
      bookId: 'bk-sync',
      ts: 1,
      mode: 'reveal',
      verdict: null,
      exact: null,
      grade: 'good',
      prevInterval: null,
      latencyMs: 10,
      arm: null,
      ...extra,
    });

    const digestEmpty = L.bookDigest({ decks: [] });
    const digestEmptyAttempts = L.bookDigest({ decks: [], attempts: [] });

    // Unión: lo que falta entra; lo repetido (aunque venga distinto) no reescribe nada.
    const w1 = await DB.mergeAttempts([mk('a1'), mk('a2'), mk('a1')]);
    const w2 = await DB.mergeAttempts([mk('a1', { grade: 'again' }), mk('a3')]);
    const a1 = (await DB.getAttempts('bk-sync')).find((x: any) => x.uid === 'a1');

    // El snapshot los lleva en el fichero del libro, y entran en su huella.
    const snap = await L.buildSnapshot();
    const inSnap = (snap.books['bk-sync']?.attempts || []).map((x: any) => x.uid).sort();
    const digestWith = L.bookDigest(snap.books['bk-sync']);

    // Restaurar (también en modo 'restore') une: no pisa ni borra lo local.
    await L.restoreSnapshot(
      { books: { 'bk-sync': { attempts: [mk('a4'), mk('a2', { grade: 'again' })] } } },
      { mode: 'restore' },
    );
    const afterRestore = (await DB.getAttempts('bk-sync'))
      .map((x: any) => `${x.uid}:${x.grade}`)
      .sort();

    // Backup de ida y vuelta: viajan, y reimportarlos no duplica.
    const backup = JSON.parse(JSON.stringify(await Backup.buildBackup()));
    await Backup.importBackup(backup);
    const afterImport = (await DB.getAttempts('bk-sync')).length;

    return {
      digestEmpty,
      digestEmptyAttempts,
      w1,
      w2,
      a1grade: a1.grade,
      inSnap,
      digestWith,
      afterRestore,
      inBackup: backup.ai.attempts.length,
      afterImport,
    };
  });
  // Un libro sin intentos tiene la MISMA huella que antes: subir de versión no fuerza re-subidas.
  expect(r.digestEmptyAttempts).toBe(r.digestEmpty);
  expect(r.w1).toBe(2);
  expect(r.w2).toBe(1);
  expect(r.a1grade).toBe('good');
  expect(r.inSnap).toEqual(['a1', 'a2', 'a3']);
  expect(r.digestWith).not.toBe(r.digestEmpty);
  expect(r.afterRestore).toEqual(['a1:good', 'a2:good', 'a3:good', 'a4:good']);
  expect(r.inBackup).toBe(4);
  expect(r.afterImport).toBe(4);
});

test('subir la BD de v7 a v8 conserva los datos y crea el store de intentos', async ({ page }) => {
  // Una página del mismo origen que NO arranca la app: así nadie abre la BD antes que el test.
  await page.goto('/manifest.json');
  const r = await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('bookreader_ai', 7);
      req.onupgradeneeded = () => {
        const d = req.result.createObjectStore('decks', { keyPath: 'id', autoIncrement: true });
        d.createIndex('bookId', 'bookId', { unique: false });
        d.add({
          uid: 'deck-v7',
          bookId: 'bk-v7',
          name: 'Mazo de antes',
          cards: [{ uid: 'c-v7', front: 'q', back: 'a' }],
        });
      };
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    const DB: any = await import('/js/ai/db.js');
    const decks = await DB.getAllDecks();
    await DB.addAttempt({
      uid: 'u-v8',
      cardUid: 'c-v7',
      deckUid: 'deck-v7',
      bookId: 'bk-v7',
      ts: 1,
      mode: 'reveal',
      verdict: null,
      exact: null,
      grade: 'good',
      prevInterval: null,
      latencyMs: 5,
      arm: null,
    });
    const version = await new Promise((resolve) => {
      const req = indexedDB.open('bookreader_ai');
      req.onsuccess = () => {
        const v = req.result.version;
        req.result.close();
        resolve(v);
      };
    });
    return {
      names: decks.map((d: any) => d.name),
      attempts: (await DB.getAttempts('bk-v7')).length,
      version,
    };
  });
  expect(r.names).toEqual(['Mazo de antes']);
  expect(r.attempts).toBe(1);
  expect(r.version).toBe(8);
});
