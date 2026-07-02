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

// Tokeniza: minúsculas, sin acentos, solo alfanumérico, sin stopwords ni tokens de 1 char.
function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // quitar diacríticos (café→cafe)
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && !STOP.has(t));
}

function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

// Índice en memoria (uno a la vez; se reconstruye al cambiar de libro). No se persiste:
// construir el índice de un libro entero es de milisegundos.
let index = null; // { key, passages:[{id,text,chapter,cfi,len,tf:Map}], df:Map, avgLen, N }

// Extrae los pasajes del libro anotado. Cada línea `[[aN]] texto` es un pasaje; los
// marcadores `## X` fijan el capítulo en curso (mismo formato que segment.js).
export function parsePassages(annotatedText, anchors = new Map()) {
  const passages = [];
  let chapter = '';
  for (const line of (annotatedText || '').split('\n')) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) { chapter = h[1].trim(); continue; }
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
  index = { key, passages: docs, df, avgLen: docs.length ? totalLen / docs.length : 0, N: docs.length };
  return index;
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

// Todos los pasajes de un capítulo (por etiqueta), en orden de lectura.
export function passagesByChapter(chapterLabel) {
  if (!index || !chapterLabel) return [];
  const target = norm(chapterLabel);
  return index.passages.filter(p => norm(p.chapter) === target);
}

// Router de capítulo: detecta en la pregunta referencias estructurales explícitas y
// devuelve las etiquetas del TOC que casan. Resuelve el caso "flashcards del capítulo 9"
// de forma DETERMINISTA (número o título), sin depender del score léxico.
export function matchChapters(query, tocLabels = []) {
  const qn = norm(query);
  const hits = new Set();
  const numMatch = qn.match(/\b(?:cap(?:itulo|\.)?|chapter|chap)\s*(\d+)\b/);
  for (const label of tocLabels) {
    const nl = norm(label);
    if (!nl) continue;
    // 1) por número: "capitulo 9" / "chapter 9" casa con "9. Consistency..."
    if (numMatch) {
      const ln = nl.match(/^(\d+)\b/);
      if (ln && ln[1] === numMatch[1]) { hits.add(label); continue; }
    }
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
