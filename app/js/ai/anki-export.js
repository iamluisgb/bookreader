// Export de flashcards a Anki, 100% en el navegador (sin backend).
// Dos formatos:
//   - .apkg  → paquete nativo de Anki: un zip (JSZip, ya vendorizado) con una base
//     SQLite `collection.anki2` (esquema legacy v11, importable por Anki Desktop,
//     AnkiDroid y AnkiMobile). La SQLite se genera con sql.js (vendorizado, wasm),
//     que se carga PEREZOSAMENTE solo al exportar: no pesa en el arranque.
//   - .txt   → formato de import de texto de Anki moderno (cabeceras #separator/
//     #html/#notetype column/#deck/#tags column). Fallback sin dependencias.
//
// El esquema y los JSON de col/models/decks siguen a genanki (la referencia de facto
// para generar .apkg): ver https://github.com/kerrickstaley/genanki. Modelos propios
// con id fijo ("BookReader Basic"/"BookReader Cloze") para no chocar con los del
// usuario y que re-importar actualice en vez de duplicar.
//
// Una tarjeta es { type: 'basic'|'cloze', front, back, tags: [..] }. En las cloze,
// `front` lleva el texto con huecos {{c1::...}} y `back` la nota extra (opcional).

// Ids FIJOS de modelo (timestamp arbitrario reservado): estables entre exports.
const MODEL_BASIC_ID = 1751800000001;
const MODEL_CLOZE_ID = 1751800000002;

const CARD_CSS = `.card {
  font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  font-size: 20px; text-align: left; color: #1a1a1a; background-color: #fdfdfd;
  max-width: 40em; margin: 0 auto; padding: 12px; line-height: 1.45;
}
.cloze { font-weight: 600; color: #0f62d6; }
.br-src { margin-top: 1em; font-size: 13px; color: #8a8a8a; }`;

// ---- Carga perezosa de sql.js ------------------------------------------------

let sqlPromise = null;

function loadSqlJs() {
  if (sqlPromise) return sqlPromise;
  sqlPromise = new Promise((resolve, reject) => {
    if (window.initSqlJs) { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'vendor/sql-wasm-1.13.0.min.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('No se pudo cargar sql.js (vendor)'));
    document.head.appendChild(s);
  }).then(() => window.initSqlJs({ locateFile: () => 'vendor/sql-wasm-1.13.0.wasm' }));
  return sqlPromise;
}

// ---- Utilidades ----------------------------------------------------------------

// Campo de Anki: texto plano → HTML mínimo (escapado + saltos de línea). En las cloze
// NO se tocan las llaves {{c1::...}} (no las afecta el escapado de &<>").
function fieldHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .trim().replace(/\n/g, '<br>');
}

// Tag de Anki: sin espacios (el separador de tags ES el espacio).
function tagify(t) {
  return String(t || '').trim().replace(/\s+/g, '_').replace(/"/g, '');
}

function noteTags(card) {
  return (card.tags || []).map(tagify).filter(Boolean);
}

// Índices de hueco de una cloze ({{c1::..}} {{c2::..}}) → ords de sus cards (0-based).
function clozeOrds(text) {
  const set = new Set();
  for (const m of String(text).matchAll(/\{\{c(\d+)::/g)) set.add(parseInt(m[1], 10) - 1);
  return [...set].filter(n => n >= 0).sort((a, b) => a - b);
}

// guid de nota: aleatorio, como base91 de genanki (basta con que sea único y estable
// dentro del paquete).
function guid() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~';
  const buf = new Uint8Array(10);
  crypto.getRandomValues(buf);
  return [...buf].map(b => chars[b % chars.length]).join('');
}

// Checksum de nota: primeros 8 hex de SHA-1 del campo de ordenación, como entero.
async function fieldChecksum(sfld) {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(sfld));
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  return parseInt(hex.slice(0, 8), 16);
}

// ---- JSON del col (modelos, mazos, config) — esqueleto genanki -----------------

function modelJson({ id, name, type, flds, tmpls, now }) {
  return {
    id, name, type, mod: now, usn: -1, sortf: 0, did: null,
    flds: flds.map((n, ord) => ({ name: n, ord, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] })),
    tmpls: tmpls.map((t, ord) => ({ ...t, ord, bqfmt: '', bafmt: '', did: null })),
    css: CARD_CSS,
    latexPre: '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n',
    latexPost: '\\end{document}',
    tags: [], vers: [],
    ...(type === 0 ? { req: [[0, 'all', [0]]] } : {}),
  };
}

