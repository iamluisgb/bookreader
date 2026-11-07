// IA14 · ¿Libro entero o RAG cuando el libro cabe en el presupuesto? (BACKLOG · IA14)
//
// Compara, pregunta a pregunta y con el MISMO modelo y prompt de la app, dos brazos:
//   rag   · lo de hoy: buildContext de panel.js (router de capítulo + BM25 de 60 con vecinos,
//           unión con la expansión IA7 real) hasta 60k tokens, encuadre «EXTRACTO».
//   whole · el libro anotado entero, encuadre «LIBRO COMPLETO» (prototipo de IA14).
// Lo que no se replica (dicho en el informe): la ronda agéntica de IA5 1b (solo se anota si
// el gate habría saltado), el capítulo donde está el lector y la libreta.
//
//   node evals/ia14-whole-vs-rag.mjs fetch            # texto de los libros → evals/private/ia14-books/
//   node evals/ia14-whole-vs-rag.mjs gen              # batería CONGELADA → evals/private/ia14-battery.json
//   node evals/ia14-whole-vs-rag.mjs run [--name X]   # respuestas de los dos brazos → evals/runs/ia14-X.json
//   node evals/ia14-whole-vs-rag.mjs judge <run>      # juez + métricas deterministas, en el mismo JSON
//   node evals/ia14-whole-vs-rag.mjs report <run>     # tabla rag vs whole
//
// Batería privada (libros de la biblioteca de Luis): evals/private/, fuera de git.
// Claves: NAN_API_KEY (de .env o del entorno) y el token del MCP de BookReader.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, RUNS, loadEnv, nanChat, lastJsonObject, citesOf, avg } from './lib.mjs';

loadEnv();
const PRIV = path.join(ROOT, 'evals', 'private');
const BOOKS_DIR = path.join(PRIV, 'ia14-books');
const BATTERY = path.join(PRIV, 'ia14-battery.json');
const ANSWER_MODEL = process.env.IA14_MODEL || 'deepseek-v4-flash';   // el modelo por defecto del preset nan
const GEN_MODEL = process.env.IA14_GEN || 'glm5.3-flash';
const JUDGE = process.env.EVAL_JUDGE || 'glm5.3-flash';               // el mismo juez que evals/judge.mjs
const GOAL = 'Entender el libro y poder aplicarlo.';

// ---- MCP (texto de los libros) ------------------------------------------------------
function mcpEndpoint() {
  if (process.env.BOOKREADER_MCP_TOKEN) return { url: process.env.BOOKREADER_MCP_URL || 'https://bookreader-sync.luisgonzalezb93.workers.dev/mcp', headers: { Authorization: 'Bearer ' + process.env.BOOKREADER_MCP_TOKEN } };
  return JSON.parse(fs.readFileSync(process.env.HOME + '/.claude.json', 'utf8')).mcpServers.bookreader;
}
let lastCall = 0;
async function mcp(name, args) {
  const ep = mcpEndpoint();
  for (let attempt = 0; ; attempt++) {
    await new Promise(r => setTimeout(r, Math.max(0, lastCall + 1100 - Date.now())));   // 60 llamadas/min
    lastCall = Date.now();
    const r = await fetch(ep.url, { method: 'POST', headers: { ...ep.headers, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    if (r.status >= 500 && attempt < 3) { await new Promise(s => setTimeout(s, 3000)); continue; }
    const j = await r.json();
    const txt = j.result?.content?.[0]?.text;
    if (j.result?.isError || !txt) throw new Error(`${name}: ${txt || JSON.stringify(j.error)}`);
    return JSON.parse(txt);
  }
}

// ---- Entorno de la app en Node (prompt, retrieval y expansión REALES) ------------------
// llm.js lee su configuración de localStorage; nan da 403/1010 a UAs que no son de navegador.
function installAppEnv() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k), key: (i) => [...store.keys()][i] ?? null, get length() { return store.size; },
  };
  localStorage.setItem('bookreader_ai_key', JSON.stringify(process.env.NAN_API_KEY || ''));
  localStorage.setItem('bookreader_ai_base_url', JSON.stringify('https://api.nan.builders/v1'));
  localStorage.setItem('bookreader_ai_model', JSON.stringify(ANSWER_MODEL));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init = {}) => {
    if (String(url).includes('api.nan.builders')) init = { ...init, headers: { ...(init.headers || {}), 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } };
    return realFetch(url, init);
  };
}
async function appModules() {
  installAppEnv();
  const app = (p) => import(path.join(ROOT, 'app/js', p));
  return {
    LLM: await app('ai/llm.js'), Retrieval: await app('ai/retrieval.js'), QueryExpand: await app('ai/query-expand.js'),
    Template: await app('ai/panel-template.js'), Context: await app('ai/context.js'),
  };
}

