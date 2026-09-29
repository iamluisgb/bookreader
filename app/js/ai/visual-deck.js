// Tarjetas visuales (WU5b): orquestación del mazo visual. Dado el texto de un
// capítulo y las figuras del libro, produce las tarjetas de los tres tipos
// reutilizando los llamadores finos de visual-cards.js (groundFigure,
// generateOcclusions, generateDiagrams, generateDrawingCards) y los helpers de
// datos de figures.js (normalizeText).
//
// Sin UI y sin IndexedDB: quien llama guarda el mazo. Las figuras entran como
// parámetro (la resolución de figuras es de otra unidad). La salida son objetos
// planos con el CONTRATO de tarjeta visual que consumen el estudio (WU6), el
// sync (WU8) y el export:
//   occlusion: { type, front, back, figureKey, bbox:{x,y,w,h}, occludedLabel, chapter, src }
//   diagram:   { type, front, back, svg, answerNodeId, chapter, src }
//   drawing:   { type, front, back, steps, chapter, src }
//
// La figura NUNCA viaja inline en la tarjeta: `figureKey` es la clave del
// artefacto y la UI carga el dataUrl desde el store (base64 por tarjeta
// inflaría el mazo y el payload de sync).

import { normalizeText } from './figures.js';
import {
  groundFigure,
  generateOcclusions,
  generateDiagrams,
  generateDrawingCards,
} from './visual-cards.js';

export const VISUAL_TYPES = ['occlusion', 'diagram', 'drawing'];

export function isVisualType(t) {
  return VISUAL_TYPES.includes(t);
}

// ---------------------------------------------------------------------------
// Contrato de tarjeta: helpers de normalización.
// ---------------------------------------------------------------------------

// bbox canónico {x,y,w,h} entero (la forma de parseLabelsResponse) a partir de
// cualquiera de las DOS formas que circulan (array del modelo u objeto): null si
// es inservible. Mismo criterio de aceptación que figures.js.
function bboxToCanonical(bbox) {
  if (Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite)) {
    return { x: Math.round(bbox[0]), y: Math.round(bbox[1]), w: Math.round(bbox[2]), h: Math.round(bbox[3]) };
  }
  if (bbox && typeof bbox === 'object'
    && [bbox.x, bbox.y, bbox.w, bbox.h].every(Number.isFinite)) {
    return { x: Math.round(bbox.x), y: Math.round(bbox.y), w: Math.round(bbox.w), h: Math.round(bbox.h) };
  }
  return null;
}

// Recorta un string a su tope (la salida del modelo no controla el tamaño del
// mazo ni del payload de sync).
function clip(v, n) {
  return String(v ?? '').trim().slice(0, n);
}

const LIMITS = {
  text: 500,        // front / back
  figureKey: 200,   // clave de artefacto (${bookId}:figures:${id})
  occludedLabel: 200,
  answerNodeId: 100,
  svg: 20000,       // un diagrama del prompt 3 sale en ~2-6 KB
  step: 300,        // cada paso de la rúbrica de dibujo
  meta: 200,        // chapter / src
};

