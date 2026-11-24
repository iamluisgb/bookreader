// IA10 F5 · ¿Merecen la pena los embeddings en search_library? Ver BACKLOG (IA10 F5).
// Trabaja en evals/private/ia10-f5/ (fuera del repo: texto de los libros y vectores).
//   node evals/ia10-f5/toc.mjs && node evals/ia10-f5/fetch.mjs && node evals/ia10-f5/eval.mjs
// Token del MCP: servidor `bookreader` de ~/.claude.json (≤ 60 llamadas/min). NAN_API_KEY para embeddings.
import { mkdirSync } from 'node:fs';
const WORK = new URL('../private/ia10-f5/', import.meta.url).pathname;
mkdirSync(WORK + 'text', { recursive: true }); process.chdir(WORK);
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { call } from '../ia10-f5/mcp.mjs';
const BR = new URL('../', import.meta.url).pathname;
const { nanChat, lastJsonObject, loadEnv } = await import(BR + 'lib.mjs');
loadEnv();
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
const KEY = process.env.NAN_API_KEY;
const SECTION_WORDS = +process.env.SECTION_WORDS || 800;

async function embed(inputs, attempt = 0) {
  const r = await fetch('https://api.nan.builders/v1/embeddings', { method: 'POST',
    headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ model: 'qwen3-embedding', input: inputs }) }).catch(() => null);
  if (!r || !r.ok) {
    if (attempt < 5) { await new Promise((s) => setTimeout(s, 3000 * (attempt + 1))); return embed(inputs, attempt + 1); }
    throw new Error('embed ' + (r && r.status) + ' ' + (r ? (await r.text()).slice(0, 200) : ''));
  }
  const j = await r.json();
  return { vecs: j.data.sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding)), tokens: j.usage?.prompt_tokens || 0 };
}
const norm = (v) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); };
const trunc = (v, d) => norm(v.slice(0, d));
const int8 = (v) => { const m = Math.max(...v.map(Math.abs)) || 1; return norm(Float32Array.from(v, (x) => Math.round((x / m) * 127))); };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// 1 · Secciones (~SECTION_WORDS palabras, sin cruzar capítulos) con contexto de libro y capítulo.
const cacheF = `sections-${SECTION_WORDS}.json`;
let sections;
if (existsSync(cacheF)) sections = JSON.parse(readFileSync(cacheF, 'utf8'));
else {
  sections = [];
  for (const f of readdirSync('text')) {
    const b = JSON.parse(readFileSync('text/' + f, 'utf8'));
    let cur = null;
    const flush = () => { if (cur && cur.w > 30) sections.push(cur); cur = null; };
    for (const p of b.passages) {
      const w = p.t.split(/\s+/).length;
      if (cur && (cur.ch !== p.ch || cur.w + w > SECTION_WORDS)) flush();
      if (!cur) cur = { book: b.id, title: b.title, ch: p.ch, a: p.a, w: 0, text: `${b.title}${p.chTitle ? ' — ' + p.chTitle : ''}\n` };
      cur.text += p.t + '\n'; cur.w += w;
    }
    flush();
  }
}
// 2 · Embeddings de secciones (en caché).
const vecF = `vecs-${SECTION_WORDS}.bin`;
let tokens = 0;
const DIM = 4096;
if (!existsSync(vecF)) {
  const all = new Float32Array(sections.length * DIM);
  const B = 16; const t0 = Date.now();
  for (let i = 0; i < sections.length; i += B) {
    const batch = sections.slice(i, i + B).map((s) => s.text.split(/\s+/).slice(0, 1400).join(' '));
    const { vecs, tokens: t } = await embed(batch); tokens += t;
    vecs.forEach((v, j) => all.set(norm(v), (i + j) * DIM));
    if ((i / B) % 25 === 0) console.log(`emb ${i}/${sections.length} · ${Math.round((Date.now() - t0) / 1000)} s · ${tokens} tok`);
  }
  writeFileSync(vecF, Buffer.from(all.buffer));
  writeFileSync(cacheF, JSON.stringify(sections.map(({ text, ...s }) => s)));
  console.log('tokens de indexado', tokens, 'segundos', Math.round((Date.now() - t0) / 1000));
}
const buf = readFileSync(vecF);
const ALL = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
const secVec = (i) => ALL.subarray(i * DIM, (i + 1) * DIM);

