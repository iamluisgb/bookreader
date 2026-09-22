import { test, expect } from '@playwright/test';

// Merge de BIBLIOTECA (sync/merge.js · mergeMaps y sync/library-sync.js).
// Unidad pura: no toca Drive, solo las reglas de fusión de mapas por id, que son
// las que deciden si un libro sobrevive, se borra o pierde su puntero al fichero
// cuando dos dispositivos escriben a la vez.

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('mergeMaps: unión por id, LWW por updatedAt y tombstones que ganan el empate', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { mergeMaps } = await import('/js/sync/merge.js');
    const local = {
      solo_local: { title: 'A', updatedAt: 10 },
      ambos_gana_local: { title: 'nuevo', updatedAt: 20 },
      ambos_gana_remoto: { title: 'viejo', updatedAt: 5 },
      empate_borrado: { title: 'X', updatedAt: 7 },
    };
    const remote = {
      solo_remoto: { title: 'B', updatedAt: 11 },
      ambos_gana_local: { title: 'viejo', updatedAt: 12 },
      ambos_gana_remoto: { title: 'nuevo', updatedAt: 30 },
      empate_borrado: { title: 'X', updatedAt: 7, deleted: true, deletedAt: 7 },
    };
    return {
      ab: mergeMaps(local, remote),
      ba: mergeMaps(remote, local),
    };
  });

  expect(out.ab.solo_local.title).toBe('A');
  expect(out.ab.solo_remoto.title).toBe('B');
  expect(out.ab.ambos_gana_local.title).toBe('nuevo');
  expect(out.ab.ambos_gana_remoto.title).toBe('nuevo');
  // En empate exacto de updatedAt gana el borrado, y da igual el orden de los
  // operandos: si no fuera conmutativo, dos dispositivos llegarían a estados
  // distintos con los mismos datos.
  expect(out.ab.empate_borrado.deleted).toBe(true);
  expect(out.ba.empate_borrado.deleted).toBe(true);
  // Conmutatividad del CONTENIDO. El orden de las claves sí depende del orden de
  // los operandos, y por eso el engine calcula su huella con claves ordenadas
  // (stable()): comparando el JSON crudo, dos bibliotecas idénticas parecerían
  // distintas y los dispositivos se reescribirían el fichero en bucle.
  const sorted = (o: any) => JSON.stringify(o, Object.keys(o).sort());
  expect(sorted(out.ab)).toBe(sorted(out.ba));
});

test('mergeMaps: los campos monótonos sobreviven aunque el otro lado gane el LWW', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { mergeMaps } = await import('/js/sync/merge.js');
    // El dispositivo que subió el fichero (blob) es el que tiene el updatedAt
    // VIEJO; el otro solo avanzó su progreso de lectura. Sin campos monótonos,
    // el ganador del LWW borraría el puntero al binario y nadie podría
    // descargarlo nunca más.
    const local = { libro: { title: 'Libro', progress: 40, updatedAt: 99, blob: null } };
    const remote = { libro: { title: 'Libro', progress: 5, updatedAt: 50, blob: { path: 'bookreader/files/libro.epub' } } };
    const merged = mergeMaps(local, remote, { monotone: ['blob', 'title'] });
    // Un tombstone no rescata nada: borrado es borrado.
    const conBorrado = mergeMaps(
      { libro: { updatedAt: 99, deleted: true, deletedAt: 99, blob: null } },
      remote,
      { monotone: ['blob'] },
    );
    return { merged: merged.libro, conBorrado: conBorrado.libro };
  });

  expect(out.merged.progress).toBe(40);                    // gana el LWW
  expect(out.merged.blob.path).toBe('bookreader/files/libro.epub');  // pero el blob se conserva
  expect(out.conBorrado.blob).toBe(null);
});

