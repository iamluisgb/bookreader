// Genera assets/muestra/catalogo.json: la biblioteca libre que /samples/ ofrece a un clic.
//
// No se guarda NINGÚN libro: el catálogo dice de dónde se baja cada uno y la app lo pide desde
// el navegador del lector (js/samples.js). Dos fuentes:
//   - Standard Ebooks: se recorre su listado público (/ebooks?page=N). Su robots.txt deja leer
//     el listado y prohíbe a los agentes las descargas, que aquí nunca se tocan: las hace el
//     lector desde su navegador. Su feed OPDS es para socios, por eso el listado.
//     La URL del EPUB sale de la ruta: /ebooks/a/b/c → /ebooks/a/b/c/downloads/a_b_c.epub
//   - assets/muestra/tecnicos.json: técnicos con licencia abierta, curados a mano.
//
//   node scripts/catalogo-libros.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const OUT = new URL('../assets/muestra/catalogo.json', import.meta.url);
const TEC = new URL('../assets/muestra/tecnicos.json', import.meta.url);
const UA = 'BookReader catalog builder (+https://bookreader.raiatech.com/samples/)';
const PAUSA_MS = 1500;

const dec = (s) => s.replace(/&amp;/g, '&').replace(/&#039;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

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
const seUnicos = se.filter((b) => !vistos.has(b.p) && vistos.add(b.p)).sort((x, y) => orden(x.t).localeCompare(orden(y.t), 'en'));
if (seUnicos.length < 500) throw new Error(`solo ${seUnicos.length} libros de Standard Ebooks: ¿ha cambiado su HTML?`);

const { books: tecnicos } = JSON.parse(readFileSync(TEC, 'utf8'));
const out = {
  updated: new Date().toISOString().slice(0, 10),
  note: 'Generado por scripts/catalogo-libros.mjs. Ningún libro vive en este sitio: js/samples.js lo baja de la fuente. se = Standard Ebooks (dominio público, edición CC0); tecnicos = assets/muestra/tecnicos.json.',
  se: seUnicos,
  tecnicos,
};
writeFileSync(OUT, JSON.stringify(out) + '\n');
console.log(`catalogo.json: ${seUnicos.length} de Standard Ebooks + ${tecnicos.length} técnicos, ${(JSON.stringify(out).length / 1024) | 0} KB`);
