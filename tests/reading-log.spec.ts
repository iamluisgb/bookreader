import { test, expect } from '@playwright/test';
import path from 'path';

const EPUB_PATH = path.join(__dirname, 'test.epub');

// P25 F1 — el registro de lectura sólo cuenta lo que se pudo LEER. Tests deterministas:
// el reloj se inyecta en `position()`, así que no hay esperas reales.
//
// Unidad de prueba: 205 palabras (una localización de epub.js), maxStep 4. A ese tamaño,
// 40 s por unidad son ~307 wpm (lectura), 5 s son ~2460 wpm (barrido) y 200 s pasan del
// corte de inactividad.

const BOOK = { unitWords: 205, maxStep: 4 };

test('clasifica el tramo: lectura, barrido, inactividad y salto', async ({ page }) => {
  await page.goto('/');
  const v = await page.evaluate(async () => {
    const RL = await import('/js/reading-log.js');
    // Sin señales intermedias el hueco es el tramo entero (gap = dt).
    const c = (from: number, to: number, dt: number, gap = dt) => RL.classify(from, to, dt, gap, 205, 4);
    return {
      read: c(10, 11, 40000),
      skim: c(10, 11, 5000),
      idle: c(10, 11, 200000),
      seekFar: c(10, 40, 40000),
      seekBack: c(10, 9, 40000),
      hold: c(10, 10, 40000),
      // Lector lento con señales de vida (páginas más pequeñas que la unidad): tres
      // minutos por localización son ~68 wpm, gente leyendo despacio, no gente ausente.
      lento: c(10, 11, 180000, 45000),
      // Los mismos tres minutos SIN tocar nada: eso ya no es leer.
      ausente: c(10, 11, 180000, 180000),
    };
  });
  expect(v).toEqual({
    read: 'read', skim: 'skim', idle: 'idle',
    seekFar: 'seek', seekBack: 'seek', hold: 'hold',
    lento: 'read', ausente: 'idle',
  });
});

test('leer a ritmo humano suma tiempo y palabras; barrer no suma nada', async ({ page }) => {
  await page.goto('/');
  const res = await page.evaluate(async (book) => {
    const RL = await import('/js/reading-log.js');
    const t0 = Date.now();

    // Lectura: seis unidades seguidas, 40 s cada una.
    await RL.startBook('libro-leido', book);
    for (let i = 0; i <= 6; i++) RL.position(100 + i, t0 + i * 40000);
    RL.endBook(t0 + 6 * 40000);            // sin tramo abierto que premiar
    await RL.flush();
    const leido = await RL.summary(1, t0);

    // Barrido: las mismas seis unidades, pero a 5 s por unidad.
    await RL.startBook('libro-barrido', book);
    for (let i = 0; i <= 6; i++) RL.position(100 + i, t0 + i * 5000);
    RL.endBook(t0 + 6 * 5000);
    await RL.flush();
    const barrido = await RL.summary(1, t0);

    return {
      ms: leido.books['libro-leido'].ms,
      words: leido.books['libro-leido'].words,
      units: leido.books['libro-leido'].units,
      barrido: barrido.books['libro-barrido'] || null,
    };
  }, BOOK);

  expect(res.ms).toBe(6 * 40000);          // los seis tramos, ni uno más
  expect(res.units).toBe(6);
  expect(res.words).toBe(6 * 205);
  expect(res.barrido).toBeNull();          // pasar páginas rápido no es haber leído
});

test('tras un salto hay modo consulta: los primeros tramos no cuentan', async ({ page }) => {
  await page.goto('/');
  const res = await page.evaluate(async (book) => {
    const RL = await import('/js/reading-log.js');
    const t0 = Date.now();
    await RL.startBook('libro-consulta', book);
    RL.position(10, t0);
    RL.markJump();                          // salto desde el índice a la unidad 500
    // Seis tramos de lectura legítima: los tres primeros los devora la consulta.
    for (let i = 0; i <= 6; i++) RL.position(500 + i, t0 + 1000 + i * 40000);
    RL.endBook(t0 + 1000 + 6 * 40000);
    await RL.flush();
    const s = await RL.summary(1, t0);
    return s.books['libro-consulta'];
  }, BOOK);

  expect(res.units).toBe(3);               // 6 tramos − 3 de consulta
  expect(res.ms).toBe(3 * 40000);
});

test('rastrear el capítulo a saltos no suma ni un minuto', async ({ page }) => {
  await page.goto('/');
  const res = await page.evaluate(async (book) => {
    const RL = await import('/js/reading-log.js');
    const t0 = Date.now();
    await RL.startBook('libro-rastreo', book);
    // Diez saltos por el capítulo mirando cada sitio unos segundos: lo que uno hace
    // buscando una cita. Cada salto reinicia la consulta, así que nunca sale de ella.
    for (let i = 0; i < 10; i++) {
      RL.markJump();
      RL.position(300 + i * 7, t0 + i * 8000);
    }
    RL.endBook(t0 + 10 * 8000);
    await RL.flush();
    const s = await RL.summary(1, t0);
    return s.books['libro-rastreo'] || null;
  }, BOOK);

  expect(res).toBeNull();
});

