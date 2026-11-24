// IA10 F5 · ¿Merecen la pena los embeddings en search_library? Ver BACKLOG (IA10 F5).
// Trabaja en evals/private/ia10-f5/ (fuera del repo: texto de los libros y vectores).
//   node evals/ia10-f5/toc.mjs && node evals/ia10-f5/fetch.mjs && node evals/ia10-f5/eval.mjs
// Token del MCP: servidor `bookreader` de ~/.claude.json (≤ 60 llamadas/min). NAN_API_KEY para embeddings.
import { mkdirSync } from 'node:fs';
const WORK = new URL('../private/ia10-f5/', import.meta.url).pathname;
mkdirSync(WORK + 'text', { recursive: true }); process.chdir(WORK);
import { call } from '../ia10-f5/mcp.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const toc = JSON.parse(readFileSync('toc.json', 'utf8')).filter((b) => !b.noText);
let errs = 0;
async function book(b) {
  const f = `text/${b.id}.json`;
  if (existsSync(f)) return;
  const passages = []; let bad = 0;
  for (const c of b.chapters) {
    let offset = 0;
    while (offset != null) {
      const r = await call('read_chapter', { bookId: b.id, chapter: c.index, offset });
      if (r.error) { errs++; bad = (bad || 0) + 1; console.log('ERR', b.title.slice(0,30), c.index, offset, String(r.error).slice(0,120)); break; }
      for (const m of r.data.text.matchAll(/\[\[(a\d+)\]\]\s*([\s\S]*?)(?=\[\[a\d+\]\]|$)/g)) passages.push({ a: m[1], ch: c.index, chTitle: c.title, t: m[2].trim() });
      offset = r.data.nextOffset;
    }
  }
  if (bad) { console.log('INCOMPLETO', b.title, bad); return; }
  writeFileSync(f, JSON.stringify({ id: b.id, title: b.title, passages }));
  console.log(new Date().toISOString().slice(11, 19), b.title.slice(0, 50), passages.length, 'errs', errs);
}
let i = 0;
await Promise.all([0].map(async () => { while (i < toc.length) await book(toc[i++]); }));
console.log('FIN errs', errs);