// Validación y normalización de la salida del orquestador (o de cualquier lote
// de tarjetas visuales): exige `type` en VISUAL_TYPES y los campos obligatorios
// de cada tipo, recorta strings, deduplica por front normalizado (sin caso ni
// tildes, misma comparación que las labels) y cappea a `max`. NUNCA lanza:
// basura → [].
export function sanitizeVisualCards(cards, { max = 40 } = {}) {
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : 40;
  const list = Array.isArray(cards) ? cards : [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (out.length >= cap) break;
    if (!raw || typeof raw !== 'object' || !isVisualType(raw.type)) continue;
    const chapter = clip(raw.chapter, LIMITS.meta);
    const src = clip(raw.src, LIMITS.meta);
    const front = clip(raw.front, LIMITS.text);
    const back = clip(raw.back, LIMITS.text);
    let card;
    if (raw.type === 'occlusion') {
      const figureKey = clip(raw.figureKey, LIMITS.figureKey);
      const bbox = bboxToCanonical(raw.bbox);
      if (!front || !figureKey || !bbox) continue;
      card = {
        type: 'occlusion', front, back, figureKey, bbox,
        occludedLabel: clip(raw.occludedLabel, LIMITS.occludedLabel),
        chapter, src,
      };
    } else if (raw.type === 'diagram') {
      const svg = clip(raw.svg, LIMITS.svg);
      if (!front || !svg) continue;
      card = {
        type: 'diagram', front, back, svg,
        answerNodeId: clip(raw.answerNodeId, LIMITS.answerNodeId),
        chapter, src,
      };
    } else {   // 'drawing' (VISUAL_TYPES no tiene otros valores)
      const steps = (Array.isArray(raw.steps) ? raw.steps : [])
        .map(s => clip(s, LIMITS.step))
        .filter(Boolean);
      // Menos de 3 pasos no es una rúbrica: es una pregunta suelta.
      if (!front || steps.length < 3) continue;
      card = { type: 'drawing', front, back, steps, chapter, src };
    }
    const key = normalizeText(card.front);
    if (key && seen.has(key)) continue;   // duplicada por front: queda la primera
    if (key) seen.add(key);
    out.push(card);
  }
  return out;
}