test('releer no multiplica lo leído, pero el tiempo sigue contando', async ({ page }) => {
  await page.goto('/');
  const res = await page.evaluate(async (book) => {
    const RL = await import('/js/reading-log.js');
    const t0 = Date.now();
    await RL.startBook('libro-releido', book);
    for (let i = 0; i <= 4; i++) RL.position(10 + i, t0 + i * 40000);
    RL.endBook(t0 + 4 * 40000);
    await RL.flush();

    // Vuelta atrás y otra pasada por las MISMAS unidades (el salto atrás gasta consulta,
    // así que se le dan tramos de sobra y se mide sólo lo que cambia).
    await RL.startBook('libro-releido', book);
    const t1 = t0 + 600000;
    RL.markJump();
    for (let i = 0; i <= 8; i++) RL.position(10 + i, t1 + i * 40000);
    RL.endBook(t1 + 8 * 40000);
    await RL.flush();

    const s = await RL.summary(1, t0);
    return s.books['libro-releido'];
  }, BOOK);

  // Unidades 10..18 son 8 tramos; 3 se los come la consulta → 5 contados, de los cuales
  // sólo 14..18 (4) son nuevos respecto a la primera pasada... el tiempo, en cambio, suma.
  expect(res.units).toBe(8);                       // 4 de la primera pasada + 4 nuevas
  expect(res.words).toBe(8 * 205);                 // nunca 4+5 unidades de palabras
  expect(res.ms).toBe(4 * 40000 + 5 * 40000);      // releer sí cuesta tiempo
});

// El cableado: el lector tiene que ENTREGAR el índice de localización junto al %. Sin él
// el registro no puede medir avance (un 1% redondeado son varias localizaciones de golpe).
test('el lector entrega la localización, no sólo el porcentaje', async ({ page }) => {
  await page.goto('/');
  const fc = page.waitForEvent('filechooser');
  await page.click('.lib-empty .lib-upload');
  await (await fc).setFiles(EPUB_PATH);
  await page.waitForSelector('#epub-container iframe', { timeout: 15000 });
  await page.waitForFunction(() => {
    const f = document.querySelector('#epub-container iframe') as HTMLIFrameElement;
    return f && f.clientHeight > 100;
  });
  // Las localizaciones se generan tras abrir: sin ellas el índice todavía es 0.
  await page.waitForFunction(async () => {
    const R: any = await import('/js/epub-reader.js');
    const b = R.getBook();
    try { return !!b && b.locations && b.locations.length() > 1; } catch { return false; }
  }, null, { timeout: 20000 });

  const units = await page.evaluate(async () => {
    const R: any = await import('/js/epub-reader.js');
    const seen: number[] = [];
    R.onProgress((pct: number, unit: number) => seen.push(unit));
    for (let i = 0; i < 6; i++) {
      R.next();
      await new Promise(r => setTimeout(r, 300));
    }
    return seen;
  });

  expect(units.length).toBeGreaterThan(2);
  expect(units.every(u => u > 0)).toBe(true);              // hay localización, no 0
  expect(units[units.length - 1]).toBeGreaterThan(units[0]);  // y avanza al pasar página
});

// El caso que destapó la prueba en la app real: en móvil (o con letra grande) una página
// de pantalla es MÁS PEQUEÑA que una localización, así que se pasan varias páginas sin que
// la unidad se mueva. Eso es lectura, y tiene que contar.
test('páginas más pequeñas que la unidad: el lector lento cuenta', async ({ page }) => {
  await page.goto('/');
  const res = await page.evaluate(async (book) => {
    const RL = await import('/js/reading-log.js');
    const t0 = Date.now();
    await RL.startBook('libro-lento', book);
    // Tres vueltas de página de 45 s dentro de la misma localización, y a la cuarta
    // cambia: 180 s por unidad ≈ 68 wpm. Despacio, pero leyendo.
    let t = t0;
    for (let u = 10; u < 13; u++) {
      for (let i = 0; i < 3; i++) { RL.position(u, t); t += 45000; }
      RL.position(u + 1, t);
    }
    RL.endBook(t);
    await RL.flush();
    const s = await RL.summary(1, t0);
    return s.books['libro-lento'];
  }, BOOK);

  expect(res.units).toBe(3);
  expect(res.ms).toBeGreaterThan(3 * 120000);   // más de lo que el corte de 2 min permitía
});
