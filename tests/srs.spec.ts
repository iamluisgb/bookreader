import { test, expect } from '@playwright/test';

// P10 · Modo Estudiar — unit del scheduler SM-2 (js/ai/srs.js). Módulo puro: se prueba
// con fechas inyectadas (determinista, sin LLM ni IndexedDB).

const DAY = 86400000;
// Mediodía local: lejos de la medianoche, dayOf no baila con el huso.
const T0 = new Date('2026-07-08T12:00:00').getTime();

test('SM-2: ciclo de vida de una tarjeta (nueva → 1d → 6d → ×ease) y fallo (lapse)', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async (t0) => {
    const S: any = await import('/js/ai/srs.js');
    const day = 86400000;

    // Nueva → "bien": 1 día.
    let s = S.grade(null, 'good', t0);
    const first = { interval: s.interval, reps: s.reps, dueDelta: s.due - S.dayOf(t0) };

    // Segundo "bien" (al día siguiente): 6 días.
    s = S.grade(s, 'good', t0 + day);
    const second = { interval: s.interval, reps: s.reps };

    // Tercer "bien": interval × ease (6 × 2.5 = 15).
    const third = S.grade(s, 'good', t0 + 7 * day);

    // Fallo → lapse: reps a 0, vuelve a HOY (re-encolada en sesión) y baja el ease.
    const lapsed = S.grade(third, 'again', t0 + 22 * day);

    // Tras el lapse, "bien" reinicia en 1 día (reps era 0).
    const relearn = S.grade(lapsed, 'good', t0 + 22 * day);

    // hard crece poco y baja ease; easy dispara y sube ease.
    const hard = S.grade(third, 'hard', t0 + 22 * day);
    const easy = S.grade(third, 'easy', t0 + 22 * day);

    return {
      first, second,
      thirdInterval: third.interval,
      lapse: { reps: lapsed.reps, interval: lapsed.interval, ease: lapsed.ease, dueIsToday: lapsed.due === S.dayOf(t0 + 22 * day), lapses: lapsed.lapses },
      relearnInterval: relearn.interval,
      hard: { interval: hard.interval, ease: hard.ease },
      easy: { interval: easy.interval, ease: easy.ease },
      immutable: third.reps === 3 && s.reps === 2,   // grade no muta el estado de entrada
    };
  }, T0);

  expect(r.first).toEqual({ interval: 1, reps: 1, dueDelta: 1 });
  expect(r.second).toEqual({ interval: 6, reps: 2 });
  expect(r.thirdInterval).toBe(15);                       // 6 × 2.5
  expect(r.lapse.reps).toBe(0);
  expect(r.lapse.interval).toBe(0);
  expect(r.lapse.lapses).toBe(1);
  expect(r.lapse.dueIsToday).toBe(true);
  expect(r.lapse.ease).toBeCloseTo(2.3);                  // 2.5 − 0.2
  expect(r.relearnInterval).toBe(1);
  expect(r.hard.interval).toBe(18);                       // 15 × 1.2
  expect(r.hard.ease).toBeCloseTo(2.35);                  // 2.5 − 0.15
  expect(r.easy.interval).toBe(49);                       // 15 × 2.5 × 1.3 ≈ 48.75
  expect(r.easy.ease).toBeCloseTo(2.65);                  // 2.5 + 0.15
  expect(r.immutable).toBe(true);
});

