// IA10 F5 · ¿Merecen la pena los embeddings en search_library? Ver BACKLOG (IA10 F5).
// Trabaja en evals/private/ia10-f5/ (fuera del repo: texto de los libros y vectores).
//   node evals/ia10-f5/toc.mjs && node evals/ia10-f5/fetch.mjs && node evals/ia10-f5/eval.mjs
// Token del MCP: servidor `bookreader` de ~/.claude.json (≤ 60 llamadas/min). NAN_API_KEY para embeddings.
import { mkdirSync } from 'node:fs';
const WORK = new URL('../private/ia10-f5/', import.meta.url).pathname;
mkdirSync(WORK + 'text', { recursive: true }); process.chdir(WORK);
import { call } from '../ia10-f5/mcp.mjs';
import { writeFileSync } from 'node:fs';
const { data: lib } = await call('list_books');
const out = []; let words = 0;
for (const b of lib.books) {
  const t = await call('get_toc', { bookId: b.id });
  if (t.error) { out.push({ id: b.id, title: b.title, noText: true }); continue; }
  const w = (t.data.chapters || []).reduce((n, c) => n + (c.words || 0), 0);
  words += w; out.push({ id: b.id, title: b.title, chapters: t.data.chapters });
}
writeFileSync('toc.json', JSON.stringify(out));
console.log('libros', lib.books.length, 'con texto', out.filter(b => !b.noText).length, 'palabras', words);
console.log(JSON.stringify(out.find(b=>!b.noText).chapters.slice(0,2)));
