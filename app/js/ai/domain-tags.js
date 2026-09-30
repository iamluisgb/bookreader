// Post-filtro de dominio en la revisión de flashcards (odd/tasks/flashcards-dominio.md).
// Un libro cuyo tema es X (p. ej. grafos de conocimiento) puede traer worked examples de
// otro dominio (p. ej. genómica): las tarjetas son FIELES al pasaje pero fuera de objetivo.
// El prompt de generación no se toca (contrato EV5 de docs/EVALS.md); esto es una pasada
// de etiquetado NUEVA, barata y opt-in que corre el usuario desde la revisión, más un
// descarte por lote de todo un dominio.
//
// Módulo PURO a propósito: sin llm.js ni db.js. Solo fabrica los mensajes del prompt,
// limpia la respuesta del modelo y agrupa. Quien llama (flashcards.js) dueña de la
// llamada LLM, la persistencia y el DOM.

// Techo de una etiqueta de dominio: es un chip en la UI, no una categoría enciclopédica.
// Un modelo desbocado que devuelve una frase entera no debe romper el layout.
const MAX_DOMAIN_LEN = 40;

// Normaliza una etiqueta de dominio para usarla como chip: recorta, colapsa espacios y
// techa la longitud. Nada falsy → '' (el grupo "sin dominio" de la revisión).
export function normalizeDomain(s) {
  if (!s) return '';   // falsy → '': el grupo "sin dominio" de la revisión
  const v = String(s).replace(/\s+/g, ' ').trim();
  return v.slice(0, MAX_DOMAIN_LEN);
}

// Extracción tolerante de un array JSON de strings de la respuesta del modelo. Espeja el
// estilo de `balancedObjects` (query-expand.js) pero para ARRAYS: los frentes llevan
// llaves/corchetes dentro de strings, y los modelos reasoning envuelven el JSON en
// <think> y prosa. Prueba los arrays balanceados del ÚLTIMO al primero (el real suele ir
// tras el razonamiento). NUNCA lanza: cualquier fallo → [] y el caller mantiene el estado.
// Contrato: hasta `n` etiquetas válidas en orden (best effort si el modelo dio menos o
// soltó entradas inservibles); [] solo si no hay NINGUNA aprovechable.
export function parseDomainSuggestions(raw, n) {
  const want = Math.max(0, n | 0);
  if (!want) return [];
  const text = String(raw ?? '')
    .replace(/```(?:json)?/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ');   // descarta el razonamiento de models reasoning
  for (const candidate of balancedArrays(text).reverse()) {
    let arr;
    try { arr = JSON.parse(candidate); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    const labels = [];
    for (const item of arr) {
      // Solo strings: un número o null no es etiqueta, y convertirlo inventaría datos.
      // Sobre-longitud fuera (no recortada): una etiqueta de 80 chars no es un dominio.
      if (typeof item !== 'string') continue;
      const label = normalizeDomain(item);
      if (!label || item.trim().length > MAX_DOMAIN_LEN) continue;
      labels.push(label);
      if (labels.length === want) break;
    }
    if (labels.length) return labels;
  }
  return [];
}

// Arrays JSON balanceados de nivel superior (la gemela de balancedObjects para '['):
// respeta corchetes y llaves dentro de strings. Robusto ante prosa alrededor.
function balancedArrays(text) {
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '[') { if (depth === 0) start = i; depth++; }
    else if (c === ']' && depth > 0) { depth--; if (depth === 0 && start >= 0) { out.push(text.slice(start, i + 1)); start = -1; } }
  }
  return out;
}

// Agrupa los índices de tarjetas por su dominio, en orden de PRIMERA APARICIÓN (la fila
// de chips es estable entre re-renders). Las tarjetas sin `domain` (undefined/null/'')
// van al grupo '' — el caller no pinta chip para ese grupo.
export function groupCardsByDomain(cards) {
  const groups = [];
  const byDomain = new Map();
  for (let i = 0; i < (cards || []).length; i++) {
    const c = cards[i];
    if (!c) continue;
    const domain = normalizeDomain(c.domain);
    let g = byDomain.get(domain);
    if (!g) {
      g = { domain, indices: [] };
      byDomain.set(domain, g);
      groups.push(g);
    }
    g.indices.push(i);
  }
  return groups;
}

// Mensajes de la ÚNICA pasada barata de etiquetado (datos planos, sin llm.js): clasificador
// de dominio que etiqueta el TEMA de cada frente, no el del ejemplo — y devuelve SOLO un
// array JSON de n strings en el mismo orden. `lang` ('es'|'en'|'') fija el idioma de las
// etiquetas; vacío = el idioma de los propios frentes.
export function domainTagMessages(fronts, chapters, lang) {
  const frontsList = (fronts || []).map(f => String(f || ''));
  const langRule = lang === 'es' ? 'español'
    : lang === 'en' ? 'inglés'
      : 'el mismo idioma que los frentes';
  const system = `Eres un clasificador de dominio temático. Recibes una lista numerada de frentes de tarjetas de estudio de un libro.
Para CADA frente, responde con una etiqueta de dominio corta (1-3 palabras, en ${langRule}) que nombre el TEMA del concepto que pregunta — NO el dominio del ejemplo o caso de estudio que el frente pueda mencionar (p. ej. un concepto de grafos ilustrado con genómica se etiqueta "grafos de conocimiento", no "biología").
Etiqueta fiel al tema, sin inventar categorías rebuscadas: si varios frentes comparten tema, repite la misma etiqueta.
Responde SOLO con un array JSON de ${frontsList.length} strings, en el mismo orden que los frentes. Sin markdown, sin explicaciones, sin texto alrededor.`;
  const user = frontsList.map((f, i) => `${i + 1}. ${f}${chapters?.[i] ? ` — ${chapters[i]}` : ''}`).join('\n');
  return { system, user };
}
