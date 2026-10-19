// Forma de los artefactos del Studio (mapa mental, infografía, resumen), PURA: sin DOM, sin
// IndexedDB, sin modelo. La usan la app al generarlos (mindmap.js, infographic.js) y el MCP
// cuando un agente los crea (mcp/src/artifact-tools.mjs), para que lo que escribe un agente
// pase por los mismos techos que lo que genera la app. Los renderers NO vuelven a normalizar lo
// guardado: lo que no se recorte aquí se pinta tal cual (y se sale de la píldora o del póster).
//
// Los textos visibles por defecto («Rama 3», «Ideas clave») los pasa quien llama, ya
// traducidos: este módulo no importa i18n.

// ---- Mapa mental -------------------------------------------------------------------------

// Palabras que no pueden cerrar una etiqueta recortada: «Fiabilidad, escalabilidad y» o
// «Esquema en lectura frente a esquema en» se leían como un error, no como un resumen.
const DANGLING = /\s+(?:y|e|o|u|ni|de|del|la|las|el|los|un|una|a|al|en|con|por|para|sin|sobre|entre|frente|que|como|su|sus|tu|tus|mi|mis|se|lo|and|or|of|the|a|an|to|in|on|for|with|by|vs\.?)$/i;

// Recorta a `maxChars` por FRONTERA DE PALABRA y marca el corte con «…», CONTADO dentro del
// máximo: así la etiqueta sigue cabiendo en la píldora y wrapLabel no la vuelve a truncar
// (una segunda «…»). El texto completo va al detalle del nodo.
export function clampWords(s, maxChars) {
  s = String(s || '').trim();
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars - 1);   // un hueco para la «…»
  const sp = cut.lastIndexOf(' ');
  let out = (sp > 6 ? cut.slice(0, sp) : cut).trim().replace(/[\s,;:.\-–—]+$/, '');
  for (let i = 0; i < 3 && DANGLING.test(out); i++) out = out.replace(DANGLING, '').replace(/[\s,;:]+$/, '');
  // El corte se marca: el texto completo está en el detalle del nodo (`full`).
  return out + '…';
}

export const MINDMAP_LIMITS = { branches: 8, children: 6, depth: 2, title: 44, branch: 32, leaf: 42 };

// Valida/normaliza el árbol. Devuelve null si no es usable (menos de dos ramas con hojas):
// quien llama decide qué hacer (la app, un mapa por capítulos; el MCP, un error).
export function buildMindmapTree(tree, scopeName, { branchLabel = (i) => 'Rama ' + (i + 1) } = {}) {
  const L = MINDMAP_LIMITS;
  const cleanSrc = (s) => (typeof s === 'string' && (s.match(/a\d+/) || [])[0]) || '';
  // Cada hoja guarda una etiqueta CORTA visible + el texto completo (`full`) para el detalle.
  // RECURSIVA: un mapa expandido tiene nietos, y al reabrirlo pasa otra vez por aquí.
  const asLeaf = (raw, depth = 0) => {
    const full = String(raw.label ?? raw).replace(/\s*\[\[a\d+\]\]\s*$/, '').trim();
    const leaf = { label: clampWords(full, L.leaf), src: cleanSrc(raw.src), full };
    const kids = depth < L.depth && Array.isArray(raw.children) ? raw.children : [];
    if (kids.length) leaf.children = kids.slice(0, L.children).map(k => asLeaf(k, depth + 1)).filter(c => c.label);
    return leaf;
  };
  if (tree && Array.isArray(tree.branches) && tree.branches.length) {
    const branches = tree.branches.slice(0, L.branches).map((br, i) => {
      const label = String(br.label || branchLabel(i)).trim();
      return {
        label: clampWords(label, L.branch), full: label,
        children: (Array.isArray(br.children) ? br.children : []).slice(0, L.children).map(c => asLeaf(c)).filter(c => c.label),
      };
    }).filter(br => br.children.length);
    // Un árbol de UNA rama no es un mapa.
    if (branches.length >= 2) return { title: clampWords(String(tree.title || scopeName), L.title), branches };
  }
  return null;
}

// ---- Infografía ----------------------------------------------------------------------------

// Techos del esquema. Son GATES, no estética: a un modelo al que se le piden «ideas clave» le
// salen veinte, y veinte ideas convierten el póster en un muro.
export const LIMITS = {
  ideas: 8,
  panels: 3,
  panelItems: 4,
  aside: 2,
  thesis: 260,
  head: 48,
  body: 170,
  quote: 170,
  attribution: 90,
};

// Iconos por posición (el modelo no conoce nuestro set). Determinista: misma ranura, mismo
// icono.
const IDEA_ICONS = ['target', 'chart', 'user', 'note', 'undo', 'warning', 'books', 'sparkles'];
const STEP_ICONS = ['sparkles', 'chart', 'columns', 'target', 'books', 'gear', 'check', 'undo'];
const COL_ICONS = ['columns', 'chart', 'books', 'undo', 'target', 'note', 'gear', 'warning'];

function str(v) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