// ---- fetch ---------------------------------------------------------------------------
async function cmdFetch() {
  const bat = JSON.parse(fs.readFileSync(BATTERY, 'utf8'));
  fs.mkdirSync(BOOKS_DIR, { recursive: true });
  for (const b of bat.books) {
    const out = path.join(BOOKS_DIR, b.id + '.json');
    if (fs.existsSync(out)) { console.log('ya está', b.title); continue; }
    const toc = await mcp('get_toc', { bookId: b.id });
    const parts = [];
    const tocLabels = [];
    for (const ch of toc.chapters) {
      let offset = 0, text = '';
      for (;;) {
        const r = await mcp('read_chapter', { bookId: b.id, chapter: ch.index, offset, maxWords: 20000 });
        text += (text ? '\n' : '') + r.text;
        if (r.nextOffset == null) break;
        offset = r.nextOffset;
      }
      if (ch.title) { tocLabels.push(ch.title); parts.push(`## ${ch.title}`); }
      parts.push(text.trim());
    }
    fs.writeFileSync(out, JSON.stringify({ id: b.id, title: toc.title, words: toc.words, tocLabels, annotated: parts.join('\n') }));
    console.log('bajado', toc.title, toc.words, 'palabras');
  }
}
function loadBook(id) { return JSON.parse(fs.readFileSync(path.join(BOOKS_DIR, id + '.json'), 'utf8')); }

// ---- gen: batería congelada ------------------------------------------------------------
// Semilla fija: la misma batería sale igual si se regenera desde cero.
// glm, con el libro entero delante, deja a veces el array `synthesis` sin cerrar y mete la
// trampa como un elemento más («…]},{"trap":{…}}}», medido): lastJsonObject no lo da por bueno.
// Reparación estructural: una «}» que llega con un «[» abierto cierra antes ese «[»; al final
// se cierra lo que quede. Después, `normalizeGen` saca la trampa si quedó dentro del array.
function repairJson(s) {
  const out = []; const stack = []; let inStr = false, esc = false;
  for (const c of s) {
    if (inStr) { out.push(c); if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c);
    else if (c === '}') { while (stack.at(-1) === '[') { out.push(']'); stack.pop(); } if (!stack.length) break; stack.pop(); }
    else if (c === ']') { if (stack.at(-1) !== '[') continue; stack.pop(); }
    out.push(c);
    if (!stack.length && c === '}') break;
  }
  while (stack.length) out.push(stack.pop() === '[' ? ']' : '}');
  return out.join('');
}
function parseLoose(raw) {
  const j = lastJsonObject(raw);
  if (j) return normalizeGen(j);
  const s = String(raw || '').replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  try { return normalizeGen(JSON.parse(repairJson(s.slice(start)))); } catch { return null; }
}
function normalizeGen(j) {
  if (!j || !Array.isArray(j.synthesis)) return j;
  const trap = j.trap || j.synthesis.find(x => x && x.trap)?.trap;
  return { ...j, synthesis: j.synthesis.filter(x => x && x.q), trap };
}
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

