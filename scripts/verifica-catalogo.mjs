// Verifica que las obras del catálogo siguen teniendo fichero en su fuente.
//
// El catálogo promete 48.000 obras y nadie comprobaba que los enlaces sigan vivos: Elejandría cambia
// el `fichaid` cuando republica una ficha, Gutenberg retira ids de vez en cuando y el espejo puede
// caerse. Esto recorre las tres fuentes y deja `assets/muestra/verificacion.json` con lo que falla;
// `catalogo-libros.mjs` lo lee y saca del catálogo lo que ya no se puede abrir.
//
//   node scripts/verifica-catalogo.mjs                 todo (unos 30 min)
//   node scripts/verifica-catalogo.mjs --fuente pg     solo Gutenberg
//   node scripts/verifica-catalogo.mjs --muestra 200   muestreo aleatorio, para probar el script
//
// No pasa por el Worker: comprueba la FUENTE, que es lo que puede cambiar. El Worker se vigila con
// `scripts/smoke-muestras.mjs`, que sí pega contra producción.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WEB = new URL('../assets/muestra/', import.meta.url);
const OUT = new URL('../assets/muestra/verificacion.json', import.meta.url);
const UA = 'BookReader catalog verifier (+https://bookreader.raiatech.com/samples/)';
const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const SOLO = arg('--fuente');
const MUESTRA = Number(arg('--muestra', '0'));
const CONC = Number(arg('--concurrencia', '10'));
const REPARAR = argv.includes('--reparar');
const TIMEOUT = 25000;

const pg = JSON.parse(readFileSync(new URL('pg-espana.json', WEB), 'utf8')).works;
const el = JSON.parse(readFileSync(new URL('elejandria-enlaces.json', WEB), 'utf8')).links;
const wiki = JSON.parse(readFileSync(new URL('wikisource.json', WEB), 'utf8')).books;

// Una respuesta vale si es 200/206 y no es una página HTML (Elejandría devuelve su web cuando el
// fichaid no existe, y eso un `res.ok` no lo distingue).
async function pide(url, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Range: 'bytes=0-0', ...headers }, signal: ctrl.signal, redirect: 'follow' });
    const tipo = r.headers.get('content-type') || '';
    const vale = (r.status === 200 || r.status === 206) && !tipo.startsWith('text/html');
    await r.body?.cancel().catch(() => {});
    return vale ? null : `${r.status} ${tipo.split(';')[0] || 'sin tipo'}`;
  } catch (e) {
    return e.name === 'AbortError' ? 'tiempo agotado' : String(e.message || e).slice(0, 60);
  } finally {
    clearTimeout(t);
  }
}

async function recorrer(nombre, items, fn) {
  const fallos = [];
  let hechos = 0;
  const inicio = Date.now();
  const cola = [...items];
  const trabajadores = Array.from({ length: CONC }, async () => {
    for (;;) {
      const it = cola.shift();
      if (!it) return;
      const motivo = await fn(it);
      if (motivo) fallos.push([it.id, motivo]);
      hechos++;
      if (hechos % 500 === 0) {
        const porMin = hechos / ((Date.now() - inicio) / 60000);
        process.stderr.write(`\r${nombre}: ${hechos}/${items.length} · fallos ${fallos.length} · ${porMin.toFixed(0)}/min · faltan ${Math.round((items.length - hechos) / porMin)} min   `);
      }
    }
  });
  await Promise.all(trabajadores);
  process.stderr.write('\n');
  return fallos;
}

const aleatorio = (arr, n) => (n > 0 ? arr.slice().sort(() => Math.random() - 0.5).slice(0, n) : arr);

// Si se comprueba una sola fuente, se conserva lo que ya decía el informe: si no, reparar Elejandría
// borraría la lista de fallos de Gutenberg.
let previo = {};
try {
  previo = JSON.parse(readFileSync(OUT, 'utf8'));
} catch {}
const salida = {
  generated: new Date().toISOString(),
  fallos: { pg: (previo.fallos || {}).pg || [], el: (previo.fallos || {}).el || [], ws: (previo.fallos || {}).ws || [] },
  comprobadas: previo.comprobadas || {},
};

if (!SOLO || SOLO === 'pg') {
  const items = aleatorio(pg.map((w) => ({ id: w[0] })), MUESTRA);
  salida.fallos.pg = await recorrer('Gutenberg', items, ({ id }) =>
    pide(`https://gutenberg.pglaf.org/cache/epub/${id}/pg${id}-images-3.epub`),
  );
  salida.comprobadas.pg = items.length;
}