test('applyLibrary: crea la ficha fantasma y nunca pisa el fichero local ya descargado', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const Store = await import('/js/library/store.js');
    const LibrarySync = await import('/js/sync/library-sync.js');

    // Este dispositivo tiene "local" descargado; el remoto trae además "remoto".
    await Store.putBook({
      id: 'local', title: 'Local', format: 'epub', progress: 10,
      file: new ArrayBuffer(1024), size: 1024,
    });

    await LibrarySync.applyLibrary({
      books: {
        local: { title: 'Local', format: 'epub', progress: 80, updatedAt: Date.now() + 1000, blob: { path: 'p' } },
        remoto: { title: 'Remoto', format: 'pdf', size: 2048, updatedAt: Date.now(), blob: { path: 'q' } },
      },
      shelves: { sh_1: { name: 'Ensayo', createdAt: 1, updatedAt: 1 } },
    });

    const books = await Store.getAllBooks();
    const localRaw: any = await Store.getRaw('local');
    const shelves = await Store.getShelves();
    return {
      ids: books.map((b: any) => b.id).sort(),
      localBytes: localRaw.file ? localRaw.file.byteLength : 0,
      localProgress: localRaw.progress,
      remotoEsFantasma: Store.isGhost(books.find((b: any) => b.id === 'remoto')),
      localEsFantasma: Store.isGhost(books.find((b: any) => b.id === 'local')),
      shelfName: shelves[0] && shelves[0].name,
    };
  });

  expect(out.ids).toEqual(['local', 'remoto']);
  expect(out.localBytes).toBe(1024);      // el binario sobrevive al merge de metadatos
  expect(out.localProgress).toBe(80);     // pero el progreso remoto, más nuevo, sí entra
  expect(out.localEsFantasma).toBe(false);
  expect(out.remotoEsFantasma).toBe(true);
  expect(out.shelfName).toBe('Ensayo');   // las estanterías también viajan
});

test('borrar deja tombstone: el libro no revive al volver a aplicar el remoto que aún lo tenía vivo', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const Store = await import('/js/library/store.js');
    const LibrarySync = await import('/js/sync/library-sync.js');

    await Store.putBook({ id: 'x', title: 'X', format: 'epub', file: new ArrayBuffer(8), size: 8 });
    const antes = (await Store.getAllBooks()).length;
    await Store.deleteBook('x');
    const despues = (await Store.getAllBooks()).length;

    // El otro dispositivo todavía no se enteró y sigue anunciándolo vivo, con un
    // updatedAt anterior al borrado: el tombstone tiene que ganar.
    await LibrarySync.applyLibrary({
      books: { x: { title: 'X', format: 'epub', updatedAt: 1, deleted: false } },
    });
    const traSync = (await Store.getAllBooks()).length;
    const raw: any = await Store.getRaw('x');
    return { antes, despues, traSync, deleted: !!raw.deleted, tieneFichero: !!raw.file };
  });

  expect(out.antes).toBe(1);
  expect(out.despues).toBe(0);
  expect(out.traSync).toBe(0);      // sin tombstone, aquí el libro habría "resucitado"
  expect(out.deleted).toBe(true);
  expect(out.tieneFichero).toBe(false);   // borrar libera el binario de inmediato
});

test('quitar la descarga deja la ficha y no viaja en el sync', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const Store = await import('/js/library/store.js');
    const LibrarySync = await import('/js/sync/library-sync.js');

    await Store.putBook({
      id: 'y', title: 'Y', format: 'epub', size: 4096,
      file: new ArrayBuffer(4096), blob: { path: 'bookreader/files/y.epub' },
    });
    const antes = await LibrarySync.buildLibrary();
    await Store.removeDownload('y');
    const despues = await LibrarySync.buildLibrary();
    const raw: any = await Store.getRaw('y');
    const listado = (await Store.getAllBooks())[0];

    return {
      sigueEnBiblioteca: !!listado,
      esFantasma: Store.isGhost(listado),
      tieneFichero: !!raw.file,
      // Lo que viaja tiene que ser IDÉNTICO: si "quitar descarga" cambiara el
      // payload, el resto de dispositivos creerían que hay algo que aplicar.
      payloadIgual: JSON.stringify(antes.books.y) === JSON.stringify(despues.books.y),
      conservaBlob: !!despues.books.y.blob,
    };
  });

  expect(out.sigueEnBiblioteca).toBe(true);
  expect(out.esFantasma).toBe(true);
  expect(out.tieneFichero).toBe(false);
  expect(out.payloadIgual).toBe(true);
  expect(out.conservaBlob).toBe(true);
});

