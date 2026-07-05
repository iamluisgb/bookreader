import { test, expect } from '@playwright/test';
import path from 'path';

// Golden set de recall@k sobre un libro REAL (test.epub = "Pedro Páramo", Juan Rulfo).
// Complementa a retrieval.spec.ts (corpus sintético): aquí se ejercita el pipeline completo
// —segmentación real del EPUB → parsePassages → BM25— para cazar regresiones end-to-end de la
// recuperación que el corpus sintético no vería (p. ej. cambios en el tokenizador o el troceo).
//
// Cada entrada: una consulta y un texto que DEBE aparecer en alguno de los top-k pasajes.
// Las consultas son por PALABRA CLAVE (nombres propios / términos distintivos), que es donde
// BM25 léxico es fuerte (ADR-003), no paráfrasis semántica (eso es la Fase 2 con embeddings).
const GOLDEN: { q: string; expect: string }[] = [
  { q: 'Comala padre madre promesa', expect: 'comala' },
  { q: 'canícula agosto aire saponarias', expect: 'canicula' },
  { q: 'Pedro Páramo marido de mi madre', expect: 'marido' },
];

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

test('recall@5 sobre un EPUB real (Pedro Páramo)', async ({ page }) => {
  await page.goto('/index.html');
  await page.setInputFiles('#file-input', path.join(__dirname, 'test.epub'));
  await page.waitForSelector('#epub-container iframe', { timeout: 15000 });

  const hits = await page.evaluate(async (golden) => {
    const DB: any = await import('/js/ai/db.js');
    const R: any = await import('/js/ai/retrieval.js');
    const Store: any = await import('/js/library/store.js');
    // Espera (polling) a que la segmentación del agente quede cacheada en IndexedDB.
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let s: any = null;
    for (let i = 0; i < 40 && !s; i++) {
      const books = await Store.getAllBooks();
      const epub = books.find((b: any) => b.format === 'epub');
      if (epub) {
        const cand = await DB.loadSegmented(epub.id);
        if (cand && cand.annotatedText && cand.annotatedText.length > 1000) s = cand;
      }
      if (!s) await wait(500);
    }
    if (!s) return null;
    R.buildIndex('golden', R.parsePassages(s.annotatedText, s.anchors, null));
    return golden.map((g: any) => {
      const top = R.search(g.q, 5).map((p: any) => p.text);
      return { q: g.q, expect: g.expect, top };
    });
  }, GOLDEN);

  expect(hits, 'la segmentación del EPUB debería quedar cacheada').not.toBeNull();
  for (const h of hits!) {
    const found = h.top.some((t: string) => norm(t).includes(h.expect));
    expect(found, `"${h.q}" debería recuperar un pasaje con "${h.expect}" en el top-5`).toBe(true);
  }
});
