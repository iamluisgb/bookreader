// Tarjetas visuales (image occlusion): capa de DATOS pura, sin UI ni llamadas al LLM.
// Extrae figuras de páginas del PDF, un modelo de visión devuelve etiquetas con bboxes en
// píxeles sobre el recorte, y este módulo valida/normaliza esas etiquetas y persiste la
// figura como artefacto (kind 'figures') reutilizando la capa de artefactos de db.js.
//
// Sin acceso al DOM: solo funciones puras + IndexedDB vía db.js, para poder testear
// importándolo dentro de la página.

import { balancedObjects } from './query-expand.js';
import { getArtifacts, putArtifact, deleteArtifact } from './db.js';

// kind de artefacto para las tarjetas visuales (key = `${bookId}:figures:${id}`).
export const FIGURE_KIND = 'figures';

// bbox válido: array de 4 números finitos [x, y, w, h].
function validBbox(bbox) {
  return Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite);
}

// Normaliza las DOS formas de bbox a un array [x, y, w, h] entero: la de array (la que
// llega del modelo) y la de objeto {x, y, w, h} (la que devuelve clampBbox). null si es
// inservible. IoU necesita la forma array.
function bboxToArray(bbox) {
  if (validBbox(bbox)) return bbox.map(Math.round);
  if (bbox && typeof bbox === 'object' && [bbox.x, bbox.y, bbox.w, bbox.h].every(Number.isFinite)) {
    return [Math.round(bbox.x), Math.round(bbox.y), Math.round(bbox.w), Math.round(bbox.h)];
  }
  return null;
}