function buildColJson(deckId, deckName, now) {
  const models = {
    [MODEL_BASIC_ID]: modelJson({
      id: MODEL_BASIC_ID, name: 'BookReader Basic', type: 0, now,
      flds: ['Front', 'Back'],
      tmpls: [{ name: 'Card 1', qfmt: '{{Front}}', afmt: '{{FrontSide}}\n\n<hr id="answer">\n\n{{Back}}' }],
    }),
    [MODEL_CLOZE_ID]: modelJson({
      id: MODEL_CLOZE_ID, name: 'BookReader Cloze', type: 1, now,
      flds: ['Text', 'Extra'],
      tmpls: [{ name: 'Cloze', qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<br>\n{{Extra}}' }],
    }),
  };
  const mkDeck = (id, name) => ({
    id, name, desc: '', mod: now, usn: -1, collapsed: false, browserCollapsed: false,
    newToday: [0, 0], revToday: [0, 0], lrnToday: [0, 0], timeToday: [0, 0],
    dyn: 0, extendNew: 0, extendRev: 0, conf: 1,
  });
  const decks = { 1: mkDeck(1, 'Default'), [deckId]: mkDeck(deckId, deckName) };
  const conf = {
    activeDecks: [1], curDeck: 1, newSpread: 0, collapseTime: 1200, timeLim: 0,
    estTimes: true, dueCounts: true, curModel: String(MODEL_BASIC_ID), nextPos: 1,
    sortType: 'noteFld', sortBackwards: false, addToCur: true, dayLearnFirst: false,
  };
  const dconf = { 1: {
    id: 1, name: 'Default', replayq: true, timer: 0, maxTaken: 60, mod: 0, usn: 0, autoplay: true,
    new: { perDay: 20, delays: [1, 10], separate: true, ints: [1, 4, 7], initialFactor: 2500, bury: true, order: 1 },
    rev: { perDay: 100, ivlFct: 1, maxIvl: 36500, ease4: 1.3, bury: true, minSpace: 1, fuzz: 0.05 },
    lapse: { leechFails: 8, minInt: 1, delays: [10], leechAction: 0, mult: 0 },
  } };
  return { models, decks, conf, dconf };
}

const SCHEMA = `
CREATE TABLE col (
  id integer primary key, crt integer not null, mod integer not null, scm integer not null,
  ver integer not null, dty integer not null, usn integer not null, ls integer not null,
  conf text not null, models text not null, decks text not null, dconf text not null, tags text not null
);
CREATE TABLE notes (
  id integer primary key, guid text not null, mid integer not null, mod integer not null,
  usn integer not null, tags text not null, flds text not null, sfld integer not null,
  csum integer not null, flags integer not null, data text not null
);
CREATE TABLE cards (
  id integer primary key, nid integer not null, did integer not null, ord integer not null,
  mod integer not null, usn integer not null, type integer not null, queue integer not null,
  due integer not null, ivl integer not null, factor integer not null, reps integer not null,
  lapses integer not null, left integer not null, odue integer not null, odid integer not null,
  flags integer not null, data text not null
);
CREATE TABLE revlog (
  id integer primary key, cid integer not null, usn integer not null, ease integer not null,
  ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null,
  type integer not null
);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn ON notes (usn);
CREATE INDEX ix_cards_usn ON cards (usn);
CREATE INDEX ix_revlog_usn ON revlog (usn);
CREATE INDEX ix_cards_nid ON cards (nid);
CREATE INDEX ix_cards_sched ON cards (did, queue, due);
CREATE INDEX ix_revlog_cid ON revlog (cid);
CREATE INDEX ix_notes_csum ON notes (csum);
`;

// ---- .apkg ----------------------------------------------------------------------

// Construye el paquete .apkg y lo devuelve como Blob. `deckName` es el nombre del
// mazo en Anki; `cards` la lista { type, front, back, tags }.
export async function buildApkg(deckName, cards) {
  if (!window.JSZip) throw new Error('JSZip no disponible');
  const SQL = await loadSqlJs();
  const db = new SQL.Database();
  try {
    db.run(SCHEMA);

    const nowMs = Date.now();
    const now = Math.floor(nowMs / 1000);
    const { models, decks, conf, dconf } = buildColJson(nowMs, deckName, now);
    db.run('INSERT INTO col VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [
      1, now, nowMs, nowMs, 11, 0, 0, 0,
      JSON.stringify(conf), JSON.stringify(models), JSON.stringify(decks), JSON.stringify(dconf), '{}',
    ]);

    let noteId = nowMs, cardId = nowMs + 100000, due = 1;
    for (const card of cards) {
      const cloze = card.type === 'cloze';
      const f1 = fieldHtml(card.front), f2 = fieldHtml(card.back);
      const tags = noteTags(card);
      const id = noteId++;
      db.run('INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)', [
        id, guid(), cloze ? MODEL_CLOZE_ID : MODEL_BASIC_ID, now, -1,
        tags.length ? ` ${tags.join(' ')} ` : '', `${f1}\x1f${f2}`, f1, await fieldChecksum(f1), 0, '',
      ]);
      // Basic: una card (ord 0). Cloze: una card por hueco {{cN::..}} distinto.
      const ords = cloze ? clozeOrds(card.front) : [0];
      for (const ord of (ords.length ? ords : [0])) {
        db.run('INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
          cardId++, id, nowMs, ord, now, -1, 0, 0, due++, 0, 0, 0, 0, 0, 0, 0, 0, '',
        ]);
      }
    }

    const zip = new window.JSZip();
    zip.file('collection.anki2', db.export());
    zip.file('media', '{}');
    return await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  } finally {
    db.close();
  }
}

// ---- .txt (import de texto de Anki) ---------------------------------------------

// Campo del .txt: HTML mínimo y entrecomillado CSV-style (tab/nuevas líneas seguros).
function txtField(text) {
  return '"' + fieldHtml(text).replace(/"/g, '""') + '"';
}

// Fichero de texto importable por Anki moderno (Archivo → Importar). Las cabeceras
// preconfiguran separador, HTML, notetype por fila, mazo destino y columna de tags.
export function buildAnkiTxt(deckName, cards) {
  const lines = [
    '#separator:tab',
    '#html:true',
    '#notetype column:1',
    `#deck:${String(deckName).replace(/\n/g, ' ')}`,
    '#tags column:4',
  ];
  for (const card of cards) {
    const notetype = card.type === 'cloze' ? 'Cloze' : 'Basic';
    lines.push([notetype, txtField(card.front), txtField(card.back), noteTags(card).join(' ')].join('\t'));
  }
  return lines.join('\n') + '\n';
}