function clamp(s, max) {
  s = str(s);
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s.,;:]+$/, '')}…`;
}

// El modelo a veces envuelve el JSON en ```json ... ``` o añade una frase antes. Se busca el
// primer objeto balanceado en vez de fiarse de `JSON.parse` a la primera.
export function parseJson(raw) {
  let s = String(raw || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// Recorta y da forma al JSON de la infografía. Devuelve el contenido del póster (sin portada ni
// título: eso lo pone la app, que es quien los tiene). `invalid` cuenta las anclas que no
// existen en el libro — el póster no las pinta, pero es la señal de calidad de las citas.
export function normalizeInfographic(raw, anchors = null, { ideasTitle = 'Ideas clave' } = {}) {
  const o = typeof raw === 'string' ? parseJson(raw) : raw || {};
  const list = (v) => (Array.isArray(v) ? v : []);
  const invalid = { count: 0 };

  const takeSrc = (src) => {
    const s = str(src).replace(/^\[\[|\]\]$/g, '');
    if (!s) return '';
    if (anchors && !anchors.has(s)) {
      invalid.count++;
      return '';
    }
    return s;
  };

  const ideas = list(o.ideas)
    .map((it, i) => ({
      ico: IDEA_ICONS[i % IDEA_ICONS.length],
      head: clamp(it && (it.head || it.title), LIMITS.head),
      body: clamp(it && (it.body || it.text), LIMITS.body),
      src: takeSrc(it && it.src),
    }))
    .filter((it) => it.head && it.body)
    .slice(0, LIMITS.ideas);

  const kindOf = (k) => (['flow', 'cols', 'rows'].includes(k) ? k : null);
  const panels = list(o.panels)
    .map((p) => {
      const kind = kindOf(p && p.kind);
      if (!kind) return null;
      const icons = kind === 'flow' ? STEP_ICONS : kind === 'rows' ? null : COL_ICONS;
      const items = list(p.items)
        .map((it, i) => {
          const base = { src: takeSrc(it && it.src) };
          if (kind === 'rows') return { tag: clamp(it && (it.tag || it.head), 40), body: clamp(it && it.body, LIMITS.body), ...base };
          return {
            ico: icons[i % icons.length],
            head: clamp(it && (it.head || it.title), LIMITS.head),
            sub: clamp(it && it.sub, 40),
            body: clamp(it && it.body, LIMITS.body),
            ...base,
          };
        })
        .filter((it) => (kind === 'rows' ? it.tag && it.body : it.head && it.body))
        .slice(0, LIMITS.panelItems);
      if (!items.length) return null;
      return { kind, title: clamp(p && p.title, LIMITS.head), items };
    })
    .filter(Boolean)
    .slice(0, LIMITS.panels);

  const aside = list(o.aside)
    .map((a, i) => ({
      ico: i === 0 ? 'note' : 'target',
      label: clamp(a && (a.label || a.head), 40),
      body: clamp(a && a.body, LIMITS.body),
    }))
    .filter((a) => a.label && a.body)
    .slice(0, LIMITS.aside);

  const quote = o.quote || {};
  return {
    kicker: clamp(o.kicker, 70),
    thesis: clamp(o.thesis, LIMITS.thesis),
    ideasTitle: clamp(o.ideasTitle, 40) || ideasTitle,
    ideas,
    panels,
    aside,
    quote: {
      text: clamp(quote.text, LIMITS.quote),
      attribution: clamp(quote.attribution, LIMITS.attribution),
    },
    invalid,
  };
}

// ---- Resumen ---------------------------------------------------------------------------------

// El resumen es Markdown con citas `[[aN]]` (render.js las convierte en enlaces al pasaje; las
// que no existen se quitan sin más). Mismo esqueleto que summary.js: título, TL;DR, ideas
// principales, una sección por capítulo con viñetas citadas y «qué llevarte».
export const SUMMARY_LIMITS = { tldr: 1500, ideas: 8, sections: 40, bullets: 12, bullet: 400, takeaways: 6 };

export function composeSummary(input, scopeName, labels = {}) {
  const L = SUMMARY_LIMITS;
  const lb = { summary: 'Resumen', ideas: 'Ideas principales', takeaways: 'Qué llevarte', ...labels };
  const o = input || {};
  const line = (s) => clamp(s, L.bullet);
  const cite = (src) => {
    const m = typeof src === 'string' ? src.match(/a\d+/) : null;
    return m ? ` [[${m[0]}]]` : '';
  };
  const bullet = (b) => {
    const text = line(typeof b === 'string' ? b : b && b.text);
    return text ? `- ${text}${typeof b === 'object' && b ? cite(b.src) : ''}` : '';
  };
  const bullets = (xs, max) => (Array.isArray(xs) ? xs : []).slice(0, max).map(bullet).filter(Boolean);
  const parts = [`# ${lb.summary} — ${str(scopeName)}`];
  const tldr = clamp(o.tldr, L.tldr);
  if (tldr) parts.push(tldr);
  const ideas = bullets(o.ideas, L.ideas);
  if (ideas.length) parts.push(`## ${lb.ideas}\n\n${ideas.join('\n')}`);
  const sections = (Array.isArray(o.sections) ? o.sections : []).slice(0, L.sections)
    .map((s) => ({ title: clamp(s && s.title, 120), items: bullets(s && s.bullets, L.bullets) }))
    .filter((s) => s.title && s.items.length);
  for (const s of sections) parts.push(`## ${s.title}\n\n${s.items.join('\n')}`);
  const take = bullets(o.takeaways, L.takeaways);
  if (take.length) parts.push(`## ${lb.takeaways}\n\n${take.join('\n')}`);
  return { markdown: parts.join('\n\n') + '\n', empty: !tldr && !ideas.length && !sections.length };
}