// IoC (Intersection over Union) de dos boxes [x, y, w, h]. 0 si no se tocan.
function iou(a, b) {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  if (inter === 0) return 0;
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

// Clampea un bbox del modelo de visión a píxeles enteros dentro de la imagen.
// bbox = [x, y, w, h] en píxeles, admite floats. Devuelve {x, y, w, h} enteros, o null si
// el box es inservible: no son 4 números finitos, w/h quedan por debajo de `minSize`, o el
// box cae a más de `tolerance` px por fuera de los límites de la imagen.
export function clampBbox(bbox, { width, height, minSize = 5, tolerance = 2 } = {}) {
  if (!validBbox(bbox)) return null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  // Redondear antes de validar: el modelo puede devolver 99.6 en vez de 100.
  const [x, y, w, h] = bbox.map(Math.round);
  // Tolerancia pequeña: los modelos suelen pasarse 1-2 px en los bordes; más que eso es
  // una alucinación de coordenadas y el box se descarta entero.
  if (x < -tolerance || y < -tolerance || x + w > width + tolerance || y + h > height + tolerance) return null;
  const bx = Math.max(0, x);
  const by = Math.max(0, y);
  const bw = Math.min(width, x + w) - bx;
  const bh = Math.min(height, y + h) - by;
  if (bw < minSize || bh < minSize) return null;
  return { x: bx, y: by, w: bw, h: bh };
}

// Normaliza texto de etiqueta para comparar: minúsculas, sin tildes, espacios colapsados y
// solo caracteres alfanuméricos (el resto se vuelve separador). '¡Hóla,  Mundo!' → 'hola mundo'.
export function normalizeText(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // tildes y diacríticos
    .replace(/[^a-z0-9]+/g, ' ')       // no alfanumérico → separador
    .trim()
    .replace(/\s+/g, ' ');
}

// Deduplica etiquetas: mismas dos etiquetas si su texto normalizado coincide o si sus boxes
// se solapan por encima de `iouThreshold`. Se queda con la PRIMERA (asume ranking del
// modelo: mejor primero). Devuelve un array NUEVO; descarta entradas sin texto utilizable
// o con bbox inválido.
export function dedupeLabels(labels, { iouThreshold = 0.55 } = {}) {
  const out = [];
  const norms = [];
  for (const label of Array.isArray(labels) ? labels : []) {
    if (!label || typeof label !== 'object') continue;
    const text = typeof label.text === 'string' ? label.text.trim() : '';
    const norm = normalizeText(text);
    const arr = bboxToArray(label.bbox);
    if (!norm || !arr) continue;
    let dup = false;
    for (let i = 0; i < out.length; i++) {
      if (norms[i] === norm || iou(out[i].__arr, arr) > iouThreshold) { dup = true; break; }
    }
    if (dup) continue;
    // Se conserva el bbox en su forma original (array del modelo u objeto clampeado).
    out.push({ text, bbox: label.bbox, __arr: arr });
    norms.push(norm);
  }
  return out.map(({ text, bbox }) => ({ text, bbox }));
}

// Parseo tolerante de la respuesta del modelo de visión. DEBERÍA ser
// {"labels":[{"text":..,"bbox":[x,y,w,h]}]} pero puede venir con fences markdown, prosa
// alrededor, basura final o truncado. Extrae los objetos JSON balanceados (reutiliza el
// extractor de query-expand.js) y se queda con el PRIMERO que traiga array `labels`;
// mapea cada entrada por clampBbox + normalizeText y deduplica. Devuelve [] si no hay nada
// aprovechable. NUNCA lanza.
export function parseLabelsResponse(text, { width, height } = {}) {
  const raw = String(text ?? '').replace(/```(?:json)?/gi, '');
  for (const candidate of balancedObjects(raw)) {
    let obj;
    try { obj = JSON.parse(candidate); } catch { continue; }   // truncado o inválido → siguiente
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.labels)) continue;
    const labels = obj.labels
      .map(l => (l && typeof l === 'object' && typeof l.text === 'string')
        ? { text: l.text, bbox: clampBbox(l.bbox, { width, height }) }
        : null)
      .filter(l => l && l.bbox);   // bbox fuera de imagen → etiqueta descartada
    return dedupeLabels(labels);
  }
  return [];
}

// Convierte un rect fraccional {x, y, w, h} en 0..1 (mismo sistema que
// captureRegionImage de pdf-reader.js) a un box en píxeles enteros, clampeado al tamaño
// de la página. Devuelve null si el rect no es utilizable.
export function figureRectToBox(rect, { pageWidth, pageHeight } = {}) {
  if (!rect || typeof rect !== 'object') return null;
  if (![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)) return null;
  if (!Number.isFinite(pageWidth) || !Number.isFinite(pageHeight)) return null;
  // El rect viene del recorte del propio usuario, no de un modelo que alucine bordes:
  // lo que se pasa de 1 se CLAMPEA al área visible (no se descarta). minSize 1: un rect
  // fraccional válido siempre mapea a al menos 1 px.
  const x = Math.min(Math.max(rect.x, 0), 1);
  const y = Math.min(Math.max(rect.y, 0), 1);
  const w = Math.min(Math.max(rect.w, 0), 1 - x);
  const h = Math.min(Math.max(rect.h, 0), 1 - y);
  return clampBbox(
    [x * pageWidth, y * pageHeight, w * pageWidth, h * pageHeight],
    { width: pageWidth, height: pageHeight, minSize: 1, tolerance: 0 },
  );
}

// Persiste una figura como artefacto del libro y devuelve la clave (handle para borrarla).
// Cada save crea un artefacto NUEVO (historial), como el resto de los artefactos.
export async function saveFigure({ bookId, page, rect, dataUrl, labels = [], caption = '', source = 'pdf', width = 0, height = 0 }) {
  return putArtifact({
    bookId,
    kind: FIGURE_KIND,
    params: { page },
    // width/height son los píxeles REALES del recorte. Se persisten para no tener que
    // volver a decodificar el dataUrl en cada generación (figureSize de visual-deck los
    // usa primero y solo decodifica si faltan: artefactos viejos sin estos campos).
    result: { page, rect, dataUrl, labels, caption, source, width, height },
  });
}

// Figuras de un libro, más nuevas primero. Devuelve { key, ...result } por figura para que
// la UI acceda directo a page/rect/dataUrl/labels y conserve la clave para borrar.
export async function getFigures(bookId) {
  const artifacts = await getArtifacts(bookId);
  return artifacts
    .filter(a => a.kind === FIGURE_KIND)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(a => ({ key: a.key, ...a.result }));
}

// Borra una figura por clave completa (tombstone en db.js: se propaga por sync).
export function deleteFigure(key) {
  return deleteArtifact(key);
}
