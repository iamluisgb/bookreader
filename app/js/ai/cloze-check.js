// P42 F1 · Comparación LOCAL y determinista de la respuesta a una tarjeta de huecos (cloze).
// Módulo PURO (sin DOM, sin red): recibe el frente con sus huecos y lo que escribió el lector,
// y dice si coincide. Solo MIDE — alimenta el campo `exact` del registro de intentos. La
// corrección que ve el usuario sigue siendo la del modelo (`checkRecall` en study.js): esto no
// la sustituye ni la toca.
//
// Por qué estricto y no "parecido": la métrica primaria del contrato de P42 tiene que ser
// determinista y comparable entre semanas. Una distancia de edición o un sinónimo admitido
// convertirían "acierto" en una opinión del comparador. Lo que se perdona es SOLO la forma,
// nunca el contenido:
//
//   1. Mayúsculas/minúsculas.                       «Raft»      = «raft»
//   2. Acentos y diacríticos (NFD + quitar marcas). «algoritmo» = «algorítmo», y ñ = n
//   3. Guiones y guiones bajos valen como espacio.  «byte-pair» = «byte pair»
//   4. Espacios repetidos y en los extremos.
//   5. Puntuación y comillas que ENVUELVEN la respuesta (no las de dentro): . , ; : ! ? ¡ ¿
//      " ' « » “ ” ‘ ’ ( ) [ ]                       «"Raft."»   = «raft»
//   6. UN artículo inicial, en español o inglés (los dos idiomas de la app):
//      el, la, los, las, lo, un, una, unos, unas · the, a, an
//                                                    «el Senado» = «Senado»
//
// Lo que NO pasa (a propósito): sinónimos («consenso» ≠ «acuerdo»), erratas («Rfat» ≠
// «Raft»), plurales («nodo» ≠ «nodos») y respuestas que contienen la buena entre más texto.
//
// Varios huecos en la misma tarjeta: el lector escribe una sola respuesta. Acierta si (a) tras
// normalizar coincide con todos los huecos unidos por espacio, o (b) separando por coma, punto y
// coma, barra, barra vertical o salto de línea, cada trozo coincide con su hueco EN ORDEN.

// Mismo patrón que pinta study.js: {{cN::respuesta}} o {{cN::respuesta::pista}}.
export const CLOZE_RE = /\{\{c\d+::((?:(?!::|\}\}).)*)(?:::((?:(?!\}\}).)*))?\}\}/g;

const ARTICLES = ['el', 'la', 'los', 'las', 'lo', 'un', 'una', 'unos', 'unas', 'the', 'a', 'an'];
const ARTICLE_RE = new RegExp(`^(?:${ARTICLES.join('|')})\\s+`);
const WRAP_RE = /^[\s.,;:!?¡¿"'«»“”‘’()[\]]+|[\s.,;:!?¡¿"'«»“”‘’()[\]]+$/g;
const SPLIT_RE = /[,;/|\n]+/;

// Forma canónica de una respuesta. Exportada para los tests y para quien analice los intentos.
export function normalizeAnswer(text) {
  const base = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[-_‐‑–—]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(WRAP_RE, '')
    .trim();
  // El artículo se quita UNA vez y solo si deja algo detrás: «la» como respuesta entera se queda.
  const stripped = base.replace(ARTICLE_RE, '');
  return stripped || base;
}

// Respuestas de los huecos, en el orden en que aparecen en el frente.
export function clozeAnswers(front) {
  const out = [];
  for (const m of String(front || '').matchAll(CLOZE_RE)) out.push(m[1]);
  return out;
}

// true/false si hay huecos y respuesta que comparar; null si no aplica (sin huecos o sin texto).
export function clozeExact(front, answer) {
  const holes = clozeAnswers(front).map(normalizeAnswer).filter(Boolean);
  const said = normalizeAnswer(answer);
  if (!holes.length || !said) return null;
  if (said === holes.join(' ')) return true;
  if (holes.length === 1) return false;
  const parts = String(answer).split(SPLIT_RE).map(normalizeAnswer).filter(Boolean);
  return parts.length === holes.length && parts.every((p, i) => p === holes[i]);
}
