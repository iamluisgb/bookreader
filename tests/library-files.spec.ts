import { test, expect, BrowserContext, Page } from '@playwright/test';
import { installDriveMocks, seedDriveToken, createDriveState, DriveState } from './drive-mock';
import { seedProLicense } from './pro-license';
import { createHash } from 'crypto';

// Sync de BIBLIOTECA y de ARCHIVOS entre dos dispositivos reales (contextos
// aislados, mismo Drive en memoria). Es el escenario Play Books completo:
// importo un libro en el PC y en el móvil aparece su ficha, con un botón para
// traerse el archivo.
//
// Antes de esto solo viajaban las anotaciones: en el segundo dispositivo los
// subrayados llegaban a un libro que no existía en su biblioteca.

async function bootDevice(context: BrowserContext, state: DriveState, { pro = true } = {}): Promise<Page> {
  await installDriveMocks(context, state);
  await seedDriveToken(context);
  const page = await context.newPage();
  await page.goto('/');
  if (pro) await seedProLicense(page);
  return page;
}

// Importa un libro con contenido REAL: el id es el SHA-256 del fichero, que es
// justo lo que hace que las anotaciones enganchen tras la descarga.
async function importBook(page: Page, title: string, seed: number, bytes = 2048) {
  return page.evaluate(async ({ title, seed, bytes }) => {
    const Store = await import('/js/library/store.js');
    const DB = await import('/js/ai/db.js');
    const buf = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) buf[i] = (i * 31 + seed) % 251;
    const id = await DB.hashBuffer(buf.buffer.slice(0));
    await Store.putBook({
      id, title, author: 'Autor', format: 'epub', fileName: title + '.epub',
      file: buf.buffer, size: bytes, addedAt: Date.now(), progress: 0,
      status: 'unread', shelfIds: [],
    });
    return id;
  }, { title, seed, bytes });
}

const sync = (page: Page) => page.evaluate(async () => {
  const Engine = await import('/js/sync/engine.js');
  await Engine.syncNow();
});

// Vacía la cola de transferencias (subidas pendientes y descargas encoladas).
const flushBlobs = (page: Page) => page.evaluate(async () => {
  const Blobs = await import('/js/sync/blobs.js');
  await Blobs.flush();
});

const libraryOf = (page: Page) => page.evaluate(async () => {
  const Store = await import('/js/library/store.js');
  const books = await Store.getAllBooks();
  return books.map((b: any) => ({
    id: b.id, title: b.title, author: b.author,
    ghost: Store.isGhost(b), uploaded: !!(b.blob && b.blob.path), size: b.size,
  }));
});

