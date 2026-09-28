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
// la orden de omitir lo dudoso (mejor un label menos que una alucinación).
export function buildGroundingMessages({ dataUrl, width, height }) {
  const text = `Detecta las etiquetas de texto de este diagrama técnico. Devuelve SOLO JSON sin markdown:
{"labels":[{"text":"<texto exacto>","bbox":[x,y,w,h]}]}
con bbox en PÍXELES de la imagen (x,y = arriba-izquierda), encerrando SOLO el texto
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
- "contextFact": UN dato del capítulo que ayude a recordar la respuesta, rastreable al texto
  del capítulo: debe poder SUBRAYARSE en él. Prohibido inventar datos que el texto no diga.
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

Si SÍ la tiene, generá un SVG autocontenido que cumpla TODAS estas reglas:
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
// Parsers tolerantes. Nunca lanzan.
// ---------------------------------------------------------------------------

// Quita fences y razonamiento inline antes de buscar objetos balanceados.
function stripWrappers(text) {
  return String(text ?? '')
    .replace(/```(?:json)?/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ');
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

// ---------------------------------------------------------------------------
// Llamadores finos (async). UI-cero: la Vista llama, esto responde datos.
// ---------------------------------------------------------------------------

// Prompt 1 contra el modelo de visión. Si el parseo no rinde labels, reintenta UNA vez
// con más presupuesto: los modelos de visión que razonan truncan el JSON cuando el tope
// de tokens es corto (medido en el experimento de grounding del spec). truncated=true
// solo cuando TAMBIÉN el reintento rinde vacío. No lanza salvo abort del usuario (la
// cancelación de la generación debe propagarse: reintentar con la señal ya abortada
// solo gasta cuota).
export async function groundFigure({ dataUrl, width, height, signal } = {}) {
  const messages = buildGroundingMessages({ dataUrl, width, height });
  let attempts = 0;
  try {
    let raw = await LLM.chatVision({ messages, signal, maxTokens: GROUNDING_MAX_TOKENS });
    attempts = 1;
    let labels = parseLabelsResponse(raw, { width, height });
    if (!labels.length) {
      // Reintento documentado: los modelos de visión reasoning truncan el JSON.
      raw = await LLM.chatVision({ messages, signal, maxTokens: GROUNDING_RETRY_TOKENS });
      attempts = 2;
      labels = parseLabelsResponse(raw, { width, height });
    }
    return { labels, attempts, truncated: labels.length === 0 };
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;   // cancelación del usuario: propaga, no reintenta
    return { labels: [], attempts, truncated: true, error: e && e.message ? e.message : String(e) };
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
