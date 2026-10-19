// Batería de P43 F2 (widgets): 20 capítulos de 4 libros de géneros distintos, sacados de los
// fixtures (node evals/fetch-fixtures.mjs). Exporta loadWidgetBattery(); evals/widgets.mjs la usa.
//
// Por qué estos: la pregunta del contrato es si el tipo generaliza, no si sale bien en DDIA.
//   técnico      Pro Git (EN)            capítulos largos, con comandos
//   ciencia      Relativity (EN)         secciones cortas (2–8 mil caracteres), con fórmulas
//   humanidades  On Liberty (EN)         capítulos largos de argumento, sin listas
//   legal        Constitución (ES)       articulado; único en español
// El texto sale con una extracción mínima de HTML (sin dependencias, `unzip` del sistema). No es
// la de la app, pero las citas se comparan con normalizeQuote, que absorbe esas diferencias.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './lib.mjs';

const FIX = path.join(ROOT, 'evals', 'fixtures');

const BLOCK = /<\/?(p|div|h[1-6]|li|br|tr|pre|blockquote|dt|dd|table|section)\b[^>]*>/gi;
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function htmlText(html) {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(BLOCK, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENT[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

const unzip = (epub, member) => execFileSync('unzip', ['-p', path.join(FIX, epub), member], { maxBuffer: 64 << 20 }).toString('utf8');
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s(“"-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

function progit() {
  return [
    ['ch01-getting-started', 'Getting Started'],
    ['ch02-git-basics-chapter', 'Git Basics'],
    ['ch03-git-branching', 'Git Branching'],
    ['ch05-distributed-git', 'Distributed Git'],
    ['ch10-git-internals', 'Git Internals'],
  ].map(([f, chapter]) => ({ book: 'progit', lang: 'en', genre: 'técnico', id: `progit:${f.slice(0, 4)}`, chapter, text: htmlText(unzip('p2-progit.epub', `EPUB/${f}.xhtml`)) }));
}

function relativity() {
  // Una sección del libro = una entrada del índice = un «capítulo» para la app.
  return [10, 12, 13, 17, 21].map((i) => {
    const text = htmlText(unzip('p1-relativity.epub', `OEBPS/7631244486620120910_30155-h-${i}.htm.html`));
    const [num, , title] = text.split('\n');
    return { book: 'relativity', lang: 'en', genre: 'ciencia', id: `relativity:s${i}`, chapter: `${num} ${titleCase(title)}`, text };
  });
}

function onLiberty() {
  let full = [0, 1, 2, 3, 4].map((i) => htmlText(unzip('p5-onliberty.epub', `OEBPS/806396527687182254_34901-h-${i}.htm.html`))).join('\n\n');
  full = full.split('*** END OF THE PROJECT')[0];
  // Las notas al pie de cada capítulo caen al principio del fichero siguiente: fuera.
  full = full.replace(/\n\s*FOOTNOTES?:\s*\n[\s\S]*?(?=\n\s*CHAPTER [IVX]+\. [A-Z])/g, '\n');
  const heads = [...full.matchAll(/\n\s*CHAPTER ([IVX]+)\. ([A-Z][^\n]*?)\.?\n/g)];
  return heads.map((m, n) => ({
    book: 'onliberty', lang: 'en', genre: 'humanidades', id: `onliberty:ch${n + 1}`,
    chapter: `Chapter ${m[1]}. ${titleCase(m[2].trim())}`,
    text: full.slice(m.index + m[0].length, n + 1 < heads.length ? heads[n + 1].index : full.length).trim(),
  }));
}

function constitucion() {
  const text = htmlText(fs.readFileSync(path.join(FIX, 'p3-constitucion.html'), 'utf8'));
  const segs = text.split(/\n\s*(TÍTULO (?:PRELIMINAR|[IVX]+))\s*\n/);
  // El índice repite los títulos: el bueno es el tramo más largo.
  const byTitle = new Map();
  for (let k = 1; k < segs.length; k += 2) if (segs[k + 1].length > (byTitle.get(segs[k]) || '').length) byTitle.set(segs[k], segs[k + 1]);
  return ['II', 'III', 'IV', 'VI', 'VIII'].map((n) => {
    let body = byTitle.get(`TÍTULO ${n}`).split(/\n\s*(?:DISPOSICIONES ADICIONALES|Volver arriba)/)[0];
    body = body.replace(/^\s*(Subir|Jurisprudencia|\[Bloque [^\]]*\])\s*$/gm, '').replace(/\n\s*\n+/g, '\n\n').trim();
    const [head, ...rest] = body.split('\n');
    return { book: 'constitucion', lang: 'es', genre: 'legal', id: `constitucion:${n}`, chapter: `Título ${n}. ${head.trim()}`, text: rest.join('\n').trim() };
  });
}

// SRE 2.ª ed. (O'Reilly, 16-sep-2026): posterior al corte de los modelos. Los otros cuatro son
// textos famosos que el solver se sabe, y con ellos «a ciegas» mide memoria del libro, no si la
// pregunta obliga a leer (P43 F4). Tiene copyright: NO se versiona ni se descarga; es local, de la
// biblioteca de Luis. Si no está, la batería sigue con los cuatro de siempre.
function sre2() {
  if (!fs.existsSync(path.join(FIX, 'p6-sre2.epub'))) return [];
  return [
    ['ch02', 'Chapter 2. The Value of Reliability'],
    ['ch08', 'Chapter 8. Service Level Objectives'],
    ['ch11', 'Chapter 11. Learning from Incidents'],
    ['ch20', 'Chapter 20. How SRE Supports AI'],
    ['ch21', 'Chapter 21. How AI Supports SRE'],
  ].map(([f, chapter]) => ({ book: 'sre2', lang: 'en', genre: 'técnico reciente', id: `sre2:${f}`, chapter, text: htmlText(unzip('p6-sre2.epub', `OEBPS/${f}.html`)) }));
}

export function loadWidgetBattery() {
  return [...progit(), ...relativity(), ...onLiberty(), ...constitucion(), ...sre2()];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const c of loadWidgetBattery()) console.log(c.id.padEnd(18), String(c.text.length).padStart(6), c.chapter.slice(0, 60), '|', JSON.stringify(c.text.slice(0, 50)));
}