async function cmdGen() {
  const bat = JSON.parse(fs.readFileSync(BATTERY, 'utf8'));
  if (bat.frozen) { console.log('la batería ya está congelada: no se regenera'); return; }
  const { Retrieval } = await appModules();
  for (const b of bat.books) {
    const book = loadBook(b.id);
    const ps = Retrieval.parsePassages(book.annotated, new Map(), book.tocLabels)
      .filter(p => p.chapter && !Retrieval.isBoilerplate(p.chapter) && p.text.split(/\s+/).length >= 45);
    const rand = rng(14 + b.seed);
    const picked = new Set();
    while (picked.size < bat.needlePerBook && picked.size < ps.length) picked.add(ps[Math.floor(rand() * ps.length)]);
    b.questions = b.questions || [];
    let n = 0;
    // Reanudable: lo ya generado se queda; solo se completa lo que falta.
    for (const p of b.questions.some(q => q.type === 'needle') ? [] : picked) {
      const lang = n++ % 2 === 0 ? 'es' : b.lang;   // la mitad en español: es como pregunta Luis
      const raw = await nanChat({ model: GEN_MODEL, maxTokens: 3000, messages: [
        { role: 'system', content: 'Escribes preguntas de examen sobre un pasaje de un libro. Devuelves SOLO JSON.' },
        { role: 'user', content: `Pasaje [[${p.id}]] del capítulo «${p.chapter}»:\n\n${p.text}\n\n` +
          `Escribe UNA pregunta concreta que se responda con este pasaje y no con conocimiento general. ` +
          `No copies frases literales del pasaje: parafrasea, como lo preguntaría un lector que lo recuerda vagamente. ` +
          `Idioma de la pregunta: ${lang === 'es' ? 'español' : 'inglés'}. Respuesta de referencia en una o dos frases, en el mismo idioma. ` +
          `JSON: {"q": "...", "answer": "..."}` } ] });
      const j = lastJsonObject(raw);
      if (!j?.q) { console.warn('sin pregunta para', p.id); continue; }
      b.questions.push({ type: 'needle', q: j.q, answer: j.answer, gold: p.id, chapter: p.chapter, lang });
    }
    // Síntesis y trampa: el generador ve el libro entero (cabe; es justo la premisa de IA14).
    // Una respuesta sin JSON parseable pasa (medido: la primera vez fallaron los cuatro libros
    // y la siguiente salió bien), así que se reintenta en vez de dejar el libro sin ellas. Sin
    // razonamiento: con él, glm gastaba a veces las 8000 de cupo pensando y devolvía contenido vacío.
    if (b.questions.some(q => q.type === 'synthesis')) { console.log(b.title, 'completo'); continue; }
    let j = null, lastRaw = null;
    for (let attempt = 0; attempt < 3 && !(j?.synthesis?.length && j?.trap?.q); attempt++) j = parseLoose(lastRaw = await nanChat({ model: GEN_MODEL, maxTokens: 8000, extra: { thinking: { type: "disabled" } }, messages: [
      { role: 'system', content: 'Diseñas preguntas de evaluación sobre un libro completo. Devuelves SOLO JSON.' },
      { role: 'user', content: `LIBRO «${book.title}» con anclas [[aN]]:\n\n${book.annotated}\n\n` +
        `1) Escribe ${bat.synthPerBook} preguntas de SÍNTESIS en español que exijan juntar ideas de al menos TRES capítulos distintos ` +
        `(evolución de una idea, comparación, tesis de conjunto). Para cada una, 3-5 puntos clave de la respuesta, cada uno con las anclas [[aN]] reales que lo sostienen.\n` +
        `2) Escribe 1 pregunta TRAMPA en español: plausible para este libro pero cuyo tema el libro NO trata.\n` +
        `JSON: {"synthesis": [{"q": "...", "points": [{"point": "...", "anchors": ["a12"]}]}], "trap": {"q": "...", "why": "..."}}` } ] }));
    if (!j?.synthesis?.length) fs.writeFileSync(path.join(PRIV, `ia14-gen-fail-${b.id.slice(0, 8)}.txt`), String(lastRaw));
    for (const s of j?.synthesis || []) b.questions.push({ type: 'synthesis', q: s.q, points: s.points, lang: 'es' });
    if (j?.trap?.q) b.questions.push({ type: 'trap', q: j.trap.q, why: j.trap.why, lang: 'es' });
    console.log(b.title, '→', b.questions.length, 'preguntas');
    fs.writeFileSync(BATTERY, JSON.stringify(bat, null, 2));
  }
  const incomplete = bat.books.filter(b => !['needle', 'synthesis', 'trap'].every(t => b.questions?.some(q => q.type === t)));
  if (incomplete.length) { console.error('sin congelar: faltan preguntas en', incomplete.map(b => b.title).join(' · ')); process.exit(1); }
  bat.frozen = new Date().toISOString();
  fs.writeFileSync(BATTERY, JSON.stringify(bat, null, 2));
}

