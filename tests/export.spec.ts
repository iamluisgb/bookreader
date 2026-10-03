import { test, expect } from '@playwright/test';
import path from 'path';

const EPUB_PATH = path.join(__dirname, 'test.epub');

// P8 · Export legible y selectivo de UNA conversación (libreta + chat). Sembramos el store
// (convo + notas + mensajes + anclas) y verificamos el Markdown: incluye el chat, preserva el
// contenido de las notas y resuelve las citas [[aN]] a "(pág. N)".

test('buildConvoMarkdown: libreta + chat, formato y citas resueltas', async ({ page }) => {
  await page.goto('/index.html');

  const md = await page.evaluate(async () => {
    const DB = await import('/js/ai/db.js');
    const Backup = await import('/js/backup.js');
    const bookId = 'book-p8-test';

    // Anclas para resolver citas (como si el libro estuviera segmentado).
    await DB.saveSegmented(bookId, 'Libro P8', {
      annotatedText: '', tokenEstimate: 0, blockCount: 1,
      anchors: new Map([['a5', { page: 42, chapter: 'Cap 6' }]]),
    });

    const convo = await DB.createConvo(bookId, 't3-juicio', 'entender el capítulo 6', 'Mi sesión');
    await DB.addNote(convo.id, 'claim', 'La **tesis** central es X según [[a5]].');
    await DB.addMessage(convo.id, 'user', '¿Qué dice la Figure 6.2?');
    await DB.addMessage(convo.id, 'assistant', 'Explica el flujo, ver [[a5]].');

    return Backup.buildConvoMarkdown(convo.id, { includeChat: true, includeNotebook: true });
  });

  // Cabecera con objetivo.
  expect(md).toContain('entender el capítulo 6');
  // Libreta con la nota, preservando el markdown (negritas intactas).
  expect(md).toContain('## Libreta');
  expect(md).toContain('La **tesis** central es X');
  // Chat incluido con ambos roles y su contenido.
  expect(md).toContain('## Conversación');
  expect(md).toContain('**Tú:**');
  expect(md).toContain('¿Qué dice la Figure 6.2?');
  expect(md).toContain('**Agente:**');
  // Citas resueltas a pág.
  expect(md).toContain('(pág. 42)');
  expect(md).not.toContain('[[a5]]');
});

test('el botón de exportar del panel descarga un .md', async ({ page }) => {
  await page.goto('/index.html');
  await page.evaluate((k) => localStorage.setItem('bookreader_ai_key', JSON.stringify(k)), 'test-key');
  await page.reload();
  // Stub del LLM para completar el onboarding sin red.
  await page.evaluate(() => {
    const real = window.fetch.bind(window);
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions')) return new Response(JSON.stringify({ choices: [{ message: { content: 'LISTO' } }] }), { status: 200 });
      return real(url, opts);
    };
  });

  const fc = page.waitForEvent('filechooser');
  await page.click('.lib-empty .lib-upload');
  await (await fc).setFiles(EPUB_PATH);
  await page.waitForSelector('#ai-toggle:not([disabled])', { timeout: 15000 });
  await page.click('#ai-toggle');
  await page.waitForSelector('.ai-onboarding', { timeout: 5000 });
  await page.click('.ai-ob-tpl[data-tpl="t3-juicio"]');
  await page.fill('#ai-ob-goal', 'objetivo de prueba');
  await page.click('#ai-ob-start');
  // Exportar vive en el menú del selector de conversación (antes era un icono del toolbar).
  await expect(page.locator('#ai-convo-btn')).toBeVisible({ timeout: 5000 });
  await page.click('#ai-convo-btn');
  const exportItem = page.locator('.ai-convo-menu [data-act="export"]');
  await expect(exportItem).toBeVisible({ timeout: 5000 });

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }),
    exportItem.click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.md$/);
});

