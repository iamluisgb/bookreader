// IA11 · Baseline de «consultas cortas» contra la materia auxiliar (Index, Notes, Contents…).
// Por pregunta: search_book en su libro, top 5. Acierto = algún resultado cae en un capítulo del
// cuerpo esperado (fijado por el título del capítulo ANTES de mirar resultados).
//   Primaria  · hit@5 (determinista).
//   Secundaria · % del top 5 que cae en materia auxiliar (lo que IA11 quiere bajar a ~0) y MRR.
// Batería privada (evals/private/, fuera del repo): ids de la biblioteca de Luis.
//
//   node evals/ia11-baseline.mjs [batería.json] [--name <run>]
//
// Token: BOOKREADER_MCP_URL + BOOKREADER_MCP_TOKEN, o el servidor `bookreader` de ~/.claude.json.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const HERE = new URL('.', import.meta.url).pathname;
const argv = process.argv.slice(2);
const named = argv.indexOf('--name');
const RUN = named >= 0 ? argv[named + 1] : 'ia11-baseline-' + new Date().toISOString().slice(0, 10);
const BATTERY = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--name') || HERE + 'private/ia11-short-queries.json';
const TOP = 5;

// Mismo criterio que tools/br-audit: título EXACTO plegado, de final o de delante.
const AUX = new Set(['index', 'indice analitico', 'notes', 'notas', 'endnotes', 'glossary', 'glosario',
  'bibliography', 'bibliografia', 'references', 'referencias', 'works cited',
  'contents', 'table of contents', 'contents at a glance', 'brief contents',
  'contenido', 'contenidos', 'indice', 'indice general', 'sumario']);
const fold = (s) => String(s || '').replace(/[^\p{L}\p{N}]+/gu, ' ').normalize('NFKD')
  .replace(/[̀-ͯ]/g, '').toLowerCase().trim();
export const isAux = (title) => AUX.has(fold(title));

function endpoint() {
  if (process.env.BOOKREADER_MCP_TOKEN) return { url: process.env.BOOKREADER_MCP_URL || 'https://bookreader-sync.luisgonzalezb93.workers.dev/mcp', headers: { Authorization: 'Bearer ' + process.env.BOOKREADER_MCP_TOKEN } };
  return JSON.parse(readFileSync(process.env.HOME + '/.claude.json', 'utf8')).mcpServers.bookreader;
}
const EP = endpoint();
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
let last = 0;
async function call(name, args = {}, attempt = 0) {
  await sleep(Math.max(0, last + 1100 - Date.now()));   // el token admite 60 llamadas/min
  last = Date.now();
  const r = await fetch(EP.url, { method: 'POST', headers: { ...EP.headers, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const raw = await r.text();
  if (!raw || r.status >= 500 || r.status === 429) {
    if (attempt < 3) { await sleep(5000 * (attempt + 1)); return call(name, args, attempt + 1); }
    throw new Error(`${name}: HTTP ${r.status}`);
  }
  const res = JSON.parse(raw).result || {};
  const text = (res.content || []).map((c) => c.text).join('');
  if (res.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}

const battery = JSON.parse(readFileSync(BATTERY, 'utf8'));
const tocs = {};
for (const [key, id] of Object.entries(battery.books)) tocs[key] = await call('get_toc', { bookId: id });

const rows = [];
for (const q of battery.questions) {
  const toc = tocs[q.book];
  const auxIdx = new Set(toc.chapters.filter((c) => isAux(c.title)).map((c) => c.index));
  const res = await call('search_book', { bookId: battery.books[q.book], query: q.query, limit: TOP });
  const chapters = res.results.map((r) => r.chapter);
  const rank = chapters.findIndex((c) => q.expect.includes(c));
  rows.push({ book: q.book, query: q.query, expect: q.expect, chapters,
    hit: rank >= 0, rr: rank >= 0 ? 1 / (rank + 1) : 0,
    aux: chapters.filter((c) => auxIdx.has(c)).length, n: chapters.length });
}

const n = rows.length;
const hits = rows.filter((r) => r.hit).length;
const auxTotal = rows.reduce((s, r) => s + r.aux, 0);
const slots = rows.reduce((s, r) => s + r.n, 0);
const summary = {
  run: RUN, battery: battery.id, date: new Date().toISOString(), questions: n,
  hitAt5: +(hits / n).toFixed(3), mrr: +(rows.reduce((s, r) => s + r.rr, 0) / n).toFixed(3),
  auxShareTop5: +(auxTotal / Math.max(1, slots)).toFixed(3),
  auxFirst: rows.filter((r) => r.n && r.aux && !r.hit).length,
};
for (const r of rows) {
  console.log(`${r.hit ? '✓' : '✗'} ${r.book.padEnd(9)} ${r.query.padEnd(22)} top5=${JSON.stringify(r.chapters).padEnd(20)} aux=${r.aux}/${r.n}`);
}
console.log(`\n${RUN}: hit@5 ${hits}/${n} (${summary.hitAt5}) · MRR ${summary.mrr} · ${(summary.auxShareTop5 * 100).toFixed(1)} % del top 5 es materia auxiliar`);
mkdirSync(HERE + 'runs', { recursive: true });
writeFileSync(HERE + `runs/${RUN}.json`, JSON.stringify({ summary, rows }, null, 1));
