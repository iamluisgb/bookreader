// Tarjetas visuales (WU3): constructores de prompts (1–3 del spec en
// odd/tasks/tarjetas-visuales.md), parsers tolerantes, validadores y los dos
// llamadores finos (grounding de figura y selección de oclusión + diagrama SVG).
// Sin UI: todo lo visual llega en WU5. Dos modelos, según el experimento de
// grounding: el de visión localiza etiquetas (prompt 1) y el de texto hace la
// pedagogía (prompts 2 y 3).
//
// Los parsers NUNCA lanzan: los modelos reasoning envuelven el JSON en prosa,
// fences o <think>, y un modelo de visión con presupuesto corto trunca a mitad
// de objeto (ver "Evidencia del experimento de grounding" en el spec).

import { balancedObjects } from './query-expand.js';
import { parseLabelsResponse, normalizeText } from './figures.js';
import * as LLM from './llm.js';

// Presupuesto de salida del grounding. El experimento midió que glm5.3-flash
// razona y con max_tokens=1500 trunca el JSON a mitad: con ≥4000 cierra
// (finish_reason=stop). Guarda obligatoria 1 del spec.
const GROUNDING_MAX_TOKENS = 4000;
// Reintento del grounding: mismo motivo, un poco más de margen.
const GROUNDING_RETRY_TOKENS = 6000;
// Pedagogía (prompts 2 y 3): la salida es chica (≤3 tarjetas) pero un modelo
// reasoning consume presupuesto igual; el SVG del prompt 3 además es largo.
const PEDAGOGY_MAX_TOKENS = 4000;

const DIFFICULTIES = new Set(['easy', 'medium', 'hard']);
const MAX_OCCLUSION_CARDS = 3;

// ---------------------------------------------------------------------------
// Prompt 1 — grounding de labels con el modelo de visión.
// ---------------------------------------------------------------------------

// Mensajes multimodales (formato OpenAI: content como array con {type:'text'} y
// {type:'image_url'}) para pedir las etiquetas de una figura. El texto replica el
// prompt validado en el experimento: contrato JSON exacto, medidas en píxeles y
// la orden de omitir lo dudoso (mejor un label menos que una alucinación). Agrega
// el veredicto `kind` (oclusiones-calidad WU2): SOLO un diagrama vale la pena
// ocluir; una captura, foto, código o anécdota ilustrada produce tarjetas que no
// son material de estudio (la captura del acertijo del granjero de la pág. 59).
export function buildGroundingMessages({ dataUrl, width, height }) {
  const text = `Clasifica qué ES esta imagen y detecta sus etiquetas de texto. Devuelve SOLO JSON sin markdown:
{"kind":"diagram|illustration|screenshot|code|other","labels":[{"text":"<texto exacto>","bbox":[x,y,w,h]}]}
REGLA DE "kind": SOLO un DIAGRAMA (esquema, flujo, jerarquía, grafo, arquitectura o tabla con
estructura) sirve para estudiar tapando etiquetas; una captura de pantalla, una foto, una
página de código, una imagen decorativa o una anécdota ilustrada NO.
Las bbox van en PÍXELES de la imagen (x,y = arriba-izquierda), encerrando SOLO el texto
(no el ícono ni la forma completa). La imagen mide ${width}×${height} píxeles.
Omite las etiquetas de las que no estés seguro.`;
  return [{
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: dataUrl } },
    ],
  }];
}

// ---------------------------------------------------------------------------
// Prompt 2 — selección de oclusión con el modelo de texto.
// ---------------------------------------------------------------------------

// Aplana labels ({text,bbox} de figures.js o strings sueltos) a la lista de textos
// que el prompt le muestra al modelo.
function labelTexts(labels) {
  return (Array.isArray(labels) ? labels : [])
    .map(l => (typeof l === 'string' ? l : (l && typeof l.text === 'string' ? l.text : '')))
    .map(s => s.trim())
    .filter(Boolean);
}