test.describe('Biblioteca y archivos entre dos dispositivos', () => {
  test('el libro del PC aparece en el móvil como ficha descargable, y al bajarlo llega intacto', async ({ browser }) => {
    const drive = createDriveState();
    const pc = await browser.newContext();
    const movil = await browser.newContext();
    try {
      const pcPage = await bootDevice(pc, drive);
      const id = await importBook(pcPage, 'Lituma en los Andes', 7);
      await sync(pcPage);        // sube biblioteca + portadas + manifest
      await flushBlobs(pcPage);  // y el binario
      await sync(pcPage);        // propaga el puntero `blob` recién creado

      const movilPage = await bootDevice(movil, drive);
      await sync(movilPage);

      const enMovil = await libraryOf(movilPage);
      expect(enMovil).toHaveLength(1);
      expect(enMovil[0].id).toBe(id);
      expect(enMovil[0].title).toBe('Lituma en los Andes');
      expect(enMovil[0].author).toBe('Autor');
      expect(enMovil[0].ghost).toBe(true);      // la ficha está, el archivo no
      expect(enMovil[0].uploaded).toBe(true);   // pero se puede traer

      // Descarga bajo demanda: los bytes tienen que hashear al mismo id, que es
      // lo que garantiza que subrayados y notas del libro siguen enganchados.
      const bajado = await movilPage.evaluate(async ({ id }) => {
        const Blobs = await import('/js/sync/blobs.js');
        const Store = await import('/js/library/store.js');
        const DB = await import('/js/ai/db.js');
        await Blobs.requestDownload(id);
        const raw: any = await Store.getRaw(id);
        if (!raw || !raw.file) return { ok: false, hash: null, bytes: 0 };
        return { ok: true, hash: await DB.hashBuffer(raw.file.slice(0)), bytes: raw.file.byteLength };
      }, { id });

      expect(bajado.ok).toBe(true);
      expect(bajado.bytes).toBe(2048);
      expect(bajado.hash).toBe(id);

      const trasDescarga = await libraryOf(movilPage);
      expect(trasDescarga[0].ghost).toBe(false);
    } finally {
      await pc.close(); await movil.close();
    }
  });

  test('sin licencia Pro la ficha llega igual, pero el archivo no se sube ni se descarga', async ({ browser }) => {
    const drive = createDriveState();
    const pc = await browser.newContext();
    const movil = await browser.newContext();
    try {
      // Fase A (metadatos) es gratis; los binarios son la parte de pago.
      const pcPage = await bootDevice(pc, drive, { pro: false });
      const id = await importBook(pcPage, 'Sin Pro', 3);
      await sync(pcPage);
      await flushBlobs(pcPage);
      await sync(pcPage);

      const subidos = [...drive.store.keys()].filter(k => k.startsWith('bookreader/files/'));
      expect(subidos).toHaveLength(0);

      const movilPage = await bootDevice(movil, drive, { pro: false });
      await sync(movilPage);
      const enMovil = await libraryOf(movilPage);
      expect(enMovil).toHaveLength(1);          // la biblioteca SÍ viaja gratis
      expect(enMovil[0].id).toBe(id);
      expect(enMovil[0].ghost).toBe(true);
      expect(enMovil[0].uploaded).toBe(false);  // y no hay nada que descargar
    } finally {
      await pc.close(); await movil.close();
    }
  });

  test('borrar en un dispositivo borra en el otro y libera el archivo de Drive', async ({ browser }) => {
    const drive = createDriveState();
    const pc = await browser.newContext();
    const movil = await browser.newContext();
    try {
      const pcPage = await bootDevice(pc, drive);
      const id = await importBook(pcPage, 'Para borrar', 11);
      await sync(pcPage);
      await flushBlobs(pcPage);
      await sync(pcPage);

      const movilPage = await bootDevice(movil, drive);
      await sync(movilPage);
      expect(await libraryOf(movilPage)).toHaveLength(1);
      expect([...drive.store.keys()].filter(k => k.startsWith('bookreader/files/'))).toHaveLength(1);

      // Se borra en el móvil…
      await movilPage.evaluate(async ({ id }) => {
        const Store = await import('/js/library/store.js');
        await Store.deleteBook(id);
      }, { id });
      await sync(movilPage);
      await flushBlobs(movilPage);

      // …y el PC se entera al sincronizar, sin que el libro resucite.
      await sync(pcPage);
      expect(await libraryOf(pcPage)).toHaveLength(0);
      expect([...drive.store.keys()].filter(k => k.startsWith('bookreader/files/'))).toHaveLength(0);

      // Un segundo ciclo no lo devuelve a la vida (el tombstone gana siempre).
      await sync(pcPage);
      await sync(movilPage);
      expect(await libraryOf(pcPage)).toHaveLength(0);
      expect(await libraryOf(movilPage)).toHaveLength(0);
    } finally {
      await pc.close(); await movil.close();
    }
  });

  test('el mismo libro subido una sola vez: el segundo dispositivo no lo re-sube', async ({ browser }) => {
    const drive = createDriveState();
    const pc = await browser.newContext();
    const movil = await browser.newContext();
    try {
      const pcPage = await bootDevice(pc, drive);
      const id = await importBook(pcPage, 'Compartido', 5);
      await sync(pcPage);
      await flushBlobs(pcPage);
      await sync(pcPage);
      const versionTrasPc = drive.store.get('bookreader/files/' + id + '.epub')!.version;

      // El móvil importa el MISMO fichero por su cuenta (mismo hash, mismo id).
      const movilPage = await bootDevice(movil, drive);
      const idMovil = await importBook(movilPage, 'Compartido', 5);
      expect(idMovil).toBe(id);
      await sync(movilPage);
      await flushBlobs(movilPage);

      // Write-once: el binario es contenido direccionable, re-subirlo solo
      // gastaría cuota y ancho de banda para producir los mismos bytes.
      expect(drive.store.get('bookreader/files/' + id + '.epub')!.version).toBe(versionTrasPc);
    } finally {
      await pc.close(); await movil.close();
    }
  });

  test('las estanterías también sincronizan', async ({ browser }) => {
    const drive = createDriveState();
    const pc = await browser.newContext();
    const movil = await browser.newContext();
    try {
      const pcPage = await bootDevice(pc, drive);
      const id = await importBook(pcPage, 'Con estantería', 13);
      await pcPage.evaluate(async ({ id }) => {
        const Store = await import('/js/library/store.js');
        const sh = await Store.addShelf('Pendientes');
        await Store.toggleBookShelf(id, sh.id, true);
      }, { id });
      await sync(pcPage);

      const movilPage = await bootDevice(movil, drive);
      await sync(movilPage);
      const estanterias = await movilPage.evaluate(async () => {
        const Store = await import('/js/library/store.js');
        const shelves = await Store.getShelves();
        const books = await Store.getAllBooks();
        return { nombres: shelves.map((s: any) => s.name), enLibro: books[0] && books[0].shelfIds };
      });
      expect(estanterias.nombres).toEqual(['Pendientes']);
      expect(estanterias.enLibro).toHaveLength(1);
    } finally {
      await pc.close(); await movil.close();
    }
  });
});

