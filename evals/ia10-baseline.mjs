// IA10 F0 · Baseline de «preguntar a la biblioteca» con las tools de HOY (sin search_library).
// Por pregunta y consulta: search_highlights (toda la biblioteca) + search_book en CADA libro con
// texto. Libro puntúa = Σ consultas (aciertos de texto / 20 + 0,5 si hay subrayado).
// Métrica: recall de libros @5 sobre la batería privada (evals/private/, fuera del repo).
//
//   node evals/ia10-baseline.mjs [batería.json]
//
// Token: BOOKREADER_MCP_URL + BOOKREADER_MCP_TOKEN, o el servidor `bookreader` de ~/.claude.json.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const HERE = new URL('.', import.meta.url).pathname;
const BATTERY = process.argv[2] || HERE + 'private/ia10-library.json';
const RUN = 'ia10-baseline-' + new Date().toISOString().slice(0, 10);

function endpoint() {
  if (process.env.BOOKREADER_MCP_TOKEN) return { url: process.env.BOOKREADER_MCP_URL, headers: { Authorization: 'Bearer ' + process.env.BOOKREADER_MCP_TOKEN } };
  return JSON.parse(readFileSync(process.env.HOME + '/.claude.json', 'utf8')).mcpServers.bookreader;
}
const EP = endpoint();
const fails = [];
async function call(name, args = {}, attempt = 0) {
  const r = await fetch(EP.url, { method: 'POST', headers: { ...EP.headers, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const raw = await r.text();
  if (!raw || r.status >= 500 || r.status === 429) {
    fails.push(r.status);
    if (attempt < 3) { await new Promise((s) => setTimeout(s, 1500 * (attempt + 1))); return call(name, args, attempt + 1); }
    return { error: 'http ' + r.status, final: true };
  }
  const res = JSON.parse(raw).result || {};
  const text = (res.content || []).map((c) => c.text).join('');
  return res.isError ? { error: text } : { data: JSON.parse(text) };
}
async function pool(tasks, n = 4) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < tasks.length) await tasks[i++](); }));
}

const battery = JSON.parse(readFileSync(BATTERY, 'utf8'));
const { data: lib } = await call('list_books');
const withText = [];
for (const b of lib.books) if (!(await call('get_toc', { bookId: b.id })).error) withText.push(b);
const titleOf = Object.fromEntries(lib.books.map((b) => [b.id, b.title]));
const matches = (title, exp) => title.toLowerCase().includes(exp.toLowerCase());

const rows = [];
let lost = 0;
for (const q of battery.questions) {
  const score = new Map();
  const add = (id, v) => score.set(id, (score.get(id) || 0) + v);
  const tasks = [];
  for (const query of q.queries) {
    tasks.push(async () => {
      const r = await call('search_highlights', { query, limit: 50 });
      if (r.final) lost++;
      for (const id of new Set((r.data?.results || []).map((h) => h.bookId))) add(id, 0.5);
    });
    for (const b of withText) tasks.push(async () => {
      const r = await call('search_book', { bookId: b.id, query, limit: 20 });
      if (r.final) lost++;
      const n = r.data?.results?.length || 0;
      if (n) add(b.id, n / 20);
    });
  }
  const t0 = performance.now();
  await pool(tasks);
  const top = [...score].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => titleOf[id]);
  const found = q.expect.filter((e) => top.some((t) => matches(t, e)));
  const noText = q.expect.filter((e) => !withText.some((b) => matches(b.title, e)));
  rows.push({ id: q.id, kind: q.kind, recall: found.length / q.expect.length, hit: found.length > 0, calls: tasks.length,
    s: +((performance.now() - t0) / 1000).toFixed(1), top, miss: q.expect.filter((e) => !found.includes(e)), noText });
  console.log(q.id.padEnd(22), `${found.length}/${q.expect.length}`, `${tasks.length} llamadas`);
}
const avg = (k) => rows.reduce((n, r) => n + Number(r[k]), 0) / rows.length;
const misses = rows.flatMap((r) => r.miss.map((m) => ({ m, coverage: r.noText.includes(m) })));
const summary = {
  run: RUN, books: lib.books.length, withText: withText.length,
  recallAt5: +avg('recall').toFixed(3), hitAt5: +avg('hit').toFixed(3), callsPerQ: avg('calls'), secPerQ: +avg('s').toFixed(1),
  missesCoverage: misses.filter((x) => x.coverage).length, missesRanking: misses.filter((x) => !x.coverage).length,
  http5xx: fails.length, lostAfterRetries: lost,
};
console.log(summary);
mkdirSync(HERE + 'runs', { recursive: true });
writeFileSync(HERE + 'runs/' + RUN + '.json', JSON.stringify({ summary, rows }, null, 1));
