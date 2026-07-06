import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const EPUB_PATH = path.join(__dirname, 'test.epub');

// Flashcards para Anki (feature estrella del plan de lanzamiento): generación con el
// LLM stubbeado (determinista, sin API) + export .txt y round-trip del .apkg (el zip
// generado se reabre con JSZip + sql.js y se consulta la SQLite de verdad).

const CANNED_CARDS = [
  { front: '¿Quién es el padre de Juan Preciado?', back: 'Pedro Páramo.', chapter: 'I' },
  { front: '¿A qué pueblo viaja el narrador?', back: 'A Comala.', chapter: 'I' },
  { front: '¿Qué promesa hace Juan a su madre?', back: 'Ir a Comala a reclamar lo suyo.', chapter: 'II' },
];

// Stub del endpoint del LLM: cualquier petición de streaming devuelve las tarjetas.
async function stubLLM(page, content: string) {
  await page.evaluate((payload) => {
    const real = window.fetch.bind(window);
    window.fetch = async (url: any, opts: any) => {
      const u = typeof url === 'string' ? url : url?.url || '';
      if (u.includes('/chat/completions') && opts?.body) {
        const body = JSON.parse(opts.body);
        if (body.stream) {
          const chunks = [
            `data: ${JSON.stringify({ choices: [{ delta: { content: payload }, finish_reason: null }] })}\n\n`,
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n',
          ];
          const s = new ReadableStream({ start(c) { const e = new TextEncoder(); chunks.forEach(x => c.enqueue(e.encode(x))); c.close(); } });
          return new Response(s, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: 'LISTO' } }] }), { status: 200 });
      }
      return real(url, opts);
    };
  }, content);
}

// Abre el epub, pasa el onboarding y deja el panel listo (patrón de panel.spec.ts).
async function setup(page, canned = JSON.stringify(CANNED_CARDS)) {
  await page.goto('/index.html');
  await page.evaluate((k) => localStorage.setItem('bookreader_ai_key', JSON.stringify(k)), 'test-key');
  await page.reload();
  await stubLLM(page, canned);

  const fc = page.waitForEvent('filechooser');
  await page.click('#open-file-btn');
  await (await fc).setFiles(EPUB_PATH);

  await page.waitForSelector('#ai-toggle:not([disabled])', { timeout: 15000 });
  await page.click('#ai-toggle');
  await page.waitForSelector('.ai-onboarding', { timeout: 5000 });
  await page.click('.ai-ob-tpl[data-tpl="hqa"]');
  await page.fill('#ai-ob-goal', 'memorizar la novela');
  await page.click('#ai-ob-start');
  await expect(page.locator('#ai-status')).toContainText('Listo', { timeout: 30000 });
}

async function generate(page) {
  await page.click('#ai-convo-cards');
  await page.waitForSelector('#ai-flashcards', { timeout: 5000 });
  await page.click('#fc-generate');
  await expect(page.locator('#ai-flashcards h2')).toContainText('tarjetas', { timeout: 15000 });
}

test('generar muestra la revisión con las tarjetas del modelo', async ({ page }) => {
  await setup(page);
  await generate(page);
  await expect(page.locator('.fc-item')).toHaveCount(3);
  await expect(page.locator('#ai-flashcards h2')).toHaveText('3 tarjetas');
  await expect(page.locator('.fc-front').first()).toContainText('Juan Preciado');
});

test('la respuesta con fences y texto alrededor también se parsea', async ({ page }) => {
  const wrapped = 'Aquí tienes:\n```json\n' + JSON.stringify(CANNED_CARDS.slice(0, 2)) + '\n```\n¡Listo!';
  await setup(page, wrapped);
  await generate(page);
  await expect(page.locator('.fc-item')).toHaveCount(2);
});