function occlusionPrompt({ labels, chapterText, figureCaption, bookTitle, viaTool }) {
  const labelList = labels.length
    ? labels.map(l => `- ${l}`).join('\n')
    : '- (ninguna)';
  const context = [
    bookTitle ? `Libro: ${bookTitle}` : '',
    figureCaption ? `Figura: ${figureCaption}` : '',
  ].filter(Boolean).join(' · ');
  const delivery = viaTool
    ? `ENTREGA (obligatorio): llama a la herramienta "create_occlusion_cards" con el parámetro "cards".`
    : `FORMATO (obligatorio): responde SOLO con un objeto JSON válido, sin markdown ni texto alrededor.`;
  return `Eres un experto en aprendizaje multimedia (principios de Mayer) que prepara tarjetas de oclusión de imágenes a partir de una figura de un libro.

ETIQUETAS detectadas en la figura (texto exacto, con su posición):
${labelList}
${context ? `\nCONTEXTO: ${context}\n` : ''}
TEXTO DEL CAPÍTULO (única fuente permitida para los datos):
"""
${chapterText}
"""

REGLAS (obligatorias):
- Elegí como máximo ${MAX_OCCLUSION_CARDS} etiquetas que VALGA LA PENA tapar: elementos que portan información
  (nombres de partes, valores, etapas de un flujo). REGLA DE MAYER: NUNCA ocluyas partes
  puramente decorativas (marcos, fondos, logos, adornos sin contenido informativo).
- "question": pregunta clara y AUTOCONTENIDA en ESPAÑOL que se responda tapando esa etiqueta
  (se entiende sin tener el libro delante).
- "contextFact": UNA frase corta con UN dato del capítulo que RESPONDA la pregunta y NOMBRE
  explícitamente el contenido de la etiqueta tapada (lo que quedó oculto). Rastreable al texto
  del capítulo: un dato rastreable debe poder SUBRAYARSE en él. Prohibido inventar datos que el
  texto no diga. Prohibido el relleno genérico que no menciona lo tapado (p. ej.
  «El capítulo explica que…»), la misma frase de relleno repetida en varias tarjetas y el
  dato que no dice qué estaba oculto.
- "difficulty": "easy", "medium" o "hard", según cuánto cuesta recordar la etiqueta.
- TODO lo visible para el usuario va en ESPAÑOL.
- Si NINGUNA etiqueta vale la pena, devuelve {"cards":[]}. Mejor cero tarjetas que una mala.

${delivery}
Cada tarjeta es {"occludedLabel":"<etiqueta exacta de la lista>","question":"...","contextFact":"...","difficulty":"easy|medium|hard"}.`;
}

// Mensajes de texto para el prompt 2: elegir hasta 3 etiquetas que valga la pena
// ocluir, con la regla de Mayer y datos rastreables al capítulo.
export function buildOcclusionMessages({ labels, chapterText, figureCaption = '', bookTitle = '' } = {}) {
  return [
    {
      role: 'system',
      content: occlusionPrompt({
        labels: labelTexts(labels),
        chapterText: String(chapterText ?? ''),
        figureCaption: String(figureCaption ?? ''),
        bookTitle: String(bookTitle ?? ''),
        viaTool: false,
      }),
    },
  ];
}

// Schema de la herramienta para la entrega estructurada del prompt 2 (mismo patrón
// que cardsTool de flashcards.js: los argumentos tienen forma garantizada).
function occlusionTool() {
  return [{
    type: 'function',
    function: {
      name: 'create_occlusion_cards',
      description: 'Entrega las tarjetas de oclusión seleccionadas para la figura.',
      parameters: {
        type: 'object',
        properties: {
          cards: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                occludedLabel: { type: 'string', description: 'Etiqueta exacta de la lista detectada en la figura' },
                question: { type: 'string', description: 'Pregunta autocontenida en español' },
                contextFact: { type: 'string', description: 'Dato rastreable al texto del capítulo' },
                difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
              },
              required: ['occludedLabel', 'question', 'contextFact'],
            },
          },
        },
        required: ['cards'],
      },
    },
  }];
}

// ---------------------------------------------------------------------------
// Prompt 3 — generación de diagrama SVG con el modelo de texto.
// ---------------------------------------------------------------------------

function diagramPrompt({ concept, chapterText }) {
  return `Eres un experto en aprendizaje multimedia (principios de Mayer) que convierte conceptos de un libro en diagramas de estudio con un nodo oculto.

CONCEPTO a diagramar: ${String(concept ?? '').trim()}

TEXTO DEL CAPÍTULO (única fuente permitida para el contenido):
"""
${String(chapterText ?? '')}
"""

PRIMERO, EL GATE (obligatorio): solo diagramas con ESTRUCTURA RELACIONAL — secuencia, flujo,
comparación o jerarquía. Si el concepto no la tiene, responde SOLO:
{"usable":false,"reason":"<motivo breve en español>"}
y nada más. Mejor un "no" honesto que un diagrama forzado.

Si SÍ la tiene, genera un SVG autocontenido que cumpla TODAS estas reglas:
- viewBox="0 0 720 H" con H entre 180 y 280 (relación de aspecto apaisada, sin px fijos fuera del viewBox).
- Clases obligatorias: "d-box" en las cajas, "d-txt" en los textos, "d-cap" en los rótulos de
  flechas/leyendas, "d-line" en las líneas y flechas.
- El NODO OBJETIVO (la respuesta que el estudiante debe recordar) lleva un id único
  (answerNodeId) y su texto es "?" en el frente; al voltear la tarjeta se le añaden las clases
  "is-fill" e "is-strong" y se muestra la respuesta. Los demás nodos van completos.
- Solo formas y texto SVG básicos (rect, line, path, text, g). Sin scripts, sin eventos, sin
  imágenes externas: el SVG se sanitiza después y lo inválido se descarta.
- TODO el texto del diagrama en ESPAÑOL.

FORMATO (obligatorio): responde SOLO con un objeto JSON válido, sin markdown ni texto alrededor:
{"usable":true,"svg":"<svg ...>...</svg>","answerNodeId":"<id del nodo objetivo>","question":"<pregunta en español>","contextFact":"<dato rastreable al capítulo>"}`;
}