// ---- run -----------------------------------------------------------------------------
// Réplica de buildContext (app/js/ai/panel.js) sin capítulo del lector ni fragmento adjunto.
const CTX_BUDGET = 60000, CTX_BUDGET_CHAPTER = 110000, AGENTIC_MIN_HITS = 6;
function buildContextLikeApp(M, question, expansion, tocLabels) {
  const { Retrieval, QueryExpand, Context } = M;
  const routed = Retrieval.matchChapters(question, tocLabels);
  const budget = routed.length ? CTX_BUDGET_CHAPTER : CTX_BUDGET;
  const chosen = new Map(); let used = 0;
  const tryAdd = (p) => {
    if (!p || chosen.has(p.id)) return;
    const t = Context.estimateTokens(p.text) + 4;
    if (used + t > budget) return;
    chosen.set(p.id, p); used += t;
  };
  for (const ch of routed) {
    for (const p of Retrieval.passagesByChapter(ch)) tryAdd(p);
    const core = Retrieval.chapterCore(ch);
    if (core) for (const p of Retrieval.search(core, 40)) tryAdd(p);
  }
  const bm25 = Retrieval.search(question, 60);
  let hits = bm25;
  const expQuery = QueryExpand.expansionQuery(expansion);
  if (expQuery) {
    const seen = new Set(bm25.map(p => p.id));
    hits = bm25.concat(Retrieval.search(expQuery, 60).filter(p => !seen.has(p.id)));
  }
  for (const p of Retrieval.withNeighbors(hits, 1)) tryAdd(p);
  const picked = [...chosen.values()].sort((a, b) => Retrieval.anchorNum(a.id) - Retrieval.anchorNum(b.id));
  const out = []; let cur = null;
  for (const p of picked) {
    if (p.chapter && p.chapter !== cur) { out.push(`\n## ${p.chapter}`); cur = p.chapter; }
    out.push(`[[${p.id}]] ${p.text}`);
  }
  return { text: out.join('\n').trim(), ids: picked.map(p => p.id), routed, agenticGate: !routed.length && hits.length < AGENTIC_MIN_HITS };
}

// Encuadre del brazo whole: el mismo systemPrompt, con el alcance cambiado a «libro completo».
function wholePrompt(base) {
  return base
    .replace(/basándote ÚNICAMENTE en el EXTRACTO del libro que se te entrega en cada turno\./,
      'basándote ÚNICAMENTE en el LIBRO COMPLETO que se te entrega en cada turno.')
    .replace(/CONTEXTO RECUPERADO \(importante\):[\s\S]*?no te lo han dado"\./,
      'CONTEXTO (importante): recibes el texto COMPLETO del libro, con todos sus capítulos. Responde desde él; ' +
      'si algo no está en el libro, dilo claramente en vez de suplirlo con conocimiento general. ' +
      'El usuario lee el libro en la app: nunca le pidas que copie ni pegue texto.');
}

