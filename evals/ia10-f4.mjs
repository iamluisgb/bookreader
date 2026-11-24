// IA10 F4 · ¿Hace falta la semántica en search_library? Misma batería privada que F0, contra
// producción, en tres modos por pregunta (una sola llamada a search_library cada uno):
//   off  → solo la pregunta tal cual (`query: q`): lo que da BM25 sin que nadie expanda.
//   on   → `queries[]` de la batería: lo que manda un agente que expande (sinónimos, idioma del libro).
//   both → la pregunta + las queries (≤ 5).
//   agent → queries que escribe un modelo (deepseek-v4-flash, el de la app) leyendo la descripción
//           real de la tool: el caso realista. Solo con NAN_API_KEY.
// Métrica primaria (contrato EV5): recall de libros @5 ≥ 90 % en `on`. Si no llega, F5 (router
// semántico) se abre con este dato; si llega, se cierra con hallazgo. Los fallos se separan en
// cobertura (el libro esperado está en `notSearched` o no está en la biblioteca) y ranking.
//
//   node evals/ia10-f4.mjs [batería.json]
//
// Token: BOOKREADER_MCP_URL + BOOKREADER_MCP_TOKEN, o el servidor `bookreader` de ~/.claude.json.
// Ojo: las `queries` de la batería las escribió una persona; un agente real puede expandir peor.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { loadEnv, nanChat, lastJsonObject } from './lib.mjs';

loadEnv();

const HERE = new URL('.', import.meta.url).pathname;
const BATTERY = process.argv[2] || HERE + 'private/ia10-library.json';
const RUN = 'ia10-f4-' + new Date().toISOString().slice(0, 10);
const MODES = {
  off: (q) => ({ query: q.q }),
  on: (q) => ({ queries: q.queries.slice(0, 5) }),
  both: (q) => ({ queries: [q.q, ...q.queries].slice(0, 5) }),
};

function endpoint() {
  if (process.env.BOOKREADER_MCP_TOKEN && process.env.BOOKREADER_MCP_URL) return { url: process.env.BOOKREADER_MCP_URL, headers: { Authorization: 'Bearer ' + process.env.BOOKREADER_MCP_TOKEN } };
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

const battery = JSON.parse(readFileSync(BATTERY, 'utf8'));
const { data: lib } = await call('list_books');
const matches = (title, exp) => (title || '').toLowerCase().includes(exp.toLowerCase());

// Modo agent: la descripción que ve cualquier cliente del MCP, tal cual.
let toolDesc = null;
if (process.env.NAN_API_KEY) {
  const r = await fetch(EP.url, { method: 'POST', headers: { ...EP.headers, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  toolDesc = JSON.parse(await r.text()).result.tools.find((t) => t.name === 'search_library');
  MODES.agent = (q) => ({ queries: q.agentQueries });
}
async function agentQueries(question) {
  const out = await nanChat({ model: 'deepseek-v4-flash', maxTokens: 800, extra: { thinking: { type: 'disabled' } }, messages: [
    { role: 'system', content: 'Eres un agente con acceso a la biblioteca del usuario. Vas a llamar a esta herramienta:\n\n'
      + JSON.stringify({ name: toolDesc.name, description: toolDesc.description, inputSchema: toolDesc.inputSchema }, null, 1)
      + '\n\nResponde SOLO con un objeto JSON {"queries": [...]} con los argumentos que usarías para la pregunta del usuario.' },
    { role: 'user', content: question },
  ] });
  const qs = lastJsonObject(out)?.queries;
  return Array.isArray(qs) && qs.length ? qs.slice(0, 5).map(String) : [question];
}

const rows = [];
let lost = 0;
for (const q of battery.questions) {
  const row = { id: q.id, kind: q.kind };
  if (MODES.agent) row.agentQueries = q.agentQueries = await agentQueries(q.q);
  for (const [mode, args] of Object.entries(MODES)) {
    const t0 = performance.now();
    const r = await call('search_library', { ...args(q), books: 8, perBook: 3 });
    const ms = Math.round(performance.now() - t0);
    if (r.final || r.error) { lost++; row[mode] = { error: r.error, ms }; continue; }
    const top = (r.data.books || []).slice(0, 5).map((b) => b.title);
    const skipped = (r.data.notSearched || []).map((b) => b.title);
    const found = q.expect.filter((e) => top.some((t) => matches(t, e)));
    const miss = q.expect.filter((e) => !found.includes(e));
    const coverage = miss.filter((e) => skipped.some((t) => matches(t, e)) || !lib.books.some((b) => matches(b.title, e)));
    row[mode] = { recall: found.length / q.expect.length, hit: found.length > 0, ms, top, miss, coverage };
  }
  rows.push(row);
  console.log(q.id.padEnd(22), Object.keys(MODES).map((m) => `${m} ${row[m].error ? 'ERR' : Math.round(row[m].recall * q.expect.length) + '/' + q.expect.length}`).join('  '));
}

const summary = { run: RUN, questions: rows.length, books: lib.books.length, http5xx: fails.length, lostAfterRetries: lost };
for (const mode of Object.keys(MODES)) {
  const ok = rows.map((r) => r[mode]).filter((x) => !x.error);
  const avg = (f) => ok.reduce((n, x) => n + f(x), 0) / (ok.length || 1);
  const misses = ok.flatMap((x) => x.miss);
  const cov = ok.reduce((n, x) => n + x.coverage.length, 0);
  const byKind = {};
  for (const r of rows) if (!r[mode].error) (byKind[r.kind] ||= []).push(r[mode].recall);
  summary[mode] = {
    recallAt5: +avg((x) => x.recall).toFixed(3), hitAt5: +avg((x) => +x.hit).toFixed(3),
    msP50: ok.map((x) => x.ms).sort((a, b) => a - b)[Math.floor(ok.length / 2)],
    missesCoverage: cov, missesRanking: misses.length - cov,
    byKind: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)])),
  };
}
summary.primary = { metric: 'on.recallAt5 >= 0.90', value: summary.on.recallAt5, pass: summary.on.recallAt5 >= 0.9 };
console.log(JSON.stringify(summary, null, 1));
mkdirSync(HERE + 'runs', { recursive: true });
writeFileSync(HERE + 'runs/' + RUN + '.json', JSON.stringify({ summary, rows }, null, 1));
