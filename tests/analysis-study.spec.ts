import { test, expect } from '@playwright/test';
import { seedProLicense } from './pro-license';

// P44 — Análisis del estudio: retención real, memoria por libro, lo que viene, calibración y
// el ajuste del algoritmo a tu memoria. Los intentos se siembran en el store `attempts` con la
// misma forma que los escribe el repaso (P42 F1).

const DAY = 86400000;

async function seedBook(page: any, { bookId, title, cards }: any) {
  await page.evaluate(async ({ bookId, title, cards }: any) => {
    const DB: any = await import('/js/ai/db.js');
    const Lib: any = await import('/js/library/store.js');
    await Lib.putBook({
      id: bookId, title, format: 'epub', fileName: `${bookId}.epub`,
      addedAt: Date.now(), lastOpenedAt: Date.now(), progress: 0, status: 'reading', shelfIds: [],
    });
    await DB.addDeck({ bookId, name: title, cardType: 'basic', scope: '', cards });
  }, { bookId, title, cards });
}

async function seedAttempts(page: any, records: any[]) {
  await page.evaluate(async (records: any[]) => {
    const DB: any = await import('/js/ai/db.js');
    await DB.mergeAttempts(records);
  }, records);
}

let seq = 0;
function att(o: any) {
  seq++;
  return {
    uid: `at-${seq}`, cardUid: o.card, deckUid: null, bookId: o.book ?? 'bk-a', ts: o.ts ?? Date.now(),
    mode: o.mode ?? 'reveal', verdict: o.verdict ?? null, exact: null, grade: o.grade ?? 'good',
    prevInterval: o.prev === undefined ? 5 : o.prev, latencyMs: o.lat ?? 8000, arm: null, answer: null, cardHash: '',
  };
}

const card = (uid: string, srs?: any) => ({ uid, type: 'basic', front: `q ${uid}`, back: 'a', chapter: '', src: '', ...(srs ? { srs } : {}) });

// ---- Cuentas puras ---------------------------------------------------------------------

test('retención real: primera nota del día, solo tarjetas que tocaban, jóvenes y maduras', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async () => {
    const S: any = await import('/js/ai/study-stats.js');
    const Srs: any = await import('/js/ai/srs.js');
    const now = Date.now();
    const a = (card: string, grade: string, prev: any, ts = now) => ({ cardUid: card, grade, prevInterval: prev, ts, mode: 'reveal' });
    const list = [
      a('x', 'again', 5, now - 1000), a('x', 'good', 0, now),   // fallo y re-encolada: cuenta el fallo
      a('y', 'good', 30), a('z', 'good', 3), a('w', 'hard', 40),
      a('n', 'good', null),                                     // nueva: no tocaba
      { cardUid: null, grade: null, mode: 'widget', ts: now },  // ejercicio: no es retención
    ];
    return {
      ret: S.trueRetention(list),
      time: S.studyTime([{ latencyMs: 5000 }, { latencyMs: 900000 }, { latencyMs: 900000, mode: 'widget' }]),
      split: S.practiceSplit([{ mode: 'reveal', grade: 'good' }, { mode: 'written', verdict: 'good', grade: 'good' }, { mode: 'widget' }, { mode: 'written', grade: 'good' }]),
      calib: S.calibration([
        { mode: 'written', verdict: 'good', grade: 'good' }, { mode: 'written', verdict: 'wrong', grade: 'good' },
        { mode: 'written', verdict: 'partial', grade: 'again' }, { mode: 'reveal', grade: 'good' },
      ]),
      byDay: S.reviewsByDay([{ ts: now }, { ts: now }], { [Srs.dayOf(now)]: { n: 9 }, 5: 4 }),
    };
  });
  expect(r.ret.all).toEqual({ n: 4, ok: 3, rate: 0.75 });
  expect(r.ret.young).toEqual({ n: 2, ok: 1, rate: 0.5 });
  expect(r.ret.mature).toEqual({ n: 2, ok: 2, rate: 1 });
  expect(r.time).toBe(5000 + 60000 + 600000);                 // topes: 60 s tarjeta, 10 min ejercicio
  expect(r.split).toEqual({ practiced: 3, revealed: 1, judged: 2 });
  expect(r.calib).toEqual({ n: 3, self: 2 / 3, agent: 1 / 3 });
  // El día con intentos manda sobre el contador viejo; un día sin intentos usa el viejo.
  expect(Object.values(r.byDay).sort()).toEqual([2, 4]);
});