// Subida RESUMABLE (drive-provider · uploadResumable). Por encima de 5 MB Drive
// no admite multipart y hay que abrir sesión y trocear. Es la ruta que siguen
// casi todos los PDFs reales, y la que puede corromper un fichero en silencio si
// la aritmética de offsets falla — el resto de tests usan ficheros de 2 KB y
// solo ejercitan multipart.
test.describe('Ficheros grandes (subida resumable)', () => {
  test.setTimeout(90000);

  test('un libro de 17 MB sube en trozos, se reensambla intacto y se descarga verificado', async ({ browser }) => {
    const drive = createDriveState();
    const pc = await browser.newContext();
    const movil = await browser.newContext();
    try {
      const pcPage = await bootDevice(pc, drive);
      // 17 MB con trozos de 8 MB = 3 peticiones (8 + 8 + 1): hay al menos un
      // trozo INTERMEDIO, que es el único caso donde se ejercita continuar a
      // partir del `Range` que devuelve el 308 en vez de dar el offset por
      // supuesto.
      const id = await importBook(pcPage, 'Tocho ilustrado', 23, 17 * 1024 * 1024);
      await sync(pcPage);
      await flushBlobs(pcPage);

      expect(drive.counters.chunkPuts).toBe(3);
      // Nada reenviado: se ofrecieron exactamente los bytes del fichero.
      expect(drive.counters.chunkBytesOffered).toBe(17 * 1024 * 1024);

      const subido = drive.store.get('bookreader/files/' + id + '.epub');
      expect(subido).toBeTruthy();
      expect(subido!.binary!.length).toBe(17 * 1024 * 1024);
      // El id ES el SHA-256 del fichero: si el reensamblado hubiera duplicado o
      // perdido un byte, este hash no cuadraría.
      expect(createHash('sha256').update(subido!.binary!).digest('hex')).toBe(id);

      // Y la vuelta completa: el otro dispositivo lo baja y lo verifica.
      await sync(pcPage);
      const movilPage = await bootDevice(movil, drive);
      await sync(movilPage);
      const bajado = await movilPage.evaluate(async ({ id }) => {
        const Blobs = await import('/js/sync/blobs.js');
        const Store = await import('/js/library/store.js');
        const DB = await import('/js/ai/db.js');
        await Blobs.requestDownload(id);
        const raw: any = await Store.getRaw(id);
        if (!raw || !raw.file) return { bytes: 0, hash: null };
        return { bytes: raw.file.byteLength, hash: await DB.hashBuffer(raw.file.slice(0)) };
      }, { id });

      expect(bajado.bytes).toBe(17 * 1024 * 1024);
      expect(bajado.hash).toBe(id);
    } finally {
      await pc.close(); await movil.close();
    }
  });

  test('si Drive acepta un trozo a medias, la subida reanuda desde ahí y el fichero no se corrompe', async ({ browser }) => {
    const drive = createDriveState();
    drive.partialAt = 1;   // el primer trozo se acepta solo a medias
    const pc = await browser.newContext();
    try {
      const pcPage = await bootDevice(pc, drive);
      const id = await importBook(pcPage, 'Tocho interrumpido', 29, 17 * 1024 * 1024);
      await sync(pcPage);
      await flushBlobs(pcPage);

      // Se ofrecieron MÁS bytes que el tamaño del fichero: la mitad rechazada
      // del primer trozo se reenvió. (El número de PUTs no cambia: al reanudar
      // más atrás, el último trozo simplemente sale más grande.)
      expect(drive.counters.chunkBytesOffered).toBeGreaterThan(17 * 1024 * 1024);

      const subido = drive.store.get('bookreader/files/' + id + '.epub');
      expect(subido!.binary!.length).toBe(17 * 1024 * 1024);
      // La prueba de fuego: reanudar mal (desde el offset propio en vez del
      // `Range` del servidor) daría este mismo tamaño con los bytes desplazados.
      expect(createHash('sha256').update(subido!.binary!).digest('hex')).toBe(id);
    } finally {
      await pc.close();
    }
  });
});
