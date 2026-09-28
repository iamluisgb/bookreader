import { test, expect } from '@playwright/test';

// P10/P19 · Modo Estudiar — unit del scheduler FSRS-5 (js/ai/srs.js). Módulo puro: se prueba
// con fechas inyectadas (determinista, sin LLM ni IndexedDB).

const DAY = 86400000;
// Mediodía local: lejos de la medianoche, dayOf no baila con el huso.
const T0 = new Date('2026-07-08T12:00:00').getTime();

// P19 · FSRS-5 sustituye a SM-2. Estos tests fijan las PROPIEDADES del scheduler (no los
// decimales de los pesos): una tarjeta nueva arranca en días, cada acierto espaciado alarga el
// intervalo, un fallo vuelve a hoy y cuenta el lapse, y los botones nunca se contradicen.
test('FSRS: ciclo de vida de una tarjeta y fallo (lapse)', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async (t0) => {
    const S: any = await import('/js/ai/srs.js');
    const day = 86400000;
    const first = S.grade(null, 'good', t0);
    const second = S.grade(first, 'good', t0 + first.interval * day);
    const third = S.grade(second, 'good', t0 + (first.interval + second.interval) * day);
    const at = t0 + 90 * day;
    const lapsed = S.grade(third, 'again', at);
    const relearn = S.grade(lapsed, 'good', at);          // mismo día: término de corto plazo
    const prev = S.previewIntervals(third, at);
    return {
      first: { interval: first.interval, reps: first.reps, dueDelta: first.due - S.dayOf(t0), hasDSR: first.stability > 0 && first.difficulty >= 1 && first.difficulty <= 10 },
      grows: second.interval > first.interval && third.interval > second.interval,
      lapse: { reps: lapsed.reps, interval: lapsed.interval, lapses: lapsed.lapses, dueIsToday: lapsed.due === S.dayOf(at), smaller: lapsed.stability < third.stability },
      relearn: relearn.interval,
      ordered: prev.hard <= prev.good && prev.good < prev.easy,
      immutable: first.reps === 1 && second.reps === 2,
    };
  }, T0);

  expect(r.first.interval).toBe(3);                       // FSRS-5: S0(bien) ≈ 3,17 días
  expect(r.first.reps).toBe(1);
  expect(r.first.dueDelta).toBe(3);
  expect(r.first.hasDSR).toBe(true);
  expect(r.grows).toBe(true);
  expect(r.lapse).toEqual({ reps: 0, interval: 0, lapses: 1, dueIsToday: true, smaller: true });
  expect(r.relearn).toBeGreaterThanOrEqual(1);
  expect(r.ordered).toBe(true);
  expect(r.immutable).toBe(true);
});

// Las tarjetas programadas con SM-2 no se pierden: su primer repaso con FSRS parte de lo que
// ya se sabía de ellas (su intervalo), no de cero.
test('FSRS: una tarjeta programada con SM-2 se convierte sin perder su progreso', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async (t0) => {
    const S: any = await import('/js/ai/srs.js');
    const day = 86400000;
    const sm2 = { reps: 3, lapses: 0, ease: 2.5, interval: 15, due: S.dayOf(t0), lastReview: t0 - 15 * day };
    const next = S.grade(sm2, 'good', t0);
    return { interval: next.interval, stability: next.stability, reps: next.reps };
  }, T0);
  expect(r.interval).toBeGreaterThan(15);                 // sigue creciendo desde donde iba
  expect(r.stability).toBeGreaterThan(15);
  expect(r.reps).toBe(4);
});

test('isDue/dueCount/deckStats y previews de intervalo en palabras', async ({ page }) => {
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
    return {
      due: S.dueCount(cards, t0),
      dueFlags: cards.map(c => S.isDue(c, t0)),
      stats: S.deckStats(cards, t0),
      prev: S.previewIntervals(null, t0),
      labels: [S.intervalLabel(0), S.intervalLabel(1), S.intervalLabel(6), S.intervalLabel(45), S.intervalLabel(400)],
      capped: S.grade({ reps: 9, lapses: 0, ease: 2.5, interval: 300, due: today, lastReview: t0 - 300 * day, stability: 300, difficulty: 3 }, 'easy', t0).interval,
    };
  }, T0);

  expect(r.due).toBe(3);
  expect(r.dueFlags).toEqual([true, true, false, true]);
  expect(r.stats).toEqual({ total: 4, nuevas: 1, aprendiendo: 1, maduras: 2, due: 3, suspendidas: 0 });
  expect(r.prev).toEqual({ again: 0, hard: 1, good: 3, easy: 16 });   // nueva: FSRS-5 por defecto
  expect(r.labels).toEqual(['ahora', 'mañana', '6 días', '2 meses', '1.1 años']);
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