// Mensajes de texto para el prompt 3: gate de estructura relacional + reglas del SVG.
export function buildDiagramMessages({ concept, chapterText } = {}) {
  return [{ role: 'system', content: diagramPrompt({ concept, chapterText }) }];
}

// ---------------------------------------------------------------------------
// Prompt 3 (variante por LOTE) — varios diagramas en una sola llamada.
// ---------------------------------------------------------------------------

// El modelo SELECCIONA los conceptos con estructura relacional y los genera en el mismo
// turno: una llamada en vez de N (una por concepto, con gate individual) a cambio de una
// salida más larga — por eso comparte el presupuesto generoso de la pedagogía.
function diagramBatchPrompt({ chapterText, count }) {
  return `Eres un experto en aprendizaje multimedia (principios de Mayer) que convierte conceptos de un libro en diagramas de estudio con un nodo oculto.

TEXTO DEL CAPÍTULO (única fuente permitida para el contenido):
"""
${String(chapterText ?? '')}
"""

TAREA: elige hasta ${count} conceptos DISTINTOS del capítulo que tengan ESTRUCTURA RELACIONAL
(secuencia, flujo, comparación o jerarquía) y genera un diagrama por concepto en este mismo
turno (seleccionar y generar en la misma pasada evita una llamada por concepto).
Mejor menos diagramas que diagramas forzados: un concepto sin estructura relacional se deja afuera.

Cada diagrama debe cumplir TODAS estas reglas:
- viewBox="0 0 720 H" con H entre 180 y 280 (relación de aspecto apaisada, sin px fijos fuera del viewBox).
- Clases obligatorias: "d-box" en las cajas, "d-txt" en los textos, "d-cap" en los rótulos de
  flechas/leyendas, "d-line" en las líneas y flechas.
- El NODO OBJETIVO (la respuesta que el estudiante debe recordar) lleva un id único
  (answerNodeId) y su texto es "?" en el frente; al voltear la tarjeta se le añaden las clases
  "is-fill" e "is-strong" y se muestra la respuesta. Los demás nodos van completos.
- Solo formas y texto SVG básicos (rect, line, path, text, g). Sin scripts, sin eventos, sin
  imágenes externas: el SVG se sanitiza después y lo inválido se descarta.
- TODO el texto del diagrama en ESPAÑOL.

FORMATO (obligatorio): responde SOLO con un objeto JSON válido, sin markdown ni texto alrededor:
{"diagrams":[{"concept":"<concepto diagramado>","svg":"<svg ...>...</svg>","answerNodeId":"<id del nodo objetivo>","question":"<pregunta en español>","contextFact":"<dato rastreable al capítulo>"}]}`;
}

// Mensajes de texto para la variante por lote del prompt 3: mismas reglas que el single,
// pero pide hasta `count` diagramas distintos del capítulo en una sola llamada.
export function buildDiagramBatchMessages({ chapterText, count = 2 } = {}) {
  return [{ role: 'system', content: diagramBatchPrompt({ chapterText, count }) }];
}

// ---------------------------------------------------------------------------
// Parsers tolerantes. Nunca lanzan.
// ---------------------------------------------------------------------------

