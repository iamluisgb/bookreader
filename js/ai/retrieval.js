// Retrieval por PREGUNTA a nivel de PASAJE (IA5, Fase 1a). Índice léxico BM25 en el
// navegador sobre los pasajes `[[aN]]` que ya produce segment.js. Cero API, cero
// coste: resuelve "recuperar los N mejores pasajes de TODO el libro para esta
// pregunta", en vez del recorte por capítulo (ciego a la query) de context.js.
//
// Por qué BM25 y no embeddings en esta fase: sirve a cualquier proveedor BYOK (no
// exige `/embeddings`), es determinista y barato, y es fuerte justo en lo que fallaba
// el recorte por objetivo: nombres propios y locators ("capítulo 9", "consensus",
// "Raft"). Los embeddings + fusión híbrida son la Fase 2 (ver IA5 en el BACKLOG).

// Stopwords ES+EN (los libros pueden estar en cualquiera de los dos). Lista corta a
// propósito: quitar el ruido más común sin arriesgar recall en términos de contenido.
const STOP = new Set((
  'de la que el en y a los del se las por un una para con no su al lo como mas pero sus le ya o este si ' +
  'porque esta entre cuando muy sin sobre tambien me hasta hay donde quien desde todo nos durante todos ' +
  'uno les ni contra otros ese eso ante ellos esto mi antes algunos unos yo otro otras otra tanto esa estos ' +
  'mucho quienes nada muchos cual sea poco ella estar haber estas estaba estamos algunas algo nosotros ' +
  'the of and a to in is was for it with as his on be at by this had not are but from or have an they which ' +
  'one you were her all she there would their we him been has when who will more no if out so what up about ' +
  'into than them can only other some could time these two do first any now such like our over even most ' +
  'after also did many before must through back where much your way well down should because each just those'
).split(/\s+/).filter(Boolean));

// Tokeniza: minúsculas, sin acentos, letras/números de cualquier alfabeto, sin stopwords ni tokens de 1 char.
function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // quitar diacríticos (café→cafe)
    // Unicode-aware: los libros en cirílico, griego, CJK… también producen tokens (antes,
    // con `[^a-z0-9]+`, quedaban con CERO tokens → BM25 no recuperaba nada).
    .split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length > 1 && !STOP.has(t));
}

function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

// Índice en memoria (uno a la vez; se reconstruye al cambiar de libro). No se persiste:
// construir el índice de un libro entero es de milisegundos.
let index = null; // { key, passages:[{id,text,chapter,cfi,len,tf:Map}], df:Map, avgLen, N }

// Extrae los pasajes del libro anotado. Cada línea `[[aN]] texto` es un pasaje.
//
// OJO con los marcadores `## X`: segment.js emite uno por CADA encabezado (H1–H6), no
// solo por capítulo. Si tratáramos todos como frontera de capítulo, los pasajes del
// Cap. 9 quedarían atribuidos a sus SUBTÍTULOS ("Linearizability", "Total Order
// Broadcast"…) y `passagesByChapter("9. Consistency and Consensus")` devolvería casi
// nada. Por eso, igual que context.js, un `## X` solo ABRE capítulo si X es una etiqueta
// del TOC; los demás son subtítulos internos y heredan el capítulo en curso. Sin
// tocLabels (fallback) se comporta como antes (cada `## ` abre capítulo).
export function parsePassages(annotatedText, anchors = new Map(), tocLabels = null) {
  const tocSet = tocLabels ? new Set(tocLabels.map(norm).filter(Boolean)) : null;
  const passages = [];
  let chapter = '';
  for (const line of (annotatedText || '').split('\n')) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) {
      const label = h[1].trim();
      if (!tocSet || tocSet.has(norm(label))) chapter = label;   // solo el TOC abre capítulo
      continue;
    }
    const m = /^\[\[(a\d+)\]\]\s*(.*)$/.exec(line);
    if (m) {
      passages.push({ id: m[1], text: m[2], chapter, cfi: anchors.get(m[1])?.cfi || null });
    }
  }
  return passages;
}

export function hasIndex(key) { return !!(index && index.key === key); }

export function buildIndex(key, passages) {
  const df = new Map();
  let totalLen = 0;
  const docs = passages.map(p => {
    const toks = tokenize(p.text);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    totalLen += toks.length;
    return { ...p, len: toks.length, tf };
  });
  const pos = new Map(docs.map((p, i) => [p.id, i]));   // id → posición en orden de lectura
  index = { key, passages: docs, df, avgLen: docs.length ? totalLen / docs.length : 0, N: docs.length, pos };
  return index;
}

// Sentence-window (IA5 Fase 3, ver DECISIONS.md · ADR-011): expande cada pasaje con sus
// VECINOS inmediatos en orden de lectura (mismo capítulo), para que el modelo lea contexto
// coherente alrededor de cada acierto en vez de fragmentos sueltos. Deduplica.
export function withNeighbors(passages, radius = 1) {
  if (!index) return passages;
  const byId = new Map();
  const add = (p) => { if (p && !byId.has(p.id)) byId.set(p.id, p); };
  for (const p of passages) {
    add(p);
    const i = index.pos.get(p.id);
    if (i == null) continue;
    for (let d = 1; d <= radius; d++) {
      for (const j of [i - d, i + d]) {
        const n = index.passages[j];
        if (n && n.chapter === p.chapter) add(n);   // no cruzar frontera de capítulo
      }
    }
  }
  return [...byId.values()];
}