test('recuerdo estimado, tarjetas que cuestan y carga diaria', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async () => {
    const Srs: any = await import('/js/ai/srs.js');
    const S: any = await import('/js/ai/study-stats.js');
    const now = Date.now();
    const DAY = 86400000;
    const today = Srs.dayOf(now);
    const cards = [
      { srs: { reps: 2, lapses: 0, interval: 10, due: today, lastReview: now - 10 * DAY, stability: 10, difficulty: 5 } }, // R = 0,9
      { srs: { reps: 1, lapses: 4, interval: 1, due: today + 1, lastReview: now, stability: 1, difficulty: 8 } },          // R = 1, difícil
      {},                                                                                                               // nueva
      { deleted: true },
    ];
    return {
      k: Srs.knowledge(cards, now),
      mem: S.bookMemory([{ id: 7, cards }], now),
      load: Srs.dailyLoad(cards),
      work: S.workload([{ cards }], now),
      over: S.overloaded({ days: [30, 30, 30, 30, 30, 30, 30] }, 10),
      notOver: S.overloaded({ days: [12, 12, 12, 12, 12, 12, 12] }, 10),
    };
  });
  expect(r.k.total).toBe(3);
  expect(r.k.known).toBeCloseTo(1.9, 4);
  expect(r.k.share).toBeCloseTo(1.9 / 3, 4);
  expect(r.mem.problems).toBe(1);
  expect(r.mem.problemDeck).toEqual({ deckId: 7, idx: [1] });
  expect(r.load).toBeCloseTo(1 / 10 + 1, 6);
  expect(r.work.dueNow).toBe(1);
  expect(r.work.days[0]).toBe(1);
  expect(r.over).toBe(true);
  expect(r.notOver).toBe(false);
});

test('pausar las nuevas de hoy: la cola se queda sin nuevas y Ajustes sigue enseñando el tope', async ({ page }) => {
  await page.goto('/index.html');
  const r = await page.evaluate(async () => {
    const Study: any = await import('/js/ai/study.js');
    const decks = [{ cards: [{ front: 'a' }, { front: 'b' }, { front: 'c' }] }];
    Study.pauseNewToday();
    const paused = { limit: Study.newLimit(), conf: Study.configuredNewLimit(), q: Study.buildQueue(decks, { newLimit: Study.newLimit() }) };
    Study.resumeNewToday();
    return { paused: { limit: paused.limit, conf: paused.conf, len: paused.q.queue.length, held: paused.q.held.length }, after: Study.newLimit() };
  });
  expect(r.paused).toEqual({ limit: -1, conf: 20, len: 0, held: 3 });
  expect(r.after).toBe(20);
});

// ---- Pantalla --------------------------------------------------------------------------