test('getAllBooks no carga los binarios en memoria', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const Store = await import('/js/library/store.js');
    await Store.putBook({ id: 'big', title: 'Big', format: 'epub', file: new ArrayBuffer(64 * 1024), size: 64 * 1024 });
    const listado: any = (await Store.getAllBooks())[0];
    const raw: any = await Store.getRaw('big');
    return {
      listadoTraeFichero: listado.file !== undefined,
      listadoMarcaFichero: listado.hasLocalFile,
      hasFileEnListado: Store.hasFile(listado),
      rawTraeFichero: !!raw.file,
    };
  });

  expect(out.listadoTraeFichero).toBe(false);
  expect(out.listadoMarcaFichero).toBe(true);
  expect(out.hasFileEnListado).toBe(true);
  expect(out.rawTraeFichero).toBe(true);
});

// La miniatura que viaja en covers.json tiene que aguantar la rejilla en retina:
// ~300 px CSS de tarjeta × 2 de DPR ≈ 600 px físicos. El ancho viejo (200) se veía
// pixelado en cuanto la ventana pasaba de estrecha — es el motivo del bump a 480.
test('makeThumb reescala la portada al ancho de miniatura actual, sin pasarse', async ({ page }) => {
  await page.goto('/');
  const out = await page.evaluate(async () => {
    const { makeThumb } = await import('/js/sync/library-sync.js');
    // Portada "grande": 1000 px de ancho, con ruido para que el JPEG no colapse a nada.
    const c = document.createElement('canvas');
    c.width = 1000; c.height = 1400;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1000, 1400);
    for (let i = 0; i < 4000; i++) {
      ctx.fillStyle = `hsl(${i % 360}, 50%, 50%)`;
      ctx.fillRect((i * 37) % 1000, (i * 53) % 1400, 3, 3);
    }
    const grande = c.toDataURL('image/png');
    const thumb = await makeThumb(grande);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = thumb; });
    // Y una mini ya: pasa casi tal cual (nada que reescalar).
    c.width = 120; c.height = 168;
    const pequena = c.toDataURL('image/png');
    const t2 = await makeThumb(pequena);
    const img2 = new Image();
    await new Promise((res, rej) => { img2.onload = res; img2.onerror = rej; img2.src = t2; });
    return { w: img.naturalWidth, h: img.naturalHeight, w2: img2.naturalWidth, len: grande.length };
  });

  expect(out.w).toBeLessThanOrEqual(480);
  expect(out.w).toBeGreaterThan(400);   // ni de coña 200: eso era lo pixelado
  expect(out.h).toBe(672);              // 1400 × (480/1000), proporción intacta
  expect(out.w2).toBe(120);             // la pequeña no se agranda
});

// La adopción de portadas es por ANCHO real, no por bytes: una v1 densa (arte pintado,
// 200px, muchos KB) puede pesar lo mismo que una v2 plana (O'Reilly blanca, 480px, pocos
// KB). El tamaño solo pre-filtra; con bytes ambiguos se decodifican y manda el ancho.
test('applyCovers adopta la portada más ancha y respeta la original local', async ({ page }) => {
  await page.goto('/');
  const out = await page.evaluate(async () => {
    const LibStore = await import('/js/library/store.js');
    const { applyCovers } = await import('/js/sync/library-sync.js');
    const dataUrl = (w) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = Math.round(w * 1.4);
      return c.toDataURL('image/jpeg', 0.8);
    };
    // A: fantasma con el thumb v1 (100px, pocos bytes) → la remota (300px, más bytes) entra.
    // B: original local de 600px (muchos bytes) → la remota (480px, menos bytes) NO entra.
    // C: sin portada → adopta directamente.
    await LibStore.putBook({ id: 'cov_a', title: 'A', cover: dataUrl(100), deleted: false });
    await LibStore.putBook({ id: 'cov_b', title: 'B', cover: dataUrl(600), deleted: false });
    await LibStore.putBook({ id: 'cov_c', title: 'C', deleted: false });
    const remotaA = dataUrl(300), remotaB = dataUrl(480), remotaC = dataUrl(480);
    const changed = await applyCovers({ covers: { cov_a: remotaA, cov_b: remotaB, cov_c: remotaC } });
    const raw = await LibStore.getAllRecords();
    const por = Object.fromEntries(raw.map((b) => [b.id, b.cover]));
    return { changed, a: por.cov_a, b: por.cov_b, c: por.cov_c, remotaA, remotaB, remotaC };
  });

  expect(out.changed).toBe(2);
  expect(out.a).toBe(out.remotaA);     // v1 → adopta la más ancha
  expect(out.b).not.toBe(out.remotaB); // la original local manda
  expect(out.c).toBe(out.remotaC);     // sin portada, adopta
});
