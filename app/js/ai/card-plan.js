// Plan de tarjetas POR CAPÍTULO (WU4 del feature "multi-tipo + plan de capítulos").
// El lector elige un total de tarjetas y el AGENTE propone cuántas llevaría cada
// capítulo; después edita ese plan a mano y genera capítulo por capítulo (eso es WU5:
// esta pantalla llamará a `suggestPlan`). Este módulo entrega el planificador completo
// sin UI: lista de capítulos con tamaño, prompt nuevo (no toca prompts existentes),
// validación DETERMINISTA de la respuesta y fallback proporcional que nunca bloquea.
//
// Diseño (odd/tasks/multi-tipo-y-plan-capitulos.md §B):
// - El planificador NO lee el libro entero: solo títulos + tokens estimados + una
//   muestra corta por capítulo. Su juicio es sobre estructura, no sobre contenido.
// - Máximo MAX_PLAN_CHAPTERS capítulos con generación en una corrida (llamadas pagas).
// - La validación es código, no prompt: nombres que existen, enteros, tope por
//   capítulo y suma EXACTA al total pedido. Si la respuesta no valida → 1 reintento →
//   fallback al reparto proporcional (el mismo criterio de allocateCounts).
import { estimateTokens } from './context.js';
import { isBoilerplate } from './retrieval.js';
import { balancedObjects } from './query-expand.js';
import { normalizeText } from './figures.js';
import * as LLM from './llm.js';

// Tope de capítulos con generación en UNA corrida: libro grande = demasiadas llamadas
// pagas (capítulos × tipos); el resto queda para una segunda pasada.
export const MAX_PLAN_CHAPTERS = 12;

// ---- Lista de capítulos -------------------------------------------------------

// Recorta una muestra a `max` caracteres sin cortar palabras por la mitad si es fácil:
// si hay un espacio razonablemente cerca del corte, se corta ahí. Pura.
function clipSample(text, max) {
  const s = String(text || '').trim();
  const m = Math.floor(Number(max));
  if (!Number.isFinite(m) || m <= 0) return '';
  if (s.length <= m) return s;
  let cut = s.slice(0, m);
  const sp = cut.lastIndexOf(' ');
  if (sp >= m * 0.6) cut = cut.slice(0, sp);   // solo si el corte por palabra no pierde demasiado
  return cut.trimEnd();
}

// Agrupa pasajes ({ text, chapter }) por capítulo EN ORDEN DE APARICIÓN, descartando
// los accesorios (isBoilerplate: licencias, índices, créditos…). Devuelve
// [{ name, tokens, sample }] donde `tokens` suma estimateTokens del capítulo y `sample`
// son los primeros `maxSample` caracteres del primer pasaje con texto. Con más
// capítulos que `maxChapters` se quedan los MÁS GRANDES (los grandes importan más para
// repartir tarjetas), pero el resultado vuelve en orden de aparición. Entradas
// malformadas se ignoran; nunca lanza. Pura (no toca el índice de Retrieval).
export function chapterList(passages, { maxSample = 400, maxChapters = MAX_PLAN_CHAPTERS } = {}) {
  const byCh = new Map();
  for (const p of Array.isArray(passages) ? passages : []) {
    const ch = p && typeof p === 'object' ? p.chapter : undefined;
    const text = p && typeof p === 'object' ? p.text : undefined;
    // Entrada malformada (sin título utilizable o sin texto string) → se ignora entera:
    // sin título no hay plan posible (el agente nombra el capítulo EXACTO) y sin texto
    // el capítulo no tiene contenido que repartir.
    if (typeof ch !== 'string' || !ch.trim() || typeof text !== 'string' || isBoilerplate(ch)) continue;
    if (!byCh.has(ch)) byCh.set(ch, { name: ch, tokens: 0, sample: '' });
    const c = byCh.get(ch);
    c.tokens += estimateTokens(text);
    if (!c.sample && text.trim()) c.sample = clipSample(text, maxSample);
  }
  const all = [...byCh.values()];
  const capN = Math.floor(Number(maxChapters));
  if (!Number.isFinite(capN)) return all;
  if (capN <= 0) return [];
  if (all.length <= capN) return all;
  // Top por tamaño; sort es estable, así que entre iguales gana el orden de aparición.
  const keep = new Set(
    [...all].sort((a, b) => b.tokens - a.tokens).slice(0, capN).map(c => c.name)
  );
  return all.filter(c => keep.has(c.name));
}

// ---- Reparto proporcional (fallback) ------------------------------------------