test('el bloque de estudio: retención con valla de N, practicado y calibración', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const cards = Array.from({ length: 40 }, (_, i) => card(`c${i}`, { reps: 2, lapses: 0, interval: 5, due: 0, lastReview: Date.now(), stability: 5, difficulty: 5 }));
  await seedBook(page, { bookId: 'bk-a', title: 'Designing Data', cards });

  // 10 repasos que tocaban: por debajo de la valla, la pantalla dice cuántos faltan.
  await seedAttempts(page, cards.slice(0, 10).map((c) => att({ card: c.uid })));
  await page.click('[data-act="analysis"]');
  const study = page.locator('#analysis .anal-study');
  await expect(study).toBeVisible();
  await expect(study.locator('.anal-ret--pending')).toContainText('llevas 10');

  // 40 en total (30 bien, 10 otra vez) + 25 escritos juzgados → retención 75 % y calibración.
  await page.click('#analysis .appset-close');
  await seedAttempts(page, [
    ...cards.slice(10, 40).map((c, i) => att({ card: c.uid, grade: i < 20 ? 'good' : 'again' })),
    ...Array.from({ length: 25 }, (_, i) => att({ card: `w${i}`, mode: 'written', verdict: i < 15 ? 'good' : 'wrong', grade: 'good', prev: null })),
  ]);
  await page.click('[data-act="analysis"]');
  await expect(study.locator('.anal-ret-n')).toHaveText('75%');
  await expect(study.locator('.anal-ret')).toContainText('Por debajo');
  await expect(study.locator('.anal-calib')).toContainText('100%');
  await expect(study.locator('.anal-calib')).toContainText('60%');
  await expect(study.locator('.anal-tile', { hasText: 'Practicado' })).toContainText('25');
  await expect(study.locator('.anal-tile', { hasText: 'Solo girar' })).toContainText('40');
  await expect(study.locator('.anal-chart')).toBeVisible();
});

test('por libro: memoria de hoy, «Revisar» lleva a las tarjetas difíciles y la fila filtra la pantalla', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const today = await page.evaluate(async () => ((await import('/js/ai/srs.js')) as any).dayOf(Date.now()));
  const now = Date.now();
  await seedBook(page, {
    bookId: 'bk-a', title: 'Designing Data', cards: [
      card('a1', { reps: 2, lapses: 0, interval: 5, due: today, lastReview: now, stability: 5, difficulty: 5 }),
      card('a2', { reps: 1, lapses: 4, interval: 1, due: today, lastReview: now, stability: 1, difficulty: 9 }),
      card('a3'),
    ],
  });
  await seedBook(page, { bookId: 'bk-b', title: 'Otro libro', cards: [card('b1', { reps: 1, lapses: 0, interval: 3, due: today + 3, lastReview: now, stability: 3, difficulty: 5 })] });
  await seedAttempts(page, [att({ card: 'a1' }), att({ card: 'a2', grade: 'again' }), att({ card: 'b1', book: 'bk-b' })]);

  await page.click('[data-act="analysis"]');
  const row = page.locator('#analysis .anal-book', { hasText: 'Designing Data' });
  await expect(row).toContainText('2 repasos');
  await expect(row.locator('.anal-mem-l')).toHaveText('Recuerdas ~2 de 3 tarjetas');

  // Filtro por libro: la pantalla mira solo a ese libro, con salida y «Repasar este libro».
  await row.locator('.anal-book-t').click();
  await expect(page.locator('#analysis .anal-scope-t')).toHaveText('Designing Data');
  await expect(page.locator('#analysis .anal-scope-study')).toContainText('(3)');
  await expect(page.locator('#analysis .anal-study .anal-tile').first()).toContainText('2');
  await expect(page.locator('#analysis .anal-mem--big')).toContainText('~2 de 3');
  await page.click('#analysis [data-act="all-books"]');
  await expect(page.locator('#analysis .anal-scope')).toHaveCount(0);
  await expect(page.locator('#analysis .anal-book')).toHaveCount(2);

  // «Revisar» abre el mazo con la tarjeta que cuesta señalada.
  await row.locator('.anal-fix').click();
  await expect(page.locator('#analysis')).toBeHidden();
  await expect(page.locator('#decks .fc-item.is-problem')).toHaveCount(1);
  await expect(page.locator('#decks .fc-item.is-problem .fc-front')).toHaveText('q a2');
});

