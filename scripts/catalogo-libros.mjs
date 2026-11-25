// Genera assets/muestra/catalogo.json: la biblioteca libre que /samples/ ofrece a un clic.
//
// No se guarda NINGÚN libro: el catálogo dice de dónde se baja cada uno y la app lo pide desde
// el navegador del lector (app/js/samples.js). Cuatro fuentes:
//   - Standard Ebooks: se recorre su listado público (/ebooks?page=N). Su robots.txt deja leer
//     el listado y prohíbe a los agentes las descargas, que aquí nunca se tocan: las hace el
//     lector desde su navegador. Su feed OPDS es para socios, por eso el listado.
//     La URL del EPUB sale de la ruta: /ebooks/a/b/c → /ebooks/a/b/c/downloads/a_b_c.epub
//   - assets/muestra/pg-espana.json: Project Gutenberg filtrado a dominio público en España
//     (todos los firmantes, traductores incluidos, muertos antes de 1946) y con los tomos de una
//     misma obra agrupados en una fila. Se regenera con `--actualizar-gutenberg --csv <csv>`.
//   - assets/muestra/elejandria.json: catálogo de Elejandría con los autores enriquecidos.
//     Se regenera con `--actualizar-elejandria`.
//   - assets/muestra/tecnicos.json: técnicos con licencia abierta, curados a mano.
//
//   node scripts/catalogo-libros.mjs                usa los ficheros locales y baja Standard Ebooks
//   node scripts/catalogo-libros.mjs --sin-red      no toca la red: reusa el `se` del catálogo actual
//   node scripts/catalogo-libros.mjs --actualizar-gutenberg --csv ~/pg_catalog.csv.gz
//   node scripts/catalogo-libros.mjs --actualizar-elejandria
import { readFileSync, writeFileSync } from 'node:fs';

const OUT = new URL('../assets/muestra/catalogo.json', import.meta.url);
const TEC = new URL('../assets/muestra/tecnicos.json', import.meta.url);
const PG = new URL('../assets/muestra/pg-espana.json', import.meta.url);
const EL = new URL('../assets/muestra/elejandria.json', import.meta.url);
const COMPLETO = new URL('../assets/muestra/catalogo-completo.json', import.meta.url);
const ES = new URL('../assets/muestra/catalogo-es.json', import.meta.url);
const ENLACES = new URL('../assets/muestra/elejandria-enlaces.json', import.meta.url);
const WIKI = new URL('../assets/muestra/wikisource.json', import.meta.url);
const VERIF = new URL('../assets/muestra/verificacion.json', import.meta.url);
const UA = 'BookReader catalog builder (+https://bookreader.raiatech.com/samples/)';
const PAUSA_MS = 1500;
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const valor = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : null;
};

const dec = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

// ── Standard Ebooks ────────────────────────────────────────────────────────────────────────
async function pagina(n) {
  const res = await fetch(`https://standardebooks.org/ebooks?per-page=48&page=${n}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Standard Ebooks página ${n}: ${res.status}`);
  const html = await res.text();
  const libros = [];
  for (const m of html.matchAll(/<li typeof="schema:Book" about="\/ebooks\/([^"]+)">([\s\S]*?)<\/li>/g)) {
    const [, path, blk] = m;
    const title = blk.match(/<span property="schema:name">([^<]+)<\/span>/)?.[1];
    const authors = [...blk.matchAll(/property="schema:author"[\s\S]*?<span property="schema:name">([^<]+)<\/span>/g)].map((a) => dec(a[1]));
    if (title) libros.push({ p: path, t: dec(title), a: authors.join(', ') });
  }
  const ultima = Math.max(n, ...[...html.matchAll(/[?&]page=(\d+)/g)].map((x) => +x[1]));
  return { libros, ultima };
}

