#!/usr/bin/env node
/* global document */  // dentro de page.evaluate: corre en el navegador
// Lleva a la web el perfil que la app exporta en Ajustes → Perfil público → «Descargar para
// publicar» (experimento; paso 1, sin servidor).
//
//   node scripts/publicar-perfil.mjs ~/Descargas/perfil-luis.json [--dir @luis] [--covers] [--dry-run]
//
// La exportación es el perfil ENTERO (todas las estanterías públicas, en su orden): sustituye al
// publicado. También acepta el formato 1 (una sola estantería, el del primer panel «Publicar…»).
// Escribe `<dir>/perfil.json` (formato 2), las portadas en `assets/perfil/<handle>/<id>.webp` y
// regenera `<dir>/now.svg` (el widget «Reading now»). `--dir` sale de `handle` si no se da.
// Luego: revisar el diff, commit y `npm run deploy:pages`.
//
// Lo hecho a mano no se pierde: si un libro ya estaba publicado (mismo `bookId`, o mismo título
// normalizado la primera vez), se conservan su id, su lomo (O'Reilly, Packt, paper…), su portada
// (`cover`), su `kind` y sus páginas reales. De la app manda lo que cambia al leer: estado,
// progreso, orden, qué libros salen y cuál se está leyendo. Con `--covers` se reemplazan también
// las portadas ya publicadas por las que saca la app; sin él, solo se escriben las que faltan.
// Un lomo elegido en el panel distinto del automático (`plain`) gana al que había.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const input = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--dir');
if (!input) { console.error('Uso: node scripts/publicar-perfil.mjs <perfil-*.json> [--dir @luis] [--covers] [--dry-run]'); process.exit(2); }

const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
if (raw.format !== 'bookreader-perfil' || ![1, 2].includes(raw.version) || !Array.isArray(raw.books)) {
  console.error('No es una exportación del perfil público (format bookreader-perfil, version 1 o 2).'); process.exit(1);
}
const slugOf = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'shelf';
// Todo a la forma del 2: { now, shelves: [{ id, name, books: [ids] }], books: [...] }.
const snap = raw.version === 2 ? raw
  : { ...raw, shelves: [{ id: slugOf(raw.shelf), name: raw.shelf, books: raw.books.map(b => b.id) }] };

const dir = path.join(ROOT, opt('--dir', `@${snap.handle || 'luis'}`));
const handle = path.basename(dir).replace(/^@/, '');
const coversDir = path.join(ROOT, 'assets/perfil', handle);
const DRY = flag('--dry-run');

const prevPath = path.join(dir, 'perfil.json');
const prev = fs.existsSync(prevPath) ? JSON.parse(fs.readFileSync(prevPath, 'utf8')) : { books: [] };

export const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[:—–-].*$/, '').replace(/[^a-z0-9]+/g, ' ').trim();

function findPrev(b) {
  return prev.books.find(p => p.bookId && p.bookId === b.bookId)
    || prev.books.find(p => !p.bookId && norm(p.title) === norm(b.title));
}