test('SM-2: isDue/dueCount/deckStats y previews de intervalo', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async (t0) => {
    const S: any = await import('/js/ai/srs.js');
    const day = 86400000;
    const today = S.dayOf(t0);

    const cards = [
      { front: 'nueva' },                                                          // sin srs → due
      { front: 'vencida', srs: { reps: 3, lapses: 0, ease: 2.5, interval: 10, due: today - 2, lastReview: t0 - 12 * day } },
      { front: 'futura', srs: { reps: 3, lapses: 0, ease: 2.5, interval: 30, due: today + 5, lastReview: t0 - day } },
      { front: 'madura-hoy', srs: { reps: 5, lapses: 0, ease: 2.5, interval: 40, due: today, lastReview: t0 - 40 * day } },
    ];
    const stats = S.deckStats(cards, t0);
    const prev = S.previewIntervals(null, t0);
    return {
      due: S.dueCount(cards, t0),
      dueFlags: cards.map(c => S.isDue(c, t0)),
      stats,
      prev,
      labels: [S.intervalLabel(0), S.intervalLabel(6), S.intervalLabel(45), S.intervalLabel(400)],
      easeFloor: S.grade({ reps: 0, lapses: 0, ease: 1.3, interval: 0, due: today, lastReview: 0 }, 'again', t0).ease,
      capped: S.grade({ reps: 9, lapses: 0, ease: 2.5, interval: 300, due: today, lastReview: 0 }, 'good', t0).interval,
    };
  }, T0);

  expect(r.due).toBe(3);
  expect(r.dueFlags).toEqual([true, true, false, true]);
  expect(r.stats).toEqual({ total: 4, nuevas: 1, aprendiendo: 1, maduras: 2, due: 3, suspendidas: 0 });
  expect(r.prev.again).toBe(0);
  expect(r.prev.good).toBe(1);                            // nueva + bien = 1d
  expect(r.prev.easy).toBeGreaterThan(r.prev.good);
  expect(r.labels).toEqual(['<10m', '6d', '2m', '1.1a']);
  expect(r.easeFloor).toBeCloseTo(1.3);                   // el ease nunca baja del suelo
  expect(r.capped).toBe(365);                             // techo de un año
});

test('racha: suma en días consecutivos, es idempotente hoy y se rompe con hueco', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async (t0) => {
    const S: any = await import('/js/ai/srs.js');
    const day = 86400000;
    let s = S.bumpStreak(null, t0);                       // primer repaso → racha 1
    const first = s.count;
    const sameDay = S.bumpStreak(s, t0 + 3600000);        // segundo repaso del MISMO día
    s = S.bumpStreak(s, t0 + day);                        // al día siguiente → 2
    s = S.bumpStreak(s, t0 + 2 * day);                    // y otro → 3
    const alive = S.currentStreak(s, t0 + 3 * day);       // aún mostrable al día siguiente
    const broken = S.currentStreak(s, t0 + 5 * day);      // con hueco → 0
    const restart = S.bumpStreak(s, t0 + 5 * day);        // repasar tras el hueco → reinicia a 1
    return { first, sameDay: sameDay.count, count: s.count, alive, broken, restart: restart.count };
  }, new Date('2026-07-08T12:00:00').getTime());
  expect(r.first).toBe(1);
  expect(r.sameDay).toBe(1);
  expect(r.count).toBe(3);
  expect(r.alive).toBe(3);
  expect(r.broken).toBe(0);
  expect(r.restart).toBe(1);
});

// ---- P24 · Suspensión y leeches -------------------------------------------------

test('suspendida: fuera de la cola y en su propio cubo de stats; leech a partir de 8 fallos', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async (t0) => {
    const S: any = await import('/js/ai/srs.js');
    const today = S.dayOf(t0);
    const vencida = (extra = {}) => ({
      front: 'x', srs: { reps: 3, lapses: 0, ease: 2.5, interval: 5, due: today - 1, lastReview: 0 }, ...extra,
    });
    const cards = [
      vencida(),                                   // vencida normal
      vencida({ suspended: true }),                // vencida pero suspendida → no toca
      { front: 'nueva', suspended: true },         // nueva suspendida → tampoco
    ];
    const leech = { front: 'l', srs: { reps: 0, lapses: 8, ease: 1.3, interval: 0, due: today, lastReview: 0 } };
    return {
      due: S.dueCount(cards, t0),
      stats: S.deckStats(cards, t0),
      leech: S.isLeech(leech),
      casi: S.isLeech({ front: 'l', srs: { ...leech.srs, lapses: 7 } }),
      suspendidoNoEsLeech: S.isLeech({ ...leech, suspended: true }),
      umbral: S.LEECH_LAPSES,
    };
  }, new Date('2026-07-08T12:00:00').getTime());

  expect(r.due).toBe(1);                                    // solo la que no está suspendida
  expect(r.stats).toEqual({ total: 3, nuevas: 0, aprendiendo: 1, maduras: 0, due: 1, suspendidas: 2 });
  expect(r.leech).toBe(true);
  expect(r.casi).toBe(false);                               // 7 fallos aún no es leech
  expect(r.suspendidoNoEsLeech).toBe(false);                // ya está fuera: no hay nada que avisar
  expect(r.umbral).toBe(8);
});

