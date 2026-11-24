import { readFileSync } from 'node:fs';
const EP = JSON.parse(readFileSync(process.env.HOME + '/.claude.json', 'utf8')).mcpServers.bookreader;
let last = 0;
export async function call(name, args = {}, attempt = 0) {
  const wait = last + 1100 - Date.now(); if (wait > 0) await new Promise((s) => setTimeout(s, wait)); last = Date.now();
  let r, raw;
  try {
    r = await fetch(EP.url, { method: 'POST', headers: { ...EP.headers, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    raw = await r.text();
  } catch (e) { raw = ''; r = { status: 0 }; }
  if (!raw || r.status >= 500 || r.status === 429 || r.status === 0) {
    if (attempt < 5) { await new Promise((s) => setTimeout(s, 2000 * (attempt + 1))); return call(name, args, attempt + 1); }
    return { error: 'http ' + r.status };
  }
  const res = JSON.parse(raw).result || {};
  const text = (res.content || []).map((c) => c.text).join('');
  if (res.isError && /Demasiadas llamadas/.test(text) && attempt < 5) { await new Promise((s) => setTimeout(s, 61000)); return call(name, args, attempt + 1); }
  return res.isError ? { error: text } : { data: JSON.parse(text) };
}