// IA14_MAX_TOKENS: tope de salida del chat para medir otro valor que el de la app (IA16).
const MAX_OUT = Number(process.env.IA14_MAX_TOKENS) || undefined;
async function answer(M, messages) {
  const t0 = Date.now(); let acc = '', truncated = false;
  const raw = await M.LLM.chatStream({ messages, ...(MAX_OUT ? { maxTokens: MAX_OUT } : {}), onToken: (t) => { acc += t; }, onDone: (i) => { truncated = !!i?.truncated; } });
  return { text: raw || acc, ms: Date.now() - t0, truncated };
}

// `--arms rag` corre un solo brazo (p. ej. para medir un cambio del RAG contra el baseline).
const armsAt = process.argv.indexOf('--arms');
const ARMS = armsAt > 0 ? process.argv[armsAt + 1].split(',') : ['rag', 'whole'];
// `--types synthesis` filtra por tipo de pregunta; `--reps N` repite cada una (lo aleatorio,
// como el truncado, se mide con repeticiones y no con una sola pasada).
const typesAt = process.argv.indexOf('--types');
const TYPES = typesAt > 0 ? process.argv[typesAt + 1].split(',') : null;
const repsAt = process.argv.indexOf('--reps');
const REPS = repsAt > 0 ? Number(process.argv[repsAt + 1]) : 1;

async function cmdRun() {
  const named = process.argv.indexOf('--name');
  const name = named > 0 ? process.argv[named + 1] : new Date().toISOString().slice(0, 10);
  const outFile = path.join(RUNS, `ia14-${name}.json`);
  const bat = JSON.parse(fs.readFileSync(BATTERY, 'utf8'));
  if (!bat.frozen) throw new Error('la batería no está congelada: corre `gen` primero');
  const M = await appModules();
  const run = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8'))
    : { name, model: ANSWER_MODEL, maxTokens: MAX_OUT || 'app', battery: bat.frozen, startedAt: new Date().toISOString(), items: [] };
  const done = new Set(run.items.map(i => i.key));
  for (const b of bat.books) {
    const book = loadBook(b.id);
    M.Retrieval.buildIndex(b.id, M.Retrieval.parsePassages(book.annotated, new Map(), book.tocLabels));
    const base = M.Template.systemPrompt(GOAL, null, null, { tocLabels: book.tocLabels });
    for (const [qi, q] of b.questions.entries()) {
      if (TYPES && !TYPES.includes(q.type)) continue;
      for (let rep = 0; rep < REPS; rep++) for (const arm of ARMS) {
        const key = `${b.id.slice(0, 12)}:${qi}:${arm}` + (rep ? `:r${rep}` : '');
        if (done.has(key)) continue;
        let ctx, system, framing, expanded = false;
        if (arm === 'rag') {
          let expansion = null;
          if (M.QueryExpand.shouldExpand({ question: q.q, chapterNamed: !!M.Retrieval.matchChapters(q.q, book.tocLabels).length })) {
            expansion = await M.QueryExpand.expandQuery(q.q, { tocLabels: book.tocLabels });
            expanded = !!expansion;
          }
          ctx = buildContextLikeApp(M, q.q, expansion, book.tocLabels);
          system = base;
          framing = 'EXTRACTO DEL LIBRO recuperado por relevancia para esta pregunta (cita los pasajes con sus anclas [[aN]]):\n\n';
        } else {
          ctx = { text: book.annotated, ids: null, routed: [], agenticGate: false };
          system = wholePrompt(base);
          framing = 'LIBRO COMPLETO (cita los pasajes con sus anclas [[aN]]):\n\n';
        }
        // nan devuelve la MISMA respuesta, en <1 s, a una petición idéntica (medido en IA16: 8 respuestas
        // distintas de 24). Cada repetición lleva un marcador mínimo para ser una muestra de verdad.
        const sys = rep ? `${system}\n\n(muestra ${rep})` : system;
        const messages = [{ role: 'system', content: sys }, { role: 'user', content: framing + ctx.text }, { role: 'user', content: q.q }];
        const a = await answer(M, messages);
        run.items.push({
          key, book: b.id, title: book.title, qi, type: q.type, lang: q.lang, arm, q: q.q,
          ctxTokens: M.Context.estimateTokens(system + framing + ctx.text + q.q), ctxIds: ctx.ids,
          expanded, agenticGate: ctx.agenticGate, routed: ctx.routed, ms: a.ms, truncated: a.truncated, answer: a.text,
        });
        fs.writeFileSync(outFile, JSON.stringify(run, null, 2));   // reanudable
        console.log(key, arm, a.ms + 'ms', '~' + Math.round(run.items.at(-1).ctxTokens / 1000) + 'k tok');
      }
    }
  }
  run.finishedAt = new Date().toISOString();
  fs.writeFileSync(outFile, JSON.stringify(run, null, 2));
}