// Espejo EXACTO de `allocateCounts` (flashcards.js): reparte proporcional a los tokens
// con suma EXACTA (resto mayor / Hamilton), mínimo 1 por capítulo y — con menos
// tarjetas que capítulos — 1 solo a los más grandes. Va duplicado A PROPÓSITO:
// importar flashcards.js desde aquí arrastraría UI, BD y jobs a un módulo de datos,
// y en WU5 la dependencia se invierte (flashcards llamará a suggestPlan).
function allocateByTokens(items, total) {
  const n = items.length;
  if (!n || total <= 0) return items.map(() => 0);
  if (total < n) {
    const counts = items.map(() => 0);
    [...items.keys()].sort((a, b) => items[b].tokens - items[a].tokens)
      .slice(0, total).forEach(i => { counts[i] = 1; });
    return counts;
  }
  const rest = total - n;                                   // mínimo 1 por capítulo
  const totalTokens = items.reduce((s, c) => s + c.tokens, 0) || 1;
  const quotas = items.map(c => rest * c.tokens / totalTokens);
  const counts = quotas.map(q => 1 + Math.floor(q));
  let left = total - counts.reduce((s, x) => s + x, 0);
  const order = quotas.map((q, i) => [q - Math.floor(q), i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) { if (left <= 0) break; counts[i]++; left--; }
  return counts;
}

const usableChapters = (chapters) =>
  (Array.isArray(chapters) ? chapters : [])
    .filter(c => c && typeof c.name === 'string' && c.name.trim());

// Fallback puro: [{ name, cards }] que suma EXACTAMENTE `total` (o el máximo posible si
// total < nº de capítulos). Mismo criterio que allocateCounts de flashcards.js.
export function proportionalPlan(chapters, total) {
  const list = usableChapters(chapters);
  const t = Math.floor(Number(total));
  const counts = allocateByTokens(
    list.map(c => ({ tokens: Math.max(0, Math.round(Number(c.tokens)) || 0) })),
    Number.isFinite(t) ? t : 0,
  );
  return list.map((c, i) => ({ name: c.name, cards: counts[i] }));
}

// ---- Prompt del planificador --------------------------------------------------

// Mensajes para el planificador. Contrato de salida SOLO JSON, explícito en el prompt.
// El plan es una SUGERENCIA: el lector va a poder editar cada número antes de generar
// (eso lo deja claro el prompt para que el modelo no "proteja" su reparto).
export function buildPlanMessages({ bookTitle = '', goal = '', chapters = [], total = 0 } = {}) {
  const list = usableChapters(chapters);
  const t = Math.max(0, Math.floor(Number(total)) || 0);
  const listing = list.map((c, i) => {
    const tokens = Math.max(0, Math.round(Number(c.tokens)) || 0);
    const sample = typeof c.sample === 'string' ? c.sample.trim() : '';
    return `${i + 1}. ${c.name} — ${tokens} tokens${sample ? `\n   Inicio del texto: "${clipSample(sample, 400)}"` : ''}`;
  }).join('\n');
  const system = `Eres un planificador de estudio: reparte un total de flashcards entre los capítulos de un libro, según lo que cada uno merece.

ENTREGA (obligatorio): responde SOLO con un objeto JSON válido, sin markdown ni texto alrededor, con esta forma exacta:
{"chapters":[{"name":"<título EXACTO de la lista>","cards":N,"reason":"<una frase breve en español>"}],"total":M}

REGLAS:
- "name" debe ser el título EXACTO de un capítulo de la lista. NO inventes capítulos.
- Cada capítulo con contenido recibe al menos 1 tarjeta.
- La suma de "cards" debe ser EXACTAMENTE el total indicado.
- En "reason" justifica en UNA frase breve por qué ese capítulo merece más o menos tarjetas: densidad de conceptos, definiciones, listas, ejemplos.
- Este plan es una SUGERENCIA: el lector va a poder editar cada número antes de generar.`;
  const user = `LIBRO: ${bookTitle || '(sin título)'}${goal ? `\nOBJETIVO DEL LECTOR: ${goal}` : ''}

CAPÍTULOS (título — tamaño estimado; el "inicio del texto" es una muestra del arranque del capítulo):
${listing}

TOTAL DE TARJETAS A REPARTIR: ${t}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// ---- Parseo tolerante ----------------------------------------------------------

// Extrae { chapters, total } de la respuesta del modelo. Tolerante (prosa, fences,
// <think> de modelos reasoning): prueba los objetos JSON balanceados (el real suele ir
// el ÚLTIMO) y acepta el primero —del último al primero— que traiga `chapters` como
// array. Un JSON truncado no tiene objeto contenedor completo → null (el reintento y
// el fallback deciden). Nunca lanza.
export function parsePlan(raw) {
  const text = String(raw || '')
    .replace(/```(?:json)?/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ');   // descarta el razonamiento inline
  const candidates = balancedObjects(text);
  for (let i = candidates.length - 1; i >= 0; i--) {
    let obj;
    try { obj = JSON.parse(candidates[i]); } catch { continue; }
    if (obj && typeof obj === 'object' && Array.isArray(obj.chapters)) {
      return { chapters: obj.chapters, total: obj.total };
    }
  }
  return null;
}

// ---- Validación determinista (el corazón) --------------------------------------

// Normaliza `cards` (array de contadores) a `target` con suma EXACTA, tocando primero
// los capítulos con más margen: al subir, el que más lejos está de su tope; al bajar,
// el que más excede su reparto proporcional. Empates: mayor proporción, luego orden de
// aparición. Nunca baja de `floor`. Determinista y acotado (guard anti-bucle).
function normalizeSum(cards, { cap, prop, floor, target }) {
  const sum = () => cards.reduce((s, x) => s + x, 0);
  let guard = cards.length * (Math.abs(target) + cards.length) + 64;
  while (sum() < target && guard-- > 0) {
    let best = -1;
    for (let i = 0; i < cards.length; i++) {
      const margin = cap[i] - cards[i];
      if (margin <= 0) continue;
      if (best < 0 || margin > cap[best] - cards[best]
        || (margin === cap[best] - cards[best] && prop[i] > prop[best])) best = i;
    }
    if (best < 0) return;   // sin margen (solo posible con floors que aprietan): se deja
    cards[best]++;
  }
  while (sum() > target && guard-- > 0) {
    let best = -1;
    for (let i = 0; i < cards.length; i++) {
      if (cards[i] <= floor[i]) continue;
      const excess = cards[i] - Math.max(floor[i], prop[i]);
      if (best < 0 || excess > cards[best] - Math.max(floor[best], prop[best])
        || (excess === cards[best] - Math.max(floor[best], prop[best]) && cards[i] > cards[best])) best = i;
    }
    if (best < 0) return;
    cards[best]--;
  }
}

// Capa la lista de capítulos a los `maxChapters` más grandes (por tokens), conservando
// el orden de aparición. MAX_PLAN_CHAPTERS se respeta también aquí, aunque el caller
// venga con una lista más larga.
function capToLargest(list, maxChapters) {
  if (list.length <= maxChapters) return list;
  const keep = new Set(
    [...list.keys()]
      .sort((a, b) => (Number(list[b].tokens) || 0) - (Number(list[a].tokens) || 0))
      .slice(0, maxChapters)
  );
  return list.filter((_, i) => keep.has(i));
}

// Valida el plan parseado del agente contra la lista REAL de capítulos y el total
// pedido. Determinista de principio a fin (esto es el corazón del ítem, no el prompt):
//   · nombres que no existen (comparación con normalizeText) → fuera, a `dropped`;
//   · `cards` debe ser entero ≥ 0 → si no, la entrada se descarta;
//   · tope por capítulo: max(1, 3 × su reparto proporcional), para que el agente no
//     concentre todo en un capítulo;
//   · capítulos no mencionados → su reparto proporcional;
//   · la suma se normaliza EXACTAMENTE a `total` (por margen), sin bajar de 1;
//   · todo capítulo con contenido recibe al menos 1 (contrato del prompt, forzado aquí).
// Con total < nº de capítulos no hay reparto que cumpla "≥1 para todos": cae al
// reparto proporcional puro (1 a los más grandes). Sin entradas utilizables devuelve
// plan vacío: el caller hace fallback. Nunca lanza.
export function validatePlan(parsed, { chapters = [], total = 0 } = {}) {
  const out = { plan: [], total: 0, adjusted: false, dropped: [], notes: [] };
  const full = usableChapters(chapters);
  const list = capToLargest(full, MAX_PLAN_CHAPTERS);
  const t = Math.floor(Number(total));
  const reqTotal = Number.isFinite(t) && t > 0 ? t : 0;
  if (!reqTotal || !list.length) return out;   // sin total o sin capítulos: nada que validar
  out.total = reqTotal;

  if (full.length > list.length) {
    out.notes.push(`Lista de capítulos recortada a ${MAX_PLAN_CHAPTERS} (tope de una corrida).`);
  }

  const prop = allocateByTokens(
    list.map(c => ({ tokens: Math.max(0, Math.round(Number(c.tokens)) || 0) })), reqTotal);

  // Con menos tarjetas que capítulos, el mínimo de 1 es imposible: reparto proporcional.
  if (reqTotal < list.length) {
    out.plan = proportionalPlan(list, reqTotal).map(p => ({ ...p, reason: '' }));
    out.adjusted = true;
    out.notes.push('El total es menor que el número de capítulos: solo los más grandes reciben tarjetas.');
    return out;
  }

  const cap = prop.map(p => Math.max(1, 3 * p));
  const cards = new Array(list.length).fill(null);   // null = el agente no lo mencionó
  const reasons = new Array(list.length).fill('');
  const byNorm = new Map();
  list.forEach((c, i) => { const k = normalizeText(c.name); if (k && !byNorm.has(k)) byNorm.set(k, i); });

  let kept = 0;
  for (const e of (parsed && Array.isArray(parsed.chapters) ? parsed.chapters : [])) {
    const name = e && typeof e.name === 'string' ? e.name.trim() : '';
    const i = name ? byNorm.get(normalizeText(name)) : undefined;
    if (i === undefined) {
      if (name) out.dropped.push(name);
      out.notes.push(`Capítulo desconocido descartado: "${name}".`);
      continue;
    }
    if (cards[i] !== null) {                       // nombre duplicado: gana el primero
      out.dropped.push(name);
      out.notes.push(`Entrada duplicada descartada: "${name}".`);
      continue;
    }
    const n = Number(e.cards);
    if (!Number.isInteger(n) || n < 0) {
      out.dropped.push(name);
      out.notes.push(`Entrada descartada ("${name}"): cards no es un entero ≥ 0.`);
      continue;
    }
    cards[i] = n;
    reasons[i] = typeof e.reason === 'string' ? e.reason.trim().slice(0, 300) : '';
    kept++;
  }
  // El agente no dijo NADA utilizable: plan vacío → el caller cae al fallback.
  if (!kept) return out;

  for (let i = 0; i < list.length; i++) {
    if (cards[i] === null) {                       // no mencionado: su proporcional
      cards[i] = prop[i];
      continue;
    }
    if (cards[i] < 1) {                            // cada capítulo con contenido ≥ 1
      out.notes.push(`"${list[i].name}" subido a 1: cada capítulo con contenido recibe al menos una tarjeta.`);
      cards[i] = 1;
      out.adjusted = true;
    }
    if (cards[i] > cap[i]) {                       // anti-concentración: tope 3× proporcional
      out.notes.push(`"${list[i].name}" con tope de ${cap[i]} (3 × su reparto proporcional).`);
      cards[i] = cap[i];
      out.adjusted = true;
    }
  }

  const sum = cards.reduce((s, x) => s + x, 0);
  if (sum !== reqTotal) {                          // la suma cuadra SIEMPRE al total pedido
    normalizeSum(cards, { cap, prop, floor: list.map(() => 1), target: reqTotal });
    out.notes.push(`Suma ajustada al total pedido (${sum} → ${reqTotal}).`);
    out.adjusted = true;
  }

  out.plan = list.map((c, i) => ({ name: c.name, cards: cards[i], reason: reasons[i] }));
  return out;
}

// ---- Sugerencia del agente -----------------------------------------------------

// Pide el plan al modelo (chatStream + buildPlanMessages), parsea y valida. Si no hay
// plan válido, REINTENTA una vez (igual que las otras familias). Si tampoco, cae al
// reparto proporcional (source 'proportional'); un error de la llamada (red, 401…)
// cae igual con source 'fallback-error' y el mensaje en `notes`. AbortError propaga:
// cancelar es del usuario. Devuelve { plan, source, adjusted, notes }.
export async function suggestPlan({ bookTitle = '', goal = '', chapters = [], total = 0, signal } = {}) {
  const messages = buildPlanMessages({ bookTitle, goal, chapters, total });
  const attempt = async () =>
    validatePlan(parsePlan(await LLM.chatStream({ messages, maxTokens: 2048, signal })), { chapters, total });

  try {
    let res = await attempt();
    if (!res.plan.length) res = await attempt();   // un solo reintento
    if (res.plan.length) {
      return { plan: res.plan, source: 'agent', adjusted: res.adjusted, notes: res.notes };
    }
    return {
      plan: proportionalPlan(chapters, total).map(p => ({ ...p, reason: '' })),
      source: 'proportional', adjusted: false,
      notes: ['El plan del agente no fue utilizable; se usó el reparto proporcional.'],
    };
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    return {
      plan: proportionalPlan(chapters, total).map(p => ({ ...p, reason: '' })),
      source: 'fallback-error', adjusted: false,
      notes: [`Falló la llamada al modelo (${e && e.message ? e.message : e}); se usó el reparto proporcional.`],
    };
  }
}
