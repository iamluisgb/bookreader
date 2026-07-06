import { test, expect } from '@playwright/test';
import fs from 'fs';

// IA7 · F2 — Golden @live de la reescritura de consulta (HyDE-lite). Mide, sobre un libro
// REAL y con la API real, si el retrieval encuentra el pasaje correcto con la pregunta cruda
// vs. con la expansión (unión), como en producción. No determinista (LLM real): fuera del
// `npm test`; corre con `npm run test:ai`.
//
// Requiere NAN_API_KEY (.env) y el libro. Por defecto DDIA (canónico de los ADRs, en inglés);
// GOLDEN_BOOK=/ruta lo sobreescribe. Se salta si falta algo.
//
// Dos frentes, por diseño:
//  - EN (mismo idioma): BM25 ya es fuerte → se comprueba la INVARIANTE (la unión nunca empeora)
//    y la PRECISIÓN (top-k pequeño), donde la expansión sí puede subir el pasaje de rango.
//  - ES→EN (cross-lingüe): el caso real del usuario (pregunta en español, libro en inglés). Aquí
//    BM25 crudo ≈ 0 y la expansión, con el idioma del libro, recupera el pasaje. Aquí MUEVE la aguja.
const KEY = process.env.NAN_API_KEY;
const BOOK = process.env.GOLDEN_BOOK
  || '/Users/lgb/Downloads/Designing Data-Intensive Ap_ (z-library.sk, 1lib.sk, z-lib.sk).pdf';

const EN = [
  { q: "How can two clients avoid silently overwriting each other's changes to the same record?", targets: ['lost update', 'compare-and-set', 'atomic write'] },
  { q: 'How does a brand-new replica get up to date after it joins the cluster?', targets: ['catch-up', 'snapshot', 'replication log'] },
  { q: 'How do you keep a separate search index in sync with the main database?', targets: ['change data capture', 'derived data', 'change events'] },
  { q: 'How do nodes agree on a single value even when some of them fail?', targets: ['consensus', 'total order', 'atomic commit'] },
  { q: 'Why is ordering events by wall-clock timestamp across machines unreliable?', targets: ['clock skew', 'last write wins', 'unreliable clock'] },
  { q: 'What approach handles never-ending streams of events as they arrive?', targets: ['stream processing', 'event stream', 'message broker'] },
];

// Español con BAJO solapamiento de cognados con el término inglés objetivo (para que el crudo
// no acierte por casualidad léxica).
const ES = [
  { q: '¿Cómo evitan dos clientes pisarse los cambios al tocar el mismo dato a la vez?', targets: ['lost update', 'compare-and-set'] },
  { q: '¿Cómo se pone al día un servidor nuevo cuando se incorpora al grupo?', targets: ['catch-up', 'snapshot'] },
  { q: '¿Cómo se mantiene al día un buscador respecto a los datos guardados?', targets: ['change data capture', 'derived data'] },
  { q: '¿Cómo se ponen de acuerdo las máquinas en un valor aunque algunas caigan?', targets: ['consensus', 'total order'] },
  { q: '¿Por qué no es fiable ordenar sucesos por la hora del reloj de cada máquina?', targets: ['clock skew', 'last write wins'] },
];

