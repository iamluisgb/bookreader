// IA7 · Reescritura de consulta por defecto (HyDE-lite). Ver BACKLOG · IA7.
// BM25 (nuestro retrieval, ver retrieval.js) falla en preguntas conceptuales/parafraseadas:
// las palabras de la pregunta no están en el texto. Antes de buscar, una llamada barata al
// LLM (BYOK, sin infra nueva) expande la pregunta en:
//   - terms: palabras clave que probablemente aparezcan LITERALMENTE en el libro.
//   - hypothetical: 1-2 frases con una respuesta plausible (HyDE), en el idioma del libro.
// El retrieval hace BM25 sobre la pregunta CRUDA ∪ la expansión (unión, no sustitución):
// conserva la precisión léxica y suma recall conceptual, sin riesgo de regresión.
//
// Robustez: gate + timeout + fallback. expandQuery NUNCA lanza: ante cualquier fallo
// (sin key, timeout, JSON inválido, red) devuelve null y el retrieval sigue con la
// pregunta cruda (comportamiento actual, cero regresión).
import * as LLM from './llm.js';

const EXPAND_TIMEOUT_MS = 7000;   // techo de latencia: si tarda más, fallback a la cruda

function systemPrompt(tocLabels) {
  const map = (Array.isArray(tocLabels) ? tocLabels.filter(Boolean) : []).slice(0, 40);
  const hint = map.length ? `\nÍNDICE DEL LIBRO (usa su MISMO idioma y dominio):\n${map.map(t => '- ' + t).join('\n')}` : '';
  return `Preparas una BÚSQUEDA por palabras clave (BM25) dentro de un libro, a partir de la pregunta del usuario.
NO respondas la pregunta. Devuelve SOLO un objeto JSON compacto (sin markdown, sin texto alrededor) con:
- "terms": 3-6 palabras o frases clave que probablemente aparezcan LITERALMENTE en el libro (sustantivos,
  términos técnicos, nombres propios), en el MISMO idioma que el libro.
- "hypothetical": 1-2 frases con una respuesta plausible a la pregunta, redactadas como si fueran un
  extracto del libro (para recuperar por similitud léxica), en el idioma del libro.
Ejemplo de forma: {"terms":["...","..."],"hypothetical":"..."}${hint}`;
}

// Objetos JSON balanceados de un texto (respeta llaves dentro de strings). Devuelve las
// subcadenas `{...}` de nivel superior, en orden. Robusto ante prosa y llaves anidadas.
function balancedObjects(text) {
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}' && depth > 0) { depth--; if (depth === 0 && start >= 0) { out.push(text.slice(start, i + 1)); start = -1; } }
  }
  return out;
}

// Extrae {terms, hypothetical} de la respuesta del modelo. Tolerante a fences, bloques de
// razonamiento (<think>…</think> de modelos reasoning) y prosa alrededor: prueba los objetos
// JSON balanceados (el real suele ir el ÚLTIMO, tras el razonamiento). Devuelve null si no
// hay nada aprovechable (→ el retrieval usa solo la pregunta cruda).
export function parseExpansion(raw) {
  const text = String(raw || '')
    .replace(/```(?:json)?/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ');   // descarta el razonamiento de modelos reasoning
  const candidates = balancedObjects(text);
  for (let i = candidates.length - 1; i >= 0; i--) {   // del último al primero
    let obj;
    try { obj = JSON.parse(candidates[i]); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;
    const terms = Array.isArray(obj.terms)
      ? obj.terms.map(t => String(t || '').trim()).filter(Boolean).slice(0, 8)
      : [];
    const hypothetical = typeof obj.hypothetical === 'string' ? obj.hypothetical.trim() : '';
    if (terms.length || hypothetical) return { terms, hypothetical };
  }
  return null;
}

// Cadena de búsqueda combinada (términos + hipótesis) para pasar a Retrieval.search.
export function expansionQuery(expansion) {
  if (!expansion) return '';
  return [...(expansion.terms || []), expansion.hypothetical || ''].join(' ').replace(/\s+/g, ' ').trim();
}

// Genera la expansión de la pregunta. `signal` (opcional) = aborto del turno; internamente
// añade un timeout. Nunca lanza: devuelve null y se cae con gracia a la pregunta cruda.
export async function expandQuery(question, { tocLabels = [], signal } = {}) {
  const q = String(question || '').trim();
  if (!q || !LLM.hasKey()) return null;
  if (signal?.aborted) return null;

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), EXPAND_TIMEOUT_MS);
  try {
    let acc = '';
    const raw = await LLM.chatStream({
      messages: [
        { role: 'system', content: systemPrompt(tocLabels) },
        { role: 'user', content: 'PREGUNTA: ' + q },
      ],
      signal: ctrl.signal,
      onToken: (t) => { acc += t; },
    });
    return parseExpansion(raw || acc);
  } catch {
    return null;   // timeout, red, aborto, proveedor… → fallback a la pregunta cruda
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
