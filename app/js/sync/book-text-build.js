// El formato del texto de un libro en el sync, para los agentes (MCP). Puro: lo usan la app al
// subirlo (book-text.js) y el MCP al leerlo (mcp/src/text-tools.mjs), como sync-crypto.js.
//
// Está pensado para el tiempo de CPU de un Worker (10 ms en el plan gratuito): ninguna tool
// descifra ni parsea el libro entero.
//
//   text/<id>.json        índice: capítulos (título, ancla de inicio, trozo, tamaño) y datos
//                         de la búsqueda. Pequeño.
//   text/<id>/p<n>.txt    trozos de ~250 KB con capítulos ENTEROS, tal como los trocea la app:
//                         líneas `## sección` y `[[aN]] pasaje`. read_chapter lee uno.
//   text/<id>/search.txt  una línea por pasaje, `aN<TAB>capítulo<TAB>texto plegado` (sin tildes,
//                         mayúsculas ni puntuación, palabras separadas por un espacio). Buscar es
//                         `indexOf` de cada palabra (nativo) y puntuar solo las líneas que casan.
//                         El plegado, que es lo caro, lo hace el dispositivo, una vez.

export const TEXT_FORMAT = 2;
const PART_BYTES = 250 * 1024;
const LINE = /^\[\[(a\d+)\]\]\s?(.*)$/;

/** Plegado para buscar: sin tildes, en minúsculas, solo [a-z0-9] y espacios sueltos. */
export function foldSearch(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

const words = (s) => (s.match(/\S+/g) || []).length;

/**
 * El libro troceado (annotatedText de ai/segment.js y sus anclas) → los ficheros de arriba.
 * `chapterStarts`: [{ title, from: 'aN' }] en orden (book-text.js · chaptersOf).
 * Devuelve { toc, parts: [texto], search: texto }.
 */
export function buildTextFiles(annotatedText, chapterStarts, { bookId = null, title = null, segVersion = null } = {}) {
  const starts = new Map((chapterStarts || []).map((c) => [c.from, c.title || '']));
  const chapters = [];
  let cur = null;
  let pendingHeads = [];
  for (const raw of String(annotatedText || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('## ')) { pendingHeads.push(line); continue; }
    const m = LINE.exec(line);
    if (!m) continue;
    if (starts.has(m[1]) || !cur) {
      cur = { title: starts.has(m[1]) ? starts.get(m[1]) : '', from: m[1], lines: [], passages: [] };
      chapters.push(cur);
      // El encabezado `## <título del capítulo>` ya es el capítulo: no se repite como sección.
      pendingHeads = pendingHeads.filter((h) => h.slice(3).trim() !== cur.title);
    }
    cur.lines.push(...pendingHeads, line);
    pendingHeads = [];
    cur.passages.push({ id: m[1], text: m[2] });
  }

  const parts = [];
  let part = '';
  const toc = [];
  for (const ch of chapters) {
    const block = ch.lines.join('\n') + '\n';
    if (part && part.length + block.length > PART_BYTES) { parts.push(part); part = ''; }
    toc.push({ title: ch.title, from: ch.from, part: parts.length, passages: ch.passages.length, words: ch.passages.reduce((n, p) => n + words(p.text), 0) });
    part += block;
  }
  if (part) parts.push(part);

  const searchLines = [];
  let chars = 0;
  chapters.forEach((ch, ci) => {
    for (const p of ch.passages) {
      const f = foldSearch(p.text);
      chars += f.length;
      searchLines.push(`${p.id}\t${ci}\t${f}`);
    }
  });
  return {
    toc: {
      v: TEXT_FORMAT, bookId, title, segVersion, parts: parts.length, chapters: toc,
      search: { passages: searchLines.length, avgChars: searchLines.length ? chars / searchLines.length : 0 },
    },
    parts,
    search: searchLines.join('\n') + '\n',
  };
}

/** Las líneas de UN capítulo dentro de su trozo: de su ancla de inicio a la del siguiente. */
export function chapterLines(partText, from, nextFrom) {
  const lines = partText.split('\n');
  let start = lines.findIndex((l) => l.startsWith(`[[${from}]]`));
  if (start < 0) return [];
  while (start > 0 && lines[start - 1].startsWith('## ')) start--;
  let end = lines.length;
  if (nextFrom) {
    const j = lines.findIndex((l) => l.startsWith(`[[${nextFrom}]]`));
    if (j >= 0) { end = j; while (end > start && lines[end - 1].startsWith('## ')) end--; }
  }
  return lines.slice(start, end).filter(Boolean);
}
