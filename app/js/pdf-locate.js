// Localiza un fragmento de texto dentro de una capa de texto de pdf.js (un árbol de
// <span>) y devuelve un Range DOM que lo cubre. Se usa para resaltar el TROZO exacto de
// un pasaje citado por el agente (app.js · highlightPdfPassage).
//
// Retos que resuelve: el texto de pdf.js viene partido en muchos spans (a veces a mitad
// de palabra) y con blancos distintos a los del corpus. Se normaliza colapsando blancos
// y se guarda, por cada carácter normalizado, su posición REAL, para reconstruir el rango.

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

  // Normaliza (blancos colapsados) guardando el mapa carácter-normalizado → posición real.
  let norm = '', prevSpace = false;
  const map = [];
  for (let i = 0; i < full.length; i++) {
    const ws = /\s/.test(full[i]);
    if (ws) { if (prevSpace) continue; norm += ' '; map.push(i); prevSpace = true; }
    else { norm += full[i]; map.push(i); prevSpace = false; }
  }

  const nTarget = target.replace(/\s+/g, ' ').trim();
  if (!nTarget) return null;
  let idx = norm.indexOf(nTarget);
  let len = nTarget.length;
  if (idx === -1) {                       // pasaje largo o con diferencias: basta el prefijo
    const prefix = nTarget.slice(0, 60);
    idx = norm.indexOf(prefix);
    len = prefix.length;
    if (idx === -1) return null;
  }

  const rawStart = map[idx];
  const rawEnd = map[Math.min(idx + len, map.length) - 1] + 1;
  const startInfo = nodes.find(n => rawStart >= n.start && rawStart < n.end);
  const endInfo = nodes.find(n => rawEnd > n.start && rawEnd <= n.end);
  if (!startInfo || !endInfo) return null;

  const range = (root.ownerDocument || document).createRange();
  range.setStart(startInfo.node, rawStart - startInfo.start);
  range.setEnd(endInfo.node, rawEnd - endInfo.start);
  return range;
}