// BM25 clásico. Devuelve los top-k pasajes (con su score) para la query.
const K1 = 1.5, B = 0.75;
export function search(query, k = 40) {
  if (!index || !index.N) return [];
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return [];
  const out = [];
  for (const p of index.passages) {
    let s = 0;
    for (const t of terms) {
      const f = p.tf.get(t);
      if (!f) continue;
      const dfi = index.df.get(t) || 1;
      const idf = Math.log(1 + (index.N - dfi + 0.5) / (dfi + 0.5));
      s += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * (p.len / (index.avgLen || 1))));
    }
    if (s > 0) out.push({ p, score: s });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, k).map(x => ({ ...x.p, score: x.score }));
}

// Núcleo del título de un capítulo, sin el "9." ni el numeral romano/parte inicial.
// "9. Consistency and Consensus" → "consistency and consensus".
export function chapterCore(label) {
  return norm(label).replace(/^(?:chapter|cap(?:itulo|\.)?|parte|part)?\s*[ivxlcdm\d]+[.\-)\s]+/i, '').trim();
}

// Romano → entero (0 si no es válido). Muchos libros numeran los capítulos en
// romanos (Lituma: I, II, III…), así que "capítulo 3" debe casar con "III".
function romanToInt(r) {
  const map = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  const s = r.toLowerCase();
  let total = 0, prev = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const v = map[s[i]];
    if (!v) return 0;
    if (v < prev) total -= v; else { total += v; prev = v; }
  }
  return total;
}
function isValidRoman(s) {
  return /^m{0,4}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i.test(s);
}
// Número inicial de una etiqueta de capítulo, sea árabe ("9. …") o romano ("III").
// Devuelve un ENTERO (o null), de modo que romano y árabe se comparen entre sí.
function leadingNum(s) {
  const n = norm(s);
  const a = n.match(/^(?:chapter|cap(?:itulo|\.)?)?\s*(\d+)\b/);
  if (a) return parseInt(a[1], 10);
  const r = n.match(/^(?:chapter|cap(?:itulo|\.)?)?\s*([ivxlcdm]+)\b/);
  if (r && isValidRoman(r[1])) return romanToInt(r[1]);
  return null;
}
// Número de capítulo referido en la pregunta ("capítulo 3" | "capítulo III"), árabe o romano.
function queryChapterNum(qn) {
  const a = qn.match(/\b(?:cap(?:itulo|\.)?|chapter|chap)\s*(\d+)\b/);
  if (a) return parseInt(a[1], 10);
  const r = qn.match(/\b(?:cap(?:itulo|\.)?|chapter|chap)\s*([ivxlcdm]+)\b/);
  if (r && isValidRoman(r[1])) return romanToInt(r[1]);
  return 0;
}

// Todos los pasajes de un capítulo, en orden de lectura. Matching TOLERANTE a variaciones
// de etiqueta (igualdad normalizada | mismo número inicial | contención del núcleo del
// título), por si el marcador de segmentación difiere del label del TOC.
export function passagesByChapter(chapterLabel) {
  if (!index || !chapterLabel) return [];
  const target = norm(chapterLabel);
  const core = chapterCore(chapterLabel);
  const num = leadingNum(chapterLabel);
  return index.passages.filter(p => {
    const pc = norm(p.chapter);
    if (!pc) return false;
    if (pc === target) return true;
    if (num && leadingNum(p.chapter) === num) return true;
    if (core && core.length >= 6 && (pc.includes(core) || core.includes(pc))) return true;
    return false;
  });
}

// Router de capítulo: detecta en la pregunta referencias estructurales explícitas y
// devuelve las etiquetas del TOC que casan. Resuelve el caso "flashcards del capítulo 9"
// de forma DETERMINISTA (número o título), sin depender del score léxico.
export function matchChapters(query, tocLabels = []) {
  const qn = norm(query);
  const hits = new Set();
  const qNum = queryChapterNum(qn);   // nº del capítulo pedido (árabe o romano), 0 si ninguno
  for (const label of tocLabels) {
    const nl = norm(label);
    if (!nl) continue;
    // 1) por número: "capitulo 9"→"9. Consistency…"; "capitulo 3"→"III" (romano).
    if (qNum && leadingNum(label) === qNum) { hits.add(label); continue; }
    // 2) por título: el núcleo del título (sin el "9." o numeral romano) aparece literal.
    const core = nl.replace(/^[ivxlcdm\d]+[.\-)\s]+/i, '').trim();
    if (core.length >= 6 && qn.includes(core)) hits.add(label);
  }
  return [...hits];
}

// Número del ancla (a12 → 12) para reordenar pasajes en orden de lectura.
export function anchorNum(id) {
  const n = parseInt(String(id).slice(1), 10);
  return Number.isFinite(n) ? n : 0;
}