// ---- judge ---------------------------------------------------------------------------
// Juez sin razonamiento y con reintento: con él, glm devolvía a veces contenido vacío o JSON roto
// (8 de 72 en el primer run) y el criterio quedaba en null sin avisar.
async function judgeChat({ messages }) {
  let raw = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    raw = await nanChat({ model: JUDGE, maxTokens: 3000, messages, extra: { thinking: { type: 'disabled' } } });
    if (parseLoose(raw)) return raw;
  }
  return raw;
}
const anchorN = (id) => Number(String(id).replace(/^a/, ''));
async function judgeItem(it, q) {
  const cites = [...new Set(citesOf(it.answer))];
  if (q.type === 'needle') {
    it.citeHit = cites.some(c => Math.abs(anchorN(c) - anchorN(q.gold)) <= 1);
    if (it.ctxIds) it.ctxHit = it.ctxIds.includes(q.gold);
    const raw = await judgeChat({ messages: [
      { role: 'system', content: 'Eres un corrector estricto. Devuelves SOLO JSON.' },
      { role: 'user', content: `PREGUNTA: ${q.q}\nRESPUESTA DE REFERENCIA: ${q.answer}\nRESPUESTA A CORREGIR:\n${it.answer}\n\n` +
        `Puntúa: 2 = contiene lo esencial de la referencia sin errores; 1 = parcial o con algún error menor; 0 = no responde, se equivoca o dice que no está en el texto. JSON: {"score": 0|1|2, "why": "..."}` } ] });
    const j = parseLoose(raw); it.score = Number.isFinite(j?.score) ? j.score : null; it.why = j?.why;
  } else if (q.type === 'synthesis') {
    const raw = await judgeChat({ messages: [
      { role: 'system', content: 'Eres un corrector estricto. Devuelves SOLO JSON.' },
      { role: 'user', content: `PREGUNTA: ${q.q}\nPUNTOS CLAVE ESPERADOS:\n${q.points.map((p, i) => `${i + 1}. ${p.point}`).join('\n')}\n\nRESPUESTA A CORREGIR:\n${it.answer}\n\n` +
        `Para cada punto clave, ¿la respuesta lo cubre con su sustancia? JSON: {"covered": [true|false, ...], "why": "..."}` } ] });
    const j = parseLoose(raw);
    const cov = Array.isArray(j?.covered) ? j.covered.slice(0, q.points.length) : null;
    it.coverage = cov ? cov.filter(Boolean).length / q.points.length : null; it.why = j?.why;
  } else {
    const raw = await judgeChat({ messages: [
      { role: 'system', content: 'Eres un corrector estricto. Devuelves SOLO JSON.' },
      { role: 'user', content: `El libro NO trata este tema (${q.why}).\nPREGUNTA: ${q.q}\nRESPUESTA:\n${it.answer}\n\n` +
        `¿La respuesta deja claro que el libro no trata eso, sin inventar contenido del libro? JSON: {"honest": true|false, "why": "..."}` } ] });
    const j = parseLoose(raw); it.honest = typeof j?.honest === 'boolean' ? j.honest : null; it.why = j?.why;
  }
  it.cites = cites.length;
  it.judged = true;
}