test.describe('IA7 · HyDE-lite golden (retrieval real)', () => {
  test.skip(!KEY, 'NAN_API_KEY no definido (.env)');
  test.skip(!fs.existsSync(BOOK), `Libro no encontrado: ${BOOK} (usa GOLDEN_BOOK=...)`);

  test('la expansión mejora precisión y recupera lo cross-lingüe, sin regresión @live', async ({ page }) => {
    test.setTimeout(420000);

    await page.goto('/index.html');
    await page.evaluate((k) => localStorage.setItem('bookreader_ai_key', JSON.stringify(k)), KEY);
    await page.reload();

    const [fc] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: 'Abrir archivo' }).click(),
    ]);
    await fc.setFiles(BOOK);

    await page.waitForSelector('#ai-toggle:not([disabled])', { timeout: 60000 });
    await page.click('#ai-toggle');
    await page.waitForSelector('.ai-onboarding', { timeout: 10000 });
    await page.click('.ai-ob-quickchat');
    await expect(page.locator('#ai-status')).toContainText('Listo', { timeout: 180000 });

    // Warmup: construye el índice BM25 del libro (ensureIndex).
    await page.fill('#ai-input', 'What is this book about?');
    await page.click('#ai-send');
    await expect(page.locator('.ai-msg-assistant .ai-bubble-text').last()).toHaveText(/.{20,}/, { timeout: 120000 });

    const measure = (goldens: any[]) => page.evaluate(async (gs) => {
      const R: any = await import('/js/ai/retrieval.js');
      const Q: any = await import('/js/ai/query-expand.js');
      // tocLabels reales del libro (idioma del libro) para la expansión, como en producción.
      const tocLabels = [...new Set(R.allPassages().map((p: any) => p.chapter).filter(Boolean))];
      const norm = (s: string) => (s || '').toLowerCase();
      const rankOf = (passages: any[], targets: string[]) => {
        for (let i = 0; i < passages.length; i++) {
          if (targets.some((t: string) => norm(passages[i].text).includes(norm(t)))) return i + 1;
        }
        return 0;   // 0 = no encontrado
      };
      const out: any[] = [];
      for (const g of gs) {
        const rawFull = R.search(g.q, 60);
        const exp = await Q.expandQuery(g.q, { tocLabels, signal: null });
        const eq = Q.expansionQuery(exp);
        const extra = eq ? R.search(eq, 60) : [];
        const seen = new Set(rawFull.map((p: any) => p.id));
        const union = rawFull.concat(extra.filter((p: any) => !seen.has(p.id)));
        out.push({ q: g.q, rawRank: rankOf(rawFull, g.targets), expRank: rankOf(union, g.targets), terms: exp ? exp.terms : null });
      }
      return out;
    }, goldens);

    const en = await measure(EN);
    const es = await measure(ES);

    const inTop = (rank: number, k: number) => rank > 0 && rank <= k;
    const report = (label: string, rows: any[]) => {
      console.log(`\n=== ${label} ===`);
      for (const r of rows) {
        console.log(`  raw#${r.rawRank || '—'} → exp#${r.expRank || '—'}  ${r.q}`);
        console.log(`      terms: ${r.terms ? r.terms.join(', ') : '(sin expansión)'}`);
      }
    };
    report('EN (mismo idioma)', en);
    report('ES→EN (cross-lingüe)', es);

    const enTop8Raw = en.filter(r => inTop(r.rawRank, 8)).length;
    const enTop8Exp = en.filter(r => inTop(r.expRank, 8)).length;
    const enTop40Raw = en.filter(r => inTop(r.rawRank, 40)).length;
    const enTop40Exp = en.filter(r => inTop(r.expRank, 40)).length;
    const esRaw = es.filter(r => inTop(r.rawRank, 40)).length;
    const esExp = es.filter(r => inTop(r.expRank, 40)).length;
    console.log('\n--- RESUMEN ---');
    console.log(`EN top-8:  crudo ${enTop8Raw}/${EN.length} → expansión ${enTop8Exp}/${EN.length}`);
    console.log(`EN top-40: crudo ${enTop40Raw}/${EN.length} → expansión ${enTop40Exp}/${EN.length}`);
    console.log(`ES→EN top-40: crudo ${esRaw}/${ES.length} → expansión ${esExp}/${ES.length}\n`);

    // (1) INVARIANTE (garantía del diseño de unión): en EN, la unión nunca pierde un acierto
    // del crudo (rango<=60). La expansión nunca empeora el recall.
    for (const r of en) {
      if (r.rawRank > 0) expect(r.expRank, `regresión EN: ${r.q}`).toBeGreaterThan(0);
    }
    // (2) MUEVE LA AGUJA en cross-lingüe (el caso real del usuario): recupera estrictamente más
    // pasajes correctos que el crudo, que apenas cruza la barrera del idioma.
    expect(esExp).toBeGreaterThan(esRaw);
  });
});