const out = [];
const log = [];
const idMap = new Map();   // id de la exportación → id publicado (el de antes, si ya estaba)
// Solo los libros que alguna estantería enseña: un libro suelto en la exportación no se publica.
const referenced = new Set(snap.shelves.flatMap(sh => sh.books));
for (const b of snap.books.filter(x => referenced.has(x.id))) {
  const p = findPrev(b);
  const id = p ? p.id : b.id;
  idMap.set(b.id, id);
  const book = {
    id, bookId: b.bookId,
    title: p ? p.title : b.title,
    author: p ? p.author : b.author,
    status: b.status,
    progress: b.progress,
    pages: p && !p.pagesEstimated ? p.pages : b.pages,
    ...(p && !p.pagesEstimated ? {} : { pagesEstimated: true }),
    ...(p?.kind ? { kind: p.kind } : {}),
    // Un lomo hecho a mano se conserva salvo que en la app se haya elegido uno concreto (no «automático»).
    spine: p && (b.spine.style === 'plain' || b.spineAuto) ? p.spine : b.spine,
    ...(p?.cover ? { cover: p.cover } : {}),
    // Nota y enlace los escribe quien publica en la app: manda lo de la app.
    ...(b.note ? { note: String(b.note).slice(0, 280) } : {}),
    ...(/^https?:\/\//.test(b.link || '') ? { link: b.link } : {}),
  };
  if (book.progress == null) delete book.progress;
  out.push(book);

  const file = path.join(coversDir, `${id}.webp`);
  const has = fs.existsSync(file);
  // Un paper se dibuja en el navegador (portada-paper.js): su webp es el del widget, no se pisa.
  // Se escribe si falta, con `--covers`, o si la de la app es más ancha que la publicada (las de
  // 320 px se veían borrosas; así mejoran solas al volver a publicar).
  const newW = b.coverData ? (await sharp(Buffer.from(b.coverData.split(',')[1], 'base64')).metadata()).width || 0 : 0;
  const oldW = has ? (await sharp(file).metadata()).width || 0 : 0;
  const write = b.coverData && !book.cover && (!has || flag('--covers') || newW > oldW);
  if (write && !DRY) {
    const buf = Buffer.from(b.coverData.split(',')[1], 'base64');
    fs.mkdirSync(coversDir, { recursive: true });
    await sharp(buf).resize({ width: 640, withoutEnlargement: true }).webp({ quality: 85 }).toFile(file);
  }
  log.push(`${p ? 'conserva' : 'nuevo   '} ${id.padEnd(12)} ${write ? 'portada nueva' : has ? 'portada de antes' : 'SIN PORTADA'} · lomo ${book.spine.style} · ${book.title}`);
}
const gone = prev.books.filter(p => !out.some(b => b.id === p.id)).map(p => p.id);

const shelves = snap.shelves.map(sh => ({ id: sh.id, name: sh.name, books: sh.books.map(id => idMap.get(id)).filter(Boolean) }))
  .filter(sh => sh.books.length);
const nowBook = out.find(b => b.id === idMap.get(snap.now)) || null;
const pr = snap.profile || {};
const profile = { lang: pr.lang === 'es' ? 'es' : 'en', ...(pr.bio ? { bio: String(pr.bio).slice(0, 200) } : {}), ...(pr.avatarData ? { avatar: true } : {}) };
const perfil = { owner: prev.owner || 'Luis González', profile, now: nowBook ? nowBook.id : null,
  ...(snap.showFilters === false ? { showFilters: false } : {}), shelves, books: out };

// Widget «Reading now»: SVG autocontenido (la portada va dentro en base64) para el README de GitHub.
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function widgetAuthor(a) {
  const people = String(a || '').split(/\s*,\s*/).filter(Boolean).map(p => p.split(/\s+/).pop());
  if (people.length <= 1) return a || '';
  return people.slice(0, -1).join(', ') + ' & ' + people.at(-1);
}
async function nowSvg(b) {
  const file = path.join(coversDir, `${b.id}.webp`);
  const img = fs.existsSync(file) ? (await sharp(file).resize({ width: 160 }).webp({ quality: 80 }).toBuffer()).toString('base64') : '';
  const title = b.spine.title || b.title;
  const pct = b.progress == null ? null : Math.max(0, Math.min(100, b.progress));
  const SANS = 'font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif"';
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="440" height="132" viewBox="0 0 440 132" role="img" aria-label="${xml(`${perfil.owner} is reading ${title}${pct == null ? '' : ` (${pct}%)`} · BookReader`)}">
  <style>
    .bg { fill: #ffffff; stroke: #e5e5ea; } .fg { fill: #1d1d1f; } .soft { fill: #5f5f64; } .track { fill: #f0f0f2; } .acc { fill: #178046; }
    @media (prefers-color-scheme: dark) { .bg { fill: #161b22; stroke: #30363d; } .fg { fill: #f0f6fc; } .soft { fill: #9198a1; } .track { fill: #30363d; } .acc { fill: #32d074; } }
  </style>
  <rect class="bg" x="0.5" y="0.5" width="439" height="131" rx="10"/>
  ${img ? `<image x="18" y="14" width="80" height="104" preserveAspectRatio="xMidYMid slice" href="data:image/webp;base64,${img}"/>` : ''}
  <rect x="18" y="14" width="80" height="104" fill="none" stroke="#d1d1d6"/>
  <text class="soft" x="110" y="34" ${SANS} font-size="11" font-weight="600" letter-spacing="0.8">READING NOW</text>
  <text class="fg" x="110" y="58" font-family="Georgia, serif" font-size="18" font-weight="600">${xml(title.length > 34 ? title.slice(0, 33) + '…' : title)}</text>
  <text class="soft" x="110" y="78" ${SANS} font-size="12">${xml(widgetAuthor(b.author).slice(0, 52))}</text>
  ${pct == null ? '' : `<rect class="track" x="110" y="94" width="200" height="6" rx="3"/>
  <rect class="acc" x="110" y="94" width="${Math.max(6, Math.round(2 * pct))}" height="6" rx="3"/>
  <text class="soft" x="320" y="100" ${SANS} font-size="12">${pct}%</text>`}
  <text class="soft" x="424" y="120" text-anchor="end" ${SANS} font-size="10">BookReader</text>
</svg>
`;
}

console.log(log.join('\n'));
if (gone.length) console.log(`deja de publicar: ${gone.join(', ')} (sus portadas siguen en ${path.relative(ROOT, coversDir)}; bórralas si no vuelven)`);
for (const sh of shelves) console.log(`estantería «${sh.name}» (#${sh.id}) · ${sh.books.length} libros`);
console.log(`${out.length} libros distintos · leyendo ahora: ${nowBook ? nowBook.id : '—'}`);
if (DRY) { console.log('(--dry-run: no se ha escrito nada)'); process.exit(0); }
fs.writeFileSync(prevPath, JSON.stringify(perfil, null, 2) + '\n');
if (pr.avatarData) {
  fs.mkdirSync(coversDir, { recursive: true });
  await sharp(Buffer.from(pr.avatarData.split(',')[1], 'base64')).resize(192, 192).webp({ quality: 85 }).toFile(path.join(coversDir, 'avatar.webp'));
} else if (fs.existsSync(path.join(coversDir, 'avatar.webp'))) fs.rmSync(path.join(coversDir, 'avatar.webp'));
if (!flag('--no-og')) await shareImages();
if (nowBook) fs.writeFileSync(path.join(dir, 'now.svg'), await nowSvg(nowBook));
console.log(`escrito ${path.relative(ROOT, prevPath)}${nowBook ? ' y now.svg' : ''}. Revisa el diff, commit y npm run deploy:pages.`);

// ---- Imágenes y páginas para compartir --------------------------------------------------------
// Al pegar el enlace en LinkedIn o WhatsApp se ve una imagen: la de cada estantería, con sus lomos,
// hecha fotografiando la propia página en modo `?og=1` (1200×630). Como los buscadores y las redes
// no leen el `#id`, cada estantería tiene además su página `@handle/<id>/` con su imagen, que
// lleva a la estantería. La principal usa la de la primera. `--no-og` se lo salta.
async function shareImages() {
  const { chromium } = await import('playwright');
  const { spawn } = await import('node:child_process');
  const port = 8700 + Math.floor(Math.random() * 200);
  const srv = spawn(process.execPath, [path.join(ROOT, 'scripts/test-server.mjs'), String(port), ROOT], { stdio: 'ignore' });
  const BASE = 'https://bookreader.raiatech.com';
  const MARK = '<!-- bookreader-share -->';
  try {
    await new Promise(r => setTimeout(r, 900));
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    // Fuera las páginas de estanterías que ya no se publican (solo las que hizo este script).
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, d.name, 'index.html');
      if (d.isDirectory() && fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes(MARK) && !shelves.some(sh => sh.id === d.name)) fs.rmSync(path.join(dir, d.name), { recursive: true });
    }
    for (const sh of shelves) {
      await page.goto(`http://localhost:${port}/@${handle}/?og=1&shelf=${encodeURIComponent(sh.id)}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.pf-bk');
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      const png = await page.screenshot({ type: 'png' });
      const img = path.join(coversDir, `og-${sh.id}.png`);
      await sharp(png).png({ compressionLevel: 9, palette: true, quality: 90 }).toFile(img);
      const title = `${perfil.owner} · ${sh.name}`;
      const desc = profile.lang === 'es' ? `Lo que ${perfil.owner} está leyendo: ${sh.name}, en BookReader.` : `What ${perfil.owner} is reading: ${sh.name}, on BookReader.`;
      const ogImg = `${BASE}/assets/perfil/${handle}/og-${sh.id}.png?v=${Date.now().toString(36)}`;
      fs.mkdirSync(path.join(dir, sh.id), { recursive: true });
      fs.writeFileSync(path.join(dir, sh.id, 'index.html'), `<!doctype html>
${MARK}
<html lang="${profile.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${xml(title)} · BookReader</title>
<meta name="description" content="${xml(desc)}">
<meta property="og:type" content="profile">
<meta property="og:title" content="${xml(title)}">
<meta property="og:description" content="${xml(desc)}">
<meta property="og:url" content="${BASE}/@${handle}/${sh.id}/">
<meta property="og:image" content="${ogImg}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="${BASE}/@${handle}/#${sh.id}">
<meta http-equiv="refresh" content="0; url=../?ref=share#${sh.id}">
</head>
<body><p><a href="../?ref=share#${sh.id}">${xml(title)}</a></p></body>
</html>
`);
      console.log(`imagen para compartir: ${path.relative(ROOT, img)} · enlace: ${BASE}/@${handle}/${sh.id}/`);
    }
    await browser.close();
    // La página principal enseña la imagen de la primera estantería.
    const idx = path.join(dir, 'index.html');
    if (shelves[0] && fs.existsSync(idx)) {
      let html = fs.readFileSync(idx, 'utf8');
      const ogImg = `${BASE}/assets/perfil/${handle}/og-${shelves[0].id}.png?v=${Date.now().toString(36)}`;
      html = html.replace(/<meta property="og:image" content="[^"]*">/, `<meta property="og:image" content="${ogImg}">`);
      if (!html.includes('twitter:card')) html = html.replace(/(<meta property="og:image"[^>]*>)/, '$1\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n<meta name="twitter:card" content="summary_large_image">');
      fs.writeFileSync(idx, html);
    }
  } finally { srv.kill(); }
}