// 3 · Batería: la privada (revisada) + extras.
const main = JSON.parse(readFileSync(BR + 'private/ia10-library.json', 'utf8')).questions;
const extra = JSON.parse(readFileSync(BR + 'private/ia10-f5-extra.json', 'utf8')).questions;
const run = JSON.parse(readFileSync(BR + 'runs/ia10-f4-2026-11-24.json', 'utf8'));
const prevAgent = Object.fromEntries(run.rows.map((r) => [r.id, r.agentQueries]));
const { data: lib } = await call('list_books');
const titleOf = Object.fromEntries(lib.books.map((b) => [b.id, b.title]));
const { result: tl } = await (await fetch(JSON.parse(readFileSync(process.env.HOME + '/.claude.json', 'utf8')).mcpServers.bookreader.url, { method: 'POST',
  headers: { ...JSON.parse(readFileSync(process.env.HOME + '/.claude.json', 'utf8')).mcpServers.bookreader.headers, 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).json();
const toolDesc = tl.tools.find((t) => t.name === 'search_library');
async function agentQueries(question) {
  const out = await nanChat({ model: 'deepseek-v4-flash', maxTokens: 800, extra: { thinking: { type: 'disabled' } }, messages: [
    { role: 'system', content: 'Eres un agente con acceso a la biblioteca del usuario. Vas a llamar a esta herramienta:\n\n'
      + JSON.stringify({ name: toolDesc.name, description: toolDesc.description, inputSchema: toolDesc.inputSchema }, null, 1)
      + '\n\nResponde SOLO con un objeto JSON {"queries": [...]} con los argumentos que usarías para la pregunta del usuario.' },
    { role: 'user', content: question }] });
  const qs = lastJsonObject(out)?.queries;
  return Array.isArray(qs) && qs.length ? qs.slice(0, 5).map(String) : [question];
}
const bm25 = async (args) => { const r = await call('search_library', { ...args, books: 12, perBook: 1 }); return r.error ? null : r.data.books.map((b) => b.bookId); };
const INSTR = 'Instruct: Given a question from a reader, retrieve book sections from their personal library that answer it\nQuery: ';
function embRank(qv, variant) {
  const best = new Map();
  for (let i = 0; i < sections.length; i++) {
    let v = secVec(i);
    if (variant === 'mrl256') v = trunc(v, 256);
    if (variant === 'mrl256i8') v = int8(trunc(v, 256));
    let q = qv;
    if (variant !== 'full') q = trunc(qv, 256);
    const s = dot(q, v);
    const b = sections[i].book;
    if (!best.has(b) || best.get(b) < s) best.set(b, s);
  }
  return [...best].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
const rrf = (...lists) => { const sc = new Map(); for (const l of lists) l.forEach((id, i) => sc.set(id, (sc.get(id) || 0) + 1 / (60 + i))); return [...sc].sort((a, b) => b[1] - a[1]).map(([id]) => id); };
const matches = (t, e) => (t || '').toLowerCase().includes(e.toLowerCase());
const score = (ids, expect) => { const top = (ids || []).slice(0, 5).map((id) => titleOf[id]); const f = expect.filter((e) => top.some((t) => matches(t, e))); return { recall: f.length / expect.length, top }; };

const rows = [];
for (const q of [...main, ...extra]) {
  const aq = prevAgent[q.id] || await agentQueries(q.q);
  const { vecs: [qv0] } = await embed([INSTR + q.q]);
  const qv = norm(qv0);
  const lists = {
    bm25_off: await bm25({ query: q.q }),
    bm25_agent: await bm25({ queries: aq }),
    emb: embRank(qv, 'full'),
    emb_mrl256i8: embRank(qv, 'mrl256i8'),
  };
  lists.hybrid = lists.bm25_agent ? rrf(lists.bm25_agent, lists.emb) : null;
  lists.hybrid_i8 = lists.bm25_agent ? rrf(lists.bm25_agent, lists.emb_mrl256i8) : null;
  const row = { id: q.id, kind: q.kind, set: q.kind === 'extra' ? 'extra' : 'main', expect: q.expect, agentQueries: aq };
  for (const [k, l] of Object.entries(lists)) row[k] = l ? score(l, q.expect) : { error: true };
  rows.push(row);
  console.log(q.id.padEnd(20), Object.keys(lists).map((k) => `${k} ${row[k].error ? 'ERR' : Math.round(row[k].recall * 100)}`).join(' · '));
}
const summary = {};
for (const set of ['main', 'extra']) for (const k of ['bm25_off', 'bm25_agent', 'emb', 'emb_mrl256i8', 'hybrid', 'hybrid_i8']) {
  const ok = rows.filter((r) => r.set === set && !r[k].error);
  summary[set + '.' + k] = { n: ok.length, recallAt5: +(ok.reduce((n, r) => n + r[k].recall, 0) / (ok.length || 1)).toFixed(3) };
}
console.log(summary, { sections: sections.length });
writeFileSync(`eval-${SECTION_WORDS}.json`, JSON.stringify({ summary, rows }, null, 1));
