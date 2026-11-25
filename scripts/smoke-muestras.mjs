// Humo de la biblioteca libre contra producción: ¿los enlaces del catálogo siguen sirviendo libros?
//
// `verifica-catalogo.mjs` mira las FUENTES (Gutenberg, Elejandría); esto mira lo que ve el lector:
// el Worker de /pg y /el y los ficheros estáticos de Wikisource. Sirve para el cron —si un día
// falla, es que el catálogo promete algo que ya no se puede abrir— y para después de desplegar.
//
//   node scripts/smoke-muestras.mjs             12 de Gutenberg, 6 de Elejandría, 1 de Wikisource
//   node scripts/smoke-muestras.mjs --n 30      más muestra
//   SMOKE_BASE=https://preview.pages.dev node scripts/smoke-muestras.mjs
import { readFileSync } from 'node:fs';

const WEB = new URL('../assets/muestra/', import.meta.url);
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const N_PG = Number(arg('--n', '12'));
const N_EL = Number(arg('--el', '6'));
const BASE = (process.env.SMOKE_BASE || 'https://bookreader.raiatech.com').replace(/\/$/, '');
const WORKER = (process.env.WORKER_BASE || 'https://bookreader-libros.luisgonzalezb93.workers.dev').replace(/\/$/, '');
const ORIGIN = process.env.SMOKE_ORIGIN || 'https://bookreader.raiatech.com';
const UA = 'BookReader smoke (+https://bookreader.raiatech.com/samples/)';

const catalogo = JSON.parse(readFileSync(new URL('catalogo.json', WEB), 'utf8'));
const elPdf = new Set((catalogo.elPdfIds || []).map(String));
const wiki = JSON.parse(readFileSync(new URL('wikisource.json', WEB), 'utf8')).books;

const alAzar = (arr, n) => arr.slice().sort(() => Math.random() - 0.5).slice(0, n);

const casos = [
  ...alAzar(catalogo.pgIds, N_PG).map((n) => ({ etiqueta: `pg:${n}`, url: `${WORKER}/pg/${n}`, tipo: 'application/epub+zip', magia: 'PK' })),
  ...alAzar(catalogo.elIds, N_EL).map((id) => {
    const pdf = elPdf.has(String(id));
    return { etiqueta: `el:${id}`, url: `${WORKER}/el/${id}`, tipo: pdf ? 'application/pdf' : 'application/epub+zip', magia: pdf ? '%PDF' : 'PK' };
  }),
  ...alAzar(wiki, 1).map((b) => ({ etiqueta: `ws:${b.id}`, url: `${BASE}/assets/muestra/${b.file}`, tipo: 'application/epub+zip', magia: 'PK' })),
];

let fallos = 0;
for (const c of casos) {
  try {
    const r = await fetch(c.url, { headers: { 'User-Agent': UA, Origin: ORIGIN, Range: 'bytes=0-3' }, redirect: 'follow' });
    const tipo = (r.headers.get('content-type') || '').split(';')[0];
    // Se lee el primer trozo y se corta: con `arrayBuffer()` el navegador se baja el libro entero
    // (el Worker no reenvía el Range y un EPUB de 10 MB tarda), y aquí solo hacen falta 4 bytes.
    const lector = r.body.getReader();
    const { value } = await lector.read();
    await lector.cancel().catch(() => {});
    const bytes = value || new Uint8Array();
    const magia = String.fromCharCode(...bytes.slice(0, 4));
    const ok = (r.status === 200 || r.status === 206) && tipo === c.tipo && magia.startsWith(c.magia);
    const detalle = `${r.status} ${tipo} ${magia.replace(/[^\x20-\x7e]/g, '.')}`;
    console.log(`${ok ? '✓' : '✗'} ${c.etiqueta.padEnd(14)} ${c.url.replace(/^https?:\/\/[^/]+/, '')} — ${detalle}`);
    if (!ok) fallos++;
  } catch (e) {
    console.log(`✗ ${c.etiqueta.padEnd(14)} error: ${e.message}`);
    fallos++;
  }
}

console.log(`\n${casos.length - fallos}/${casos.length} correctos contra ${BASE}`);
process.exit(fallos ? 1 : 0);