// Elejandría renumera el `fichaid` cuando republica una ficha (397→517), así que un fallo ahí no
// significa que el libro se haya ido: con `--reparar` se vuelve a resolver desde la ficha y, si el
// nuevo enlace sirve, se actualiza el catálogo en vez de tirar la obra.
const RE_DESC = /(?:https:\/\/www\.elejandria\.com)?\/libro\/descargar\/([^/"']+)\/([^/"']+)\/(\d+)\/(\d+)/;
const RE_TEXTO = /Descargando(?: gratis)?[^<]{0,80}?\ben\s+(ePub|EPUB|PDF|Mobi|MOBI)/;
async function repararEl(id, v) {
  const ficha = await fetch(encodeURI(`https://www.elejandria.com/libro/${v.slug}/${v.autor}/${id}`), { headers: { 'User-Agent': UA } }).then((r) => r.text()).catch(() => '');
  const m = ficha.match(RE_DESC);
  if (!m) return false;
  // Algunas fichas meten espacios de ancho cero (U+200B) dentro del slug y eso rompe la cabecera
  // Referer; se limpian aquí para que el enlace guardado sirva.
  const limpia = (s) => s.replace(/[\u200b\u200c\u200d\u200e\u200f\ufeff\u00ad]/g, '').trim();
  const [, slugBruto, autorBruto, , fichaid] = m;
  const slug = limpia(slugBruto);
  const autor = limpia(autorBruto);
  const pagina = await fetch(`https://www.elejandria.com${m[0].replace(/^https:\/\/www\.elejandria\.com/, '')}`, { headers: { 'User-Agent': UA } }).then((r) => r.text()).catch(() => '');
  const formato = (pagina.match(RE_TEXTO)?.[1] || 'pdf').toLowerCase();
  const motivo = await pide(`https://www.elejandria.com/libro/link_descarga_libro/${id}/${fichaid}`, {
    Referer: encodeURI(`https://www.elejandria.com/libro/${slug}/${autor}/${id}`),
  });
  if (motivo) return false;
  el[id] = { slug, autor, fichaid, format: formato };
  console.log(`  reparado ${id}: fichaid ${v.fichaid} → ${fichaid} (${formato})`);
  return true;
}

if (!SOLO || SOLO === 'el') {
  const items = aleatorio(Object.entries(el).map(([id, v]) => ({ id, v })), MUESTRA);
  const fallos = await recorrer('Elejandría', items, ({ id, v }) =>
    // La cabecera va percent-encoded: hay slugs con acentos y un header HTTP no admite no-ASCII.
    pide(`https://www.elejandria.com/libro/link_descarga_libro/${id}/${v.fichaid}`, {
      Referer: encodeURI(`https://www.elejandria.com/libro/${v.slug}/${v.autor}/${id}`),
    }),
  );
  if (REPARAR && fallos.length) {
    console.log(`reparando ${fallos.length} enlaces de Elejandría…`);
    const siguen = [];
    for (const [id, motivo] of fallos) {
      if (!(await repararEl(String(id), el[String(id)] || {}))) siguen.push([id, motivo]);
    }
    salida.reparados = fallos.length - siguen.length;
    salida.fallos.el = siguen;
    if (salida.reparados) {
      writeFileSync(new URL('elejandria-enlaces.json', WEB), JSON.stringify({ note: 'Enlaces de descarga de Elejandría: {id: {slug, autor, fichaid, format}}. Reparados por scripts/verifica-catalogo.mjs --reparar cuando Elejandría renumera.', links: el }, null, 0) + '\n');
    }
  } else {
    salida.fallos.el = fallos;
  }
  salida.comprobadas.el = items.length;
}

if (!SOLO || SOLO === 'ws') {
  const items = wiki.map((b) => ({ id: b.id }));
  // Los EPUB de Wikisource son ficheros del propio sitio: se comprueba que siguen en el repo.
  salida.fallos.ws = await recorrer('Wikisource', items, ({ id }) => {
    const b = wiki.find((x) => x.id === id);
    return existsSync(fileURLToPath(new URL(b.file, WEB))) ? null : 'falta el fichero';
  });
  salida.comprobadas.ws = items.length;
}

writeFileSync(OUT, JSON.stringify(salida, null, 1) + '\n');
const total = (o) => Object.values(o).reduce((n, a) => n + a.length, 0);
console.log(`\nverificación ${salida.generated.slice(0, 10)}:`);
for (const [k, n] of Object.entries(salida.comprobadas)) {
  console.log(`  ${k}: ${n} comprobadas, ${salida.fallos[k].length} fallos`);
}
console.log(`  total fallos: ${total(salida.fallos)} → ${OUT.pathname.split('/').pop()}`);
if (total(salida.fallos)) {
  console.log('  primeros:', salida.fallos.pg.slice(0, 3), salida.fallos.el.slice(0, 3));
}