// Devuelve el label cuya forma normalizada coincide con `occludedLabel` (sin
// caso ni tildes, vía normalizeText de figures.js) o null. Es el puente entre
// la etiqueta que eligió el modelo y el bbox del grounding.
export function pickLabeledFigure(labels, occludedLabel) {
  const norm = normalizeText(occludedLabel);
  if (!norm) return null;
  for (const label of Array.isArray(labels) ? labels : []) {
    if (label && typeof label === 'object' && normalizeText(label.text) === norm) return label;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Orquestador.
// ---------------------------------------------------------------------------

function isAbort(e) {
  return !!e && e.name === 'AbortError';
}

// Labels utilizables de una figura: objetos {text, bbox} con texto no vacío.
function labelList(figure) {
  return (figure && Array.isArray(figure.labels) ? figure.labels : [])
    .filter(l => l && typeof l === 'object' && typeof l.text === 'string' && l.text.trim());
}

// Construye el mazo visual de un capítulo. SECUENCIAL a propósito: cada llamada
// es pagada y con cuota, así que no se pegan en paralelo. AbortError propaga y
// corta todo; cualquier otro error de una llamada suma a stats.skipped y se
// sigue con la próxima figura/tipo (generación parcial > nada). Nunca lanza
// otra cosa que abort.
export async function buildVisualCards({
  types,
  chapterText,
  figures = [],
  signal,
  onProgress,
  maxOcclusions = 6,
  maxDiagrams = 2,
  maxDrawings = 1,
  bookTitle = '',
} = {}) {
  const selected = (Array.isArray(types) ? types : []).filter(isVisualType);
  const stats = { figures: 0, grounded: 0, occlusion: 0, diagram: 0, drawing: 0, skipped: 0 };
  const raw = [];
  // Solo figuras con clave: sin artifact key no hay tarjeta de oclusión que
  // referencie la imagen (la UI la carga desde el store por figureKey).
  const figs = (Array.isArray(figures) ? figures : [])
    .filter(f => f && typeof f === 'object' && typeof f.key === 'string' && f.key);
  stats.figures = figs.length;
  const text = String(chapterText ?? '');
  const occlusionCap = Number.isFinite(maxOcclusions) && maxOcclusions > 0 ? Math.floor(maxOcclusions) : 0;
  const diagramCap = Number.isFinite(maxDiagrams) && maxDiagrams > 0 ? Math.floor(maxDiagrams) : 0;
  const drawingCap = Number.isFinite(maxDrawings) && maxDrawings > 0 ? Math.floor(maxDrawings) : 0;

  if (selected.includes('occlusion') && occlusionCap > 0) {
    const toGround = figs.filter(f => !labelList(f).length).length;
    let groundedDone = 0;
    let occludedDone = 0;
    let produced = 0;
    for (const figure of figs) {
      if (produced >= occlusionCap) break;
      let labels = labelList(figure);
      if (!labels.length) {
        // Sin labels previas: grounding con el modelo de visión. Las dimensiones
        // salen de la propia figura (width/height si existen; si no, 0 y se
        // acepta igual — groundFigure solo las usa en el texto del prompt).
        let res;
        try {
          res = await groundFigure({
            dataUrl: figure.dataUrl,
            width: Number.isFinite(figure.width) ? figure.width : 0,
            height: Number.isFinite(figure.height) ? figure.height : 0,
            signal,
          });
        } catch (e) {
          if (isAbort(e)) throw e;   // cancelación: corta TODO el mazo
          stats.skipped++;
          continue;                  // fallo de esta figura: se sigue con la próxima
        }
        groundedDone++;
        onProgress?.({ phase: 'grounding', done: groundedDone, total: toGround });
        if (res && Array.isArray(res.labels) && res.labels.length) {
          stats.grounded++;
          labels = res.labels;
        } else {
          // Grounding sin labels: de esta figura no puede salir ninguna tarjeta.
          stats.skipped++;
          continue;
        }
      }
      let ocCards;
      try {
        ocCards = await generateOcclusions({
          labels,
          chapterText: text,
          figureCaption: typeof figure.caption === 'string' ? figure.caption : '',
          bookTitle,
          signal,
        });
      } catch (e) {
        if (isAbort(e)) throw e;
        stats.skipped++;
        continue;
      }
      occludedDone++;
      onProgress?.({ phase: 'occlusion', done: occludedDone, total: figs.length });
      for (const card of Array.isArray(ocCards) ? ocCards : []) {
        if (produced >= occlusionCap) break;
        // Sin bbox no hay tarjeta: la etiqueta elegida debe existir en el
        // grounding de ESTA figura y traer coordenadas utilizables.
        const label = pickLabeledFigure(labels, card && card.occludedLabel);
        if (!label) { stats.skipped++; continue; }
        const bbox = bboxToCanonical(label.bbox);
        if (!bbox) { stats.skipped++; continue; }
        raw.push({
          type: 'occlusion',
          front: card.question,
          back: card.contextFact,
          figureKey: figure.key,
          bbox,
          occludedLabel: card.occludedLabel,
        });
        produced++;
      }
    }
  }

  if (selected.includes('diagram') && diagramCap > 0) {
    try {
      // Una sola llamada por familia: el lote selecciona y genera en el mismo turno.
      const res = await generateDiagrams({ chapterText: text, count: diagramCap, signal });
      onProgress?.({ phase: 'diagram', done: 1, total: 1 });
      for (const d of (res && Array.isArray(res.diagrams) ? res.diagrams : [])) {
        raw.push({
          type: 'diagram',
          front: d.question,
          back: d.contextFact,
          svg: d.svg,
          answerNodeId: d.answerNodeId,
        });
      }
    } catch (e) {
      if (isAbort(e)) throw e;
      stats.skipped++;
    }
  }

  if (selected.includes('drawing') && drawingCap > 0) {
    try {
      const res = await generateDrawingCards({ chapterText: text, count: drawingCap, signal });
      onProgress?.({ phase: 'drawing', done: 1, total: 1 });
      for (const c of (res && Array.isArray(res.cards) ? res.cards : [])) {
        raw.push({ type: 'drawing', front: c.question, back: c.contextFact, steps: c.steps });
      }
    } catch (e) {
      if (isAbort(e)) throw e;
      stats.skipped++;
    }
  }

  const cards = sanitizeVisualCards(raw);
  for (const card of cards) stats[card.type]++;
  return { cards, stats };
}