test('lo que viene: previsión, carga y aviso con «Pausar nuevas hoy» cuando no cabe', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  const today = await page.evaluate(async () => ((await import('/js/ai/srs.js')) as any).dayOf(Date.now()));
  const now = Date.now();
  // 30 tarjetas venciendo cada uno de los próximos 7 días; ritmo habitual de 10 al día.
  const cards = Array.from({ length: 210 }, (_, i) => card(`f${i}`, { reps: 2, lapses: 0, interval: 3, due: today + 1 + (i % 7), lastReview: now, stability: 3, difficulty: 5 }));
  await seedBook(page, { bookId: 'bk-a', title: 'Designing Data', cards });
  const past = [];
  for (let d = 1; d <= 5; d++) for (let k = 0; k < 10; k++) past.push(att({ card: `f${k}`, ts: now - d * DAY }));
  await seedAttempts(page, past);

  await page.click('[data-act="analysis"]');
  const work = page.locator('#analysis .anal-work');
  await expect(work.locator('.anal-fc-col')).toHaveCount(7);
  await expect(work.locator('.anal-fc-n').first()).toHaveText('30');
  await expect(work.locator('.anal-tile', { hasText: 'Carga media' })).toContainText('~70 al día');
  await expect(work.locator('.anal-warn')).toContainText('~10 al día');
  await work.locator('[data-act="pause-new"]').click();
  await expect(work.locator('.anal-warn--ok')).toContainText('Nuevas en pausa hoy');
  expect(await page.evaluate(async () => ((await import('/js/ai/study.js')) as any).newLimit())).toBe(-1);
  await work.locator('[data-act="resume-new"]').click();
  await expect(work.locator('[data-act="pause-new"]')).toBeVisible();
});

test('sin estudio no hay bloques de estudio; con lectura sola la pantalla es la de siempre', async ({ page }) => {
  await page.goto('/index.html');
  await page.click('[data-act="analysis"]');
  await expect(page.locator('#analysis .anal-empty')).toBeVisible();
  await expect(page.locator('#analysis .anal-study, #analysis .anal-work, #analysis .anal-fsrs')).toHaveCount(0);
});

test('los bloques de estudio están traducidos (EN)', async ({ page }) => {
  await page.goto('/index.html');
  await page.evaluate(() => localStorage.setItem('bookreader_lang', 'en'));
  await page.reload();
  await seedProLicense(page);
  const today = await page.evaluate(async () => ((await import('/js/ai/srs.js')) as any).dayOf(Date.now()));
  await seedBook(page, { bookId: 'bk-a', title: 'Designing Data', cards: [card('a1', { reps: 2, lapses: 3, interval: 5, due: today + 2, lastReview: Date.now(), stability: 5, difficulty: 5 })] });
  await seedAttempts(page, [att({ card: 'a1' })]);
  await page.click('[data-act="analysis"]');
  await expect(page.locator('#analysis .anal-study')).toBeVisible();
  const txt = await page.locator('#analysis').innerText();
  expect(txt).toContain('True retention');
  expect(txt).toContain("What's coming");
  expect(txt).not.toMatch(/Estudio|Repasos|Retención|Lo que viene|Recuerdas|difíciles|Ajustado|Llevas/);
});

// ---- Ajuste del algoritmo a tu memoria (F4) ----------------------------------------------