// Quita fences y razonamiento inline antes de buscar objetos balanceados.
function stripWrappers(text) {
  return String(text ?? '')
    .replace(/```(?:json)?/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ');
}

// WU2 (oclusiones-calidad): valores válidos del veredicto `kind` del grounding.
// Solo 'diagram' (esquema, flujo, jerarquía, grafo, arquitectura o tabla con
// estructura) se oculta; el resto NO es material de estudio.
const FIGURE_KINDS = new Set(['diagram', 'illustration', 'screenshot', 'code', 'other']);

// Normaliza el veredicto `kind` del modelo a un valor del contrato, o a '' cuando
// falta o es desconocido. '' se trata como NO diagrama (por seguridad): mejor
// perder la figura que pagar cuota por una captura o una anécdota. NUNCA lanza.
export function normalizeFigureKind(raw) {
  const k = String(raw ?? '').trim().toLowerCase();
  return FIGURE_KINDS.has(k) ? k : '';
}

// Parseo tolerante de la respuesta del prompt 1 con el veredicto `kind` incluido.
// Las labels salen de parseLabelsResponse (figures.js: la misma extracción
// tolerante de siempre, con clampBbox y dedupe) y el `kind` del PRIMER objeto
// balanceado que traiga un kind válido del contrato (prosa, fences y truncado no
// importan). kind '' = el modelo no respondió un valor conocido. NUNCA lanza.
export function parseGroundingResponse(text, { width, height } = {}) {
  const labels = parseLabelsResponse(text, { width, height });
  const raw = stripWrappers(text);
  for (const chunk of balancedObjects(raw)) {
    let obj;
    try { obj = JSON.parse(chunk); } catch { continue; }   // truncado/roto → siguiente
    if (!obj || typeof obj !== 'object') continue;
    const kind = normalizeFigureKind(obj.kind);
    if (kind) return { labels, kind };
  }
  return { labels, kind: '' };
}

// Normaliza una tarjeta cruda del prompt 2. null si no sirve.
function sanitizeOcclusionCard(card, allowedNorms) {
  if (!card || typeof card !== 'object') return null;
  const occludedLabel = typeof card.occludedLabel === 'string' ? card.occludedLabel.trim() : '';
  const question = typeof card.question === 'string' ? card.question.trim() : '';
  const contextFact = typeof card.contextFact === 'string' ? card.contextFact.trim() : '';
  if (!occludedLabel || !question || !contextFact) return null;
  // El modelo SOLO puede ocluir etiquetas que el grounding realmente detectó:
  // comparación sin caso ni tildes (la misma de normalizeText de figures.js).
  if (allowedNorms.size && !allowedNorms.has(normalizeText(occludedLabel))) return null;
  const difficulty = DIFFICULTIES.has(card.difficulty) ? card.difficulty : 'medium';
  return { occludedLabel, question, contextFact, difficulty };
}

// Parseo tolerante de la respuesta del prompt 2. Acepta el objeto JSON envuelto en
// prosa/fences o el string de argumentos de un tool-call (mismo JSON). Solo sobreviven
// tarjetas cuya occludedLabel coincide (sin caso ni tildes) con una de allowedLabels;
// sin question o contextFact se descartan; difficulty desconocida → 'medium'; tope de 3.
// NUNCA lanza: [] = nada aprovechable.
export function parseOcclusionCards(text, { allowedLabels = [] } = {}) {
  const allowedNorms = new Set(
    (Array.isArray(allowedLabels) ? allowedLabels : [])
      .map(l => normalizeText(typeof l === 'string' ? l : (l && typeof l.text === 'string' ? l.text : '')))
      .filter(Boolean),
  );
  const raw = stripWrappers(text);
  for (const chunk of balancedObjects(raw)) {
    let obj;
    try { obj = JSON.parse(chunk); } catch { continue; }   // truncado/roto → siguiente
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.cards)) continue;
    return obj.cards
      .map(c => sanitizeOcclusionCard(c, allowedNorms))
      .filter(Boolean)
      .slice(0, MAX_OCCLUSION_CARDS);
  }
  return [];
}

// Validador post-generación del SVG (código, no prompt): parsea XML, exige raíz <svg>,
// rechaza <script>, atributos on*, href con javascript: y <foreignObject>; con
// answerNodeId, exige un elemento con ese id. Devuelve { ok:true, svg } con el markup
// normalizado (re-serializado) o { ok:false, reason }. NUNCA lanza.
export function sanitizeSvg(svg, { answerNodeId = '' } = {}) {
  const markup = typeof svg === 'string' ? svg.trim() : '';
  if (!markup) return { ok: false, reason: 'missing svg' };
  let doc;
  try {
    doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  } catch {
    return { ok: false, reason: 'svg parse error' };
  }
  if (!doc || doc.querySelector('parsererror')) return { ok: false, reason: 'svg parse error' };
  const root = doc.documentElement;
  if (!root || root.localName !== 'svg') return { ok: false, reason: 'root is not <svg>' };
  const all = [root, ...root.getElementsByTagName('*')];
  for (const el of all) {
    const tag = (el.localName || '').toLowerCase();
    if (tag === 'script') return { ok: false, reason: 'forbidden element: script' };
    if (tag === 'foreignobject') return { ok: false, reason: 'forbidden element: foreignObject' };
    for (const attr of [...el.attributes || []]) {
      if (/^on/i.test(attr.name)) return { ok: false, reason: `forbidden attribute: ${attr.name}` };
      if (attr.localName === 'href' && /^\s*javascript:/i.test(attr.value)) {
        return { ok: false, reason: 'forbidden href: javascript:' };
      }
    }
  }
  if (answerNodeId) {
    // getElementById no es fiable en documentos XML sin DTD: se busca el atributo id.
    const target = all.find(el => el.getAttribute && el.getAttribute('id') === answerNodeId);
    if (!target) return { ok: false, reason: `answer node id not found: ${answerNodeId}` };
  }
  let out;
  try {
    out = new XMLSerializer().serializeToString(root).trim();
  } catch {
    return { ok: false, reason: 'svg serialization failed' };
  }
  return { ok: true, svg: out };
}

// Parseo tolerante de la respuesta del prompt 3. Busca el objeto con "usable"
// booleano entre los objetos balanceados (saltea el razonamiento y la basura):
// - usable:false → { usable:false, reason } (el gate del modelo dijo que no).
// - usable:true → valida el SVG (sanitizeSvg) y exige answerNodeId dentro de él y
//   question no vacía; si algo falla → { usable:false, reason }.
// NUNCA lanza.
export function parseDiagramResponse(text) {
  const raw = stripWrappers(text);
  for (const chunk of balancedObjects(raw)) {
    let obj;
    try { obj = JSON.parse(chunk); } catch { continue; }
    if (!obj || typeof obj !== 'object' || typeof obj.usable !== 'boolean') continue;
    if (!obj.usable) {
      const reason = typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason.trim() : 'model declined';
      return { usable: false, reason };
    }
    const answerNodeId = typeof obj.answerNodeId === 'string' ? obj.answerNodeId.trim() : '';
    const check = sanitizeSvg(obj.svg, { answerNodeId });
    if (!check.ok) return { usable: false, reason: `invalid svg: ${check.reason}` };
    if (!answerNodeId) return { usable: false, reason: 'missing answerNodeId' };
    const question = typeof obj.question === 'string' ? obj.question.trim() : '';
    if (!question) return { usable: false, reason: 'missing question' };
    const contextFact = typeof obj.contextFact === 'string' ? obj.contextFact.trim() : '';
    return { usable: true, svg: check.svg, answerNodeId, question, contextFact };
  }
  return { usable: false, reason: 'no usable JSON object found' };
}

// Normaliza una entrada cruda del lote de diagramas. null si no sirve: exige answerNodeId
// no vacío y presente en el markup (sanitizeSvg lo verifica) y question no vacía.
function sanitizeDiagramBatchEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const concept = typeof entry.concept === 'string' ? entry.concept.trim() : '';
  const answerNodeId = typeof entry.answerNodeId === 'string' ? entry.answerNodeId.trim() : '';
  const question = typeof entry.question === 'string' ? entry.question.trim() : '';
  if (!answerNodeId || !question) return null;
  const check = sanitizeSvg(entry.svg, { answerNodeId });
  if (!check.ok) return null;
  const contextFact = typeof entry.contextFact === 'string' ? entry.contextFact.trim() : '';
  return { concept, svg: check.svg, answerNodeId, question, contextFact };
}

// Parseo tolerante de la respuesta del lote del prompt 3. Misma tolerancia que sus
// hermanos (prosa/fences/truncado): busca el objeto con "diagrams" array y valida cada
// entrada con sanitizeSvg; las inválidas se descartan SIN tirar las demás, se deduplica
// por concepto normalizado (misma comparación sin caso ni tildes que las labels) y se
// cappea a maxCards. NUNCA lanza: [] = nada aprovechable.
export function parseDiagramBatchResponse(text, { maxCards = 2 } = {}) {
  const raw = stripWrappers(text);
  for (const chunk of balancedObjects(raw)) {
    let obj;
    try { obj = JSON.parse(chunk); } catch { continue; }   // truncado/roto → siguiente
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.diagrams)) continue;
    const seen = new Set();
    const out = [];
    for (const entry of obj.diagrams) {
      if (out.length >= maxCards) break;
      const card = sanitizeDiagramBatchEntry(entry);
      if (!card) continue;
      const key = normalizeText(card.concept);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(card);
    }
    return out;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Llamadores finos (async). UI-cero: la Vista llama, esto responde datos.
// ---------------------------------------------------------------------------

// Prompt 1 contra el modelo de visión. Si el parseo no rinde labels, reintenta UNA vez
// con más presupuesto: los modelos de visión que razonan truncan el JSON cuando el tope
// de tokens es corto (medido en el experimento de grounding del spec). truncated=true
// solo cuando TAMBIÉN el reintento rinde vacío. Devuelve { labels, kind, attempts,
// truncated } (kind '' si el modelo no dio un valor del contrato). No lanza salvo abort
// del usuario (la cancelación de la generación debe propagarse: reintentar con la señal
// ya abortada solo gasta cuota).
export async function groundFigure({ dataUrl, width, height, signal } = {}) {
  const messages = buildGroundingMessages({ dataUrl, width, height });
  let attempts = 0;
  try {
    let raw = await LLM.chatVision({ messages, signal, maxTokens: GROUNDING_MAX_TOKENS });
    attempts = 1;
    let parsed = parseGroundingResponse(raw, { width, height });
    if (!parsed.labels.length) {
      // Reintento documentado: los modelos de visión reasoning truncan el JSON.
      raw = await LLM.chatVision({ messages, signal, maxTokens: GROUNDING_RETRY_TOKENS });
      attempts = 2;
      parsed = parseGroundingResponse(raw, { width, height });
    }
    return { labels: parsed.labels, kind: parsed.kind, attempts, truncated: parsed.labels.length === 0 };
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;   // cancelación del usuario: propaga, no reintenta
    return { labels: [], kind: '', attempts, truncated: true, error: e && e.message ? e.message : String(e) };
  }
}

// Prompt 2 con la escalera de robustez de flashcards.js (versión de dos escalones):
//   1) function calling FORZADO — los argumentos tienen schema, no prosa que parsear;
//   2) fallback a texto + parser tolerante (proveedores BYOK sin function calling,
//      o modelo que no llamó a la herramienta).
// Devuelve el array de tarjetas (posiblemente vacío) ya validado contra las labels.
export async function generateOcclusions({ labels, chapterText, figureCaption = '', bookTitle = '', signal } = {}) {
  const allowedLabels = labelTexts(labels);
  const messages = buildOcclusionMessages({ labels, chapterText, figureCaption, bookTitle });
  try {
    const { toolCalls } = await LLM.chatTools({
      messages,
      tools: occlusionTool(),
      toolChoice: { type: 'function', function: { name: 'create_occlusion_cards' } },
      maxTokens: PEDAGOGY_MAX_TOKENS,
      signal,
    });
    const call = toolCalls.find(t => t.name === 'create_occlusion_cards');
    // chatTools ya parseó los argumentos a objeto; el parser tolerante acepta el JSON
    // re-serializado (misma forma que un string de argumentos de tool-call).
    if (call) return parseOcclusionCards(JSON.stringify(call.args || {}), { allowedLabels });
  } catch (e) {
    if (e.name === 'AbortError') throw e;   // abort del usuario: no bajar a fallback
  }
  const raw = await LLM.chatStream({ messages, maxTokens: PEDAGOGY_MAX_TOKENS, signal });
  return parseOcclusionCards(raw, { allowedLabels });
}

// Prompt 3 (texto, no tools: el SVG es prosa larga dentro del JSON). Devuelve lo que
// produce parseDiagramResponse: { usable:true, ... } o { usable:false, reason }.
// El reintento por SVG inválido del spec queda para el wiring de WU4: acá una llamada,
// un veredicto.
export async function generateDiagram({ concept, chapterText, signal } = {}) {
  const raw = await LLM.chatStream({
    messages: buildDiagramMessages({ concept, chapterText }),
    maxTokens: PEDAGOGY_MAX_TOKENS,
    signal,
  });
  return parseDiagramResponse(raw);
}

// Prompt 3 por lote (texto, no tools: el SVG es prosa larga dentro del JSON). Si NINGÚN
// diagrama sale usable, regenera UNA vez — el spec cierra el reintento diferido de WU3
// con "1 regeneración → descarte": si tampoco sale nada, se devuelven cero diagramas.
// AbortError propaga (no reintentar con la señal ya abortada); nada más lanza.
export async function generateDiagrams({ chapterText, count = 2, signal } = {}) {
  const messages = buildDiagramBatchMessages({ chapterText, count });
  let attempts = 0;
  try {
    let raw = await LLM.chatStream({ messages, maxTokens: PEDAGOGY_MAX_TOKENS, signal });
    attempts = 1;
    let diagrams = parseDiagramBatchResponse(raw, { maxCards: count });
    if (!diagrams.length) {
      // Regeneración única: otra pasada con el mismo prompt y el mismo presupuesto.
      raw = await LLM.chatStream({ messages, maxTokens: PEDAGOGY_MAX_TOKENS, signal });
      attempts = 2;
      diagrams = parseDiagramBatchResponse(raw, { maxCards: count });
    }
    return { diagrams, attempts };
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;   // cancelación del usuario: propaga, no reintenta
    return { diagrams: [], attempts };
  }
}

// ---------------------------------------------------------------------------
// Prompt 4 — tarjetas de dibujo (proceso para dibujar de memoria + rúbrica).
// ---------------------------------------------------------------------------

// La rúbrica (steps) es el contrato con la revisión del boceto de WU6: el modelo de visión
// coteja el dibujo del lector contra estos pasos, así que deben ser concretos y ordenados.
function drawingCardPrompt({ chapterText, count }) {
  return `Eres un experto en aprendizaje multimedia (principios de Mayer) que prepara ejercicios de recuerdo activo con dibujo: el lector dibuja de memoria un proceso del libro y después compara su boceto contra una rúbrica de pasos esperados.

TEXTO DEL CAPÍTULO (única fuente permitida para el contenido):
"""
${String(chapterText ?? '')}
"""

REGLAS (obligatorias):
- Elige hasta ${count} PROCESOS o SECUENCIAS del capítulo que valga la pena dibujar de memoria:
  algo con pasos ordenados (un flujo, un ciclo, una transformación). Si no hay ninguno,
  devuelve {"cards":[]}. Mejor cero tarjetas que una mala.
- "question": la consigna en ESPAÑOL NEUTRO (sin voseo: «dibuja», no «dibujá»), empezando
  con "Dibuja de memoria ..." y AUTOCONTENIDA
  (se entiende sin tener el libro delante).
- "steps": entre 3 y 7 pasos ORDENADOS y concretos del proceso, con los nombres de los
  componentes conectados (no frases genéricas tipo "paso 1"). Son la rúbrica con la que
  después se revisa el boceto del lector.
- "contextFact": UN dato del capítulo que ayude a recordar el proceso, rastreable al texto
  del capítulo: debe poder SUBRAYARSE en él. Prohibido inventar datos que el texto no diga.
- TODO lo visible para el usuario va en ESPAÑOL NEUTRO (sin voseo).

FORMATO (obligatorio): responde SOLO con un objeto JSON válido, sin markdown ni texto alrededor:
{"cards":[{"question":"Dibuja de memoria ...","steps":["paso 1","paso 2","paso 3"],"contextFact":"..."}]}`;
}

// Mensajes de texto para el prompt 4: consigna de dibujo de memoria + rúbrica de pasos.
export function buildDrawingCardMessages({ chapterText, count = 1 } = {}) {
  return [{ role: 'system', content: drawingCardPrompt({ chapterText, count }) }];
}

// Normaliza una tarjeta de dibujo cruda. null si no sirve: sin question no hay consigna y
// con menos de 3 pasos no es una rúbrica (es una pregunta suelta).
function sanitizeDrawingCard(card) {
  if (!card || typeof card !== 'object') return null;
  const question = typeof card.question === 'string' ? card.question.trim() : '';
  const steps = (Array.isArray(card.steps) ? card.steps : [])
    .map(s => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean);
  if (!question || steps.length < 3) return null;
  const contextFact = typeof card.contextFact === 'string' ? card.contextFact.trim() : '';
  return { question, steps, contextFact };
}

// Parseo tolerante de la respuesta del prompt 4. Misma tolerancia que sus hermanos
// (prosa/fences/truncado): busca el objeto con "cards" array y exige question no vacía y
// steps con AL MENOS 3 strings no vacíos tras trim; las inválidas se descartan SIN tirar
// las demás y se cappea a maxCards. NUNCA lanza: [] = nada aprovechable.
export function parseDrawingCards(text, { maxCards = 1 } = {}) {
  const raw = stripWrappers(text);
  for (const chunk of balancedObjects(raw)) {
    let obj;
    try { obj = JSON.parse(chunk); } catch { continue; }   // truncado/roto → siguiente
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.cards)) continue;
    const out = [];
    for (const card of obj.cards) {
      if (out.length >= maxCards) break;
      const clean = sanitizeDrawingCard(card);
      if (clean) out.push(clean);
    }
    return out;
  }
  return [];
}

// Prompt 4 (texto, no tools: la rúbrica es prosa dentro del JSON). Devuelve { cards }
// (posiblemente vacío) ya validado. AbortError propaga; nada más lanza.
export async function generateDrawingCards({ chapterText, count = 1, signal } = {}) {
  try {
    const raw = await LLM.chatStream({
      messages: buildDrawingCardMessages({ chapterText, count }),
      maxTokens: PEDAGOGY_MAX_TOKENS,
      signal,
    });
    return { cards: parseDrawingCards(raw, { maxCards: count }) };
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;   // cancelación del usuario: propaga
    return { cards: [] };
  }
}

// ---------------------------------------------------------------------------
// Prompt 5 — revisión del boceto de una tarjeta de dibujo (modelo de visión).
// ---------------------------------------------------------------------------

// Presupuesto de la revisión: mismas guardas del grounding (un modelo de visión que
// razona trunca el JSON con un tope corto), ahora con evidencia propia de WU7.
const DRAWING_REVIEW_MAX_TOKENS = 4000;
// Reintento: un poco más de margen sobre el presupuesto del primer intento.
const DRAWING_REVIEW_RETRY_MARGIN = 2000;
// El comentario del modelo es una sola frase; se cappea por si el modelo se desboca.
const MAX_COMMENT_CHARS = 140;

// Caja delimitadora de un trazo (puntos ya en las coordenadas que el caller decidió
// enviar — píxeles del canvas) como [x0, y0, x1, y1] redondeada. null si el trazo
// está vacío.
function strokeBbox(points) {
  if (!Array.isArray(points) || !points.length) return null;
  const xs = points.map(p => Number(p && p.x)).filter(Number.isFinite);
  const ys = points.map(p => Number(p && p.y)).filter(Number.isFinite);
  if (!xs.length || !ys.length) return null;
  const r = (n) => Math.round(n);
  return [r(Math.min(...xs)), r(Math.min(...ys)), r(Math.max(...xs)), r(Math.max(...ys))];
}

// Mensajes de visión para la revisión del boceto: (a) texto con la rúbrica numerada
// (los `steps` del dorso de la tarjeta), la consigna y los metadatos de trazos
// (índice 1-based, nº de puntos y bbox en píxeles); (b) la imagen del canvas.
// Los trazos llegan con puntos en PÍXELES del canvas (study.js reescala los
// normalizados 0..1 antes de llamar); el bbox sale de ellos.
// Contrato de salida, explícito en el prompt: SOLO JSON.
export function buildDrawingReviewMessages({ dataUrl, strokes, plan, question } = {}) {
  const steps = (Array.isArray(plan) ? plan : []).map(s => String(s ?? '').trim()).filter(Boolean);
  const meta = (Array.isArray(strokes) ? strokes : []).map((s, i) => ({
    i: i + 1,
    points: Array.isArray(s) ? s.length : 0,
    bbox: strokeBbox(s) || [0, 0, 0, 0],
  }));
  const text = `Un estudiante dibujó de memoria el siguiente proceso (canvas en blanco, trazos negros):
"""
Pasos esperados (en orden): ${steps.length ? steps.map((s, i) => `${i + 1}. ${s}`).join(' ') : '(sin rúbrica)'}
Proceso: ${String(question ?? '').trim()}
"""
Trazos detectados (numerados, con caja delimitadora en píxeles del canvas):
${JSON.stringify(meta)}

Tu tarea: mirando la IMAGEN adjunta del boceto, determina qué pasos esperados fueron
dibujados y a qué trazo corresponden.
Devuelve SOLO JSON sin markdown, con esta forma exacta:
{"steps":[{"name":"<paso exacto de la rúbrica>","detected":true|false,"stroke":<nº de trazo o null>}],"extraCount":<nº de trazos que no corresponden a ningún paso>,"comment":"<una frase en español, máx ${MAX_COMMENT_CHARS} caracteres>"}`;
  return [{
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: String(dataUrl ?? '') } },
    ],
  }];
}

// `stroke` crudo del modelo → nº de trazo 1-based o null. false/negativo/no entero → null.
function sanitizeStrokeNumber(raw, detected) {
  if (!detected) return null;
  return Number.isInteger(raw) && raw >= 1 ? raw : null;
}

// Parseo tolerante de la revisión del boceto (prosa/fences/JSON truncado). NUNCA lanza.
// Normaliza contra `plan` (los steps del dorso): una fila cuyo `name` no coincide con
// ningún paso (comparación sin caso ni tildes, la de normalizeText) se DESCARTA — el
// modelo no inventa pasos; los pasos de `plan` que el modelo no mencionó se rellenan
// como { name, detected: false, stroke: null } para que la UI tenga las filas completas
// en el orden de la rúbrica. `stroke` fuera de forma (no entero ≥ 1) → null; el recorte
// contra la cantidad real de trazos lo hace reviewDrawing, que sí la conoce.
export function parseDrawingReview(text, { plan = [] } = {}) {
  const names = (Array.isArray(plan) ? plan : []).map(s => String(s ?? '').trim());
  const byNorm = new Map();
  names.forEach((name, i) => {
    const norm = normalizeText(name);
    if (norm && !byNorm.has(norm)) byNorm.set(norm, i);
  });
  const raw = stripWrappers(text);
  for (const chunk of balancedObjects(raw)) {
    let obj;
    try { obj = JSON.parse(chunk); } catch { continue; }   // truncado/roto → siguiente
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.steps)) continue;
    const rows = names.map(name => ({ name, detected: false, stroke: null }));
    let matched = 0;
    for (const entry of obj.steps) {
      if (!entry || typeof entry !== 'object') continue;
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      const idx = byNorm.get(normalizeText(name));
      if (idx == null) continue;                           // paso que no está en la rúbrica: fuera
      const detected = entry.detected === true;
      rows[idx] = { name: names[idx], detected, stroke: sanitizeStrokeNumber(entry.stroke, detected) };
      matched++;
    }
    // Un objeto sin NINGÚN paso de la rúbrica no es una revisión: probar el siguiente
    // candidato (puede haber un JSON bueno después del razonamiento).
    if (!matched) continue;
    const extraRaw = Number(obj.extraCount);
    const extraCount = Number.isFinite(extraRaw) ? Math.max(0, Math.round(extraRaw)) : 0;
    const comment = typeof obj.comment === 'string' ? obj.comment.trim().slice(0, MAX_COMMENT_CHARS) : '';
    return { steps: rows, extraCount, comment };
  }
  return { steps: [], extraCount: 0, comment: '' };
}

// Revisión del boceto contra el modelo de visión. Presupuesto generoso (mismo motivo
// que el grounding: los modelos de visión que razonan truncan JSON corto). Si el parseo
// no rinde NINGÚN paso, reintenta UNA vez con más presupuesto; AbortError propaga sin
// reintentar (la señal ya abortada solo gastaría cuota). Devuelve { review, attempts }
// o { review: null, attempts, error }: nunca lanza salvo abort. Además recorta el nº de
// trazo contra la cantidad real de trazos: fuera de rango → null.
export async function reviewDrawing({ dataUrl, strokes, plan, question, signal, maxTokens = DRAWING_REVIEW_MAX_TOKENS } = {}) {
  const messages = buildDrawingReviewMessages({ dataUrl, strokes, plan, question });
  const strokeCount = Array.isArray(strokes) ? strokes.length : 0;
  const clamp = (review) => ({
    ...review,
    steps: review.steps.map(r => (r.stroke != null && r.stroke > strokeCount
      ? { ...r, stroke: null }
      : r)),
  });
  let attempts = 0;
  try {
    let raw = await LLM.chatVision({ messages, signal, maxTokens });
    attempts = 1;
    let review = parseDrawingReview(raw, { plan });
    if (!review.steps.length) {
      // Reintento documentado: mismo motivo que en el grounding de figuras.
      raw = await LLM.chatVision({ messages, signal, maxTokens: maxTokens + DRAWING_REVIEW_RETRY_MARGIN });
      attempts = 2;
      review = parseDrawingReview(raw, { plan });
    }
    return { review: clamp(review), attempts };
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;   // cancelación del usuario: propaga, no reintenta
    return { review: null, attempts, error: e && e.message ? e.message : String(e) };
  }
}