test('el backup round-trip conserva mazos (con estado FSRS) y artefactos del Studio', async ({ page }) => {
  await page.goto('/index.html');
  const result = await page.evaluate(async () => {
    const DB = await import('/js/ai/db.js');
    const Backup = await import('/js/backup.js');

    // Mazo con una tarjeta ya repasada (estado FSRS) y una nueva (sin srs).
    await DB.addDeck({
      bookId: 'book-bk-rt', name: 'Mazo round-trip', cardType: 'qa', scope: 'cap 1',
      cards: [
        { front: '¿P1?', back: 'R1', srs: { stability: 3.5, difficulty: 5.2, due: Date.now() - 86400000, reps: 2, lapses: 0, state: 'review' } },
        { front: '¿P2?', back: 'R2' },
      ],
    });
    // Artefacto del Studio (mapa mental) con su resultado cacheado.
    await DB.putArtifact({
      bookId: 'book-bk-rt', kind: 'mindmap',
      result: { nodes: [{ id: 'n1', label: 'Raíz' }], edges: [] },
    });

    const backup = JSON.parse(JSON.stringify(await Backup.buildBackup()));

    // Simular un dispositivo limpio: vaciar las dos tiendas antes de restaurar.
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('bookreader_ai', 7);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['decks', 'artifacts'], 'readwrite');
        tx.objectStore('decks').clear();
        tx.objectStore('artifacts').clear();
        tx.oncomplete = () => { db.close(); resolve(null); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });

    await Backup.importBackup(backup);
    const decks = await DB.getAll('decks');
    const artifacts = await DB.getAll('artifacts');
    const deck = decks.find(d => d.name === 'Mazo round-trip');
    const art = artifacts.find(a => a.kind === 'mindmap');
    return {
      deckCards: deck ? deck.cards.map(c => ({ front: c.front, srs: c.srs || null })) : null,
      artifact: art ? { kind: art.kind, result: art.result } : null,
    };
  });

  // El mazo completo sobrevive: dos tarjetas, con y sin estado FSRS.
  expect(result.deckCards).toHaveLength(2);
  const graded = result.deckCards.find(c => c.front === '¿P1?');
  expect(graded.srs).toMatchObject({ stability: 3.5, state: 'review' });
  expect(result.deckCards.find(c => c.front === '¿P2?').srs).toBeNull();
  // El artefacto sobrevive con su resultado intacto.
  expect(result.artifact).toEqual({ kind: 'mindmap', result: { nodes: [{ id: 'n1', label: 'Raíz' }], edges: [] } });
});

test('importar un backup viejo (sin mazos ni artefactos) no rompe', async ({ page }) => {
  await page.goto('/index.html');
  const result = await page.evaluate(async () => {
    const DB = await import('/js/ai/db.js');
    const Backup = await import('/js/backup.js');

    await DB.addDeck({
      bookId: 'book-bk-old', name: 'Mazo preexistente', cardType: 'qa', scope: 'x',
      cards: [{ front: 'A', back: 'B' }],
    });

    // Backup de una versión anterior: la clave `ai` existe pero sin `decks`/`artifacts`.
    const oldBackup = {
      format: 'bookreader-backup', version: 1, exportedAt: new Date().toISOString(),
      localStorage: {},
      ai: { convos: [], messages: [], notes: [], ratings: [], books: [] },
    };
    const r = await Backup.importBackup(oldBackup);
    // El mazo preexistente no se toca (la importación fusiona, no borra).
    const decks = await DB.getAllDecks();
    return { localKeys: r.localKeys, aiRecords: r.aiRecords, kept: decks.filter(d => d.name === 'Mazo preexistente').length };
  });
  expect(result.aiRecords).toBe(0);
  expect(result.kept).toBe(1);
});

test('buildConvoMarkdown: solo libreta (sin chat)', async ({ page }) => {
  await page.goto('/index.html');
  const md = await page.evaluate(async () => {
    const DB = await import('/js/ai/db.js');
    const Backup = await import('/js/backup.js');
    const convo = await DB.createConvo('book-p8-b', 't3-juicio', 'obj', 'S2');
    await DB.addNote(convo.id, 'claim', 'Nota A');
    await DB.addMessage(convo.id, 'user', 'mensaje que NO debe salir');
    return Backup.buildConvoMarkdown(convo.id, { includeChat: false, includeNotebook: true });
  });
  expect(md).toContain('Nota A');
  expect(md).not.toContain('## Conversación');
  expect(md).not.toContain('mensaje que NO debe salir');
});
