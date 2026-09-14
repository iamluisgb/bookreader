// Fabrica la fixture de REVISTA del arnés de rendimiento: N páginas, cada una
// una foto JPEG a toda página.
//
// Por qué generada y no descargada como las demás (evals/fetch-fixtures.mjs):
// no hace falta que sea una revista concreta, hace falta que tenga la FORMA de
// una —páginas que son una foto grande— porque lo que se quiere medir es el
// decodificado de imagen, que es lo que domina el render de un PDF así. Las
// fotos salen del canvas de Chromium con ruido encima: nada de JPEG
// trivialmente comprimible, para que pesar y rasterizar cueste de verdad.
//
//   node scripts/make-magazine.mjs [páginas] [salida]
//
// Por defecto, 60 páginas (~95 MB) en evals/fixtures/p4-revista.pdf.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = Number(process.argv[2] || 60);
const SALIDA = process.argv[3] || path.join(RAIZ, 'evals', 'fixtures', 'p4-revista.pdf');
const W = 1700, H = 2200;

const browser = await chromium.launch();
const page = await browser.newPage();
const jpegs = await page.evaluate(async ({ N, W, H }) => {
  const out = [];
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  for (let n = 0; n < N; n++) {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, `hsl(${n * 37 % 360} 70% 45%)`);
    g.addColorStop(1, `hsl(${(n * 37 + 120) % 360} 70% 25%)`);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = (Math.random() * 90) | 0;
      d[i] = Math.min(255, d[i] + r); d[i + 1] = Math.min(255, d[i + 1] + r); d[i + 2] = Math.min(255, d[i + 2] + r);
    }
    ctx.putImageData(img, 0, 0);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 220px sans-serif';
    ctx.fillText(String(n + 1), 80, 260);
    const url = cv.toDataURL('image/jpeg', 0.85);
    out.push(url.slice(url.indexOf(',') + 1));
  }
  return out;
}, { N, W, H });
await browser.close();

// Ensamblado de un PDF mínimo: cada página es un XObject DCTDecode a sangre.
const objs = [];
const add = (body) => { objs.push(body); return objs.length; };
const PW = 595, PH = 770;   // A4-ish en puntos

const kidsIds = [];
const pagesId = 1;
objs.push(null);            // reservado para /Pages

for (let i = 0; i < N; i++) {
  const jpg = Buffer.from(jpegs[i], 'base64');
  const imgId = add(Buffer.concat([
    Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`),
    jpg, Buffer.from('\nendstream'),
  ]));
  const content = Buffer.from(`q ${PW} 0 0 ${PH} 0 0 cm /Im0 Do Q`);
  const contId = add(Buffer.concat([
    Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream'),
  ]));
  const pageId = add(Buffer.from(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im0 ${imgId} 0 R >> >> /Contents ${contId} 0 R >>`));
  kidsIds.push(pageId);
}
objs[0] = Buffer.from(`<< /Type /Pages /Count ${N} /Kids [${kidsIds.map(i => `${i} 0 R`).join(' ')}] >>`);
const catId = add(Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`));

const chunks = [Buffer.from('%PDF-1.4\n')];
let len = chunks[0].length;
const offsets = [];
objs.forEach((body, i) => {
  offsets.push(len);
  const head = Buffer.from(`${i + 1} 0 obj\n`);
  const tail = Buffer.from('\nendobj\n');
  const b = Buffer.concat([head, body, tail]);
  chunks.push(b); len += b.length;
});
const xrefAt = len;
let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
for (const o of offsets) xref += String(o).padStart(10, '0') + ' 00000 n \n';
xref += `trailer\n<< /Size ${objs.length + 1} /Root ${catId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
chunks.push(Buffer.from(xref));

const out = Buffer.concat(chunks);
fs.mkdirSync(path.dirname(SALIDA), { recursive: true });
fs.writeFileSync(SALIDA, out);
console.log(`${path.relative(RAIZ, SALIDA)} · ${N} páginas · ${(out.length / 1048576).toFixed(1)} MB`);