async function standardEbooks() {
  const se = [];
  for (let n = 1, ultima = 1; n <= ultima; n++) {
    const r = await pagina(n);
    ultima = r.ultima;
    se.push(...r.libros);
    process.stderr.write(`\rStandard Ebooks: página ${n}/${ultima}, ${se.length} libros`);
    await new Promise((ok) => setTimeout(ok, PAUSA_MS));
  }
  process.stderr.write('\n');
  // Al ordenar no cuentan las comillas ni el signo inicial («“We”» va con la W).
  const orden = (t) => t.replace(/^[^\p{L}\p{N}]+/u, '');
  const vistos = new Set();
  const unicos = se.filter((b) => !vistos.has(b.p) && vistos.add(b.p)).sort((x, y) => orden(x.t).localeCompare(orden(y.t), 'en'));
  if (unicos.length < 500) throw new Error(`solo ${unicos.length} libros de Standard Ebooks: ¿ha cambiado su HTML?`);
  return unicos;
}

// ── Project Gutenberg ─────────────────────────────────────────────────────────────────────
// Clasificación de la Library of Congress → nombre legible. Viene poblada en el 99,99% del CSV
// y es el único eje de materia que trae la fuente: no se adivina por el título (un «Journal of
// the Plague Year» de Defoe caería en «informes»).
const MAT = {
  A: 'Obras generales', B: 'Filosofía y religión', C: 'Ciencias auxiliares de la historia', D: 'Historia universal',
  E: 'Historia de América', F: 'América local', G: 'Geografía y viajes', H: 'Ciencias sociales', J: 'Política',
  K: 'Derecho', L: 'Educación', M: 'Música', N: 'Arte', P: 'Literatura', Q: 'Ciencia', R: 'Medicina',
  S: 'Agricultura', T: 'Tecnología', U: 'Militar', V: 'Naval', Z: 'Bibliografía',
};

// Época = siglo de nacimiento del autor: es la única fecha que traen las fuentes. Los años a.C.
// (Platón, Séneca) van a su propio tramo en lugar de caer en «sin dato».
function epoca(y) {
  if (y === null || y === undefined) return 'sin dato';
  if (y < 0) return 'Antigüedad (a.C.)';
  if (y < 1600) return 'antes de 1600';
  if (y < 1700) return 'siglo XVII';
  if (y < 1800) return 'siglo XVIII';
  if (y < 1850) return 'siglo XIX (1800-1849)';
  if (y < 1900) return 'fin del XIX (1850-1899)';
  return 'siglo XX';
}

const norm = (s) =>
  (s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const anios = (a) => [...(a || '').matchAll(/\b(1[0-9]{3}|20[0-2][0-9])\b/g)].map((m) => +m[1]);

// Marcadores de tomo y de edición: sin quitarlos, «Vol. 1 (of 6)» deja seis filas de la misma obra.
const NUM = '(?:\\d{1,3}|[IVXLCDM]{1,7})';
const VOL = new RegExp(
  `(?:[\\(\\[]?\\s*\\b(?:vol(?:ume)?|tomo|tome|tomus|volumen|part(?:e)?|band|teil|book|bd|deel)\\b\\s*\\.?\\s*${NUM}\\s*(?:\\(?\\s*(?:of|de|von|/)\\s*${NUM}\\s*\\)?)?\\s*[\\)\\]]?)|(?:[—\\-–]\\s*${NUM}\\s*$)`,
  'gi',
);
const RUIDO = /\s*(?:[\(\[]?\s*(?:html|pdf|epub|plain text|illustrated|annotated|large print|complete|unabridged)\s*(?:edition|version|text)?\s*[\)\]]?)\s*$/i;

// El CSV trae comillas dobles; se parte a mano para no añadir un parser como dependencia.
function campos(linea) {
  const out = [];
  let actual = '';
  let comillas = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];
    if (c === '"') {
      if (comillas && linea[i + 1] === '"') {
        actual += '"';
        i++;
      } else comillas = !comillas;
    } else if (c === ',' && !comillas) {
      out.push(actual);
      actual = '';
    } else actual += c;
  }
  out.push(actual);
  return out;
}

