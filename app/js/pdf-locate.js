// Localiza un fragmento de texto dentro de una capa de texto de pdf.js (un árbol de
// <span>) y devuelve un Range DOM que lo cubre. Se usa para resaltar el TROZO exacto de
// un pasaje citado por el agente (app.js · highlightPdfPassage).
//
// Retos que resuelve: el texto de pdf.js viene partido en muchos spans (a veces a mitad
// de palabra) y con blancos DISTINTOS a los del corpus. Y no es solo "más o menos
// espacios": el corpus (segment-pdf · reconstruct) une los renglones con un espacio y
// deshace los guiones de corte, mientras que la capa de texto concatena los spans SIN
// separador. El mismo pasaje es "eiusmod tempor" en el corpus y "eiusmodtempor" en el DOM,
// así que comparar blanco contra blanco fallaba en cuanto el pasaje cruzaba un renglón —
// es decir, casi siempre.
//
// Por eso se compara un ESQUELETO: sin blancos, sin guiones y en minúsculas, guardando por
// cada carácter del esqueleto su posición REAL para reconstruir el rango.

// Mínimo de caracteres (de esqueleto) que ha de casar EN EL FALLBACK por prefijo: por
// debajo, el resaltado señalaría un trozo tan corto que no ayuda y sí puede ser un falso
// positivo. Una coincidencia exacta se acepta sea del largo que sea (la pide quien llama).
const MIN_MATCH = 20;

export function rangeForText(root, target) {
  if (!root || !target) return null;
  const nodes = [];
  let full = '';
  const walker = (root.ownerDocument || document).createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push({ node, start: full.length, end: full.length + node.nodeValue.length });
    full += node.nodeValue;
  }
  if (!full) return null;

  let skel = '';
  const map = [];                      // map[i] = posición real del i-ésimo carácter del esqueleto
  for (let i = 0; i < full.length; i++) {
    if (SKIP.test(full[i])) continue;
    skel += full[i].toLowerCase();
    map.push(i);
  }
  const nTarget = skeleton(target);
  if (!skel || !nTarget) return null;

  let idx = skel.indexOf(nTarget);
  let len = nTarget.length;
  if (idx === -1) {
    // El pasaje no está entero en la página (cruza el corte de página, o pdf.js extrajo
    // algo distinto): se resalta el PREFIJO MÁS LARGO que sí está, no un prefijo fijo —
    // así el subrayado llega hasta donde llega el texto de esta página. Búsqueda binaria:
    // si un prefijo de n casa, cualquiera más corto también.
    let lo = MIN_MATCH, hi = nTarget.length - 1;
    idx = -1; len = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const at = skel.indexOf(nTarget.slice(0, mid));
      if (at === -1) { hi = mid - 1; }
      else { idx = at; len = mid; lo = mid + 1; }
    }
    if (idx === -1) return null;
  }

  const rawStart = map[idx];
  const rawEnd = map[idx + len - 1] + 1;
  const startInfo = nodes.find(n => rawStart >= n.start && rawStart < n.end);
  const endInfo = nodes.find(n => rawEnd > n.start && rawEnd <= n.end);
  if (!startInfo || !endInfo) return null;

  const range = (root.ownerDocument || document).createRange();
  range.setStart(startInfo.node, rawStart - startInfo.start);
  range.setEnd(endInfo.node, rawEnd - endInfo.start);
  return range;
}

// Blancos, guion de corte y guion normal: los tres difieren entre corpus y capa de texto.
// Se descartan en AMBOS lados, así que "state-of-the-art" sigue casando consigo mismo.
const SKIP = /[\s\u00ad\u2010\u2011-]/;

function skeleton(s) {
  return String(s).replace(/[\s\u00ad\u2010\u2011-]+/g, '').toLowerCase();
}