// ---- P24 F1 · Orden de la sesión (buildQueue, pura) -----------------------------

test('buildQueue: tope de nuevas, barajado y hermanas separadas', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async (t0) => {
    const St: any = await import('/js/ai/study.js');
    const today = (await import('/js/ai/srs.js') as any).dayOf(t0);
    // rng determinista (LCG): el barajado tiene que ser testeable, no "a ver qué sale".
    let seed = 42;
    const rng = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

    const nuevas = Array.from({ length: 30 }, (_, i) => ({ type: 'basic', front: 'n' + i, back: 'b' }));
    const repasos = Array.from({ length: 5 }, (_, i) => ({
      type: 'basic', front: 'r' + i, back: 'b',
      srs: { reps: 3, lapses: 0, ease: 2.5, interval: 5, due: today - 1, lastReview: 0 },
    }));
    const deck = { id: 1, name: 'D', cards: [...repasos, ...nuevas] };

    const capped = St.buildQueue([deck], { now: t0, newLimit: 20, rng });
    const sinTope = St.buildQueue([deck], { now: t0, newLimit: 0, rng });

    // Hermanas: 4 tarjetas del MISMO pasaje entre otras de pasajes distintos.
    const sibs = {
      id: 2, name: 'S', cards: [
        ...Array.from({ length: 4 }, (_, i) => ({ type: 'cloze', front: 's' + i, src: 'a1' })),
        ...Array.from({ length: 4 }, (_, i) => ({ type: 'cloze', front: 'o' + i, src: 'a' + (i + 2) })),
      ],
    };
    const sq = St.buildQueue([sibs], { now: t0, newLimit: 0, rng }).queue;
    let adyacentes = 0;
    for (let i = 1; i < sq.length; i++) if (sq[i].src && sq[i].src === sq[i - 1].src) adyacentes++;

    const fronts = (q) => q.map(e => deck.cards[e.idx].front);
    return {
      cappedLen: capped.queue.length, held: capped.held.length,
      // El tope recorta NUEVAS, nunca repasos: los 5 repasos siguen enteros.
      repasosEnCola: fronts(capped.queue).filter(f => f.startsWith('r')).length,
      heldSonNuevas: capped.held.every(e => deck.cards[e.idx].front.startsWith('n')),
      sinTopeLen: sinTope.queue.length,
      barajada: fronts(sinTope.queue).join() !== fronts(sinTope.queue.slice().sort((a, b) => a.idx - b.idx)).join(),
      adyacentes,
    };
  }, new Date('2026-07-08T12:00:00').getTime());

  expect(r.cappedLen).toBe(25);            // 5 repasos + 20 nuevas
  expect(r.held).toBe(10);                 // las 10 nuevas que no entraron
  expect(r.repasosEnCola).toBe(5);
  expect(r.heldSonNuevas).toBe(true);
  expect(r.sinTopeLen).toBe(35);
  expect(r.barajada).toBe(true);
  expect(r.adyacentes).toBe(0);            // ninguna pareja del mismo pasaje seguida
});