async function actualizarGutenberg(csv) {
  const { gunzipSync } = await import('node:zlib');
  const bruto = readFileSync(csv);
  const texto = (csv.endsWith('.gz') ? gunzipSync(bruto) : bruto).toString('utf8');
  const obras = new Map();
  for (const linea of texto.split('\n').slice(1)) {
    if (!linea.trim()) continue;
    const [id, tipo, , titulo, idioma, autores, , locc] = campos(linea);
    if (tipo !== 'Text') continue;
    const aa = anios(autores);
    // Dominio público en España: TODOS los firmantes, traductores incluidos, muertos antes de 1946.
    if (!aa.length || Math.max(...aa) > 1945) continue;
    let t = (titulo || '').replace(/\r/g, '');
    if (t.includes('\n') && t.split('\n')[0].length > 12) t = t.split('\n')[0];
    t = t.replace(/\s+/g, ' ').trim();
    for (let i = 0; i < 2; i++) t = t.replace(RUIDO, '');
    t = t.replace(VOL, ' ').replace(/\s{2,}/g, ' ').replace(/[\s([\-—:,.]+$/, '').trim() || titulo;
    const primero = (autores || '').split(';')[0].split(',');
    const apellido = norm(primero[0] || 'anonimo');
    const nombre = primero
      .slice(1)
      .map((p) => p.replace(/\b\d{3,4}-?\d{0,4}\b/g, '').trim())
      .filter(Boolean)
      .join(' ');
    const autor = nombre ? `${nombre} ${primero[0].trim()}` : primero[0].trim();
    const clave = `${norm(t)}|${apellido}`;
    if (!obras.has(clave)) obras.set(clave, [Number(id), t, autor, (idioma || '').split(';')[0], (locc || '').trim()[0]?.toUpperCase() || null, Math.min(...aa)]);
  }
  const works = [...obras.values()].sort((a, b) => a[1].localeCompare(b[1], 'es'));
  writeFileSync(
    PG,
    JSON.stringify({
      note: 'Obras de Project Gutenberg en dominio público en España (todos los firmantes, traductores incluidos, muertos antes de 1946), con los tomos de una misma obra agrupados. [id, título, autor, idioma, clase LoCC, año de nacimiento del autor]. Generado por scripts/catalogo-libros.mjs --actualizar-gutenberg.',
      works,
    }) + '\n',
  );
  console.log(`pg-espana.json: ${works.length} obras`);
}

// ── Elejandría ────────────────────────────────────────────────────────────────────────────
async function actualizarElejandria() {
  const sm = await (await fetch('https://www.elejandria.com/sitemap.xml', { headers: { 'User-Agent': UA } })).text();
  const urls = [...sm.matchAll(/<loc>(https:\/\/www\.elejandria\.com\/libro\/[^<]+)<\/loc>/g)].map((m) => m[1]);
  const previo = JSON.parse(readFileSync(EL, 'utf8'));
  const autores = new Map(previo.autores.map((a) => [a[0], a]));
  const titulo = (s) =>
    s
      .replace(/-/g, ' ')
      .split(' ')
      .map((w, i) => (i && ['de', 'del', 'la', 'las', 'los', 'el', 'y'].includes(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
      .join(' ');
  const works = [];
  for (const u of urls) {
    const p = u.replace(/\/$/, '').split('/');
    const [slug, autor, id] = [p[p.length - 3], p[p.length - 2], p[p.length - 1]];
    if (!id || !slug || !autor) continue;
    const nombre = autor.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const a = autores.get(nombre) || [nombre, null, null];
    works.push([id, titulo(slug), nombre, a[2] || null, a[1] || null]);
  }
  writeFileSync(
    EL,
    JSON.stringify({
      note: 'Catálogo de Elejandría con autores enriquecidos: año de nacimiento y clase LoCC tomados de Gutenberg y Wikidata y verificados por nombre completo (los homónimos se descartan). [id, título, autor, clase, año], autores [nombre, nacimiento, clase].',
      works,
      autores: [...autores.values()],
    }) + '\n',
  );
  console.log(`elejandria.json: ${works.length} obras, ${autores.size} autores`);
}

// ── facetas ───────────────────────────────────────────────────────────────────────────────
function facetas({ pg, el, se, wiki = [] }) {
  const f = { lang: {}, mat: {}, era: {}, src: {} };
  const suma = (o, k) => (o[k] = (o[k] || 0) + 1);
  for (const [, , , l, s, y] of pg) {
    suma(f.lang, l);
    suma(f.mat, s ? MAT[s] || s : 'Sin clasificar');
    suma(f.era, epoca(y));
    suma(f.src, 'pg');
  }
  for (const [, , , s, y] of el) {
    suma(f.lang, 'es');
    suma(f.mat, s ? MAT[s] || s : 'Sin clasificar');
    suma(f.era, epoca(y));
    suma(f.src, 'el');
  }
  for (const b of wiki) {
    suma(f.lang, b.lang || 'es');
    suma(f.mat, 'Literatura');
    suma(f.era, epoca(b.authorYear ?? null));
    suma(f.src, 'ws');
  }
  // Standard Ebooks no publica años: sus obras entran como «sin dato» en la época.
  for (const b of se) {
    suma(f.lang, 'en');
    suma(f.mat, 'Literatura');
    suma(f.era, epoca(null));
    suma(f.src, 'se');
  }
  return f;
}

// ── principal ─────────────────────────────────────────────────────────────────────────────
if (flag('--actualizar-gutenberg')) {
  const csv = valor('--csv');
  if (!csv) throw new Error('falta --csv <pg_catalog.csv[.gz]>');
  await actualizarGutenberg(csv);
}
if (flag('--actualizar-elejandria')) await actualizarElejandria();
if ((flag('--actualizar-gutenberg') || flag('--actualizar-elejandria')) && argv.length <= 2) process.exit(0);

const { books: tecnicos } = JSON.parse(readFileSync(TEC, 'utf8'));
// Lo que el verificador encontró roto (scripts/verifica-catalogo.mjs) se saca del catálogo: prometer
// una obra que da 404 es peor que no ofrecerla. Si el informe no existe, se construye sin filtrar y
// se avisa; si tiene más de 45 días, también, porque entonces ya no dice la verdad.
let verificacion = null;
try {
  verificacion = JSON.parse(readFileSync(VERIF, 'utf8'));
} catch {
  console.warn('aviso: sin verificacion.json; el catálogo no está comprobado contra las fuentes');
}
if (verificacion) {
  const dias = (Date.now() - Date.parse(verificacion.generated)) / 86400000;
  if (!Number.isFinite(dias) || dias > 45) console.warn(`aviso: la verificación tiene ${dias ? Math.round(dias) : '?'} días; vuelve a lanzar scripts/verifica-catalogo.mjs`);
}
const muertosPg = new Set(((verificacion && verificacion.fallos && verificacion.fallos.pg) || []).map((f) => Number(f[0])));
const muertosEl = new Set(((verificacion && verificacion.fallos && verificacion.fallos.el) || []).map((f) => String(f[0])));
const pgBruto = JSON.parse(readFileSync(PG, 'utf8')).works.filter((w) => !muertosPg.has(Number(w[0])));
if (muertosPg.size) console.log(`Gutenberg: ${muertosPg.size} obras sin fichero, fuera del catálogo`);
// Obras compuestas desde Wikisource (scripts/wikisource-epub.py): pocas y estáticas, van en el
// índice para que aparezcan siempre, sin depender del resto del fondo.
const wiki = JSON.parse(readFileSync(WIKI, 'utf8')).books;
// Solo las obras de Elejandría cuyo ePub se pudo resolver: sin enlace, el botón «Leer» daría 404.
const enlaces = JSON.parse(readFileSync(ENLACES, 'utf8')).links;
const elBruto = JSON.parse(readFileSync(EL, 'utf8')).works;
const el = elBruto.filter((w) => enlaces[w[0]] && !muertosEl.has(String(w[0])));
if (muertosEl.size) console.log(`Elejandría: ${muertosEl.size} obras sin fichero, fuera del catálogo`);
if (elBruto.length - el.length > 0) console.log(`Elejandría: ${elBruto.length - el.length} obras sin ePub resuelto, fuera del catálogo`);

let se;
if (flag('--sin-red')) {
  se = JSON.parse(readFileSync(OUT, 'utf8')).se;
  if (!se?.length) throw new Error('--sin-red necesita un catalogo.json previo con `se`');
} else {
  se = await standardEbooks();
}

// Standard Ebooks gana a Gutenberg cuando es la misma obra: su edición está revisada y es la que
// debe ver el lector. Se compara título normalizado + apellido, que es lo que basta para no
// ofrecer dos veces el mismo libro en la misma estantería.
const apellido = (nombre) => norm((nombre || '').trim().split(' ').slice(-1)[0] || '');
const claveSe = new Set(se.map((b) => `${norm(b.t)}|${apellido(b.a)}`));
const pg = pgBruto.filter((w) => !claveSe.has(`${norm(w[1])}|${apellido(w[2])}`));
if (pgBruto.length - pg.length > 0) console.log(`dedupe: ${pgBruto.length - pg.length} obras de Gutenberg ya están en Standard Ebooks`);

// Dos ficheros, a propósito: la app solo necesita validar que un id existe (`pgIds`/`elIds`),
// y eso tiene que pesar poco; los títulos y autores de las 48.000 obras los pide la landing, en
// diferido, y no los toca el lector.
const out = {
  updated: new Date().toISOString().slice(0, 10),
  note:
    'Generado por scripts/catalogo-libros.mjs. Ningún libro vive en este sitio: js/samples.js lo baja de la fuente. ' +
    'se = Standard Ebooks (dominio público en EE. UU., edición CC0); tecnicos = assets/muestra/tecnicos.json; ' +
    'pgIds/elIds = ids válidos de Project Gutenberg (dominio público en España) y de Elejandría; sus fichas ' +
    'están en catalogo-completo.json, que solo carga la landing.',
  facets: facetas({ pg, el, se, wiki }),
  tecnicos,
  wiki,
  se,
  pgIds: pg.map((w) => w[0]),
  elIds: el.map((w) => w[0]),
  // Las fichas de Elejandría que solo ofrecen PDF (155 al cerrar esto, casi todas clásicos sin ePub):
  // la app las abre igual, pero tiene que saber el tipo antes de descargar.
  elPdfIds: el.filter((w) => enlaces[w[0]].format === 'pdf').map((w) => w[0]),
};
const completo = {
  note:
    'Fichas de las fuentes grandes para la landing (/samples/): pg [id, título, autor, idioma, clase LoCC, ' +
    'año de nacimiento], el [id, título, autor, clase, año]. Generado por scripts/catalogo-libros.mjs.',
  pg,
  el,
};
// La landing pinta primero la estantería curada (Standard Ebooks + técnicos + todo el español) y
// pide el resto del fondo en segundo plano: 400 KB para el primer trazo en vez de 3,8 MB.
const pgEs = pg.filter((w) => w[3] === 'es');
const pgResto = pg.filter((w) => w[3] !== 'es');
const es = {
  note:
    'Estantería curada para la landing: el = Elejandría, pg = Gutenberg en español. Mismo formato que ' +
    'catalogo-pg.json, con un sexto campo en el solo si la ficha no tiene ePub y se sirve el PDF.',
  pg: pgEs,
  el: el.map((w) => (enlaces[w[0]].format === 'pdf' ? [...w, 'pdf'] : w)),
};
writeFileSync(OUT, JSON.stringify(out) + '\n');
writeFileSync(COMPLETO, JSON.stringify({ note: completo.note, pg: pgResto }) + '\n');
writeFileSync(ES, JSON.stringify(es) + '\n');
const mb = (s) => (s.length / 1024 / 1024).toFixed(2);
console.log(
  `catalogo.json: ${se.length} de Standard Ebooks + ${tecnicos.length} técnicos + ${pg.length} de Gutenberg + ${el.length} de Elejandría · ${mb(JSON.stringify(out))} MB ` +
    `(español ${mb(JSON.stringify(es))} MB · resto del fondo ${mb(JSON.stringify({ pg: pgResto }))} MB)`,
);