// Historias sintéticas de alguien que olvida MÁS deprisa que la persona media: programadas con
// los parámetros de serie (como lo haría la app) y con el resultado de cada repaso sorteado con
// la curva «verdadera». El optimizador debe encontrar algo mejor que los de serie.
async function seedForgetfulHistory(page: any, cardsN: number) {
  return page.evaluate(async (cardsN: number) => {
    const Srs: any = await import('/js/ai/srs.js');
    const DB: any = await import('/js/ai/db.js');
    const Lib: any = await import('/js/library/store.js');
    const DAY = 86400000;
    const TRUE = Srs.DEFAULT_PARAMETERS.slice();
    TRUE[2] = 0.6; TRUE[3] = 2; TRUE[20] = 0.5;          // estabilidad inicial baja, curva más empinada
    let seed = 42;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const start = Date.now() - 120 * DAY;
    const records: any[] = [];
    const cards: any[] = [];
    for (let c = 0; c < cardsN; c++) {
      const uid = `opt-${c}`;
      let day = Math.floor(rnd() * 20);
      let sched: any = null, truth: any = null, prev: any = null, lastDay = day;
      for (let k = 0; k < 6; k++) {
        const elapsed = k ? day - lastDay : 0;
        const p = truth ? Srs.withParameters(TRUE, () => Srs.retrievability(elapsed, truth.stability)) : 1;
        const g = k === 0 ? 3 : rnd() < p ? 3 : 1;
        records.push({ uid: `${uid}-${k}`, cardUid: uid, deckUid: null, bookId: 'bk-opt', ts: start + day * DAY + 3600000,
          mode: 'reveal', verdict: null, exact: null, grade: g === 3 ? 'good' : 'again', prevInterval: prev,
          latencyMs: 6000, arm: null, answer: null, cardHash: '' });
        sched = Srs.nextMemory(sched, g, elapsed);
        truth = Srs.withParameters(TRUE, () => Srs.nextMemory(truth, g, elapsed));
        const interval = g === 1 ? 1 : Math.max(1, Math.round(sched.stability));
        prev = interval;
        lastDay = day;
        day += interval;
      }
      cards.push({ uid, type: 'basic', front: `q${c}`, back: 'a', chapter: '', src: '',
        srs: { reps: 3, lapses: 0, interval: prev, due: Srs.dayOf(start + day * DAY), lastReview: start + lastDay * DAY, stability: sched.stability, difficulty: sched.difficulty } });
    }
    await Lib.putBook({ id: 'bk-opt', title: 'Libro largo', format: 'epub', fileName: 'o.epub', addedAt: Date.now(), lastOpenedAt: Date.now(), progress: 0, status: 'reading', shelfIds: [] });
    await DB.addDeck({ bookId: 'bk-opt', name: 'Libro largo', cardType: 'basic', scope: '', cards });
    await DB.mergeAttempts(records);
    return records.length;
  }, cardsN);
}

test('ajuste a tu memoria: por debajo del mínimo dice cuánto falta', async ({ page }) => {
  await page.goto('/index.html');
  await seedProLicense(page);
  await seedForgetfulHistory(page, 20);                     // 20 × 5 = 100 repasos entrenables
  await page.click('[data-act="analysis"]');
  await expect(page.locator('#analysis .anal-fsrs')).toContainText('Llevas 100');
  await expect(page.locator('#analysis [data-act="fsrs-run"]')).toHaveCount(0);
});

test('ajuste a tu memoria: calcula en el dispositivo, enseña qué cambia y solo aplica si se acepta', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto('/index.html');
  await seedProLicense(page);
  await seedForgetfulHistory(page, 120);                    // 600 repasos entrenables
  await page.click('[data-act="analysis"]');
  const sec = page.locator('#analysis .anal-fsrs');
  await sec.locator('[data-act="fsrs-run"]').click();
  await expect(sec).toContainText('mejor', { timeout: 90000 });
  // Nada cambia hasta aceptar.
  expect(await page.evaluate(() => localStorage.getItem('bookreader_fsrs_params'))).toBeNull();
  await sec.locator('[data-act="fsrs-accept"]').click();
  await expect(sec).toContainText('El repaso usa tus parámetros');
  const r = await page.evaluate(async () => {
    const P: any = await import('/js/ai/fsrs-params.js');
    const Srs: any = await import('/js/ai/srs.js');
    P.applyStored();
    const st = P.stored();
    return { n: st.w.length, defaults: Srs.usingDefaults(), better: st.lossPersonal < st.lossDefault };
  });
  expect(r).toEqual({ n: 21, defaults: false, better: true });

  // Y se puede volver a los de serie (se guarda la vuelta, para que viaje por sync).
  await sec.locator('[data-act="fsrs-reset"]').click();
  await expect(sec.locator('[data-act="fsrs-run"]')).toBeVisible();
  expect(await page.evaluate(async () => {
    const P: any = await import('/js/ai/fsrs-params.js');
    const Srs: any = await import('/js/ai/srs.js');
    P.applyStored();
    return Srs.usingDefaults();
  })).toBe(true);
});