async function cmdJudge() {
  const file = path.join(RUNS, `ia14-${process.argv[3]}.json`);
  const run = JSON.parse(fs.readFileSync(file, 'utf8'));
  const bat = JSON.parse(fs.readFileSync(BATTERY, 'utf8'));
  const qOf = (it) => bat.books.find(b => b.id === it.book).questions[it.qi];
  for (const it of run.items) {
    if (it.judged) continue;
    await judgeItem(it, qOf(it));
    fs.writeFileSync(file, JSON.stringify(run, null, 2));
    process.stdout.write('.');
  }
  run.judge = JUDGE;
  fs.writeFileSync(file, JSON.stringify(run, null, 2));
  console.log('\njuzgado');
}

// ---- report --------------------------------------------------------------------------
function cmdReport() {
  const run = JSON.parse(fs.readFileSync(path.join(RUNS, `ia14-${process.argv[3]}.json`), 'utf8'));
  const by = (arm, type) => run.items.filter(i => i.arm === arm && (!type || i.type === type));
  const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');
  const rate = (xs, k) => { const v = xs.filter(i => typeof i[k] === 'boolean'); return v.length ? v.filter(i => i[k]).length / v.length : NaN; };
  const rows = [
    ['Dato concreto · cita en el pasaje (±1) [primaria]', (a) => f(rate(by(a, 'needle'), 'citeHit'))],
    ['Dato concreto · nota del juez (0-2)', (a) => f(avg(by(a, 'needle').map(i => i.score)))],
    ['Dato concreto · pregunta en español', (a) => f(avg(by(a, 'needle').filter(i => i.lang === 'es').map(i => i.score)))],
    ['Dato concreto · pregunta en el idioma del libro', (a) => f(avg(by(a, 'needle').filter(i => i.lang !== 'es').map(i => i.score)))],
    ['Dato concreto · pasaje en el contexto', (a) => (a === 'whole' ? '1.00' : f(rate(by(a, 'needle'), 'ctxHit')))],
    ['Síntesis · cobertura de puntos clave', (a) => f(avg(by(a, 'synthesis').map(i => i.coverage)))],
    ['Trampa · honesta', (a) => f(rate(by(a, 'trap'), 'honest'))],
    ['Tokens de contexto por pregunta (media)', (a) => Math.round(avg(by(a).map(i => i.ctxTokens)) / 1000) + 'k'],
    ['Latencia (mediana, s)', (a) => { const v = by(a).map(i => i.ms).sort((x, y) => x - y); return f(v[Math.floor(v.length / 2)] / 1000, 1); }],
    ['Respuestas truncadas', (a) => `${by(a).filter(i => i.truncated).length}/${by(a).length}`],
    ['Respuestas vacías', (a) => `${by(a).filter(i => !String(i.answer || '').trim()).length}/${by(a).length}`],
    ['Longitud de respuesta (mediana, caracteres)', (a) => { const v = by(a).map(i => String(i.answer || '').length).sort((x, y) => x - y); return v.length ? String(v[Math.floor(v.length / 2)]) : '—'; }],
  ];
  console.log(`IA14 · run ${run.name} · modelo ${run.model} · tope ${run.maxTokens || 'app'} · juez ${run.judge || '—'} · ${new Set(run.items.map(i => i.book + i.qi)).size} preguntas\n`);
  console.log('| Métrica | RAG (hoy) | Libro entero |\n|---|---|---|');
  for (const [label, fn] of rows) console.log(`| ${label} | ${fn('rag')} | ${fn('whole')} |`);
  const gate = by('rag').filter(i => i.agenticGate).length;
  console.log(`\nRAG: expansión IA7 en ${by('rag').filter(i => i.expanded).length}/${by('rag').length}; la ronda agéntica habría saltado en ${gate} (no replicada).`);
}

const cmd = process.argv[2];
const CMDS = { fetch: cmdFetch, gen: cmdGen, run: cmdRun, judge: cmdJudge, report: cmdReport };
if (!CMDS[cmd]) { console.error('uso: fetch | gen | run [--name X] | judge <run> | report <run>'); process.exit(1); }
await CMDS[cmd]();