test('quitar una tarjeta y exportar .txt produce el formato de import de Anki', async ({ page }) => {
  await setup(page);
  await generate(page);
  await page.locator('.fc-del').first().click();
  await expect(page.locator('.fc-item')).toHaveCount(2);

  const dl = page.waitForEvent('download');
  await page.click('#fc-txt');
  const download = await dl;
  expect(download.suggestedFilename()).toMatch(/flashcards.*\.txt$/);
  const txt = fs.readFileSync(await download.path(), 'utf8');
  expect(txt).toContain('#separator:tab');
  expect(txt).toContain('#html:true');
  expect(txt).toContain('#notetype column:1');
  expect(txt).toMatch(/#deck:.+/);
  const rows = txt.trim().split('\n').filter(l => !l.startsWith('#'));
  expect(rows.length).toBe(2);                       // la tarjeta quitada NO se exporta
  expect(rows[0].startsWith('Basic\t')).toBe(true);
  expect(rows[0]).toContain('Comala');               // la primera fue eliminada
  expect(rows[0]).toContain('bookreader');           // columna de tags
});

test('exportar .apkg descarga un paquete no vacío', async ({ page }) => {
  await setup(page);
  await generate(page);
  const dl = page.waitForEvent('download');
  await page.click('#fc-apkg');
  const download = await dl;
  expect(download.suggestedFilename()).toMatch(/flashcards.*\.apkg$/);
  const buf = fs.readFileSync(await download.path());
  expect(buf.length).toBeGreaterThan(500);
  expect(buf.subarray(0, 2).toString()).toBe('PK');  // magia zip
  expect(buf.includes(Buffer.from('collection.anki2'))).toBe(true);
});

test('round-trip .apkg: la SQLite interna tiene notas, cards y modelos válidos', async ({ page }) => {
  await page.goto('/index.html');
  test.setTimeout(60000);
  const r = await page.evaluate(async () => {
    const { buildApkg } = await import('/js/ai/anki-export.js');
    const blob = await buildApkg('Libro de prueba', [
      { type: 'basic', front: 'P1 <con> "html"', back: 'R1\nsegunda línea', tags: ['bookreader', 'cap 1'] },
      { type: 'basic', front: 'P2', back: 'R2', tags: [] },
      { type: 'cloze', front: 'La capital de {{c1::Francia}} es {{c2::París}}.', back: 'geografía', tags: ['bookreader'] },
    ]);
    // Reabrir el paquete: unzip (JSZip) + abrir la SQLite (sql.js) y consultarla.
    const zip = await (window as any).JSZip.loadAsync(blob);
    const dbBytes = await zip.file('collection.anki2').async('uint8array');
    const media = await zip.file('media').async('string');
    await new Promise<void>((res, rej) => {
      const s = document.createElement('script');
      s.src = 'vendor/sql-wasm-1.13.0.min.js';
      s.onload = () => res(); s.onerror = () => rej(new Error('no sql.js'));
      document.head.appendChild(s);
    });
    const SQL = await (window as any).initSqlJs({ locateFile: () => 'vendor/sql-wasm-1.13.0.wasm' });
    const db = new SQL.Database(dbBytes);
    const one = (sql: string) => db.exec(sql)[0].values;
    const notes = one('SELECT flds, tags, mid FROM notes ORDER BY id');
    const cardsPerNote = one('SELECT nid, count(*) FROM cards GROUP BY nid ORDER BY nid');
    const col = one('SELECT ver, models, decks FROM col');
    db.close();
    return { media, notes, cardsPerNote, ver: col[0][0], models: JSON.parse(col[0][1]), decks: JSON.parse(col[0][2]) };
  });
  expect(r.media).toBe('{}');
  expect(r.ver).toBe(11);
  expect(r.notes.length).toBe(3);
  expect(r.notes[0][0]).toBe('P1 &lt;con&gt; "html"\x1fR1<br>segunda línea');  // escapado + <br>
  expect(r.notes[0][1]).toBe(' bookreader cap_1 ');                            // tags sin espacios
  // Basic → 1 card por nota; cloze con c1 y c2 → 2 cards.
  expect(r.cardsPerNote.map((x: any) => x[1])).toEqual([1, 1, 2]);
  // El modelo de la nota cloze es el modelo cloze (type 1) y el mazo custom existe.
  const clozeMid = r.notes[2][2];
  expect(r.models[String(clozeMid)].type).toBe(1);
  const deckNames = Object.values(r.decks).map((d: any) => d.name);
  expect(deckNames).toContain('Libro de prueba');
  expect(deckNames).toContain('Default');
});

test('los mazos persisten y se pueden reabrir desde el modal', async ({ page }) => {
  await setup(page);
  await generate(page);
  // Cerrar y reabrir: el mazo generado aparece listado.
  await page.click('#ai-flashcards .ai-ob-close');
  await page.click('#ai-convo-cards');
  await expect(page.locator('.fc-deck')).toHaveCount(1);
  await expect(page.locator('.fc-deck-meta')).toContainText('3 tarjetas');
  await page.click('.fc-deck [data-act="review"]');
  await expect(page.locator('.fc-item')).toHaveCount(3);
});
