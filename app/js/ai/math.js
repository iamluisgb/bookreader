// Fórmulas del agente: LaTeX → MathML, con Temml (MIT, vendorizado en `vendor/`).
//
// POR QUÉ MathML Y NO KaTeX. KaTeX maqueta a mano con <span> y necesita SUS PROPIAS FUENTES
// (cientos de KB de woff2) para que la notación no se descuadre. Temml emite MathML y lo
// compone el navegador, que ya lo soporta de forma nativa: pesa una fracción y no arrastra
// tipografías. Para una PWA offline con CSP estricta —donde cada byte se precachea— esa
// diferencia decide.
//
// POR QUÉ CARGA PEREZOSA. La librería son ~167 KB y la mayoría de las respuestas no llevan ni
// una fórmula. `mdToHtml` es SÍNCRONO y deja un marcador con el TeX dentro; la librería se
// baja la primera vez que aparece uno de verdad y sustituye el marcador por MathML. Quien
// nunca pregunte por una fórmula no descarga nada.
//
// DEGRADACIÓN: si Temml no carga (primera visita sin red) o el TeX está roto, el marcador se
// queda con la fórmula en texto limpio —sin los `$` ni las barras invertidas más ruidosas—,
// que es exactamente lo que se veía antes de todo esto. Nunca una respuesta vacía.

const SRC = 'vendor/temml-0.13.3.min.js';
let loading = null;
let scheduled = false;

// Marcador que deja el markdown. El TeX viaja en un data- (escapado por quien lo genera) y el
// texto visible es el TeX ya legible, que es el fallback si no llega la librería.
export function mathPlaceholder(tex, display) {
  return `<span class="ai-math${display ? ' ai-math--block' : ''}" data-tex="${escapeAttr(tex)}"${display ? ' data-display="1"' : ''}>${escapeText(readableTex(tex))}</span>`;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// TeX "presentable" para el fallback: quita los comandos de puro maquetado y traduce los
// símbolos más habituales a Unicode. No pretende ser un renderizador — solo que, si falla
// todo, se lea "0.5 · x" y no "0.5 \cdot x".
const UNICODE = [
  [/\\left|\\right|\\!|\\,|\\;|\\quad|\\qquad/g, ''],
  [/\\cdot/g, '·'], [/\\times/g, '×'], [/\\div/g, '÷'],
  [/\\approx/g, '≈'], [/\\neq/g, '≠'], [/\\leq/g, '≤'], [/\\geq/g, '≥'],
  [/\\pm/g, '±'], [/\\infty/g, '∞'], [/\\sum/g, '∑'], [/\\prod/g, '∏'],
  [/\\alpha/g, 'α'], [/\\beta/g, 'β'], [/\\gamma/g, 'γ'], [/\\delta/g, 'δ'],
  [/\\theta/g, 'θ'], [/\\lambda/g, 'λ'], [/\\mu/g, 'μ'], [/\\sigma/g, 'σ'], [/\\pi/g, 'π'],
  [/\\sqrt\s*\{([^{}]*)\}/g, '√($1)'],
  [/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)'],
  [/\\text\s*\{([^{}]*)\}/g, '$1'],
  [/\\operatorname\s*\{([^{}]*)\}/g, '$1'],
  [/\\(tanh|sinh|cosh|sin|cos|tan|log|ln|exp|max|min|argmax|argmin|softmax)/g, '$1'],
];
const SUPS = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', 'n': 'ⁿ', 'T': 'ᵀ' };

export function readableTex(tex) {
  let s = String(tex || '');
  // Tres pasadas: `\sqrt{\frac{2}{\pi}}` necesita que primero caiga la fracción de dentro
  // para que el radical vea llaves simples. Con anidamientos más profundos se queda a medias,
  // y no pasa nada: esto es el plan B, no el renderizador.
  for (let i = 0; i < 3; i++) {
    const before = s;
    for (const [re, to] of UNICODE) s = s.replace(re, to);
    if (s === before) break;
  }
  s = s.replace(/\^\{?([0-9nT])\}?/g, (m, c) => SUPS[c] || m);
  return s.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

// Se llama desde markdown.js al emitir un marcador: pide una pasada de hidratación para el
// siguiente frame, cuando quien llamó ya habrá insertado el HTML en el documento.
export function scheduleHydrate() {
  if (scheduled || typeof requestAnimationFrame !== 'function') return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; hydrateMath(); });
}

function loadTemml() {
  if (window.temml) return Promise.resolve(window.temml);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = SRC;                       // mismo origen: pasa la CSP `script-src 'self'`
    el.onload = () => resolve(window.temml);
    el.onerror = () => reject(new Error('temml no disponible'));
    document.head.appendChild(el);
  }).catch((e) => { loading = null; throw e; });   // reintentar en la siguiente fórmula
  return loading;
}

// Sustituye los marcadores por MathML. Idempotente: los ya hechos se marcan y se saltan.
export async function hydrateMath(root = document) {
  const nodes = [...root.querySelectorAll('.ai-math:not([data-math-done])')];
  if (!nodes.length) return;
  let temml;
  try { temml = await loadTemml(); } catch { return; }   // sin librería: se queda el texto legible
  if (!temml) return;
  for (const el of nodes) {
    el.dataset.mathDone = '1';
    try {
      el.innerHTML = temml.renderToString(el.dataset.tex || '', {
        displayMode: el.dataset.display === '1',
        throwOnError: false,   // TeX roto → se pinta en rojo, no tumba la respuesta entera
        trust: false,          // sin \href ni \includegraphics: el TeX lo escribe un modelo
        strict: false,
      });
    } catch { /* se queda el texto legible del fallback */ }
  }
}
